// XAIBO-PROD-304 (P3-T04, EC-44, Q3-15 fault injection only): a full disk rolls the batch back (checkpoints held, no
// partial rows, the SQLITE_FULL error kept), the writer reports disk full until a commit succeeds, hook deliveries are
// rejected 'disk-full' (the forwarder spools or fails silently) and recorded as an exact hook-only gap once the store
// accepts writes again; file ingest resumes from its unchanged checkpoints; integrity_check stays ok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { createIntake } from '../../src/service/receivers/intake.ts';
import { commitBatch, Writer, type Batch } from '../../src/service/store/writer.ts';
import { claudeProfile, count, until } from '../helpers/claude-profile.ts';
import { envelope, hookStore, SESSION, T0 } from '../helpers/hook-store.ts';

const integrity = (db: import('node:sqlite').DatabaseSync) => Object.values(db.prepare('PRAGMA integrity_check').get() ?? {})[0];
const bigBatch = (dir: string): Batch => ({
  profileId: 'p1', agent: 'claude', fileSession: 'big',
  file: { path: join(dir, 'big.jsonl'), kind: 'transcript', dev: 1, ino: 1, size: 9, mtime: T0, offset: 9, headHash: 'h', status: 'ok' },
  sessions: [{ nativeSessionId: 'big' }],
  events: [{ nativeSessionId: 'big', source: 'transcript', confidence: 'confirmed', nativeId: 'n1', kind: 'message', sourceSeq: 0, receivedTs: T0, content: 'x'.repeat(300_000) }],
});

test('a real SQLITE_FULL rolls the whole batch back and is rethrown as SQLITE_FULL; the writer reports it until a commit succeeds', async () => {
  const h = await hookStore();
  const seen: boolean[] = [];
  const writer = new Writer(h.db, { onDiskFull: (f) => seen.push(f) });
  h.db.exec(`PRAGMA max_page_count = ${count(h.db, 'PRAGMA page_count')}`);
  assert.throws(() => commitBatch(h.db, bigBatch(h.dir)), (e: { errcode?: number }) => e.errcode === 13);
  await assert.rejects(writer.enqueue(bigBatch(h.dir), true), (e: { errcode?: number }) => e.errcode === 13);
  assert.equal(writer.diskFull, true);
  assert.equal(count(h.db, 'SELECT count(*) FROM sessions') + count(h.db, 'SELECT count(*) FROM source_files') + count(h.db, 'SELECT count(*) FROM events'), 0);
  h.db.exec('PRAGMA max_page_count = 1073741823');
  await writer.enqueue(bigBatch(h.dir), true);
  assert.equal(writer.diskFull, false);
  assert.deepEqual(seen, [true, false]);
  assert.equal(count(h.db, 'SELECT offset FROM source_files'), 9);
  assert.equal(integrity(h.db), 'ok');
});

