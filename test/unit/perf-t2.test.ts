// XAIBO-PROD-428 (P4-T11, EC-57 at TP per owner decision 2026-11-16): the live-load run's post-hoc analysis. Every
// emitted event is joined to its own commit, delta and paint on one monotonic clock; a restarted service reuses delta
// numbers, so a paint is matched to its delta by time; samples from the restart window are kept apart from the steady
// figures; an unpainted event is a miss, never dropped; drain is the last paint after the end of load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { analyze, hookLookup, type Emitted, type TraceLine } from '../perf/t2-analysis.ts';

const T = (ms: number) => BigInt(Math.round(ms * 1e6));
const t = (ms: number) => T(ms).toString();
const commit = (ms: number, ...ids: string[]): TraceLine => ({ ev: 'commit', ids, t: t(ms) });
const delta = (ms: number, n: number, ...ids: string[]): TraceLine => ({ ev: 'delta', delta: n, ids, t: t(ms) });
const paint = (ms: number, n: number): TraceLine => ({ ev: 'paint', delta: n, t: t(ms) });
const hook = (id: string | null, at: number, exit = at + 30): Emitted => ({ kind: 'hook', id, t0: T(at), exit: T(exit) });
const file = (id: string, at: number): Emitted => ({ kind: 'file', id, t0: T(at) });

test('each event joins to its own commit, delta and paint; hops and totals in ms', () => {
  const r = analyze({
    emitted: [hook('h1', 0), file('f1', 10)],
    service: [commit(40, 'h1'), delta(90, 1, 'h1'), commit(300, 'f1'), delta(350, 2, 'f1')],
    main: [paint(120, 1), paint(400, 2)],
    restart: null, loadEnd: T(20),
  });
  assert.deepEqual([r.m1.steady.n, r.m1.steady.max, r.m2.steady.n, r.m2.steady.max], [1, 120, 1, 390]);
  assert.deepEqual(r.hops.m1, { dispatch: 30, toCommit: 40, commitToDelta: 50, deltaToPaint: 30 });
  assert.equal(r.drainMs, 380, 'last paint (400) after the end of load (20)');
  assert.deepEqual(r.unpainted, { steady: 0, restart: 0 });
});

test('a restarted service reuses delta numbers: a paint matches its delta by time, never an earlier paint', () => {
  const r = analyze({
    emitted: [hook('a', 0), hook('b', 1000)],
    service: [commit(20, 'a'), delta(30, 1, 'a'), commit(1020, 'b'), delta(1030, 1, 'b')],
    main: [paint(50, 1), paint(1100, 1)],
    restart: null, loadEnd: T(1000),
  });
  assert.equal(r.m1.steady.max, 100, 'b painted at 1100, not by the first service\'s delta 1 at 50');
});

test('restart-window samples stay apart; an unpainted or spooled event is a miss; drain is then Infinity', () => {
  const r = analyze({
    emitted: [hook('s1', 0), hook('r1', 500), hook(null, 600), file('r2', 700), file('lost', 2000)],
    service: [commit(20, 's1'), delta(30, 1, 's1'), commit(1500, 'r1'), delta(1510, 1, 'r1'), commit(1600, 'r2'), delta(1610, 2, 'r2')],
    main: [paint(60, 1), paint(1550, 1), paint(1650, 2)],
    restart: { from: T(400), to: T(1700) }, loadEnd: T(2000),
  });
  assert.deepEqual([r.m1.steady.n, r.m1.steady.max], [1, 60]);
  assert.deepEqual([r.m1.restartWindow.n, r.m1.restartWindow.max], [2, Number.POSITIVE_INFINITY], 'the spooled hook is a miss in its window');
  assert.deepEqual([r.m2.restartWindow.n, r.m2.restartWindow.max, r.m2.steady.n, r.m2.steady.max], [1, 950, 1, Number.POSITIVE_INFINITY]);
  assert.deepEqual(r.unpainted, { steady: 1, restart: 1 });
  assert.deepEqual(r.steadyMisses, [{ kind: 'file', missing: 'commit', atMs: 2000 }], 'diagnosis: which hop is missing, and when');
  assert.equal(r.drainMs, Number.POSITIVE_INFINITY, 'a steady event never painted');
});

