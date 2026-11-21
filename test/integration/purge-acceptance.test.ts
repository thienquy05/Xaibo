// XAIBO-PROD-515 (P5-T07; FR-11, Q-5.1, Q-5.2): purge acceptance. One synthetic session carries a unique canary across
// events (FTS), an attachment, a hook delivery, a complete chunked report item, an interrupted chunk assembly, closed
// spool files, context/cost/usage snapshots, session-linked quota history and a migration backup; a second session is
// untouched. After purge: no logical row holds the canary or the session (FTS MATCH included), no byte of it is left in
// content-chunks, spool or backups (the main DB is excluded: purge is not forensic), the other session is intact, monthly
// totals are unchanged, the native fixture is byte-identical and app data stays 0700/0600. A later rescan or hook of the
// purged session inserts nothing. A purge that fails on SQLITE_FULL keeps the error, writes no marker, removes no file.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backup, type DatabaseSync } from 'node:sqlite';
import { purgeSession, resumePurges } from '../../src/service/history/purge.ts';
import * as purge from '../../src/service/history/purge.ts';
import { openChunks } from '../../src/service/adapters/generic/chunks.ts';
import { loadMigrations, openStore } from '../../src/service/store/db.ts';
import { Writer, type Batch } from '../../src/service/store/writer.ts';
import { createReportIntake } from '../../src/service/receivers/report.ts';
import { addRegistration } from '../../src/service/receivers/registrations.ts';
import { liveMonthly } from '../../src/service/usage/monthly.ts';
import { envelope, hookStore, T0 } from '../helpers/hook-store.ts';
import { request, sample, SECRET, turn } from '../helpers/monthly.ts';

const A = '00000000-0000-4000-8000-0000000f0701', B = '00000000-0000-4000-8000-0000000f0702';
const n = (db: DatabaseSync, sql: string, ...a: (string | number)[]) => (db.prepare(sql).get(...a) as { n: number }).n;

function batch(sid: string, token: string, k: number): Batch {
  return {
    profileId: 'p1', agent: 'claude',
    sessions: [{ nativeSessionId: sid, cwd: '/tmp/xaibo-fixture/alpha', title: `title ${token}`, startedAt: T0, lastActivity: T0 + k }],
    events: [
      { nativeSessionId: sid, source: 'transcript', confidence: 'confirmed', nativeId: `e1-${k}`, kind: 'user', sourceSeq: 1, sourceTs: T0, receivedTs: T0,
        content: `hello ${token}`, raw: JSON.stringify({ text: token }), turn: { id: `t1-${k}`, edge: 'start' }, toolCalls: [{ callId: `c1-${k}`, part: 'args', tool: 'Bash' }] },
      { nativeSessionId: sid, source: 'transcript', confidence: 'confirmed', nativeId: `e2-${k}`, kind: 'attachment', sourceSeq: 2, sourceTs: T0 + 1, receivedTs: T0 + 1,
        content: `attached ${token}`, raw: JSON.stringify({ attachment: { content: token } }) },
    ],
  };
}