test('EC-44: while full, ingest holds checkpoints and hooks are rejected; on recovery ingest resumes and the hook-only gap is exact', async () => {
  const p = await claudeProfile(['usage-basic']);
  let full = true;
  const seen: boolean[] = [];
  const diskFull = () => Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
  const writer = new Writer(p.db, {
    commit: (db, b) => { if (full) throw diskFull(); commitBatch(db, b); },
    onDiskFull: (f) => { seen.push(f); if (!f) intake.recovered(); },
  });
  const intake = createIntake({ db: p.db, writer, now: () => T0 + 50 });
  const adapter = new ClaudeAdapter({ db: p.db, writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  try {
    await adapter.start();
    assert.equal(writer.diskFull, true);
    assert.equal(count(p.db, 'SELECT count(*) FROM source_files'), 0, 'no checkpoint advanced');
    assert.equal(count(p.db, 'SELECT count(*) FROM events'), 0);
    for (const ts of [T0 + 1, T0 + 2]) assert.deepEqual(await intake.deliver(envelope({ received_ts: ts })), { status: 'rejected', code: 'disk-full' });
    assert.deepEqual(await intake.deliver(envelope({ received_ts: T0 + 3, session_id: null, payload: null, malformed: true })), { status: 'rejected', code: 'disk-full' });
    assert.equal(count(p.db, 'SELECT count(*) FROM hook_delivery'), 0);

    full = false;
    await adapter.wake();
    await until(() => count(p.db, "SELECT count(*) FROM events WHERE source = 'transcript'") > 0, 5_000);
    assert.equal(writer.diskFull, false);
    assert.deepEqual(seen, [true, false]);
    const gaps = p.db.prepare("SELECT agent, native_session_id AS session, from_ts AS 'from', to_ts AS 'to', count FROM hook_gaps WHERE reason = 'disk-full' ORDER BY session, from_ts")
      .all().map((r) => ({ ...(r as object) }));
    assert.deepEqual(gaps, [ // one row per rejected delivery (G3b-2)
      { agent: 'claude', session: null, from: T0 + 3, to: T0 + 3, count: 1 },
      { agent: 'claude', session: SESSION, from: T0 + 1, to: T0 + 1, count: 1 },
      { agent: 'claude', session: SESSION, from: T0 + 2, to: T0 + 2, count: 1 },
    ]);
    assert.equal((await intake.deliver(envelope())).status, 'accepted');
    assert.equal(count(p.db, "SELECT count(*) FROM hook_gaps WHERE reason = 'disk-full'"), 3, 'recorded once');
    assert.equal(count(p.db, "SELECT sum(count) FROM hook_gaps WHERE reason = 'disk-full'"), 3, 'the banner total is unchanged');
    assert.ok(count(p.db, 'SELECT max(offset) FROM source_files') > 0, 'ingest resumed from its checkpoint');
    assert.equal(integrity(p.db), 'ok');
  } finally { adapter.stop(); }
});

test('G3b-2 (EC-44): disk-full gaps dedup by delivery_id and a later accepted delivery leaves the gap', async () => {
  let full = true;
  const diskFull = () => Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
  const h = await hookStore({ writer: { commit: (db, b) => { if (full) throw diskFull(); commitBatch(db, b); } } });
  const a = envelope({ received_ts: T0 + 1 });
  const b = envelope({ received_ts: T0 + 2 });
  for (const e of [a, a, b]) assert.deepEqual(await h.intake.deliver(e), { status: 'rejected', code: 'disk-full' });
  full = false;
  h.intake.recovered();
  assert.equal(count(h.db, "SELECT sum(count) FROM hook_gaps WHERE reason = 'disk-full'"), 2, 'A rejected twice counts once');
  assert.deepEqual(await h.intake.deliver(a), { status: 'accepted', code: 'ok' });
  assert.equal(count(h.db, "SELECT sum(count) FROM hook_gaps WHERE reason = 'disk-full'"), 1, 'only B is still missing');
});

test('G3b-2 residual: a delivery that is already stored clears its disk-full gap on the duplicate path', async () => {
  // The commit lands but reports SQLITE_FULL (e.g. full at the checkpoint): the delivery is stored and also counted missing.
  let failAfterCommit = true;
  const diskFull = () => Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
  const h = await hookStore({ writer: { commit: (db, b) => { commitBatch(db, b); if (failAfterCommit) throw diskFull(); } } });
  const a = envelope({ received_ts: T0 + 1 });
  const b = envelope({ received_ts: T0 + 2 });
  for (const e of [a, b]) assert.deepEqual(await h.intake.deliver(e), { status: 'rejected', code: 'disk-full' });
  failAfterCommit = false;
  h.intake.recovered(); // both gaps written
  assert.deepEqual(await h.intake.deliver(a), { status: 'accepted', code: 'duplicate' });
  assert.equal(count(h.db, `SELECT count(*) FROM hook_gaps WHERE locator = 'disk-full:${a.delivery_id}'`), 0, 'a written gap is dropped');
  const c = envelope({ received_ts: T0 + 3 });
  failAfterCommit = true;
  assert.deepEqual(await h.intake.deliver(c), { status: 'rejected', code: 'disk-full' });
  failAfterCommit = false;
  assert.deepEqual(await h.intake.deliver(c), { status: 'accepted', code: 'duplicate' });
  h.intake.recovered();
  assert.equal(count(h.db, `SELECT count(*) FROM hook_gaps WHERE locator = 'disk-full:${c.delivery_id}'`), 0, 'a held gap is dropped');
  assert.equal(count(h.db, "SELECT sum(count) FROM hook_gaps WHERE reason = 'disk-full'"), 1, 'only B stays counted');
});

test('G3b-2 (fix re-review 2): a stored delivery\'s leftover disk-full gap is reconciled when an intake starts', async () => {
  const h = await hookStore();
  const a = envelope({ received_ts: T0 + 1 });
  assert.deepEqual(await h.intake.deliver(a), { status: 'accepted', code: 'ok' });
  // Both deletes failed earlier (on accept and on a duplicate retry): the stored delivery is still counted missing.
  const put = h.db.prepare(`INSERT INTO hook_gaps (reason, agent, native_session_id, from_ts, to_ts, count, locator, recorded_at)
    VALUES ('disk-full', 'claude', ?, ?, ?, 1, ?, ?)`);
  put.run(SESSION, T0 + 1, T0 + 1, `disk-full:${a.delivery_id}`, T0 + 5);
  put.run(SESSION, T0 + 2, T0 + 2, 'disk-full:00000000-0000-4000-8000-00000000b002', T0 + 5); // never stored
  put.run(SESSION, T0 + 3, T0 + 3, 'disk-full:overflow:00000000-0000-4000-8000-00000000b003', T0 + 5);
  createIntake({ db: h.db, writer: h.writer });
  assert.equal(count(h.db, `SELECT count(*) FROM hook_gaps WHERE locator = 'disk-full:${a.delivery_id}'`), 0, 'the stored delivery is no longer missing');
  assert.equal(count(h.db, "SELECT sum(count) FROM hook_gaps WHERE reason = 'disk-full'"), 2, 'an unstored delivery and the overflow bucket stay');
});
