// XAIBO-PROD-522 (P5-T15; S-10, US-6, PRD §5.11, design Storage row, Q-5.6): the storage meter runs in a worker thread with
// its own read-only connection and is cached. File-level totals (database, WAL, content chunks, spool, backups) do not
// overlap and add up to the total; DBSTAT (S1: compiled in) breaks the database down into content, search, usage,
// prices, other and free, never added on top. Seeded sizes are measured; the meter falls after a purge plus
// incremental_vacuum. Symlinks are neither followed nor counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { purgeSession } from '../../src/service/history/purge.ts';
import { openStore } from '../../src/service/store/db.ts';
import { ftsPrefix, Writer } from '../../src/service/store/writer.ts';
import { categoryOf, StorageMeter, type StorageCategory } from '../../src/service/storage/meter.ts';

const T = 1_700_000_000_000;
const SECRET = Buffer.alloc(32, 7);
const sid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

async function dataDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'xmeter-')));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  const sessions: number[] = [];
  let seq = 0;
  const text = 'synthetic transcript text '.repeat(4000); // ~100 KiB per event
  for (let s = 1; s <= 4; s++) {
    const id = Number(db.prepare('INSERT INTO sessions (agent, profile_id, native_session_id, last_activity) VALUES (?, ?, ?, ?)').run('claude', 'p1', sid(s), T + s).lastInsertRowid);
    sessions.push(id);
    for (let k = 0; k < 10; k++) {
      const e = Number(db.prepare(`INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, role, source_seq, received_ts, content)
        VALUES (?, 1, 'transcript', 'observed', ?, 'user', 'user', ?, ?, ?)`).run(id, `n${++seq}`, seq, T, `${k} ${text}`).lastInsertRowid);
      db.prepare('INSERT INTO event_fts (rowid, content) VALUES (?, ?)').run(e, ftsPrefix(`${k} ${text}`));
    }
  }
  const sized = (sub: string, files: [string, number][]) => { mkdirSync(join(dir, sub), { recursive: true }); for (const [f, n] of files) { mkdirSync(join(dir, sub, f, '..'), { recursive: true }); writeFileSync(join(dir, sub, f), Buffer.alloc(n, 1)); } };
  sized('content-chunks', [['a/1.bin', 10_000], ['a/2.bin', 5_000], ['b/3.bin', 1]]);
  sized('spool', [['seed.bin', 7_777]]);
  sized('backups', [['seed.bak', 123_456]]);
  const outside = join(dir, '..', `${dir.split('/').pop()}-outside`);
  mkdirSync(outside);
  writeFileSync(join(outside, 'big.bin'), Buffer.alloc(1_000_000, 1));
  symlinkSync(outside, join(dir, 'spool', 'link-dir')); // never followed
  symlinkSync(join(outside, 'big.bin'), join(dir, 'backups', 'link-file')); // never counted
  return { dir, db, writer: new Writer(db), sessions, contentBytes: 40 * text.length };
}