async function seeded(requests = 2) {
  const h = await hookStore();
  const { db, writer, dir } = h;
  const CANARY = `zq${randomBytes(8).toString('hex')}`, KEEP = `kp${randomBytes(8).toString('hex')}`;
  writer.commitLive(batch(A, CANARY, 1));
  writer.commitLive(batch(B, KEEP, 2));
  const sid = (x: string) => (db.prepare('SELECT id FROM sessions WHERE native_session_id = ?').get(x) as { id: number }).id;
  const a = sid(A), b = sid(B);
  db.prepare("INSERT INTO price_revisions (id, schema_version, source, revision, content_hash, body, accepted_at) VALUES (1, 1, 'bundled', 'r1', 'h1', '{}', 0)").run();
  for (const [s, tok] of [[a, CANARY], [b, KEEP]] as const) {
    turn(db, s, `turn-${tok}`, T0, 'claude-x');
    for (let i = 0; i < (s === a ? requests : 2); i++) {
      request(db, s, { identity: `${tok}:${i}`, ts: T0 + i, model: 'claude-x', input: 10, read: 1, write: 1, output: 5, cost: { usd: 0.01, coverage: 'full', rev: 1 } });
    }
  }
  db.prepare(`INSERT INTO context_snapshots (session_id, schema_version, source, generation, window_basis, source_locator, observed_at)
    VALUES (?, 1, 'transcript', 1, 'unavailable', ?, ?)`).run(a, `ctx ${CANARY}`, T0);
  db.prepare(`INSERT INTO usage_snapshots (schema_version, agent, profile_id, session_id, source, source_locator, observed_at)
    VALUES (1, 'claude', 'p1', ?, 'statusline', ?, ?)`).run(a, `snap ${CANARY}`, T0);
  const scope = Number(db.prepare("INSERT INTO usage_scopes (scope_key, profile_id, agent, session_id, verified) VALUES (?, 'p1', 'claude', ?, 0)")
    .run(`session:${A}`, a).lastInsertRowid);
  sample(db, scope, { percent: 42, at: T0, locator: `quota ${CANARY}` });
  // a hook delivery of A (its envelope is stored raw)
  await h.intake.deliver(envelope({ session_id: A, event: 'UserPromptSubmit', payload: { hook_event_name: 'UserPromptSubmit', session_id: A, prompt: CANARY } }));

  // G5a-4: an interrupted assembly of A under a registration that is no longer registered (revoked) and never delivered
  openChunks(join(dir, 'content-chunks')).put({ registration: '00000000-0000-4000-8000-0000000f07ff', producer: 'fixture-producer', session: A, item: 'orphan', revision: 1 },
    0, false, `orphan ${CANARY}`);
  // report content: a complete chunked item (stored in report_content) and an interrupted assembly (chunk files on disk)
  const { registration: reg } = addRegistration(dir, { agent: 'claude', profileKey: 'p1' });
  const reports = createReportIntake({ db, writer, dataDir: dir });
  let seq = 0;
  const chunk = (sessionId: string, item: string, index: number, final: boolean, content: string) => reports.deliver(reg, {
    v: 1, delivery_id: `d-${++seq}`, session_id: sessionId, producer_id: 'fixture-producer', producer_seq: seq, event: 'content.upsert', item_id: item,
    source_ts: '2026-01-01T00:00:00.000Z', payload: { revision: 1, role: 'assistant', kind: 'message', content, chunk_index: index, final } });
  assert.equal((await chunk(A, 'done', 0, false, `part ${CANARY} `)).status, 'accepted');
  assert.equal((await chunk(A, 'done', 1, true, 'end')).code, 'ok');
  assert.equal((await chunk(A, 'cut', 0, false, `interrupted ${CANARY}`)).status, 'accepted');
  assert.equal((await chunk(B, 'kept', 0, false, `pending ${KEEP}`)).status, 'accepted');

  // spool: a closed (past-date) plain file and a taken replay file, each with a record of A and one of B
  const spool = join(dir, 'spool');
  mkdirSync(spool, { mode: 0o700 });
  const hook = (s: string, tok: string) => JSON.stringify(envelope({ session_id: s, payload: { hook_event_name: 'Stop', session_id: s, note: tok } }));
  const rep = (s: string, tok: string) => JSON.stringify({ v: 1, kind: 'report', registration: reg.id, received_ts: T0,
    frame: { v: 1, delivery_id: `sp-${tok}`, session_id: s, producer_id: 'fixture-producer', producer_seq: 99, event: 'turn.start', source_ts: '2026-01-01T00:00:00.000Z', payload: { note: tok } } });
  writeFileSync(join(spool, '2025-12-31.jsonl'), `${hook(A, CANARY)}\n${hook(B, KEEP)}\n`, { mode: 0o600 });
  writeFileSync(join(spool, `2025-12-30.replay-${randomUUID()}.jsonl`), `${rep(A, CANARY)}\n${rep(B, KEEP)}\n`, { mode: 0o600 });
  for (const f of readdirSync(spool)) utimesSync(join(spool, f), new Date(T0), new Date(T0)); // closed long ago

  // a migration backup taken while A existed
  const backups = join(dir, 'backups');
  mkdirSync(backups, { mode: 0o700 });
  const bk = join(backups, 'xaibo-v21.db');
  closeSync(openSync(bk, 'w', 0o600));
  await backup(db, bk);
  // and an earlier backup run cut short (crash or full disk) left its partial copy and journal
  writeFileSync(join(backups, '.xaibo-v20.db.partial'), `partial ${CANARY}`, { mode: 0o600 });
  writeFileSync(join(backups, '.xaibo-v20.db.partial-journal'), `journal ${CANARY}`, { mode: 0o600 });
  // the session's source file checkpoint: its path names the native file (native locator, kept so a rescan resumes)
  db.prepare("INSERT INTO source_files (profile_id, session_id, path, kind, size, offset) VALUES ('p1', ?, ?, 'transcript', 10, 10)")
    .run(a, join(dir, 'native', `${A}.jsonl`));

  // the native transcript stays byte-identical (purge never reads or writes it)
  mkdirSync(join(dir, 'native'), { mode: 0o700 });
  const native = join(dir, 'native', `${A}.jsonl`);
  writeFileSync(native, `{"text":"${CANARY}"}\n`, { mode: 0o600 });
  return { ...h, a, b, CANARY, KEEP, reg, native, spool, backups, chunk, hook };
}

