// Gate 5 U1 G5-N1 (XAIBO-PROD-542; FR-11, FR-52, EC-21/22): a purge runs in phases so no transaction holds the writer for
// long. (a) one short transaction writes the marker with its purge phase, captures the files and registrations, detaches
// the files, drops quarantine and settles the contributions once; the session is hidden from every reader from then on.
// (b) dependent rows, then events and their FTS rows, go in batches bounded by rows and FTS bytes, each its own writer
// transaction with a yield between, so live writes interleave. (c) a final sweep and the session row clear the phase. A
// stop between batches leaves the phase for resume: the session stays hidden, nothing brings it back, totals do not move.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { answerCost, answerFiles, answerLiveSet, answerMarkers, answerSession, answerSlice, answerSubagents, answerTools, answerTranscript, sessionsByKey, usageScopes } from '../../src/service/api.ts';
import { mapGroups } from '../../src/service/history/map.ts';
import { applyOverlay, listHistory } from '../../src/service/history/overlay.ts';
import { purgeSession, resumePurges } from '../../src/service/history/purge.ts';
import * as purge from '../../src/service/history/purge.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { reimport } from '../../src/service/history/reimport.ts';
import { answerHistoryRow, answerSearch } from '../../src/service/history/tools.ts';
import type { Batch } from '../../src/service/store/writer.ts';
import { priceUsage } from '../../src/service/usage/cost.ts';
import { liveMonthly } from '../../src/service/usage/monthly.ts';
import { loadPrices } from '../../src/service/usage/prices.ts';
import type { HistoryFilter, LiveStatus, OverlayOp } from '../../src/shared/ipc.ts';
import { hookStore, T0 } from '../helpers/hook-store.ts';
import { request, sample, SECRET } from '../helpers/monthly.ts';

const A = '00000000-0000-4000-8000-0000000f5421', B = '00000000-0000-4000-8000-0000000f5422';
const WHO = { agent: 'claude', profile: 'p1', native: A };
/** Test-only bounds: at most 5 rows and 3000 FTS bytes per batch transaction (each event's text is ~1 KB). */
const LIMITS = { rows: 5, ftsBytes: 3000 };
const KEYED = ['events', 'tool_calls', 'usage', 'turns', 'cwd_history'];
const ALL: HistoryFilter = { mode: 'all', agent: null, project: null, folder: null };
const busy: LiveStatus = { lifecycle: 'busy', confidence: 'confirmed', health: 'connected', reason: null, outcome: null, findings: [], since: null };
const n = (db: DatabaseSync, sql: string, ...a: (string | number)[]) => Number((db.prepare(sql).get(...a) as { n: number }).n);
const cp = (path: string) => ({ path, kind: 'transcript', dev: 1, ino: 2, size: 10, mtime: 1, offset: 10, headHash: 'h', status: 'ok' as const });

/** One session larger than the bounds: `count` events of ~1 KB text, each with a turn, a tool call and a request, read from
 *  one native file (f1); plus a second file (f3) attached to the session that holds none of its events. */
