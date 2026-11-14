// XAIBO-PROD-110 (P1-T12): the renderer's port client. Requests carry increasing ids; a response resolves only its own
// request; pushes go to their handlers; every message is validated and invalid ones are counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, parseVisible, type PortLike } from '../../src/renderer/client.ts';

test('P4-T02: main\'s window visibility message (via the preload) is a strict boolean; anything else is ignored', () => {
  assert.equal(parseVisible({ xaiboVisible: true }), true);
  assert.equal(parseVisible({ xaiboVisible: false }), false);
  for (const x of [null, 'xaibo-port', { xaiboVisible: 'true' }, { xaiboVisible: 1 }, { visible: true }, [true]]) assert.equal(parseVisible(x), null);
});
import type { AgentStatus, SessionRow } from '../../src/shared/ipc.ts';

function fakePort() {
  const sent: unknown[] = [];
  const port: PortLike & { closed: boolean } = {
    onmessage: null, closed: false,
    postMessage(m) { sent.push(m); },
    close() { this.closed = true; },
  };
  return { port, sent, deliver: (data: unknown) => port.onmessage?.({ data }) };
}
const row: SessionRow = { id: 1, agent: 'claude', entrypoint: null, origin: null, interactive: null, model: 'Model unavailable', cwd: null, title: null, lastActivity: null, drift: false, compressed: false, quarantined: 0,
  live: null, contextPct: null, costUsd: null, costCoverage: 'unavailable', tokens: null, tokensComplete: true };

test('listSessions posts a versioned request and resolves with its own page only', async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const a = c.listSessions(null, 50);
  const b = c.listSessions({ lastActivity: 5, id: 1 }, 50);
  assert.deepEqual(f.sent, [
    { v: 1, type: 'listSessions', id: 1, cursor: null, limit: 50 },
    { v: 1, type: 'listSessions', id: 2, cursor: { lastActivity: 5, id: 1 }, limit: 50 },
  ]);
  f.deliver({ v: 1, type: 'page', id: 2, rows: [], next: null });
  f.deliver({ v: 1, type: 'page', id: 1, rows: [row], next: null });
  f.deliver({ v: 1, type: 'page', id: 99, rows: [], next: null }); // nobody asked: ignored
  assert.deepEqual(await a, { rows: [row], next: null });
  assert.deepEqual(await b, { rows: [], next: null });
});

test('pushes reach their handlers; invalid messages are dropped and counted', () => {
  const f = fakePort();
  const got: { sessions: SessionRow[][]; agents: (AgentStatus[] | null)[] } = { sessions: [], agents: [] };
  const c = createClient(f.port, { sessions: (rows) => got.sessions.push(rows), agents: (a) => got.agents.push(a) });
  f.deliver({ v: 1, type: 'sessions', rows: [row] });
  f.deliver({ v: 1, type: 'agents', agents: null });
  f.deliver({ v: 1, type: 'sessions', rows: [{ ...row, id: 'x' }] });
  f.deliver('<script>');
  assert.deepEqual(got, { sessions: [[row]], agents: [null] });
  assert.equal(c.dropped, 2);
});

test('close detaches and closes the port', () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  c.close();
  assert.equal(f.port.onmessage, null);
  assert.equal(f.port.closed, true);
});

test('H3: an invalid reply to a request settles it with an error instead of leaving it pending', { timeout: 5_000 }, async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const p = c.listSessions(null, 50);
  f.deliver({ v: 1, type: 'page', id: 1, rows: [{ id: 'bad' }], next: null });
  await assert.rejects(p, /invalid reply/);
  assert.equal(c.dropped, 1);
});

// XAIBO-PROD-404 review M2: the live-set request has its own pending map; an invalid reply rejects it; a page reply
// never settles it.
test('liveSet resolves with its own reply, ignores a page reply with its id, and rejects on an invalid reply', async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const a = c.liveSet();
  assert.deepEqual(f.sent, [{ v: 1, type: 'liveSet', id: 1 }]);
  f.deliver({ v: 1, type: 'page', id: 1, rows: [], next: null }); // a different request kind: not this one
  f.deliver({ v: 1, type: 'liveSet', id: 1, rows: [row], more: true });
  assert.deepEqual(await a, { rows: [row], more: true });
  const b = c.liveSet();
  f.deliver({ v: 1, type: 'liveSet', id: 2, rows: [row], more: 'no' });
  await assert.rejects(b, /invalid reply/);
});