test('seeded sizes: file totals exact and non-overlapping; DBSTAT categories account for the database; symlinks ignored', async () => {
  const d = await dataDir();
  const m = new StorageMeter(d.dir);
  assert.equal(m.latest(), null, 'nothing is computed until a refresh');
  const r = await m.refresh();
  assert.deepEqual(m.latest(), r, 'cached');
  assert.equal(r.files.database, statSync(join(d.dir, 'xaibo.db')).size);
  let wal = 0; try { wal = statSync(join(d.dir, 'xaibo.db-wal')).size; } catch { /* none */ }
  assert.equal(r.files.wal, wal);
  assert.equal(r.files.contentChunks, 15_001);
  assert.equal(r.files.spool, 7_777, 'a symlinked directory is not followed');
  assert.equal(r.files.backups, 123_456, 'a symlinked file is not counted');
  assert.equal(r.total, r.files.database! + r.files.wal! + 15_001 + 7_777 + 123_456, 'total = the file-level parts');
  const db = r.database!;
  assert.ok(db, 'DBSTAT breakdown available (S1)');
  const pageBytes = Number((d.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count) * Number((d.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size);
  assert.equal(db.bytes, pageBytes, 'database bytes = page_count x page_size');
  const sum = Object.values(db.categories).reduce((a, b) => a + b, 0);
  assert.ok(sum <= db.bytes && sum >= db.bytes * 0.97, `categories + free account for the database (${sum} of ${db.bytes})`);
  assert.ok(db.categories.content >= d.contentBytes && db.categories.content <= d.contentBytes * 1.5, `content within tolerance (${db.categories.content} for ${d.contentBytes})`);
  assert.ok(db.categories.search > 0 && db.categories.search < db.categories.content, 'search index measured apart');
  for (const k of ['usage', 'prices', 'other', 'free'] as const) assert.ok(Number.isSafeInteger(db.categories[k]) && db.categories[k] >= 0, k);
  assert.ok(r.measuredAt > 0);
});

test('the meter falls after purge plus incremental_vacuum; refreshes share one worker run and run off the main thread', async () => {
  const d = await dataDir();
  const m = new StorageMeter(d.dir);
  let done = false, tickDuring = false;
  const a = m.refresh(), b = m.refresh();
  assert.equal(a, b, 'a refresh in flight is shared');
  void a.then(() => { done = true; });
  setTimeout(() => { tickDuring = !done; }, 0);
  const before = await a;
  assert.ok(isMainThread && tickDuring, 'the main thread keeps running while the worker measures');
  for (const s of d.sessions) purgeSession(d.writer, s, { dataDir: d.dir, backupDir: join(d.dir, 'backups'), secret: SECRET, now: T, reason: 'manual' });
  const after = await m.refresh();
  assert.ok(after.database!.categories.content < before.database!.categories.content / 4, 'content falls');
  assert.ok(after.database!.bytes < before.database!.bytes / 2, 'database bytes fall (incremental_vacuum gave the pages back)');
  d.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const settled = await m.refresh();
  assert.ok(settled.total! < before.total!, 'the total falls once the WAL is checkpointed');
});

test('review L3: every table in the schema maps to its intended category (a new table must be classified)', async () => {
  const d = await dataDir();
  const expected: Record<string, StorageCategory> = {
    sessions: 'content', events: 'content', turns: 'content', tool_calls: 'content', subagents: 'content', session_links: 'content', cwd_history: 'content',
    source_files: 'content', quarantine: 'content', report_content: 'content', status_evidence: 'content', hook_gaps: 'content',
    event_fts: 'search', event_fts_config: 'search', event_fts_data: 'search', event_fts_docsize: 'search', event_fts_idx: 'search',
    usage: 'usage', usage_history: 'usage', usage_scopes: 'usage', usage_snapshots: 'usage', context_snapshots: 'usage', cost_estimates: 'usage',
    monthly_quota_peaks: 'usage', monthly_sessions: 'usage', monthly_usage: 'usage', settled_contributions: 'usage',
    price_revisions: 'prices',
    profiles: 'other', kv: 'other', overlays: 'other', projects: 'other', folders: 'other', suppressions: 'other', hook_delivery: 'other',
    report_delivery: 'other', report_rejects: 'other', schema_migrations: 'other', sqlite_sequence: 'other', sqlite_stat1: 'other',
  };
  const tables = (d.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  for (const t of tables) {
    assert.ok(t in expected, `table ${t} has an intended category in this test`);
    assert.equal(categoryOf(t), expected[t], t);
  }
});

test('review L2: a symlinked root directory is not followed', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'xmeter-root-')));
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'xmeter-elsewhere-')));
  writeFileSync(join(elsewhere, 'big.bin'), Buffer.alloc(50_000, 1));
  symlinkSync(elsewhere, join(dir, 'spool'));
  assert.equal((await new StorageMeter(dir).refresh()).files.spool, 0);
});

test('missing directories read 0; a missing database is unavailable, never zero', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'xmeter-empty-')));
  const r = await new StorageMeter(dir).refresh();
  assert.equal(r.files.contentChunks, 0);
  assert.equal(r.files.spool, 0);
  assert.equal(r.files.backups, 0);
  assert.equal(r.files.database, null, 'no database file: unavailable');
  assert.equal(r.total, null, 'no synthetic total from a partial measurement');
  assert.equal(r.database, null);
});
