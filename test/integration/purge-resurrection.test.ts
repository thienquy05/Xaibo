// XAIBO-PROD-516 (P5-T08; EC-21, EC-22 clearing, FR-11, FR-52): a purged session never comes back by itself. After a
// manual purge: a full rescan of its native file, a spool replay of pre-purge deliveries (today's active spool file and
// overflow lines), a late hook, a restart through the migration backup path and a resumed interrupted chunk upload each
// leave 0 rows and no chunk file; new native activity does not clear a manual marker, only Re-import does, which brings
// the whole native session back without counting settled months twice. A retention marker clears on demonstrably new
// native activity (a record or a live hook after the purge) and the session is re-imported whole.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { purgeSession, resumePurges } from '../../src/service/history/purge.ts';
import { reimport } from '../../src/service/history/reimport.ts';
import { clear as clearMarker } from '../../src/service/history/suppression.ts';
import { createIntake } from '../../src/service/receivers/intake.ts';
import { createReportIntake } from '../../src/service/receivers/report.ts';
import { addRegistration } from '../../src/service/receivers/registrations.ts';
import { replaySpool } from '../../src/service/receivers/spool-replay.ts';
import { loadMigrations, openStore } from '../../src/service/store/db.ts';
import { liveMonthly, type Monthly } from '../../src/service/usage/monthly.ts';
import { claudeProfile, count } from '../helpers/claude-profile.ts';
import { envelope, T0 } from '../helpers/hook-store.ts';
import { SECRET } from '../helpers/monthly.ts';

const S = '00000000-0000-4000-8000-000000001000'; // the usage-basic fixture session (January 2026)
const WHO = { agent: 'claude', profile: 'p1', native: S };

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).map((f) => join(root, f)).filter((f) => lstatSync(f).isFile());
}
/** The settled month, as the monthly view shows it. */
const january = (m: Monthly) => JSON.stringify([m.usage, m.sessions, m.quota].map((rows) => rows.filter((r) => r.month === '2026-01')));
/** A later native record of the session, timed after the purge. */
const continued = (ts: number) => `${JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: '00000000-0000-4000-8000-0000000010f1',
  timestamp: new Date(ts).toISOString(), userType: 'external', entrypoint: 'sdk-cli', cwd: '/tmp/xaibo-fixture/alpha', sessionId: S, version: '2.1.319',
  message: { role: 'user', content: 'continued later' } })}\n`;