const sum = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).map((f) => join(root, f)).filter((f) => lstatSync(f).isFile());
}

test('purge acceptance: canary and session gone from rows, FTS, chunks, spool and backups; the rest intact (FR-11)', async () => {
  const h = await seeded();
  const { db, dir, CANARY, KEEP } = h;
  const nativeSum = sum(h.native);
  assert.ok(files(join(dir, 'content-chunks')).some((f) => readFileSync(f).includes(CANARY)), 'fixture: the interrupted chunk is on disk');
  const monthly = liveMonthly(db, SECRET);

  // a minute later: the spool files are past the quiet window (their ctime is the fixture's write time)
  const r = await purgeSession(h.writer, h.a, { dataDir: dir, backupDir: h.backups, secret: SECRET, now: Date.now() + 60_000, reason: 'manual' });
  assert.equal(r.purged, true);
  assert.equal(r.filesPending, false);
  assert.equal(r.backupsDeleted, 1, 'Q-5.1: the backup holding the session is deleted and reported');

  // (a) no logical row holds the canary or the session id; FTS has no match and stays consistent. Kept by design: the
  // suppression marker (identity) and source_files.path (the native file's own name, a rescan checkpoint, not Xaibo content)
  assert.equal(n(db, 'SELECT count(*) AS n FROM source_files WHERE instr(path, ?) > 0 AND session_id IS NULL', A), 1);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'event_fts%' AND name <> 'suppressions'")
    .all() as { name: string }[]).map((t) => t.name);
  for (const t of tables) {
    for (const { name: c } of db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]) {
      if (t === 'source_files' && c === 'path') continue;
      assert.equal(n(db, `SELECT count(*) AS n FROM "${t}" WHERE instr(CAST("${c}" AS TEXT), ?) > 0 OR instr(CAST("${c}" AS TEXT), ?) > 0`, CANARY, A), 0, `${t}.${c}`);
      if (/^(from_|to_)?session_id$/.test(c)) assert.equal(n(db, `SELECT count(*) AS n FROM "${t}" WHERE "${c}" = ?`, h.a), 0, `${t}.${c} = purged id`);
    }
  }
  assert.equal(n(db, 'SELECT count(*) AS n FROM event_fts WHERE event_fts MATCH ?', `"${CANARY}"`), 0);
  db.exec("INSERT INTO event_fts (event_fts) VALUES ('integrity-check')");
  assert.deepEqual({ ...db.prepare('SELECT agent, profile_id, native_session_id, reason, pending FROM suppressions').get() },
    { agent: 'claude', profile_id: 'p1', native_session_id: A, reason: 'manual', pending: null }, 'the file work is done');

  // (b) no byte of the canary in content-chunks, spool or backups (the main DB file is excluded, Q-5.2)
  for (const f of ['content-chunks', 'spool', 'backups'].flatMap((d) => files(join(dir, d)))) assert.ok(!readFileSync(f).includes(CANARY), f);
  // a migration backup taken after the purge holds none of its bytes either (freed pages are not copied)
  const later = await openStore({ file: join(dir, 'xaibo.db'), backupDir: h.backups,
    migrations: [...loadMigrations(), { version: 999, name: '999_probe', sql: 'CREATE TABLE probe_999 (x)' }] });
  later.db.close();
  assert.equal(later.readOnly, false);
  assert.equal(files(h.backups).length, 1);
  for (const f of files(h.backups)) assert.ok(!readFileSync(f).includes(CANARY), f);

  // (c) the other session is intact, in rows, FTS, chunks and spool
  assert.equal(n(db, 'SELECT count(*) AS n FROM events WHERE session_id = ?', h.b), 3, 'two transcript events and its report delivery');
  assert.equal(n(db, 'SELECT count(*) AS n FROM event_fts WHERE event_fts MATCH ?', `"${KEEP}"`), 2);
  assert.equal(n(db, 'SELECT count(*) AS n FROM usage WHERE session_id = ?', h.b), 2);
  assert.ok(files(join(dir, 'content-chunks')).some((f) => readFileSync(f).includes(KEEP)));
  const spooled = files(h.spool).map((f) => readFileSync(f, 'utf8')).join('');
  assert.equal(spooled.split('\n').filter((l) => l.includes(KEEP)).length, 2, 'B keeps its hook and report spool records');

  // (d) monthly totals unchanged (settled in the purge transaction)
  assert.deepEqual(liveMonthly(db, SECRET), monthly);
  // (e) native fixture byte-identical
  assert.equal(sum(h.native), nativeSum);
  // (f) app data private
  for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((x) => join(dir, x))) {
    const st = lstatSync(f);
    assert.equal(st.mode & 0o777, st.isDirectory() ? 0o700 : 0o600, f);
  }

  // suppression: a later rescan, a late hook and a late content chunk of the purged session store nothing; intake refuses
  // the hook and the report before publishing them or writing a chunk
  const commits: Batch[] = [];
  new Writer(db, { onCommit: (x) => commits.push(x) }).commitLive(batch(A, CANARY, 3));
  assert.deepEqual(commits.map((x) => [x.sessions.length, x.events.length]), [[0, 0]], 'onCommit (status engine, live feed) never sees it');
  const late = await h.intake.deliver(envelope({ session_id: A, payload: { hook_event_name: 'Stop', session_id: A, note: CANARY } }));
  assert.deepEqual(late, { status: 'accepted', code: 'suppressed' });
  assert.deepEqual(await h.chunk(A, 'again', 0, false, `late ${CANARY}`), { status: 'accepted', code: 'suppressed' });
  assert.ok(!files(join(dir, 'content-chunks')).some((f) => readFileSync(f).includes(CANARY)), 'no chunk written for a suppressed session');
  // the writer's backstop: a hook or report delivery of the session reaching it directly commits nothing at all
  h.writer.commitLive({ profileId: 'p1', agent: 'claude', sessions: [{ nativeSessionId: A }], events: [],
    delivery: { deliveryId: randomUUID(), agent: 'claude', profileKey: 'p1', nativeSessionId: A, event: 'Stop', receivedTs: T0, committedTs: T0, unattributed: null } });
  h.writer.commitLive({ profileId: 'p1', agent: 'claude', sessions: [], events: [],
    report: { registrationId: h.reg.id, deliveryId: 'direct', agent: 'claude', profileKey: 'p1', nativeSessionId: A, event: 'content.upsert', producerId: 'x',
      producerSeq: 1, receivedTs: T0, committedTs: T0, unattributed: 'unknown-profile',
      content: { itemId: 'i', revision: 1, role: 'assistant', kind: 'message', state: 'complete', chunks: 1, bytes: 5, text: CANARY } } });
  for (const t of ['hook_delivery', 'report_delivery', 'report_content']) assert.equal(n(db, `SELECT count(*) AS n FROM ${t} WHERE native_session_id = ?`, A), 0, t);
  assert.equal(n(db, 'SELECT count(*) AS n FROM sessions WHERE native_session_id = ?', A), 0);
  assert.equal(n(db, 'SELECT count(*) AS n FROM events WHERE instr(coalesce(content, raw), ?) > 0', CANARY), 0);
  assert.equal(n(db, 'SELECT count(*) AS n FROM event_fts WHERE event_fts MATCH ?', `"${CANARY}"`), 0);
});

