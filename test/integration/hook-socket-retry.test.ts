// XAIBO-PROD-431 (P4-T12b finding, EC-44): a service that starts while the disk is full cannot create its socket and
// listened never again, so hooks were lost until the next restart. A failed listen is retried until it listens; hooks
// the forwarder spooled meanwhile replay after the late listen; close() stops the retry. The listen is made to fail by
// a regular file where run/ must be (the socket server refuses it), then the file is removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { createDecoder, encodeFrame } from '../../src/shared/hook-protocol.ts';
import { startHooks } from '../../src/service/receivers/intake.ts';
import { addRegistration } from '../../src/service/receivers/registrations.ts';
import { count } from '../helpers/claude-profile.ts';
import { envelope, hookStore, SESSION, T0 } from '../helpers/hook-store.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms: number) {
  for (const end = Date.now() + ms; !f(); await sleep(20)) if (Date.now() > end) return false;
  return true;
}
const logger = () => { const events: string[] = []; return { events, log: { log: (e: string) => { events.push(e); } } }; };

test('a socket that cannot listen at start retries until it listens, then replays what was spooled meanwhile', async () => {
  const h = await hookStore();
  writeFileSync(join(h.dir, 'run'), ''); // run/ cannot be made: the listen fails, as a full disk makes it fail
  const l = logger();
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, log: l.log, socketRetryMs: 50 });
  try {
    await svc.replay; // the start replay found nothing
    assert.equal(svc.socket, null);
    await sleep(200); // several retries fail
    assert.deepEqual(l.events.filter((e) => e.startsWith('hook_socket')), ['hook_socket_failed'], 'one failure line per outage, not one per retry');
    mkdirSync(join(h.dir, 'spool'), { mode: 0o700 }); // the forwarder spooled a hook while nothing listened
    writeFileSync(join(h.dir, 'spool', '2026-01-01.jsonl'), `\n${JSON.stringify(envelope())}\n`, { mode: 0o600 });
    rmSync(join(h.dir, 'run')); // space is back
    assert.ok(await until(() => svc.socket !== null, 2000), 'listens again without a restart');
    assert.ok(existsSync(join(h.dir, 'run', 'xaibo.sock')));
    assert.ok(l.events.includes('hook_socket_listening'));
    assert.ok(await until(() => count(h.db, 'SELECT count(*) FROM hook_delivery') === 1, 3000), 'the spooled hook is stored after the late listen');
  } finally { await svc.close(); }
});

test('close() during the outage stops the retry: nothing listens afterwards', async () => {
  const h = await hookStore();
  writeFileSync(join(h.dir, 'run'), '');
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, socketRetryMs: 50 });
  await svc.close();
  rmSync(join(h.dir, 'run'));
  await sleep(200);
  assert.equal(svc.socket, null);
  assert.equal(existsSync(join(h.dir, 'run', 'xaibo.sock')), false);
});

// XAIBO-PROD-443 (G4b-3): report intake that could not open content-chunks at start was off until a restart: a
// registration hello was refused as a token hello, and the spool replay stopped at the first report record, holding the
// hooks spooled behind it. It is now retried on each report delivery; the spool replays once when it first works.
test('XAIBO-PROD-443: a report intake that fails at start recovers without a restart; spooled report and hook behind it are stored', async () => {
  const h = await hookStore();
  const { registration, token } = addRegistration(h.dir, { agent: 'claude', profileKey: 'p1' });
  writeFileSync(join(h.dir, 'content-chunks'), ''); // the chunk store cannot be opened (a full disk fails the same way)
  let n = 0;
  const report = () => ({ v: 1, delivery_id: `d-${++n}`, session_id: SESSION, producer_id: 'fixture-producer', producer_seq: n, event: 'turn.start',
    source_ts: '2026-01-01T00:00:00.000Z', payload: {} });
  mkdirSync(join(h.dir, 'spool'), { mode: 0o700 });
  writeFileSync(join(h.dir, 'spool', '2026-01-01.jsonl'), [JSON.stringify({ v: 1, kind: 'report', registration: registration.id, received_ts: T0, frame: report() }),
    JSON.stringify(envelope({ received_ts: T0 + 1 }))].join('\n') + '\n', { mode: 0o600 });
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, socketRetryMs: 50 });
  try {
    await svc.replay;
    assert.deepEqual([count(h.db, 'SELECT count(*) FROM report_delivery'), count(h.db, 'SELECT count(*) FROM hook_delivery')], [0, 0], 'held behind the report');
    rmSync(join(h.dir, 'content-chunks'));
    const live = report();
    const acks = await new Promise<unknown[]>((resolve, reject) => {
      const c = net.connect(svc.socket!.path);
      const push = createDecoder();
      const got: unknown[] = [];
      c.on('error', reject);
      c.on('connect', () => c.write(Buffer.concat([encodeFrame({ v: 1, registration: registration.id, token }), encodeFrame(live)])));
      c.on('data', (b: Buffer) => { got.push(...push(b)); if (got.length) { c.destroy(); resolve(got); } });
      c.on('close', () => resolve(got));
    });
    assert.deepEqual(acks, [{ v: 1, delivery_id: live.delivery_id, status: 'accepted', code: 'ok' }], 'the registration hello is verified, the frame stored');
    assert.ok(await until(() => count(h.db, 'SELECT count(*) FROM report_delivery') === 2 && count(h.db, 'SELECT count(*) FROM hook_delivery') === 1, 3000),
      'the spooled report and the hook behind it are stored without a restart');
  } finally { await svc.close(); }
});