async function large(count = 12) {
  const h = await hookStore();
  const now = Date.now();
  const text = 'canary '.repeat(150);
  h.writer.commitLive({ profileId: 'p1', agent: 'claude', file: cp(join(h.dir, 'native', `${A}.jsonl`)), fileSession: A,
    sessions: [{ nativeSessionId: A, cwd: '/tmp/xaibo-fixture/alpha', startedAt: T0, lastActivity: now }],
    events: Array.from({ length: count }, (_, i) => ({ nativeSessionId: A, source: 'transcript', confidence: 'confirmed', nativeId: `big-${i}`, kind: 'message', role: 'user',
      sourceSeq: i + 1, sourceTs: T0 + i, receivedTs: T0 + i, content: `${text}${i}`,
      raw: JSON.stringify({ type: 'user', message: { role: 'user', content: `${text}${i}` } }), turn: { id: `bt-${i}`, edge: 'start' as const },
      model: { id: 'claude-x', turn: `bt-${i}` },
      toolCalls: [{ callId: `bc-${i}`, part: 'args' as const, tool: 'Bash' }] })) });
  const id = n(h.db, 'SELECT id AS n FROM sessions WHERE native_session_id = ?', A);
  for (let i = 0; i < count; i++) request(h.db, id, { identity: `big:${i}`, ts: T0 + i, model: 'claude-x', input: 1, output: 1 });
  h.db.prepare("INSERT INTO source_files (profile_id, session_id, path, kind, size, offset) VALUES ('p1', ?, ?, 'transcript', 1, 1)").run(id, join(h.dir, 'native', 'other.jsonl'));
  // its own (unverified) usage scope with one quota reading
  sample(h.db, Number(h.db.prepare("INSERT INTO usage_scopes (scope_key, profile_id, agent, session_id, verified) VALUES (?, 'p1', 'claude', ?, 0)")
    .run(`session:${A}`, id).lastInsertRowid), { percent: 30, at: T0 });
  const files = (db: DatabaseSync) => (db.prepare('SELECT id FROM source_files ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  const rows = () => KEYED.reduce((t, k) => t + n(h.db, `SELECT count(*) AS n FROM ${k} WHERE session_id = ?`, id), 0);
  const fts = () => n(h.db, "SELECT coalesce(sum(length(content)), 0) AS n FROM events WHERE session_id = ? AND content <> ''", id);
  /** Records each writer transaction's deletions of the session's rows and FTS text; `hook` runs after each one. */
  const txs: { rows: number; fts: number }[] = [];
  let hook: (i: number) => void = () => {};
  const inner = h.writer.transact.bind(h.writer);
  h.writer.transact = <T>(fn: (db: DatabaseSync) => T): T => {
    const r0 = rows(), f0 = fts();
    const r = inner(fn);
    txs.push({ rows: r0 - rows(), fts: f0 - fts() });
    hook(txs.length);
    return r;
  };
  const opts = { dataDir: h.dir, backupDir: join(h.dir, 'backups'), now: now - 60_000 };
  return { ...h, id, rows, txs, files: files(h.db), setHook: (f: (i: number) => void) => { hook = f; }, opts };
}

const other = (k: number): Batch => ({ profileId: 'p1', agent: 'claude', sessions: [{ nativeSessionId: B, startedAt: T0, lastActivity: T0 + k }],
  events: [{ nativeSessionId: B, source: 'transcript', confidence: 'confirmed', nativeId: `live-${k}`, kind: 'user', sourceSeq: k, sourceTs: T0 + k, receivedTs: T0 + k, content: 'live' }] });

test('G5-N1: a session larger than the batch bound is purged in bounded transactions while a live write interleaves', async () => {
  const h = await large();
  const total = h.rows();
  let atLive: number | undefined;
  h.setHook((i) => { if (i === 2) setImmediate(() => { atLive = h.rows(); h.writer.commitLive(other(1)); }); });
  const r = await purgeSession(h.writer, h.id, { ...h.opts, secret: SECRET, reason: 'manual', limits: LIMITS, vacuum: false });
  assert.equal(r.purged, true);
  for (const [i, t] of h.txs.entries()) {
    assert.ok(t.rows <= LIMITS.rows, `transaction ${i} deleted ${t.rows} rows (bound ${LIMITS.rows})`);
    assert.ok(t.fts <= LIMITS.ftsBytes, `transaction ${i} deleted ${t.fts} FTS bytes (bound ${LIMITS.ftsBytes})`);
  }
  assert.ok(h.txs.filter((t) => t.rows > 0).length >= Math.ceil(total / LIMITS.rows), 'one batch per bound');
  // review L (code): a row-bounded step that deleted fewer rows than its bound is done, with no extra empty transaction;
  // 17 = phase (a), the sweep, the two file-work transactions, the twelve steps with nothing to delete, events' last check
  assert.ok(h.txs.filter((t) => t.rows === 0).length <= 17, `empty transactions: ${h.txs.filter((t) => t.rows === 0).length}`);
  assert.ok(atLive !== undefined && atLive > 0, 'a live commit ran between batches, before the purge finished');
  assert.equal(n(h.db, 'SELECT count(*) AS n FROM events WHERE native_id = ?', 'live-1'), 1, 'the live write committed');
  assert.equal(h.rows(), 0);
  assert.equal(n(h.db, 'SELECT count(*) AS n FROM sessions WHERE id = ?', h.id), 0);
  assert.equal(n(h.db, "SELECT count(*) AS n FROM event_fts WHERE event_fts MATCH 'canary'"), 0);
  h.db.exec("INSERT INTO event_fts (event_fts) VALUES ('integrity-check')");
  const m = { ...h.db.prepare('SELECT * FROM suppressions').get() } as Record<string, unknown>;
  assert.deepEqual([m['reason'], m['purge_phase'], m['pending']], ['manual', null, null], 'the phase cleared, the file work done');
});

test('G5-N1: stopped between batches, the session stays hidden and cannot come back; totals hold; boot resume completes it', async () => {
  const h = await large();
  const before = liveMonthly(h.db, SECRET);
  const first = n(h.db, 'SELECT min(id) AS n FROM events WHERE session_id = ?', h.id);
  const slice = () => answerSlice(h.db, { v: 1, type: 'slice', id: 1, session: h.id, event: first, part: 'text', offset: 0 }).text;
  assert.ok(slice().includes('canary'), 'fixture: the slice is served (and cached)');
  assert.ok(answerTools(h.db, { v: 1, type: 'tools', id: 1, session: h.id, cursor: null, limit: 50 }).calls.length > 0, 'fixture: tools listed');
  assert.ok(mapGroups(h.db, null, null, 10).groups.length > 0, 'fixture: a map group');
  assert.ok(answerMarkers(h.db, { v: 1, type: 'markers', id: 1, session: h.id, cursor: null, limit: 50 }).markers.length > 0, 'fixture: model markers');
  assert.ok(usageScopes(h.db, '/tmp/xaibo-fixture').some((u) => u.scope !== null), 'fixture: its quota reading shows in Usage');
  const r = await purgeSession(h.writer, h.id, { ...h.opts, secret: SECRET, reason: 'retention', limits: LIMITS, vacuum: false, stopped: () => h.txs.length >= 3 });
  assert.equal(n(h.db, 'SELECT count(*) AS n FROM sessions WHERE id = ?', h.id), 1, 'the stop leaves the remaining row work for resume');
  assert.ok(h.rows() > 0);
  assert.equal(r.purged, true, 'the purge is committed (phase a): the session is suppressed and hidden');
  const marker = () => ({ ...h.db.prepare('SELECT * FROM suppressions').get() }) as Record<string, unknown>;
  assert.notEqual(marker()['purge_phase'], null, 'the purge phase is persisted');

  // hidden from every reader
  const key = { agent: 'claude', profileId: 'p1', nativeSessionId: A };
  assert.deepEqual(sessionsByKey(h.db, [key], [], [], () => busy), [], 'deltas');
  assert.deepEqual(answerLiveSet(h.db, { v: 1, type: 'liveSet', id: 1 }, Date.now(), [], [], () => busy).rows, [], 'live set');
  for (const mode of ['all', 'trash'] as const) assert.deepEqual(listHistory(h.db, { ...ALL, mode }, null, 100).rows, [], `history ${mode}`);
  assert.equal(answerSession(h.db, { v: 1, type: 'session', id: 1, session: h.id }).detail, null, 'session detail');
  assert.deepEqual(answerTranscript(h.db, { v: 1, type: 'transcript', id: 1, session: h.id, at: 'first', limit: 50 }).items, [], 'transcript');
  assert.deepEqual(answerHistoryRow(h.db, h.id), { row: null }, 'history row');
  assert.deepEqual(answerSearch(h.db, { query: 'canary', filter: ALL, cursor: null, limit: 10 }).hits, [], 'search');
  // review M (code): the session-id readers and the map too; the slice cache never serves it
  assert.equal(slice(), '', 'slice (cached before the purge)');
  const page = { v: 1, id: 1, session: h.id, cursor: null, limit: 50 } as const;
  assert.deepEqual(answerTools(h.db, { ...page, type: 'tools' }).calls, [], 'tools');
  assert.deepEqual(answerFiles(h.db, { ...page, type: 'files' }).touches, [], 'files');
  assert.deepEqual(answerSubagents(h.db, { ...page, type: 'subagents' }).subagents, [], 'subagents');
  assert.deepEqual(answerMarkers(h.db, { v: 1, type: 'markers', id: 1, session: h.id, cursor: null, limit: 50 }).markers, [], 'markers');
  assert.equal(answerCost(h.db, { v: 1, type: 'cost', id: 1, session: h.id }).cost, null, 'cost');
  assert.deepEqual(mapGroups(h.db, null, null, 10).groups, [], 'map');
  assert.ok(!usageScopes(h.db, '/tmp/xaibo-fixture').some((u) => u.scope !== null), 'its own quota reading leaves Usage');
  // overlay operations refuse it; the pricing job skips it
  const ops: OverlayOp[] = [{ kind: 'keep', session: h.id, on: true }, { kind: 'trash', session: h.id, on: true }, { kind: 'pin', session: h.id, on: true },
    { kind: 'archive', session: h.id, on: true }, { kind: 'move', session: h.id, project: null, folder: null }];
  for (const op of ops) assert.equal(applyOverlay(h.db, op, { readOnly: false, now: Date.now() }).ok, false, op.kind);
  assert.equal(n(h.db, 'SELECT count(*) AS n FROM overlays'), 0);
  priceUsage(h.db, loadPrices({ db: h.db, overridePath: join(h.dir, 'models.override.json') }));
  assert.equal(n(h.db, 'SELECT count(*) AS n FROM cost_estimates WHERE session_id = ?', h.id), 0, 'no estimate written for a purging session');

  // nothing brings it back while the phase is set: new native activity (which clears a retention marker), Re-import
  const fresh = Date.now();
  h.writer.commitLive({ profileId: 'p1', agent: 'claude', file: { ...cp(join(h.dir, 'native', `${A}.jsonl`)), mtime: fresh, size: 20, offset: 20 }, fileSession: A,
    sessions: [{ nativeSessionId: A, lastActivity: fresh }],
    events: [{ nativeSessionId: A, source: 'transcript', confidence: 'confirmed', nativeId: 'after-1', kind: 'user', sourceSeq: 99, sourceTs: fresh, fileMtime: fresh, receivedTs: fresh }] });
  assert.equal(n(h.db, "SELECT count(*) AS n FROM events WHERE native_id = 'after-1'"), 0, 'a rescan with new activity is kept out');
  assert.equal(marker()['cleared_at'], null);
  assert.equal(await reimport(h.writer, WHO, { ...h.opts, now: Date.now() + 60_000 }), 'pending', 'Re-import waits for the purge to finish');
  assert.notEqual(marker()['pending'], null, 'owed work is never cleared while the phase is set');
  assert.deepEqual(liveMonthly(h.db, SECRET), before, 'settled once in phase (a): totals unchanged');

  // boot: resume finishes the row phases, then the file work
  assert.equal(await resumePurges(h.writer, { ...h.opts, now: Date.now() + 60_000 }), 1);
  assert.equal(n(h.db, 'SELECT count(*) AS n FROM sessions WHERE id = ?', h.id), 0);
  assert.equal(h.rows(), 0);
  assert.deepEqual([marker()['purge_phase'], marker()['pending']], [null, null]);
  assert.deepEqual(liveMonthly(h.db, SECRET), before);
});

test('G5-N1: a manual purge of a session a retention purge is still deleting upgrades the reason and keeps the first captured files', async () => {
  const h = await large();
  let manual: Promise<unknown> | undefined;
  // right after phase (a): the files are detached, so a second capture would miss the file that holds none of its events
  h.setHook((i) => { if (i === 1) setImmediate(() => { manual = Promise.resolve(purgeSession(h.writer, h.id, { ...h.opts, secret: SECRET, reason: 'manual', limits: LIMITS, vacuum: false })); }); });
  await purgeSession(h.writer, h.id, { ...h.opts, secret: SECRET, reason: 'retention', limits: LIMITS, vacuum: false });
  await new Promise((resolve) => setImmediate(resolve));
  await manual;
  const m = { ...h.db.prepare('SELECT * FROM suppressions').get() } as { reason: string; files: string; purge_phase?: string | null };
  assert.equal(m.reason, 'manual', 'retention -> manual');
  assert.deepEqual((JSON.parse(m.files) as number[]).sort((x, y) => x - y), h.files, 'the files captured by the first phase (a)');
  assert.equal(m.purge_phase, null);
  assert.equal(n(h.db, 'SELECT count(*) AS n FROM sessions WHERE id = ?', h.id), 0);
});

test('review H (code): the event batch query reads an index, with no scan of the events and no sort', async () => {
  assert.equal(typeof purge.EVENT_BATCH, 'string', 'EVENT_BATCH exported');
  const { db } = await openStore({ file: join((await hookStore()).dir, 'plan.db'), backupDir: join((await hookStore()).dir, 'b') });
  const p = (db.prepare(`EXPLAIN QUERY PLAN ${purge.EVENT_BATCH}`).all(1, 500) as { detail: string }[]).map((x) => x.detail).join(' | ');
  assert.match(p, /USING (COVERING )?INDEX/, p);
  assert.doesNotMatch(p, /SCAN events|TEMP B-TREE/, p);
});

test('review M (code): a failing batch is logged with an error code (no content) and keeps the phase for resume', async () => {
  const h = await large();
  const inner = h.writer.transact.bind(h.writer);
  let calls = 0;
  h.writer.transact = <T>(fn: (db: DatabaseSync) => T): T => { if (++calls === 3) throw Object.assign(new Error('boom canary'), { code: 'EFAULT' }); return inner(fn); };
  const logged: [string, Record<string, string | number> | undefined][] = [];
  const r = await purgeSession(h.writer, h.id, { ...h.opts, secret: SECRET, reason: 'manual', limits: LIMITS, vacuum: false, log: (e, f) => { logged.push([e, f]); } });
  assert.deepEqual([r.purged, r.filesPending], [true, true]);
  assert.deepEqual(logged, [['purge_rows_failed', { error: 'EFAULT' }]]);
  assert.equal(({ ...h.db.prepare('SELECT * FROM suppressions').get() } as Record<string, unknown>)['purge_phase'], 'rows');
  h.writer.transact = inner;
  assert.equal(await resumePurges(h.writer, { ...h.opts, now: Date.now() + 60_000 }), 1);
});

test('review L (code): freed pages go back in bounded vacuum steps until none is left', async () => {
  const h = await hookStore();
  h.db.exec('CREATE TABLE pad (x)');
  const put = h.db.prepare('INSERT INTO pad VALUES (?)');
  for (let i = 0; i < 400; i++) put.run(Buffer.alloc(64 * 1024));
  h.db.exec('DROP TABLE pad');
  const free = () => n(h.db, 'SELECT freelist_count AS n FROM pragma_freelist_count');
  assert.ok(free() > 4096, 'fixture: more free pages than one step gives back');
  const w = new Writer(h.db);
  let steps = 0;
  const inner = w.transact.bind(w);
  w.transact = <T>(fn: (db: DatabaseSync) => T): T => { steps++; return inner(fn); };
  await purge.vacuum(w);
  assert.equal(free(), 0);
  assert.ok(steps >= 2 && steps < 100, `steps ${steps}`);
});

test('re-review L: resume after a stop touches no marker (the store closes right after)', async () => {
  const h = await hookStore();
  h.db.prepare("INSERT INTO suppressions (agent, profile_id, native_session_id, reason, at, pending) VALUES ('claude', 'p1', 'owed', 'manual', 1, '[]')").run();
  assert.equal(await resumePurges(h.writer, { dataDir: h.dir, backupDir: join(h.dir, 'backups'), now: Date.now(), stopped: () => true }), 0);
  assert.equal(n(h.db, 'SELECT count(*) AS n FROM suppressions WHERE pending IS NOT NULL'), 1, 'its file work stays owed');
});