test('a migration backup needs room for its copy and the compaction of that copy, else the store opens read-only', async () => {
  const h = await seeded();
  const file = join(h.dir, 'xaibo.db');
  const size = (f: string) => (existsSync(f) ? lstatSync(f).size : 0);
  // measured when asked (opening grows the WAL): one byte more than one copy needs, not enough for its compaction too
  const s = await openStore({ file, backupDir: h.backups, freeBytes: () => size(file) + size(`${file}-wal`) + 64 * 1024 * 1024 + 1,
    migrations: [...loadMigrations(), { version: 999, name: '999_probe', sql: 'CREATE TABLE probe_999 (x)' }] });
  s.db.close();
  assert.deepEqual([s.readOnly, s.reason], [true, 'insufficient-space']);
});

test('spool files changed within the quiet window (mtime or ctime: a replay rename) stay owed; resumePurges finishes them', async () => {
  const h = await seeded();
  const { db, dir, CANARY, KEEP } = h;
  // the fixture just wrote (and re-timed) the spool files: their ctime is now, as after a replay renamed them
  const r = await purgeSession(h.writer, h.a, { dataDir: dir, backupDir: h.backups, secret: SECRET, now: Date.now(), reason: 'manual' });
  assert.deepEqual([r.purged, r.filesPending, r.spoolFiles], [true, true, 0]);
  assert.ok(files(h.spool).some((f) => readFileSync(f).includes(CANARY)), 'not rewritten while a forwarder may still append');
  assert.equal(n(db, 'SELECT count(*) AS n FROM suppressions WHERE pending IS NOT NULL'), 1);

  assert.equal(await resumePurges(h.writer, { dataDir: dir, backupDir: h.backups, now: Date.now() + 60_000 }), 1);
  for (const f of ['content-chunks', 'spool', 'backups'].flatMap((d) => files(join(dir, d)))) assert.ok(!readFileSync(f).includes(CANARY), f);
  assert.equal(files(h.spool).map((f) => readFileSync(f, 'utf8')).join('').split('\n').filter((l) => l.includes(KEEP)).length, 2);
  assert.equal(n(db, 'SELECT count(*) AS n FROM suppressions WHERE pending IS NOT NULL'), 0);
  assert.equal(await resumePurges(h.writer, { dataDir: dir, backupDir: h.backups, now: Date.now() + 60_000 }), 0);
});

