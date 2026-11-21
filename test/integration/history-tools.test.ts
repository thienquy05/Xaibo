// XAIBO-PROD-527 (P5-T18 part 1; design §6.4, §6.6, US-5, US-6, FR-11, FR-12): the service side of the Session history
// tools and Settings retention/storage. Search replies carry each hit's history row and a plain snippet, scoped like the
// list; history rows show Keep and the same purge date the retention job uses (coalesce(last activity, start) + days;
// none for Keep, Never, an unreadable setting or Trash rows); the retention setting is validated and saved through the
// writer; suppressed sessions are listed by an opaque domain-separated key with a profile label, newest first, paged by
// {at, key}; manual purge is capped per minute (D-P5-07); Re-import by key sets Keep (D-P5-08); every reply passes the
// renderer's parser and requests are parsed strictly.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { profileLabel } from '../../src/service/api.ts';
import { applyOverlay, listHistory } from '../../src/service/history/overlay.ts';
import { purgeSession } from '../../src/service/history/purge.ts';
import { clear } from '../../src/service/history/suppression.ts';
import { answerHistoryRow, answerSearch, findSuppressed, PurgeLimit, purgeManual, reimportKey, rerunner, retentionState, saveRetention, suppressedPage, suppressionKey } from '../../src/service/history/tools.ts';
import { DAY } from '../../src/service/retention/policy.ts';
import { ftsPrefix } from '../../src/service/store/writer.ts';
import { parsePortMessage, parsePortRequest, RETENTION_MAX, type HistoryFilter } from '../../src/shared/ipc.ts';
import { hookStore } from '../helpers/hook-store.ts';
import { SECRET, session } from '../helpers/monthly.ts';

const NOW = Date.UTC(2026, 10, 18, 12);
const HOME = '/tmp/xaibo-fixture/home';
const ALL: HistoryFilter = { mode: 'all', agent: null, project: null, folder: null };

async function store() {
  const h = await hookStore();
  let seq = 0;
  const add = (sid: string, last: number | null = NOW - DAY, started: number | null = last) => session(h.db, { sid, last, started });
  /** An event with its FTS row as the writer stores it. */
  const ev = (sessionId: number, content: string) => {
    const id = Number(h.db.prepare(`INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, role, source_seq, received_ts, injected, content, revision_status)
      VALUES (?, 1, 'transcript', 'observed', ?, 'user', 'user', ?, ?, 0, ?, 'current')`).run(sessionId, `n${++seq}`, seq, NOW, content).lastInsertRowid);
    h.db.prepare('INSERT INTO event_fts (rowid, content) VALUES (?, ?)').run(id, ftsPrefix(content));
  };
  const files = (now = NOW) => ({ dataDir: h.dir, backupDir: join(h.dir, 'backups'), secret: SECRET, now });
  return { ...h, add, ev, files };
}
const n = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;
const row = (db: DatabaseSync, id: number) => listHistory(db, { ...ALL, mode: 'all' }, null, 100).rows.find((r) => r.id === id)
  ?? listHistory(db, { ...ALL, mode: 'trash' }, null, 100).rows.find((r) => r.id === id)!;
const reply = <T extends object>(type: string, body: T) => parsePortMessage({ v: 1, type, id: 1, ...body });

