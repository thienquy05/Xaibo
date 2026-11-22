// XAIBO-PROD-550 (Phase 6 cleanup unit, service run; D-P5-15): the Gate 5 /ponytail-review simplifications in
// src/service and src/shared. Shared helpers keep the replaced code's results; removed test-only exports and local
// copies stay gone (source scans, as cleanup-shared.test.ts).
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hasTable, pageSize, PAGE_DEFAULT, PAGE_MAX } from '../../src/service/api.ts';
import { needsOverlay } from '../../src/service/history/overlay.ts';
import * as trash from '../../src/service/history/trash.ts';
import * as tools from '../../src/service/history/tools.ts';
import { retentionOf, setRetention } from '../../src/service/retention/policy.ts';
import * as query from '../../src/service/search/query.ts';
import { rollback } from '../../src/service/store/db.ts';
import * as writer from '../../src/service/store/writer.ts';
import { contributions, quotaContributions, sessionContributions } from '../../src/service/usage/monthly.ts';
import { settle, settleContributions } from '../../src/service/usage/settle.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { runWorker } from '../../src/service/worker.ts';
import { monthlyStore, request, sample, scope, SECRET, session, turn, tx } from '../helpers/monthly.ts';

const SRC = join(import.meta.dirname, '..', '..', 'src');
const src = (f: string) => readFileSync(join(SRC, f), 'utf8');
const worker = (body: string) => new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort, workerData } from 'node:worker_threads'; ${body}`)}`);
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: Error) => e.message);

test('item 4: runWorker resolves the ok message; store, timeout, error and exit-N reject with fixed codes', async () => {
  assert.deepEqual(await runWorker<{ ok: true; n: number }>(worker('parentPort.postMessage({ ok: true, n: workerData.n });'), { n: 7 }, 5_000), { ok: true, n: 7 });
  assert.equal(await code(runWorker(worker('parentPort.postMessage({ ok: false });'), null, 5_000)), 'store');
  assert.equal(await code(runWorker(worker('setInterval(() => {}, 1000);'), null, 100)), 'timeout');
  assert.equal(await code(runWorker(worker('throw new Error("boom");'), null, 5_000)), 'error');
  assert.equal(await code(runWorker(worker('process.exit(3);'), null, 5_000)), 'exit-3');
});