// Gate 5 round 2 (decision 2990): phase (a) writes only the marker (purge phase 'settle'); the space-hungry settlement
// follows in bounded batches. A disk that fills there fails that batch like a row batch: the session stays hidden and
// suppressed, the phase stays for resume, nothing is deleted or removed and totals hold; resume settles the rest once
// space is back. (A full disk before phase (a) commits still rolls it back: no marker.)
test('a purge whose settlement hits SQLITE_FULL keeps the phase for resume: logged, nothing deleted, no file removed; resume finishes it', async () => {
  const h = await seeded(400); // enough contributions that settling them needs new pages
  const { db, dir, CANARY } = h;
  const before = ['content-chunks', 'spool', 'backups'].flatMap((d) => files(join(dir, d))).map((f) => [f, sum(f)]);
  const totals = liveMonthly(db, SECRET);
  db.exec('PRAGMA incremental_vacuum');
  db.exec(`PRAGMA max_page_count = ${n(db, 'SELECT page_count AS n FROM pragma_page_count')}`);
  const logged: string[] = [];
  const r = await purgeSession(h.writer, h.a, { dataDir: dir, backupDir: h.backups, secret: SECRET, now: Date.now(), reason: 'manual', log: (e) => { logged.push(e); } });
  db.exec('PRAGMA max_page_count = 1073741823');
  assert.deepEqual([r.purged, r.filesPending], [true, true]);
  assert.equal(h.writer.diskFull, true);
  assert.deepEqual(logged, ['purge_rows_failed']);
  assert.equal((db.prepare('SELECT purge_phase AS p FROM suppressions').get() as { p: string }).p, 'settle');
  assert.equal(n(db, 'SELECT count(*) AS n FROM sessions WHERE id = ?', h.a), 1);
  assert.equal(n(db, 'SELECT count(*) AS n FROM event_fts WHERE event_fts MATCH ?', `"${CANARY}"`), 2, 'no row deleted');
  assert.deepEqual(['content-chunks', 'spool', 'backups'].flatMap((d) => files(join(dir, d))).map((f) => [f, sum(f)]), before);
  assert.deepEqual(liveMonthly(db, SECRET), totals, 'totals unchanged');
  await resumePurges(h.writer, { dataDir: dir, backupDir: h.backups, secret: SECRET, now: Date.now() + 60_000 });
  assert.equal(h.writer.diskFull, false);
  assert.equal(n(db, 'SELECT count(*) AS n FROM sessions WHERE id = ?', h.a), 0);
  assert.deepEqual(liveMonthly(db, SECRET), totals, 'settled once');
});