test('search: each hit carries its history row and a plain snippet; scoped like the list; paged; the reply parses', async () => {
  const s = await store();
  const a = s.add('srch-a'), b = s.add('srch-b'), c = s.add('srch-c');
  s.ev(a, 'alpha bravo notes');
  s.ev(b, 'alpha charlie notes');
  s.ev(c, 'alpha in the trash');
  applyOverlay(s.db, { kind: 'trash', session: c, on: true }, { readOnly: false, now: NOW });
  const first = answerSearch(s.db, { query: 'alpha', filter: ALL, cursor: null, limit: 1 });
  assert.equal(first.hits.length, 1);
  assert.ok(first.next);
  const second = answerSearch(s.db, { query: 'alpha', filter: ALL, cursor: first.next, limit: 1 });
  const ids = [...first.hits, ...second.hits].map((h) => h.row.id).sort((x, y) => x - y);
  assert.deepEqual(ids, [a, b], 'All leaves Trash out');
  assert.match(first.hits[0]!.snippet, /alpha/);
  assert.equal(typeof first.hits[0]!.event, 'number');
  assert.ok(reply('search', first), 'the reply passes the renderer parser');
  assert.deepEqual(answerSearch(s.db, { query: 'alpha', filter: { ...ALL, mode: 'trash' }, cursor: null, limit: 10 }).hits.map((h) => h.row.id), [c]);
  assert.deepEqual(answerSearch(s.db, { query: '"(*', filter: ALL, cursor: null, limit: 10 }).hits, [], 'syntax in the text never errors');
  // review H1: a snippet of 200 code points can be ~400 UTF-16 units (emoji); the reply must still parse
  const e = s.add('srch-emoji');
  s.ev(e, `emoji ${'😀'.repeat(300)}`);
  const emoji = answerSearch(s.db, { query: 'emoji', filter: ALL, cursor: null, limit: 10 });
  assert.equal(emoji.hits.length, 1);
  assert.ok(reply('search', emoji), 'an emoji snippet parses');
  // review L1: a failed reply carries nothing; failed applies only where defined
  assert.equal(reply('search', { ...first, failed: true }), null, 'failed with hits is rejected');
  assert.ok(reply('search', { hits: [], next: null, failed: true }));
  assert.equal(reply('purge', { result: 'purged', failed: true }), null, 'purge has no failed field');
});

test('Keep and purge date: the date the job uses (last activity, else start, + days); none for Keep, Never, unreadable or Trash', async () => {
  const s = await store();
  const a = s.add('keep-a', NOW - 10 * DAY);
  const b = s.add('keep-b', null, NOW - 20 * DAY); // no last activity: the job falls back to the start (design review M1)
  const c = s.add('keep-c', null, null);
  assert.deepEqual([row(s.db, a).keep, row(s.db, a).purgeAt], [false, NOW - 10 * DAY + 45 * DAY]);
  assert.equal(row(s.db, b).purgeAt, NOW - 20 * DAY + 45 * DAY);
  assert.equal(row(s.db, c).purgeAt, null, 'no time at all');
  assert.equal(applyOverlay(s.db, { kind: 'keep', session: a, on: true }, { readOnly: false, now: NOW }).ok, true);
  assert.deepEqual([row(s.db, a).keep, row(s.db, a).purgeAt], [true, null]);
  applyOverlay(s.db, { kind: 'keep', session: a, on: false }, { readOnly: false, now: NOW });
  assert.equal(row(s.db, a).keep, false);
  assert.equal(n(s.db, 'SELECT count(*) AS n FROM overlays'), 0, 'Keep off at every default leaves no overlay row');
  applyOverlay(s.db, { kind: 'trash', session: b, on: true }, { readOnly: false, now: NOW });
  assert.equal(row(s.db, b).purgeAt, null, 'a Trash row has its Trash date instead');
  assert.equal(saveRetention(s.writer, 'never'), 'saved');
  assert.equal(row(s.db, a).purgeAt, null, 'Never');
  s.db.prepare("UPDATE kv SET value = 'garbled' WHERE key = 'retention.sessions'").run();
  assert.equal(row(s.db, a).purgeAt, null, 'unreadable setting: no date');
  assert.ok(reply('history', { rows: [row(s.db, a)], next: null }), 'rows with keep and purgeAt pass the parser');
});