test('items 4, 16: ledger.ts and clear.ts spawn through runWorker; the four contribution loops use contributions()', () => {
  for (const f of ['service/usage/ledger.ts', 'service/usage/clear.ts']) assert.doesNotMatch(src(f), /new Worker\(/, f);
  for (const f of ['service/usage/settle.ts', 'service/usage/availability.ts', 'service/usage/monthly.ts', 'service/usage/clear.ts']) {
    assert.doesNotMatch(src(f), /for \(const gen of \[/, f);
  }
});

test('item 16: contributions() yields the session then the quota contributions', async () => {
  const db = await monthlyStore();
  const nov = Date.UTC(2026, 10, 10, 12);
  const a = session(db, { sid: 'sid-a', last: nov });
  turn(db, a, 'a1', nov, 'claude-x');
  request(db, a, { identity: 'a-r1', ts: nov, model: 'claude-x', input: 10, output: 3 });
  sample(db, scope(db, 'scope-a', true), { percent: 40, at: nov });
  const all = [...contributions(db, SECRET, { sessions: null, quota: null })];
  assert.ok(all.length >= 3, 'fixture: session, request and quota contributions');
  assert.deepEqual(all, [...sessionContributions(db, SECRET, null), ...quotaContributions(db, SECRET, null)]);
});

test('item 5: test-only trashExpired and expiredTrash are gone; the Trash timer stays', () => {
  assert.equal('trashExpired' in trash, false);
  assert.equal('expiredTrash' in trash, false);
  assert.equal(trash.trashPurgeAt(0), trash.TRASH_MS);
});

// Design review L1: saveRetention checks the IPC shape once before the transaction (an invalid value never opens one,
// so it cannot signal a disk recovery); setRetention stores the typed RetentionSetting without a second parser.
test('item 8: one RetentionSetting; saveRetention refuses anything but {days} or never; setRetention stores the setting', async () => {
  const db = await monthlyStore();
  const w = new Writer(db);
  assert.equal(tools.saveRetention(w, { days: 30 }), 'saved');
  assert.deepEqual(retentionOf(db), { days: 30 });
  assert.equal(tools.saveRetention(w, 'never'), 'saved');
  for (const bad of [30, { days: 0 }, { days: 3651 }, { days: 1.5 }, { days: 30, x: 1 }, 'always', null]) assert.equal(tools.saveRetention(w, bad), 'invalid', JSON.stringify(bad));
  assert.equal(retentionOf(db), 'never', 'a refused value stores nothing');
  setRetention(db, { days: 7 });
  assert.deepEqual(retentionOf(db), { days: 7 });
  assert.doesNotMatch(src('service/retention/policy.ts'), /export type Retention = /, 'policy.ts uses RetentionSetting');
});

test('item 16 (review M3): an empty selection settles nothing; a key repeated in one batch counts once', async () => {
  const db = await monthlyStore();
  const nov = Date.UTC(2026, 10, 10, 12), now = Date.UTC(2026, 11, 20);
  const a = session(db, { sid: 'sid-m3', last: nov });
  turn(db, a, 'm1', nov, 'claude-x');
  request(db, a, { identity: 'm3-r1', ts: nov, model: 'claude-x', input: 1, output: 1 });
  tx(db, () => assert.deepEqual(settle(db, { sessions: [], quota: [] }, SECRET, now), { added: 0, skipped: 0 }, '[] is none, never all'));
  const one = [...sessionContributions(db, SECRET, [a])];
  assert.ok(one.length >= 2, 'fixture');
  tx(db, () => assert.deepEqual(settleContributions(db, [...one, ...one], now), { added: one.length, skipped: one.length }));
});

test('item 10: purgeLimit allows 10 manual purges per 60 s (monotonic), never a time from the future', () => {
  assert.equal('PurgeLimit' in tools, false);
  let t = 1_000_000;
  const take = tools.purgeLimit(() => t);
  for (let i = 0; i < 10; i++) assert.equal(take(), true, `purge ${i + 1}`);
  assert.equal(take(), false, 'the 11th within the window');
  t += 59_999;
  assert.equal(take(), false);
  t += 1;
  assert.equal(take(), true, 'the window has passed');
});

test('item 12: pageSize, hasTable and needsOverlay', async () => {
  assert.equal(pageSize(5), 5);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) assert.equal(pageSize(bad), PAGE_DEFAULT, String(bad));
  assert.equal(pageSize(PAGE_MAX + 1), PAGE_MAX);
  const db = await monthlyStore();
  assert.equal(hasTable(db, 'kv'), true);
  assert.equal(hasTable(db, 'no_such_table'), false);
  const all = { mode: 'all', agent: null, project: null, folder: null } as const;
  assert.equal(needsOverlay(all), false);
  assert.equal(needsOverlay({ ...all, agent: 'claude' }), false, 'the agent filter needs no overlay table');
  for (const f of [{ ...all, mode: 'archived' as const }, { ...all, mode: 'trash' as const }, { ...all, project: 1 }, { ...all, folder: 2 },
    { ...all, group: { kind: 'repo', key: 'k' } as never }]) assert.equal(needsOverlay(f), true, JSON.stringify(f));
  const clamps = ['service/api.ts', 'service/history/overlay.ts', 'service/search/query.ts']
    .map((f) => (src(f).match(/Number\.isSafeInteger\(limit\) && limit > 0 \? limit : PAGE_DEFAULT/g) ?? []).length);
  assert.deepEqual(clamps, [1, 0, 0], 'one page clamp: pageSize in api.ts');
  for (const f of ['service/api.ts', 'service/history/overlay.ts']) assert.doesNotMatch(src(f), /name = 'overlays'/, `${f}: one table check`);
});

test('item 14: search/query.ts takes the IPC bounds; test-only strings gone; the UI states the 64 KiB index bound', () => {
  for (const k of ['QUERY_MAX_CHARS', 'SNIPPET_MAX', 'SEARCH_COVERAGE', 'SEARCH_ITEM_LIMIT']) assert.equal(k in query, false, k);
  assert.doesNotMatch(src('service/search/query.ts'), /export interface SearchKey/);
  assert.equal(writer.FTS_MAX_BYTES, 64 * 1024, 'renderer browse.ts COVERAGE says "the first 64 KiB of each item"');
});

test('item 18: store/db.ts rollback ends an open transaction and swallows a throwing ROLLBACK; writer.ts has no rollback', () => {
  assert.equal('rollback' in writer, false);
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (x)');
  db.exec('BEGIN');
  db.exec('INSERT INTO t VALUES (1)');
  assert.equal(rollback(db), undefined);
  assert.equal(db.isTransaction, false);
  assert.equal((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n, 0);
  rollback(db); // no transaction: nothing to do, no throw
  db.close();
  assert.doesNotThrow(() => rollback(db), 'a closed connection: the caller\'s error stays the one reported');
});

test('items 3, 9, 17 and small cuts: one reply helper, one guard, one log adapter; aliases and local copies gone', () => {
  assert.doesNotMatch(src('service/index.ts'), /catch \{ \/\* (failed|unreadable) \*\/ \}/, 'index.ts: the seven answers share reply()');
  const boot = src('service/boot.ts');
  assert.doesNotMatch(boot, /let result: /, 'boot.ts: purge, reimport and saveRetention share guarded()');
  assert.doesNotMatch(boot, /type (PurgeResult|ReimportOutcome|SaveOutcome) =/, 'boot.ts: the result types come from ipc.ts');
  assert.ok((boot.match(/\(event: string, fields\?: Record<string, string \| number>\) =>/g) ?? []).length <= 1, 'boot.ts: one log adapter');
  assert.doesNotMatch(src('service/history/tools.ts'), /type (Purge|Reimport|Save) =/, 'tools.ts: the result types come from ipc.ts');
  const ipc = src('shared/ipc.ts');
  for (const t of ['PurgeResult', 'ReimportResult', 'SaveRetentionResult']) assert.match(ipc, new RegExp(`export type ${t} = `), t);
  assert.doesNotMatch(src('service/retention/job.ts'), /const LAST_RUN = /);
  assert.doesNotMatch(src('service/storage/meter.ts'), /export type \{[^}]*StorageReport/, 'meter.ts: no unused StorageReport re-export');
  assert.doesNotMatch(src('service/history/native-availability.ts'), /const DAY = /, 'native-availability.ts imports DAY');
});