// Gate 5 U1 (XAIBO-PROD-542)
const files_ = (h: Awaited<ReturnType<typeof seeded>>, now: number) => ({ dataDir: h.dir, backupDir: h.backups, now });
const nextDay = (t: number) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate() + 1);

test('G5a-2: a purge whose session is in today\'s spool file owes that file; it is rewritten after UTC midnight', async () => {
  const h = await seeded();
  const now = Date.now() + 60_000;
  const today = join(h.spool, `${new Date(now).toISOString().slice(0, 10)}.jsonl`);
  writeFileSync(today, `${h.hook(A, h.CANARY)}\n${h.hook(B, h.KEEP)}\n`, { mode: 0o600 });
  const r = await purgeSession(h.writer, h.a, { ...files_(h, now), secret: SECRET, reason: 'manual' });
  assert.deepEqual([r.purged, r.filesPending], [true, true], 'the forwarder\'s file still holds the session: work owed');
  assert.equal(n(h.db, 'SELECT count(*) AS n FROM suppressions WHERE pending IS NOT NULL'), 1);
  assert.equal(await resumePurges(h.writer, files_(h, nextDay(now) + 60_000)), 1, 'closed after midnight: rewritten');
  assert.ok(!readFileSync(today).includes(h.CANARY));
  assert.ok(readFileSync(today).includes(h.KEEP), 'the other session\'s line stays');
});

test('G5a-2: the owed rewrite of today\'s spool file is scheduled shortly after the next UTC midnight plus the quiet window', () => {
  assert.equal(typeof purge.spoolResumeDelay, 'function', 'spoolResumeDelay exported');
  const now = Date.UTC(2026, 10, 20, 23, 59);
  const at = now + purge.spoolResumeDelay(now);
  assert.ok(at >= Date.UTC(2026, 10, 21) + 5_000 && at <= Date.UTC(2026, 10, 21) + 60_000, String(at - Date.UTC(2026, 10, 21)));
});

test('G5a-3: a backup dir or spool file that cannot be read now keeps the work owed; once readable, resume finishes it', async () => {
  const h = await seeded();
  chmodSync(h.backups, 0);
  chmodSync(join(h.spool, '2025-12-31.jsonl'), 0);
  let r;
  try { r = await purgeSession(h.writer, h.a, { ...files_(h, Date.now() + 60_000), secret: SECRET, reason: 'manual' }); }
  finally { chmodSync(h.backups, 0o700); chmodSync(join(h.spool, '2025-12-31.jsonl'), 0o600); }
  assert.deepEqual([r.purged, r.filesPending], [true, true], 'EACCES is transient, never done');
  assert.equal(await resumePurges(h.writer, files_(h, Date.now() + 60_000)), 1);
  for (const f of ['spool', 'backups'].flatMap((d) => files(join(h.dir, d)))) assert.ok(!readFileSync(f).includes(h.CANARY), f);
});