// Gate 5 round 2 (perf finding, hooksOnce): a hook the forwarder spooled during a short service stall (past its ~50 ms
// deadline) while the socket listens was replayed only at the next start. The running service replays the spool on an
// interval (bounded, with the start replay's rename and grace rules), so it is stored without a restart.
test('a hook spooled while the service runs is stored within the replay interval, without a restart', async () => {
  const h = await hookStore();
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, replayIntervalMs: 100 });
  try {
    await svc.replay; // the start replay found nothing
    assert.ok(svc.socket !== null, 'fixture: the socket listens');
    mkdirSync(join(h.dir, 'spool'), { mode: 0o700 });
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(join(h.dir, 'spool', `${day}.jsonl`), `${JSON.stringify(envelope({ session_id: SESSION }))}\n`, { mode: 0o600 });
    assert.ok(await until(() => count(h.db, 'SELECT count(*) FROM hook_delivery') === 1, 15_000), 'the spooled hook is stored while the service runs (interval + grace)');
  } finally { await svc.close(); }
});

// Gate 5 round 2 (design security review): the interval replay goes through the same intake as the start replay, so a
// hook of a session whose retention purge is under way, spooled in the purge window, comes back 'suppressed' and is not
// stored; the spool file is still consumed.
test('an interval replay of a hook spooled during a retention purge of its session stores nothing', async () => {
  const h = await hookStore();
  const at = Date.now() - 1_000;
  h.db.prepare("INSERT INTO suppressions (agent, profile_id, native_session_id, reason, at, purge_phase) VALUES ('claude', 'p1', ?, 'retention', ?, 'rows')").run(SESSION, at);
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, replayIntervalMs: 100 });
  try {
    await svc.replay;
    const spool = join(h.dir, 'spool');
    mkdirSync(spool, { mode: 0o700 });
    writeFileSync(join(spool, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      `${JSON.stringify(envelope({ session_id: SESSION, received_ts: Date.now(), payload: { hook_event_name: 'Stop', session_id: SESSION } }))}\n`, { mode: 0o600 });
    assert.ok(await until(() => readdirSync(spool).filter((f) => f.endsWith('.jsonl')).length === 0, 15_000), 'the interval replay took and removed the spool file');
    assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery'), 0, 'nothing stored for the purging session');
    assert.equal(count(h.db, 'SELECT count(*) FROM events'), 0);
  } finally { await svc.close(); }
});

// XAIBO-PROD-549 (Gate 5 disk-full): the forwarder keeps appending to today's spool file while the service is slow, so a
// quiet window never opened and spool-only hooks waited until appends paused. The interval replay now takes the file
// anyway (rename, grace and size checks keep late appends for the next pass).
test('PROD-549: a spool file appended every second is still replayed while the service runs', async () => {
  const h = await hookStore();
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, replayIntervalMs: 100 });
  const spool = join(h.dir, 'spool');
  const file = join(spool, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const add = () => appendFileSync(file, `${JSON.stringify(envelope({ session_id: SESSION }))}\n`, { mode: 0o600 });
  try {
    await svc.replay;
    mkdirSync(spool, { mode: 0o700 });
    add();
    const every = setInterval(add, 1_000);
    try {
      assert.ok(await until(() => count(h.db, 'SELECT count(*) FROM hook_delivery') >= 1, 4_000), 'stored while appends continue');
    } finally { clearInterval(every); }
  } finally { await svc.close(); }
});

