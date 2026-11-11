// XAIBO-PROD-105 (P1-T07): schema, pragmas, file modes, atomic batch + checkpoint, FTS, writer scheduling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadMigrations, openStore, schemaSnapshot } from '../../src/service/store/db.ts';
import { commitBatch, Writer, type Batch } from '../../src/service/store/writer.ts';

const SCHEMA = new URL('../../src/service/store/schema.sql', import.meta.url);
const temp = () => mkdtempSync(join(tmpdir(), 'xstore-'));
const one = (db: DatabaseSync, sql: string, ...p: (string | number)[]) => Object.values(db.prepare(sql).get(...p) ?? {})[0];

async function fresh() {
  const dir = temp();
  const store = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'backups') });
  store.db.prepare("INSERT INTO profiles(id, agent, root, origin) VALUES ('p1', 'claude', '~/.claude', 'default')").run();
  return { dir, ...store };
}

function batch(n: number, offset: number, extra: Partial<Batch> = {}): Batch {
  return {
    profileId: 'p1', agent: 'claude',
    file: { path: '/tmp/xaibo-fixture/a.jsonl', kind: 'transcript', dev: 1, ino: 2, size: offset, mtime: 0, offset, headHash: 'h', status: 'ok' },
    sessions: [{ nativeSessionId: '00000000-0000-4000-8000-000000000001', cwd: '/tmp/xaibo-fixture/alpha', lastActivity: 1000 + n }],
    events: Array.from({ length: n }, (_, i) => ({
      nativeSessionId: '00000000-0000-4000-8000-000000000001', source: 'transcript', confidence: 'confirmed', nativeId: `e${offset}-${i}`,
      kind: 'message', role: 'user', sourceSeq: offset * 1000 + i, byteOffset: i, receivedTs: 1, content: `gamma ray ${i}`, raw: '{}',
    })),
    ...extra,
  };
}

test('fresh DB applies 001 and matches schema.sql', async () => {
  const { db } = await fresh();
  assert.equal(one(db, 'PRAGMA user_version'), loadMigrations().at(-1)!.version);
  const snap = schemaSnapshot(db);
  if (process.env.UPDATE_SCHEMA === '1') writeFileSync(SCHEMA, snap);
  assert.equal(snap, readFileSync(SCHEMA, 'utf8'), 'schema.sql is stale: rerun with UPDATE_SCHEMA=1');
});

test('pragmas and 0600 files', async () => {
  const { dir, db, readOnly } = await fresh();
  assert.equal(readOnly, false);
  assert.deepEqual(
    ['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout', 'auto_vacuum', 'temp_store'].map((p) => one(db, `PRAGMA ${p}`)),
    ['wal', 1, 1, 5000, 2, 2]);
  commitBatch(db, batch(3, 10));
  for (const f of ['xaibo.db', 'xaibo.db-wal', 'xaibo.db-shm']) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
});

test('batch and checkpoint commit atomically; reparse dedups', async () => {
  const { db } = await fresh();
  commitBatch(db, batch(3, 10));
  assert.equal(one(db, 'SELECT count(*) FROM events'), 3);
  assert.equal(one(db, 'SELECT offset FROM source_files'), 10);
  const bad = batch(3, 20);
  bad.events.push({ ...bad.events[0]!, nativeSessionId: 'not-in-batch', nativeId: 'x' }); // fails after rows
  assert.throws(() => commitBatch(db, bad));
  assert.equal(one(db, 'SELECT count(*) FROM events'), 3, 'no rows from the failed batch');
  assert.equal(one(db, 'SELECT offset FROM source_files'), 10, 'checkpoint not advanced');
  commitBatch(db, batch(3, 10)); // same records again (reparse from 0)
  assert.equal(one(db, 'SELECT count(*) FROM events'), 3);
  assert.equal(one(db, 'SELECT record_count FROM sessions'), 3);
});

test('FTS5 MATCH finds indexed text', async () => {
  const { db } = await fresh();
  commitBatch(db, batch(2, 10));
  assert.equal(one(db, "SELECT count(*) FROM event_fts WHERE event_fts MATCH 'gamma'"), 2);
});

test('writer: live batches before backfill; row bound and timer flush', async () => {
  const { db } = await fresh();
  const order: string[] = [];
  const timers: (() => void)[] = [];
  const w = new Writer(db, { maxRows: 5, maxBytes: 1 << 20, setTimer: (fn) => timers.push(fn), onCommit: (b) => order.push(b.file.path) });
  const back = w.enqueue({ ...batch(2, 10), file: { ...batch(2, 10).file, path: '/tmp/xaibo-fixture/back.jsonl' } }, false);
  const live = w.enqueue({ ...batch(1, 10), file: { ...batch(1, 10).file, path: '/tmp/xaibo-fixture/live.jsonl' } }, true);
  assert.equal(order.length, 0, 'below bounds: waits for the timer');
  timers.shift()!();
  await Promise.all([back, live]);
  assert.deepEqual(order, ['/tmp/xaibo-fixture/live.jsonl', '/tmp/xaibo-fixture/back.jsonl']);
  await w.enqueue({ ...batch(6, 30), file: { ...batch(6, 30).file, path: '/tmp/xaibo-fixture/big.jsonl' } }, false); // over maxRows: immediate
  assert.equal(order.at(-1), '/tmp/xaibo-fixture/big.jsonl');
});