async function imported() {
  const p = await claudeProfile(['usage-basic']);
  const dataDir = join(p.tmp, 'data');
  const adapter = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await adapter.backfill();
  const events = count(p.db, 'SELECT count(*) FROM events');
  assert.ok(events > 0 && count(p.db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', S) === 1, 'fixture imported');
  const intake = createIntake({ db: p.db, writer: p.writer });
  const { registration: reg } = addRegistration(dataDir, { agent: 'claude', profileKey: 'p1' });
  const reports = createReportIntake({ db: p.db, writer: p.writer, dataDir });
  let seq = 0;
  // ts: the frame's own event time; receivedTs: when the helper received a spooled frame (replay), else live
  const chunk = (item: string, index: number, final: boolean, content: string, ts = '2026-01-01T00:00:00.000Z', receivedTs?: number) => reports.deliver(reg, {
    v: 1, delivery_id: `d-${++seq}`, session_id: S, producer_id: 'fixture-producer', producer_seq: seq, event: 'content.upsert', item_id: item,
    source_ts: ts, payload: { revision: 1, role: 'assistant', kind: 'message', content, chunk_index: index, final } }, receivedTs);
  const sid = (p.db.prepare('SELECT id FROM sessions WHERE native_session_id = ?').get(S) as { id: number }).id;
  const transcript = join(p.root, 'projects', '-tmp-xaibo-fixture-usage-basic', `${S}.jsonl`);
  const rescan = async () => { p.db.prepare("UPDATE source_files SET offset = 0, head_hash = ''").run(); await adapter.backfill(); }; // a lost checkpoint: full re-read
  const opts = (now: number) => ({ dataDir, backupDir: join(dataDir, 'backups'), now });
  return { ...p, dataDir, adapter, events, intake, chunk, sid, transcript, rescan, opts, reg, reports, monthly: liveMonthly(p.db, SECRET) };
}

function traces(db: DatabaseSync, dataDir: string) {
  return {
    sessions: count(db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', S),
    events: count(db, 'SELECT count(*) FROM events'), // the fixture's only session
    deliveries: count(db, 'SELECT count(*) FROM hook_delivery WHERE native_session_id = ?', S) + count(db, 'SELECT count(*) FROM report_delivery WHERE native_session_id = ?', S),
    content: count(db, 'SELECT count(*) FROM report_content WHERE native_session_id = ?', S),
    gaps: count(db, 'SELECT count(*) FROM hook_gaps WHERE native_session_id = ?', S),
    evidence: count(db, 'SELECT count(*) FROM status_evidence WHERE native_session_id = ?', S),
    chunks: files(join(dataDir, 'content-chunks')).length,
  };
}
const NONE = { sessions: 0, events: 0, deliveries: 0, content: 0, gaps: 0, evidence: 0, chunks: 0 };

test('EC-21: after a manual purge, rescan, spool replay, a late hook, a backup restart and a resumed chunk upload resurrect nothing; Re-import does', async () => {
  const h = await imported();
  const { db, dataDir } = h;
  const CANARY = `zq${randomBytes(8).toString('hex')}`;
  assert.equal((await h.chunk('cut', 0, false, `interrupted ${CANARY}`)).status, 'accepted'); // an upload cut short before the purge
  // deliveries spooled before the purge into today's active file (the purge leaves it to the replay) and the overflow log
  const spool = join(dataDir, 'spool');
  mkdirSync(spool, { mode: 0o700 });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(spool, `${today}.jsonl`), `${JSON.stringify(envelope({ session_id: S, payload: { hook_event_name: 'Stop', session_id: S, note: CANARY } }))}\n`, { mode: 0o600 });
  writeFileSync(join(spool, 'overflow.log'), `${JSON.stringify({ ts: T0, agent: 'claude', session_id: S, event: 'Stop' })}\n`, { mode: 0o600 });

  // review: the purge lies in the past, so every live attempt below is timed after it and only the manual rule refuses it
  const r = await purgeSession(h.writer, h.sid, { dataDir, backupDir: join(dataDir, 'backups'), secret: SECRET, now: Date.now() - 60_000, reason: 'manual' });
  assert.equal(r.purged, true);
  assert.deepEqual(traces(db, dataDir), NONE);

  await h.rescan();
  assert.deepEqual(traces(db, dataDir), NONE, 'full rescan');
  const replay = await replaySpool({ dataDir, db, deliver: h.intake.deliver, graceMs: 0 });
  assert.equal(replay.complete, true);
  assert.deepEqual(traces(db, dataDir), NONE, 'spool replay of pre-purge deliveries and overflow lines');
  assert.ok(!files(spool).some((f) => readFileSync(f).includes(CANARY)), 'the replayed spool file is gone');
  assert.deepEqual(await h.intake.deliver(envelope({ session_id: S, received_ts: Date.now() + 120_000, payload: { hook_event_name: 'Stop', session_id: S } })),
    { status: 'accepted', code: 'suppressed' }, 'a late (even live) hook does not clear a manual purge');
  assert.deepEqual(traces(db, dataDir), NONE, 'late hook');
  const restart = await openStore({ file: join(dataDir, 'xaibo.db'), backupDir: join(dataDir, 'backups'),
    migrations: [...loadMigrations(), { version: 999, name: '999_probe', sql: 'CREATE TABLE probe_999 (x)' }] });
  restart.db.close();
  for (const f of files(join(dataDir, 'backups'))) {
    const b = new DatabaseSync(f, { readOnly: true });
    assert.equal(count(b, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', S), 0, f);
    b.close();
  }
  assert.deepEqual(traces(db, dataDir), NONE, 'restart through the migration backup path');
  assert.deepEqual(await h.chunk('cut', 1, true, `rest ${CANARY}`, new Date().toISOString()), { status: 'accepted', code: 'suppressed' });
  assert.deepEqual(traces(db, dataDir), NONE, 'resumed interrupted chunk upload');

  // new native activity: a manual marker stays until Re-import
  appendFileSync(h.transcript, continued(Date.now() + 120_000));
  await h.adapter.backfill();
  assert.deepEqual(traces(db, dataDir), NONE, 'new native activity does not clear a manual purge');
  // review H1: the file is unchanged since that scan; the reset still makes the next scan read it again
  assert.equal(reimport(h.writer, WHO, h.opts(Date.now() + 180_000)), 'ok');
  await h.adapter.backfill();
  assert.equal(count(db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', S), 1);
  assert.equal(count(db, 'SELECT count(*) FROM events'), h.events + 1, 'the whole native session, plus the new record');
  assert.equal(count(db, 'SELECT count(*) FROM suppressions WHERE cleared_at IS NOT NULL'), 1);
  assert.equal(january(liveMonthly(db, SECRET)), january(h.monthly), 'settled January is not counted twice (FR-52)');
  assert.equal(reimport(h.writer, WHO, h.opts(Date.now())), 'none', 'nothing left to re-import');
});

test('EC-22: a retention purge stays through old records and replayed hooks; a new native record clears it and re-imports the session', async () => {
  const h = await imported();
  const { db, dataDir } = h;
  const at = Date.now() - 60_000;
  await purgeSession(h.writer, h.sid, { dataDir, backupDir: join(dataDir, 'backups'), secret: SECRET, now: at, reason: 'retention' });
  await h.rescan();
  assert.deepEqual(traces(db, dataDir), NONE, 'old records are not new activity');
  assert.deepEqual(await h.intake.deliver(envelope({ session_id: S, received_ts: T0, payload: { hook_event_name: 'Stop', session_id: S } })),
    { status: 'accepted', code: 'suppressed' }, 'a replayed pre-purge hook');
  assert.deepEqual(traces(db, dataDir), NONE);
  // review M3: a record stamped after the purge in a file not written since (a clock that ran ahead) is not new activity
  appendFileSync(h.transcript, continued(Date.now() + 3_600_000).replace('0000000010f1', '0000000010f0'));
  utimesSync(h.transcript, new Date(at - 1_000), new Date(at - 1_000));
  await h.adapter.backfill();
  assert.deepEqual(traces(db, dataDir), NONE, 'a future time in an unchanged file');

  appendFileSync(h.transcript, continued(Date.now()));
  // the new record clears the marker and resets the checkpoint; the adapter reads the file again from the start at once
  // (review M (code): no later write or scan needed)
  await h.adapter.backfill();
  assert.equal(count(db, 'SELECT count(*) FROM suppressions WHERE cleared_at IS NOT NULL'), 1);
  assert.equal(count(db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', S), 1);
  assert.equal(count(db, 'SELECT count(*) FROM events'), h.events + 2);
  assert.equal(january(liveMonthly(db, SECRET)), january(h.monthly), 'settled January is not counted twice (FR-52)');
});

test('EC-22: a live hook received after a retention purge clears it; one received before stays refused', async () => {
  const h = await imported();
  const { db, dataDir } = h;
  const at = Date.now() - 10_000; // intake caps a hook's time at its commit, so the purge lies in the past here
  await purgeSession(h.writer, h.sid, { dataDir, backupDir: join(dataDir, 'backups'), secret: SECRET, now: at, reason: 'retention' });
  // review: a statusLine snapshot carries no time of its own, so it is no new activity; the writer drops it and it is not
  // remembered as stored, so the same snapshot is stored once the marker clears
  const tee = () => h.intake.deliver(envelope({ event: 'statusline', cwd: null, session_id: S, payload: { session_id: S, model: { id: 'claude-x' } } }));
  assert.equal((await tee()).status, 'accepted');
  assert.equal(count(db, "SELECT count(*) FROM events WHERE source = 'statusline'"), 0);
  assert.deepEqual(await h.intake.deliver(envelope({ session_id: S, received_ts: at - 1, payload: { hook_event_name: 'Stop', session_id: S } })),
    { status: 'accepted', code: 'suppressed' });
  assert.deepEqual(await h.intake.deliver(envelope({ session_id: S, received_ts: Date.now(), payload: { hook_event_name: 'Stop', session_id: S } })),
    { status: 'accepted', code: 'ok' });
  assert.equal(count(db, 'SELECT count(*) FROM suppressions WHERE cleared_at IS NOT NULL'), 1);
  // review L1: once cleared, a delivery from before the purge is still a copy the purge removed
  assert.deepEqual(await h.intake.deliver(envelope({ session_id: S, received_ts: at - 1, payload: { hook_event_name: 'Stop', session_id: S } })),
    { status: 'accepted', code: 'suppressed' });
  assert.deepEqual(await tee(), { status: 'accepted', code: 'ok' });
  assert.equal(count(db, "SELECT count(*) FROM events WHERE source = 'statusline'"), 1);
  await h.adapter.backfill();
  assert.equal(count(db, "SELECT count(*) FROM events WHERE source NOT IN ('hook', 'statusline')"), h.events, 'the native session re-imported whole');
  assert.equal(count(db, "SELECT count(*) FROM events WHERE source = 'hook'"), 1);
});

test('review M4: report history re-sent after a retention purge stays refused (frame time); a live frame clears it', async () => {
  const h = await imported();
  const at = Date.now() - 60_000;
  await purgeSession(h.writer, h.sid, { dataDir: h.dataDir, backupDir: join(h.dataDir, 'backups'), secret: SECRET, now: at, reason: 'retention' });
  const frame = (id: string, ts: string) => h.reports.deliver(h.reg, { v: 1, delivery_id: id, session_id: S, producer_id: 'fixture-producer', producer_seq: 1,
    event: 'turn.start', source_ts: ts, payload: {} });
  assert.deepEqual(await frame('resent', '2026-01-01T00:00:00.000Z'), { status: 'accepted', code: 'suppressed' }, 'fresh delivery id, old event');
  assert.deepEqual(await frame('garbled', 'not a time'), { status: 'accepted', code: 'suppressed' }, 'no readable event time');
  // a frame the helper spooled before the purge, stamped after it by a producer clock running ahead: refused, no chunk written
  assert.deepEqual(await h.chunk('ahead', 0, false, 'early', new Date().toISOString(), at - 1_000), { status: 'accepted', code: 'suppressed' });
  assert.equal(files(join(h.dataDir, 'content-chunks')).length, 0);
  assert.equal(count(h.db, 'SELECT count(*) FROM suppressions WHERE cleared_at IS NULL'), 1);
  assert.equal((await frame('live', new Date().toISOString())).status, 'accepted');
  assert.equal(count(h.db, 'SELECT count(*) FROM suppressions WHERE cleared_at IS NOT NULL'), 1);
  assert.equal(count(h.db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', S), 1);
});

test('review M1/L2: Re-import finishes owed file work first; it refuses when the native file is gone', async () => {
  const h = await imported();
  const spool = join(h.dataDir, 'spool');
  mkdirSync(spool, { mode: 0o700 });
  writeFileSync(join(spool, '2025-12-31.jsonl'), `${JSON.stringify(envelope({ session_id: S, payload: { hook_event_name: 'Stop', session_id: S } }))}\n`, { mode: 0o600 });
  const r = await purgeSession(h.writer, h.sid, { dataDir: h.dataDir, backupDir: join(h.dataDir, 'backups'), secret: SECRET, now: Date.now(), reason: 'manual' });
  assert.equal(r.filesPending, true, 'the spool file was written just now');
  assert.equal(reimport(h.writer, WHO, h.opts(Date.now())), 'pending', 'still inside the quiet window');
  assert.equal(count(h.db, 'SELECT count(*) FROM suppressions WHERE cleared_at IS NULL'), 1);
  assert.equal(reimport(h.writer, WHO, h.opts(Date.now() + 60_000)), 'ok');
  assert.equal(files(spool).length, 0, 'the owed spool rewrite ran before the marker cleared');

  const g = await imported();
  await purgeSession(g.writer, g.sid, { dataDir: g.dataDir, backupDir: join(g.dataDir, 'backups'), secret: SECRET, now: Date.now(), reason: 'manual' });
  unlinkSync(g.transcript);
  assert.equal(reimport(g.writer, WHO, g.opts(Date.now())), 'native-gone');
  assert.equal(count(g.db, 'SELECT count(*) FROM suppressions WHERE cleared_at IS NULL'), 1, 'still suppressed');
});

test('review H2/M2: a reset checkpoint survives an ingest that started before it; a new file of the session joins the marker', async () => {
  const h = await imported();
  const { db } = h;
  await purgeSession(h.writer, h.sid, { dataDir: h.dataDir, backupDir: join(h.dataDir, 'backups'), secret: SECRET, now: Date.now(), reason: 'manual' });
  const row = () => db.prepare('SELECT id, path, offset, size, epoch FROM source_files WHERE instr(path, ?) > 0').get(`${S}.jsonl`) as
    { id: number; path: string; offset: number; size: number; epoch: number }; // stored as its real path
  const before = row();
  assert.deepEqual(JSON.parse((db.prepare('SELECT files FROM suppressions').get() as { files: string }).files), [before.id]);
  // the session's rollout shows up under a new path (archived): its records are dropped and the file joins the marker
  const moved = join(h.tmp, 'moved.jsonl');
  const cp = { kind: 'transcript', dev: 1, ino: 2, size: 10, mtime: 1, offset: 10, headHash: 'h', status: 'ok' as const };
  h.writer.commitLive({ profileId: 'p1', agent: 'claude', file: { path: moved, ...cp, epoch: 0 }, fileSession: S, sessions: [{ nativeSessionId: S }],
    events: [{ nativeSessionId: S, source: 'transcript', confidence: 'confirmed', nativeId: 'm1', kind: 'user', sourceSeq: 1, sourceTs: T0, receivedTs: T0 }] });
  const movedId = (db.prepare('SELECT id FROM source_files WHERE path = ?').get(moved) as { id: number }).id;
  assert.deepEqual(JSON.parse((db.prepare('SELECT files FROM suppressions').get() as { files: string }).files).sort(), [before.id, movedId].sort());

  assert.equal(reimport(h.writer, WHO, h.opts(Date.now())), 'ok');
  const reset = row();
  assert.deepEqual([reset.offset, reset.size, reset.epoch], [0, -1, before.epoch + 1]);
  // a batch of an ingest that read the checkpoint before the reset cannot move it past the reset
  h.writer.commitLive({ profileId: 'p1', agent: 'claude', file: { path: before.path, ...cp, offset: before.offset, size: before.size, epoch: before.epoch },
    sessions: [], events: [] });
  assert.deepEqual([row().offset, row().size, row().epoch], [0, -1, before.epoch + 1]);
  // G5f-1: nor does it commit its records: the re-read from the start brings them (a hook batch, with no file, keeps its own)
  h.writer.commitLive({ profileId: 'p1', agent: 'claude', file: { path: before.path, ...cp, offset: before.offset, size: before.size, epoch: before.epoch },
    fileSession: S, sessions: [{ nativeSessionId: S }],
    events: [{ nativeSessionId: S, source: 'transcript', confidence: 'confirmed', nativeId: 'stale-1', kind: 'user', sourceSeq: 1, sourceTs: Date.now(), receivedTs: Date.now() }] });
  assert.equal(count(db, "SELECT count(*) FROM events WHERE native_id = 'stale-1'"), 0, 'a batch the epoch guard refuses commits no events');
  assert.deepEqual([row().offset, row().size, row().epoch], [0, -1, before.epoch + 1]);
});

// Gate 5 round 2 G5Rr1-2 (EC-22, XAIBO-PROD-542; design security review): native continuation scanned while a retention
// purge still owes work is refused (the checkpoint still advances) and recorded on the marker as fresh_at. Once neither
// the purge phase nor file work is owed (today's spool file holding the session closes only after UTC midnight), a
// retention marker with fresh_at is cleared and its files reset (epoch + 1, the G5f-1 reread path): the next scan
// re-imports the whole session, continuation included, with no further native write. A manual marker stays.
const nextDay = (t: number) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate() + 1);
test('G5Rr1-2: continuation during a retention purge is re-imported once the purge and its file work are done; manual stays out', async () => {
  const h = await imported();
  const { db, dataDir } = h;
  const at = Date.now() - 60_000;
  const marker = () => ({ ...db.prepare('SELECT * FROM suppressions').get() }) as Record<string, unknown>;
  // today's spool file holds a record of the session: the purge owes that file until the day closes
  mkdirSync(join(dataDir, 'spool'), { mode: 0o700 });
  writeFileSync(join(dataDir, 'spool', `${new Date(at).toISOString().slice(0, 10)}.jsonl`),
    `${JSON.stringify(envelope({ session_id: S, received_ts: at - 1_000, payload: { hook_event_name: 'Stop', session_id: S } }))}\n`, { mode: 0o600 });
  const r = await purgeSession(h.writer, h.sid, { dataDir, backupDir: join(dataDir, 'backups'), secret: SECRET, now: at, reason: 'retention', stopped: () => true });
  assert.deepEqual([r.purged, r.filesPending], [true, true], 'fixture: stopped after phase (a)');
  appendFileSync(h.transcript, continued(Date.now()));
  await h.adapter.backfill(); // refused while the purge is under way
  assert.equal(count(db, "SELECT count(*) FROM events WHERE native_id = '00000000-0000-4000-8000-0000000010f1'"), 0, 'refused while deleting rows');
  assert.equal(typeof marker()['fresh_at'], 'number', 'the refused batch\'s new native activity is recorded on the marker');

  await resumePurges(h.writer, { dataDir, backupDir: join(dataDir, 'backups'), secret: SECRET, now: Date.now() }); // rows done; today's file still owed
  await h.adapter.backfill();
  assert.notEqual(marker()['pending'], null, 'today\'s spool file keeps the file work owed');
  assert.equal(marker()['cleared_at'], null, 'not cleared while work is owed');
  assert.equal(count(db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', S), 0);

  let woken = 0;
  const closed = nextDay(Date.now()) + 60_000;
  assert.equal(await resumePurges(h.writer, { dataDir, backupDir: join(dataDir, 'backups'), now: closed, onReimport: () => { woken++; } }), 1, 'the day closed: file work done');
  assert.equal(marker()['pending'], null);
  assert.equal(marker()['cleared_at'], closed, 'the retention marker with fresh activity clears, at the service clock (not the native record time)');
  await resumePurges(h.writer, { dataDir, backupDir: join(dataDir, 'backups'), now: closed + 1, onReimport: () => { woken++; } });
  assert.equal(woken, 1, 'the adapters are woken exactly once');
  await h.adapter.backfill(); // no further native write
  assert.equal(count(db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', S), 1, 'the continued session is re-imported');
  assert.equal(count(db, 'SELECT count(*) FROM events'), h.events + 1, 'whole: its old records and the continuation');
  assert.equal(january(liveMonthly(db, SECRET)), january(h.monthly), 'settled January is not counted twice (FR-52)');

  const g = await imported();
  await purgeSession(g.writer, g.sid, { dataDir: g.dataDir, backupDir: join(g.dataDir, 'backups'), secret: SECRET, now: at, reason: 'manual', stopped: () => true });
  appendFileSync(g.transcript, continued(Date.now()));
  await g.adapter.backfill();
  await resumePurges(g.writer, { dataDir: g.dataDir, backupDir: join(g.dataDir, 'backups'), secret: SECRET, now: Date.now() + 60_000 });
  await g.adapter.backfill();
  assert.equal(count(g.db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', S), 0, 'a manual purge stays out');
  assert.equal(count(g.db, 'SELECT count(*) FROM suppressions WHERE cleared_at IS NULL'), 1);
});

// Gate 5 round 2 security review (test b): a manual purge of a session re-imported after a retention marker with
// fresh activity cleared resets that marker (manual, no fresh_at, uncleared): new native activity never brings it back.
test('round 2 review: a manual purge over a cleared retention marker with fresh_at resets it and stays suppressed', async () => {
  const h = await imported();
  const { db, dataDir } = h;
  const at = Date.now() - 60_000;
  await purgeSession(h.writer, h.sid, { dataDir, backupDir: join(dataDir, 'backups'), secret: SECRET, now: at, reason: 'retention' });
  db.prepare('UPDATE suppressions SET fresh_at = ?').run(at + 1);
  h.writer.transact((tdb) => clearMarker(tdb, WHO, at + 2)); // cleared by that activity: files reset for a whole re-read
  await h.adapter.backfill(); // re-imported
  const sid = (db.prepare('SELECT id FROM sessions WHERE native_session_id = ?').get(S) as { id: number }).id;
  await purgeSession(h.writer, sid, { dataDir, backupDir: join(dataDir, 'backups'), secret: SECRET, now: Date.now(), reason: 'manual' });
  const m = { ...db.prepare('SELECT reason, fresh_at, cleared_at FROM suppressions').get() } as Record<string, unknown>;
  assert.deepEqual(m, { reason: 'manual', fresh_at: null, cleared_at: null });
  appendFileSync(h.transcript, continued(Date.now() + 1_000));
  await h.adapter.backfill();
  await resumePurges(h.writer, { dataDir, backupDir: join(dataDir, 'backups'), secret: SECRET, now: Date.now() + 60_000 });
  await h.adapter.backfill();
  assert.equal(count(db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', S), 0, 'stays out');
});