test('drain counts steady events only: a restart-window miss (replayed later) does not make it Infinity', () => {
  const r = analyze({
    emitted: [file('s', 0), hook(null, 500)],
    service: [commit(100, 's'), delta(110, 1, 's')], main: [paint(150, 1)],
    restart: { from: T(400), to: T(900) }, loadEnd: T(100),
  });
  assert.deepEqual([r.unpainted.restart, r.drainMs], [1, 50]);
});

test('ingest lag: emit to commit for every steady event, the queue age the live-load check uses', () => {
  const r = analyze({
    emitted: [hook('h', 0), file('f', 0), file('late', 500)],
    service: [commit(40, 'h'), delta(50, 1, 'h'), commit(300, 'f'), delta(310, 2, 'f'), commit(900, 'late'), delta(910, 3, 'late')],
    main: [paint(60, 1), paint(320, 2), paint(920, 3)],
    restart: { from: T(450), to: T(1000) }, loadEnd: T(500),
  });
  assert.deepEqual([r.ingestLagMs.n, r.ingestLagMs.max], [2, 300], 'the restart-window event is left out');
});

test('a commit stamped before the emit is not the event\'s own', () => {
  const r = analyze({ emitted: [file('x', 100)], service: [commit(50, 'x'), delta(60, 1, 'x')], main: [paint(70, 1)], restart: null, loadEnd: T(100) });
  assert.equal(r.unpainted.steady, 1);
});

test('queue age and resyncs come from trace-stamped service metrics', () => {
  const metrics = (ms: number, q: number, resyncs: number): TraceLine => ({ ev: 'metrics', writerQueueAgeMs: q, deltaResyncs: resyncs, t: t(ms) });
  const restart = { from: T(12_000), to: T(14_000) };
  const r = analyze({ emitted: [], service: [metrics(5000, 40, 0), metrics(10_000, 900, 2), metrics(15_000, 10, 1)], main: [], restart, loadEnd: T(0) });
  assert.deepEqual([r.queueAgeMs.n, r.queueAgeMs.max, r.deltaResyncs], [3, 900, 3], 'the counter restarts with the service: 2, then 1 more');
  assert.equal(r.drainMs, 0, 'no events: nothing to drain');
  const same = analyze({ emitted: [], service: [metrics(10_000, 0, 2), metrics(15_000, 0, 2)], main: [], restart, loadEnd: T(0) });
  assert.equal(same.deltaResyncs, 4, 'review L1: a restarted counter that reaches the old value still adds');
  const none = analyze({ emitted: [], service: [metrics(5000, 0, 1), metrics(10_000, 0, 3)], main: [], restart: null, loadEnd: T(0) });
  assert.equal(none.deltaResyncs, 3);
});

test('review L4: a commit carrying many ids joins each; an id committed twice uses its first commit at or after the emit', () => {
  const r = analyze({
    emitted: [file('a', 0), file('b', 0), file('c', 100)],
    service: [commit(50, 'a', 'b', 'c'), delta(60, 1, 'a', 'b'), commit(150, 'c'), delta(160, 2, 'c')],
    main: [paint(70, 1), paint(170, 2)],
    restart: null, loadEnd: T(100),
  });
  assert.deepEqual([r.m2.steady.n, r.m2.steady.max, r.unpainted.steady], [3, 70, 0], 'c (emitted at 100) joins its commit at 150, not the earlier one');
});

test('P4-T12b: events in a fault window (disk full) are kept apart like the restart window; resyncs still split at the kill', () => {
  const r = analyze({
    emitted: [file('s', 0), file('full', 1000), hook(null, 1100), file('s2', 3000)],
    service: [commit(50, 's'), delta(60, 1, 's'), commit(2500, 'full'), delta(2510, 2, 'full'), commit(3050, 's2'), delta(3060, 3, 's2')],
    main: [paint(70, 1), paint(2600, 2), paint(3100, 3)],
    restart: null, faults: [{ from: T(900), to: T(2800) }], loadEnd: T(3000),
  });
  assert.deepEqual([r.m2.steady.n, r.m2.steady.max], [2, 100], 'the 1.6 s disk-full wait is not a steady sample');
  assert.deepEqual([r.m2.restartWindow.n, r.m1.restartWindow.n, r.unpainted.restart], [1, 1, 1], 'a hook lost while full is a fault-window miss');
  assert.equal(r.drainMs, 100);
});