test('retention: the stored setting and last run; save validates through the shared bound; unreadable reads null', async () => {
  const s = await store();
  assert.deepEqual(retentionState(s.db), { setting: { days: 45 }, lastRunAt: null });
  assert.equal(saveRetention(s.writer, { days: 10 }), 'saved');
  assert.deepEqual(retentionState(s.db).setting, { days: 10 });
  for (const bad of [{ days: 0 }, { days: RETENTION_MAX + 1 }, { days: 1.5 }, { days: Number.NaN }, 'always', null]) {
    assert.equal(saveRetention(s.writer, bad), 'invalid', JSON.stringify(bad));
  }
  assert.deepEqual(retentionState(s.db).setting, { days: 10 }, 'unchanged by invalid values');
  assert.equal(saveRetention(s.writer, 'never'), 'saved');
  assert.equal(retentionState(s.db).setting, 'never');
  s.db.prepare("INSERT INTO kv (key, value) VALUES ('retention.lastRunAt', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(NOW));
  s.db.prepare("UPDATE kv SET value = 'garbled' WHERE key = 'retention.sessions'").run();
  assert.deepEqual(retentionState(s.db), { setting: null, lastRunAt: NOW });
  assert.ok(reply('retention', retentionState(s.db)));
});

test('suppressed: opaque domain-separated keys, profile labels, newest first, paged by {at, key}; cleared ones left out; no ids', async () => {
  const s = await store();
  const ids = ['sup-1', 'sup-2', 'sup-3', 'sup-4'].map((sid) => s.add(sid));
  for (const [i, id] of ids.entries()) assert.equal((await purgeSession(s.writer, id, { ...s.files(NOW + i * 1000), reason: i === 3 ? 'retention' : 'manual' })).purged, true);
  clear(s.db, { agent: 'claude', profile: 'p1', native: 'sup-2' }, NOW + 10_000); // re-imported: no longer listed
  s.db.prepare("INSERT INTO suppressions (agent, profile_id, native_session_id, reason, at) VALUES ('claude', 'gone-profile', 'sup-gone', 'manual', ?)").run(NOW - 1000);
  const first = suppressedPage(s.db, SECRET, HOME, null, 2);
  assert.deepEqual(first.rows.map((r) => [r.reason, r.at]), [['retention', NOW + 3000], ['manual', NOW + 2000]]);
  const second = suppressedPage(s.db, SECRET, HOME, first.next, 2);
  assert.deepEqual(second.rows.map((r) => r.at), [NOW, NOW - 1000]);
  assert.equal(second.next, null);
  const all = [...first.rows, ...second.rows];
  const root = (s.db.prepare("SELECT root FROM profiles WHERE id = 'p1'").get() as { root: string }).root;
  assert.ok(all.every((r) => /^[0-9a-f]{64}$/.test(r.key) && r.agent === 'claude' && r.filesPending === false));
  assert.deepEqual(all.map((r) => r.profile), [...Array(3).fill(profileLabel('default', root, HOME)), 'Unavailable']);
  assert.equal(all[0]!.key, suppressionKey(SECRET, { agent: 'claude', profile: 'p1', native: 'sup-4' }));
  const json = JSON.stringify(all);
  for (const canary of ['sup-1', 'sup-3', 'sup-4', 'sup-gone', 'gone-profile', '"p1"']) assert.ok(!json.includes(canary), `no ${canary}`);
  assert.ok(reply('suppressed', first));
  assert.deepEqual(findSuppressed(s.db, SECRET, all[0]!.key), { agent: 'claude', profile: 'p1', native: 'sup-4' });
  assert.equal(findSuppressed(s.db, SECRET, 'f'.repeat(64)), null);
  assert.equal(findSuppressed(s.db, SECRET, suppressionKey(SECRET, { agent: 'claude', profile: 'p1', native: 'sup-2' })), null, 'a cleared marker is not found');
});

test('manual purge: purged and not-found; at most 10 per minute, then busy; the window moves on (D-P5-07)', async () => {
  const s = await store();
  let t = NOW;
  const limit = new PurgeLimit(() => t);
  const ids = Array.from({ length: 12 }, (_, i) => s.add(`cap-${i}`));
  assert.equal(await purgeManual(s.writer, 999_999, { ...s.files(), limit }), 'not-found');
  for (let i = 0; i < 10; i++) assert.equal(await purgeManual(s.writer, ids[i]!, { ...s.files(), limit }), 'purged', `purge ${i}`);
  assert.equal(await purgeManual(s.writer, ids[10]!, { ...s.files(), limit }), 'busy');
  assert.ok(s.db.prepare("SELECT 1 FROM sessions WHERE native_session_id = 'cap-10'").get(), 'nothing purged when busy');
  t += 60_001;
  assert.equal(await purgeManual(s.writer, ids[10]!, { ...s.files(t), limit }), 'purged');
  assert.equal((s.db.prepare("SELECT reason FROM suppressions WHERE native_session_id = 'cap-0'").get() as { reason: string }).reason, 'manual');
});

test('Re-import by key clears the marker and sets Keep for the returning session (D-P5-08); an unknown key is not-found', async () => {
  const s = await store();
  const id = s.add('ri-a', NOW - 200 * DAY);
  await purgeSession(s.writer, id, { ...s.files(), reason: 'retention' });
  const key = suppressionKey(SECRET, { agent: 'claude', profile: 'p1', native: 'ri-a' });
  assert.equal(reimportKey(s.writer, s.db, 'f'.repeat(64), s.files()), 'not-found');
  assert.equal(reimportKey(s.writer, s.db, key, s.files()), 'ok');
  assert.ok(s.db.prepare("SELECT 1 FROM suppressions WHERE native_session_id = 'ri-a' AND cleared_at IS NOT NULL").get());
  assert.equal(n(s.db, "SELECT keep AS n FROM overlays WHERE native_session_id = 'ri-a'"), 1, 'Keep set before the rescan brings it back');
  const back = s.add('ri-a', NOW - 200 * DAY); // the rescan re-imports it
  assert.deepEqual([row(s.db, back).keep, row(s.db, back).purgeAt], [true, null]);
  assert.equal(reimportKey(s.writer, s.db, key, s.files()), 'not-found', 'already cleared');
});

test('re-review M1: Re-import sweeps run one at a time; requests during a sweep merge into one more sweep', async () => {
  let runs = 0, release: () => void = () => {};
  const sweep = rerunner(async () => { runs++; await new Promise<void>((r) => { release = r; }); });
  sweep(); // starts
  sweep(); sweep(); sweep(); // during it: one more, not three
  assert.equal(runs, 1);
  release(); await new Promise((r) => setImmediate(r));
  assert.equal(runs, 2, 'one follow-up sweep');
  release(); await new Promise((r) => setImmediate(r));
  assert.equal(runs, 2, 'nothing more queued');
  sweep();
  assert.equal(runs, 3, 'idle again: a new request starts at once');
  release();
});

test('IPC: the new requests and replies parse strictly', () => {
  const ok = (m: object) => assert.ok(parsePortRequest({ v: 1, id: 2, ...m }), JSON.stringify(m));
  const no = (m: object) => assert.equal(parsePortRequest({ v: 1, id: 2, ...m }), null, JSON.stringify(m));
  ok({ type: 'search', query: 'alpha', filter: ALL, cursor: null, limit: 50 });
  ok({ type: 'search', query: 'alpha', filter: ALL, cursor: { rank: -1.25, session: 3, event: 9 }, limit: 50 });
  no({ type: 'search', query: '', filter: ALL, cursor: null, limit: 50 });
  no({ type: 'search', query: 'x'.repeat(257), filter: ALL, cursor: null, limit: 50 });
  no({ type: 'search', query: 'a', filter: ALL, cursor: { rank: Number.NaN, session: 3, event: 9 }, limit: 50 });
  no({ type: 'search', query: 'a', filter: ALL, cursor: { rank: Infinity, session: 3, event: 9 }, limit: 50 });
  ok({ type: 'purge', session: 4 });
  no({ type: 'purge', session: 0 });
  no({ type: 'purge', session: [4, 5] });
  ok({ type: 'suppressed', cursor: null, limit: 50 });
  ok({ type: 'suppressed', cursor: { at: NOW, key: 'a'.repeat(64) }, limit: 50 });
  no({ type: 'suppressed', cursor: { at: NOW, key: 'A'.repeat(64) }, limit: 50 });
  ok({ type: 'reimport', key: '0'.repeat(64) });
  no({ type: 'reimport', key: '0'.repeat(63) });
  ok({ type: 'retention' });
  ok({ type: 'setRetention', value: { days: 30 } });
  ok({ type: 'setRetention', value: 'never' });
  no({ type: 'setRetention', value: { days: RETENTION_MAX + 1 } });
  no({ type: 'setRetention', value: { days: 30, extra: 1 } });
  ok({ type: 'storage', refresh: true });
  no({ type: 'storage', refresh: 'yes' });
  ok({ type: 'overlay', op: { kind: 'keep', session: 4, on: true } });
  const msg = (m: object) => parsePortMessage({ v: 1, id: 2, ...m });
  for (const result of ['purged', 'not-found', 'busy', 'read-only', 'disk-full', 'failed']) assert.ok(msg({ type: 'purge', result }), result);
  assert.equal(msg({ type: 'purge', result: 'done' }), null);
  for (const result of ['ok', 'none', 'pending', 'native-gone', 'not-found', 'read-only', 'disk-full', 'failed']) assert.ok(msg({ type: 'reimport', result }), result);
  for (const result of ['saved', 'invalid', 'read-only', 'disk-full', 'failed']) assert.ok(msg({ type: 'setRetention', result }), result);
  assert.ok(msg({ type: 'storage', report: null }));
  assert.ok(msg({ type: 'storage', report: null, failed: true }));
  assert.equal(msg({ type: 'retention', setting: { days: 0 }, lastRunAt: null }), null);
});

// XAIBO-PROD-531 (P5-T18 part 3b-2): one session's history row by id, the same row the list shows (row actions refresh
// their record; the open session shows Keep and the purge date); unknown id null; a store that cannot answer says failed.
test('historyRow: the list row by id (Keep, purge date, Trash); unknown null; closed or failing store failed; strict IPC', async () => {
  const s = await store();
  const a = s.add('one-a', NOW - 10 * DAY), b = s.add('one-b');
  applyOverlay(s.db, { kind: 'pin', session: a, on: true }, { readOnly: false, now: NOW });
  applyOverlay(s.db, { kind: 'trash', session: b, on: true }, { readOnly: false, now: NOW });
  assert.deepEqual(answerHistoryRow(s.db, a), { row: row(s.db, a) });
  assert.equal(answerHistoryRow(s.db, a).row?.purgeAt, NOW - 10 * DAY + 45 * DAY);
  assert.deepEqual(answerHistoryRow(s.db, b), { row: row(s.db, b) }, 'a Trash row too');
  assert.notEqual(answerHistoryRow(s.db, b).row?.trashPurgeAt, null);
  assert.deepEqual(answerHistoryRow(s.db, 999_999), { row: null }, 'no such session');
  assert.ok(reply('historyRow', answerHistoryRow(s.db, a)), 'the reply parses');
  assert.ok(reply('historyRow', { row: null }));
  assert.ok(reply('historyRow', { row: null, failed: true }));
  assert.equal(reply('historyRow', { row: row(s.db, a), failed: true }), null, 'failed carries no row');
  assert.equal(reply('historyRow', { row: { ...row(s.db, a), keep: 'yes' } }), null);
  assert.equal(reply('historyRow', { rows: [] }), null);
  const failing = { ...s.db, isOpen: true, prepare: () => { throw new Error('busy'); } } as unknown as DatabaseSync;
  assert.deepEqual(answerHistoryRow(failing, a), { row: null, failed: true }, 'a throwing store');
  assert.deepEqual(answerHistoryRow({ isOpen: false } as unknown as DatabaseSync, a), { row: null, failed: true }, 'a closed store');
  const req = (m: object) => parsePortRequest({ v: 1, id: 2, type: 'historyRow', ...m });
  assert.deepEqual(req({ session: 4 }), { v: 1, id: 2, type: 'historyRow', session: 4 });
  for (const bad of [{ session: 0 }, { session: -1 }, { session: 1.5 }, { session: '4' }, { session: [4] }, {}, { session: 4, agent: 'claude' }])
    assert.equal(req(bad), null, JSON.stringify(bad));
});