test('G5a-3: a missing backup dir is done; an oversized own spool file holding the session is rewritten or removed, never owed forever', async () => {
  const h = await seeded();
  const big = join(h.spool, '2025-12-29.jsonl');
  writeFileSync(big, `${h.hook(A, h.CANARY)}\n${JSON.stringify({ pad: 'p'.repeat(64 << 20) })}\n`, { mode: 0o600 }); // past the 64 MiB read bound
  utimesSync(big, new Date(T0), new Date(T0));
  const r = await purgeSession(h.writer, h.a, { ...files_(h, Date.now() + 60_000), secret: SECRET, reason: 'manual', backupDir: join(h.dir, 'no-backups') });
  assert.deepEqual([r.purged, r.filesPending], [true, false]);
  for (const f of files(h.spool)) assert.ok(!readFileSync(f).includes(h.CANARY), f);
});

// Gate 5 round 2 G5a-3 (spool discovery): only a spool dir that does not exist is "no spool, done". One that cannot be
// examined now (EACCES, EMFILE, ...) keeps the file work owed, as an unreadable backup dir or spool file does; the
// same rule in spoolDir, rewriteSpool and spoolToday (a dir not ours stays never read).
test('G5a-3: a spool dir that cannot be examined now keeps the work owed; only a missing one is done', async () => {
  assert.equal(typeof purge.finishPending, 'function', 'finishPending exported');
  const h = await hookStore();
  h.db.prepare("INSERT INTO suppressions (agent, profile_id, native_session_id, reason, at, pending) VALUES ('claude', 'p1', ?, 'manual', 1, '[]')").run(A);
  const who = { agent: 'claude', profile: 'p1', native: A };
  const none = { items: () => [], remove: () => undefined } as unknown as Parameters<typeof purge.finishPending>[2]['chunks'];
  const data = join(h.dir, 'files');
  mkdirSync(join(data, 'spool'), { recursive: true, mode: 0o700 });
  const opts = { dataDir: data, backupDir: join(h.dir, 'no-backups'), now: Date.now() + 60_000, chunks: none };
  chmodSync(data, 0o600); // listable, not searchable: stat of spool/ fails with EACCES
  let done: boolean, today: Set<string> | null;
  try { done = purge.finishPending(h.writer, who, opts); today = purge.spoolToday(data, opts.now); } finally { chmodSync(data, 0o700); }
  assert.equal(today, null, 'today\'s spool identities cannot be read now: unknown, never "none"');
  assert.equal(done, false, 'EACCES on the spool dir is transient, never done');
  assert.notEqual((h.db.prepare('SELECT pending FROM suppressions').get() as { pending: string | null }).pending, null);
  assert.equal(purge.finishPending(h.writer, who, opts), true, 'examinable again: done');
  h.db.prepare("INSERT INTO suppressions (agent, profile_id, native_session_id, reason, at, pending) VALUES ('claude', 'p1', ?, 'manual', 1, '[]')").run(B);
  assert.equal(purge.finishPending(h.writer, { ...who, native: B }, { ...opts, dataDir: join(h.dir, 'no-data') }), true, 'no spool dir at all: done');
});

test('G5Su-3: a file check that fails after the rows are gone answers purged with the files owed, never not-found', async () => {
  const h = await seeded();
  const { db, dir } = h;
  // the store fails from the first transaction after the sweep (owed()'s read); peeked on the raw handle, so the peek is
  // neither counted nor thrown, and before begin() there is no marker yet
  const swept = () => (db.prepare('SELECT purge_phase AS p FROM suppressions WHERE native_session_id = ?').get(A) as { p: string | null } | undefined)?.p === null;
  assert.equal(n(db, 'SELECT count(*) AS n FROM suppressions WHERE native_session_id = ?', A), 0, 'no marker before the purge (D180-3)');
  const w = new Proxy(h.writer, { get(t, k) {
    if (k === 'transact') return <T>(f: (d: DatabaseSync) => T): T => { if (swept()) throw new Error('store closed'); return t.transact(f); };
    const v = Reflect.get(t, k, t) as unknown;
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  } });
  const r = await purgeSession(w, h.a, { dataDir: dir, backupDir: h.backups, secret: SECRET, now: Date.now(), reason: 'manual', vacuum: false });
  assert.deepEqual([r.purged, r.filesPending, r.rowsPending], [true, true, false]);
  assert.equal(n(db, 'SELECT count(*) AS n FROM sessions WHERE id = ?', h.a), 0, 'the rows are gone');
});