const full = () => { throw Object.assign(new Error('database or disk is full'), { code: 'ENOSPC' }); };

test('PROD-549: disk recovery brings the next replay forward and the backoff back to the base interval', async () => {
  const h = await hookStore();
  const commit = h.writer.commitLive.bind(h.writer);
  h.writer.commitLive = full;
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, replayIntervalMs: 100, replayNowMinMs: 50 });
  const spool = join(h.dir, 'spool');
  const put = () => writeFileSync(join(spool, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(envelope({ session_id: SESSION }))}\n`, { mode: 0o600, flag: 'a' });
  try {
    await svc.replay;
    mkdirSync(spool, { mode: 0o700 });
    put();
    await sleep(3_200); // failed passes at ~0.1, 0.3, 0.7, 1.5, 3.1 s: the next would be ~6.3 s
    assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery'), 0, 'fixture: the disk is full');
    h.writer.commitLive = commit;
    svc.replayNow();
    assert.ok(await until(() => count(h.db, 'SELECT count(*) FROM hook_delivery') === 1, 1_500), 'replayed promptly, not at the backed-off interval');
    put();
    // the recovery pass resolves after its 1 s grace; 4 s stays below the ~6.4 s backed-off interval (review D183-1)
    assert.ok(await until(() => count(h.db, 'SELECT count(*) FROM hook_delivery') === 2, 4_000), 'the interval is back to the base');
  } finally { await svc.close(); }
});

test('PROD-549 (R183-1): replayNow storms on a store hovering near full are bounded by the floor between passes', async () => {
  const h = await hookStore();
  h.writer.commitLive = full;
  const passes: number[] = [];
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, replayIntervalMs: 60_000, replayNowMinMs: 200,
    log: { log: (e: string) => { if (e === 'spool_replay') passes.push(Date.now()); } } });
  try {
    await svc.replay;
    mkdirSync(join(h.dir, 'spool'), { mode: 0o700 });
    writeFileSync(join(h.dir, 'spool', `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(envelope({ session_id: SESSION }))}\n`, { mode: 0o600 });
    const before = passes.length;
    for (const end = Date.now() + 1_000; Date.now() < end; await sleep(10)) svc.replayNow();
    await sleep(300);
    const n = passes.length - before;
    assert.ok(n >= 2 && n <= 7, `${n} passes in ~1.3 s with a 200 ms floor`);
  } finally { await svc.close(); }
});

// XAIBO-PROD-550 (G5Sx-1, Gate 5 fix re-review 7): the floor is stamped when a serialized pass starts, so a pass brought
// forward while the startup replay still holds its 1 s cleanup grace starts no sooner than the floor after the startup
// pass started (before: the floor was stamped only at tick dispatch, so it ran right after the startup pass, ~1 s in).
test('G5Sx-1: a replayNow during a startup replay holding its grace waits for the floor after the startup pass start', async () => {
  const h = await hookStore();
  const spool = join(h.dir, 'spool');
  const put = () => writeFileSync(join(spool, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(envelope({ session_id: SESSION }))}\n`, { mode: 0o600, flag: 'a' });
  mkdirSync(spool, { mode: 0o700 });
  put();
  const floor = 2_000;
  const before = Date.now(); // at or before the startup pass start
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, replayIntervalMs: 60_000, replayNowMinMs: floor });
  try {
    assert.ok(await until(() => count(h.db, 'SELECT count(*) FROM hook_delivery') === 1, 1_000), 'the startup pass delivered the spooled hook');
    put(); // appended after the startup pass read the file; that pass now waits out its grace (and keeps the changed file)
    svc.replayNow();
    assert.ok(await until(() => count(h.db, 'SELECT count(*) FROM hook_delivery') === 2, floor + 2_000), 'the brought-forward pass ran');
    const at = Date.now() - before;
    assert.ok(at >= floor - 50, `the brought-forward pass started ${at} ms after the startup pass, floor ${floor} ms`);
    await svc.replay;
  } finally { await svc.close(); }
});