test('Gate 5 disk-full: a hook resolves to its own stored delivery by (session, event, tool_use_id), never a later one', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY, agent TEXT, native_session_id TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY, session_id INTEGER, source TEXT, native_id TEXT, raw TEXT, UNIQUE (session_id, source, native_id))`);
  db.exec("INSERT INTO sessions VALUES (1, 'claude', 's1'), (2, 'claude', 's2')");
  const put = db.prepare("INSERT INTO events (session_id, source, native_id, raw) VALUES (?, 'hook', ?, ?)");
  const raw = (event: string, tool: string) => JSON.stringify({ event, payload: { tool_use_id: tool } });
  // t0 was rejected while the disk was full (no row); ten later PreToolUse hooks of s1 are stored, past the old LIMIT 8
  for (let i = 1; i <= 10; i++) put.run(1, `d${i}`, raw('PreToolUse', `t${i}`));
  put.run(1, 'post1', raw('PostToolUse', 't1'));
  put.run(2, 'other', raw('PreToolUse', 't0'));
  const find = hookLookup(db);
  assert.equal(find('claude', 's1', 'PreToolUse', 't0'), null, 'a rejected hook never borrows a later delivery');
  assert.equal(find('claude', 's1', 'PreToolUse', 't10'), 'd10', 'found beyond eight earlier rows');
  assert.equal(find('claude', 's1', 'PostToolUse', 't1'), 'post1');
  assert.equal(find('claude', 's2', 'PreToolUse', 't0'), 'other', 'scoped to the session');
  put.run(1, 'dup', raw('PreToolUse', 't3'));
  assert.throws(() => find('claude', 's1', 'PreToolUse', 't3'), /2 deliveries/, 'an ambiguous key is an error, not a guess');
});

test('Gate 5 disk-full: M1 is emit -> own paint even when the forwarder gave up first; M2 reports its hops', () => {
  const r = analyze({
    emitted: [hook('late', 0, 100), file('f1', 10)],
    service: [commit(150, 'late'), delta(200, 1, 'late'), commit(60, 'f1'), delta(80, 2, 'f1')],
    main: [paint(220, 1), paint(110, 2)],
    restart: null, loadEnd: T(20),
  });
  assert.equal(r.m1.steady.max, 220, 'delivered live after the 100 ms deadline: a 220 ms sample, not a miss');
  assert.deepEqual(r.hops.m2, { toCommit: 50, commitToDelta: 20, deltaToPaint: 30 });
});

test('G4f-2: a full TP run emits 13,500 events; a run under 95 % of the profile does not qualify', async () => {
  const { expectedEvents, loadQualifies } = await import('../perf/t2-analysis.ts');
  const TP = { rate: 20, burstRate: 50, burstEverySec: 60, burstSec: 5, seconds: 600 };
  assert.equal(expectedEvents(TP), 13_500);
  assert.equal(expectedEvents({ rate: 200, burstRate: 200, burstEverySec: 0, burstSec: 0, seconds: 600 }), 120_000);
  assert.equal(loadQualifies(13_325, TP), true); // the P4-T11 run (98.7 %)
  assert.equal(loadQualifies(6_750, TP), false);
});

test('G4f-3: the tee check compares bytes and exit code, not lengths', async () => {
  const { teeMatches } = await import('../perf/t2-usage.ts');
  const b = (s: string) => Buffer.from(s);
  assert.equal(teeMatches({ out: b('synthetic status ok'), err: b(''), code: 0 }, { out: b('synthetic status ok'), code: 0 }), true);
  assert.equal(teeMatches({ out: b('synthetic status no'), err: b(''), code: 0 }, { out: b('synthetic status ok'), code: 0 }), false);
  assert.equal(teeMatches({ out: b('x'), err: b('e'), code: 0 }, { out: b('x'), code: 0 }), false);
  assert.equal(teeMatches({ out: b('x'), err: b(''), code: 1 }, { out: b('x'), code: 0 }), false);
});
