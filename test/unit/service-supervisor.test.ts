// XAIBO-PROD-104 (P1-T06, ROB, OQ-P1-07): restart with bounded backoff, reset after a healthy period, no restart
// after stop, a fresh port per start, health transitions. Injected fork, channel, clock and timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HEALTHY_RESET_MS, nextDelay, Supervisor } from '../../src/main/service-supervisor.ts';
import type { Health } from '../../src/shared/ipc.ts';

class FakeChild extends EventEmitter {
  readonly sent: { msg: unknown; ports: unknown[] | undefined }[] = [];
  kills = 0;
  readonly pid: number;
  constructor(pid: number) { super(); this.pid = pid; }
  postMessage(msg: unknown, ports?: unknown[]) { this.sent.push({ msg, ports }); }
  kill() { this.kills++; return true; }
  ready() { this.emit('message', { v: 1, type: 'ready', readOnly: null }); }
  die(code = 1) { this.emit('exit', code); }
}

function harness() {
  let t = 0;
  let ports = 0;
  const children: FakeChild[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0;
  const health: Health[] = [];
  let spawns = 0;
  const sup = new Supervisor<{ n: number }>({
    fork: () => { const c = new FakeChild(children.length + 1); children.push(c); return c; },
    channel: () => ({ port1: { n: ++ports }, port2: { n: ++ports } }),
    onHealth: (h) => health.push(h),
    onSpawn: () => { spawns++; },
    setTimer: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimer: (id) => { timers.delete(id as number); },
    now: () => t,
    quitMs: 2_000,
  });
  const fire = () => { // runs the single pending timer, returns its delay
    assert.equal(timers.size, 1, 'exactly one pending timer');
    const [id, { fn, ms }] = [...timers][0]!;
    timers.delete(id);
    fn();
    return ms;
  };
  return { sup, children, timers, health, fire, advance: (ms: number) => { t += ms; }, spawns: () => spawns, last: () => children.at(-1)! };
}

test('nextDelay: 0.5 s doubling to a 30 s cap, indefinitely', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(nextDelay), [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(nextDelay(1000), 30000);
  assert.equal(HEALTHY_RESET_MS, 60_000);
});

test('start: starting, then running on ready', () => {
  const h = harness();
  h.sup.start();
  assert.equal(h.children.length, 1);
  assert.equal(h.sup.health.state, 'starting');
  h.last().ready();
  assert.equal(h.sup.health.state, 'running');
  assert.deepEqual(h.health.map((x) => x.state), ['starting', 'running']);
});

test('unexpected exits restart with the backoff sequence; health counts the attempt', () => {
  const h = harness();
  h.sup.start();
  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    h.last().die();
    assert.deepEqual({ state: h.sup.health.state, attempt: h.sup.health.attempt }, { state: 'restarting', attempt: i + 1 });
    delays.push(h.fire());
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(h.children.length, 9);
});

test('the attempt counter resets once the exited service had been ready for the healthy period', () => {
  const h = harness();
  h.sup.start();
  for (let i = 0; i < 3; i++) { h.last().die(); h.fire(); }
  h.last().ready();
  h.advance(HEALTHY_RESET_MS - 1);
  h.last().die();
  assert.equal(h.fire(), 4000, 'not healthy long enough: no reset (fourth restart)');
  h.last().ready();
  h.advance(HEALTHY_RESET_MS);
  h.last().die();
  assert.equal(h.sup.health.attempt, 1);
  assert.equal(h.fire(), 500);
});

test('stop: quit is sent, no restart follows the exit, health is stopped', async () => {
  const h = harness();
  h.sup.start();
  h.last().ready();
  const stopped = h.sup.stop();
  assert.deepEqual(h.last().sent.at(-1)!.msg, { v: 1, type: 'quit' });
  h.last().die(0);
  await stopped;
  assert.equal(h.children.length, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.sup.health.state, 'stopped');
});

test('stop during a pending restart cancels it', async () => {
  const h = harness();
  h.sup.start();
  h.last().die();
  assert.equal(h.timers.size, 1);
  await h.sup.stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.children.length, 1);
  assert.equal(h.sup.health.state, 'stopped');
});

test('stop kills a service that does not exit within quitMs', async () => {
  const h = harness();
  h.sup.start();
  const stopped = h.sup.stop();
  assert.equal(h.fire(), 2_000);
  assert.equal(h.last().kills, 1);
  h.last().die(null as unknown as number);
  await stopped;
  assert.equal(h.children.length, 1);
});

test('connect brokers a fresh port to the current service; onSpawn fires on every start', () => {
  const h = harness();
  assert.equal(h.sup.connect(), null, 'no service yet');
  h.sup.start();
  assert.equal(h.spawns(), 1);
  const p = h.sup.connect();
  assert.deepEqual(p, { n: 2 });
  assert.deepEqual(h.last().sent.at(-1), { msg: { v: 1, type: 'port' }, ports: [{ n: 1 }] });
  h.last().die();
  assert.equal(h.sup.connect(), null, 'no service while restarting');
  h.fire();
  assert.equal(h.spawns(), 2);
  assert.deepEqual(h.sup.connect(), { n: 4 });
});

test('invalid messages from the service are dropped and counted', () => {
  const h = harness();
  h.sup.start();
  h.last().emit('message', { v: 1, type: 'ready' });
  h.last().emit('message', 'ready');
  assert.equal(h.sup.health.state, 'starting');
  assert.equal(h.sup.dropped, 2);
});
