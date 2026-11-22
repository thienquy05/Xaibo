// XAIBO-PROD-554 (D-P5-17 part 1; design §6.4 Filters, §6.1.1 month -> retained sessions; decision D-P6-05): the Session
// list's cwd (path prefix on a path boundary), date range (activity overlap), state (record markers) and model (a usage
// row or turn of that model) filters: strict shapes at the IPC trust boundary, applied by the history list (search uses the
// same scopeWhere and refuses pinned/kept without the overlay tables, search/query.ts).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/service/store/db.ts';
import { applyOverlay, listHistory } from '../../src/service/history/overlay.ts';
import { parsePortRequest, type HistoryFilter } from '../../src/shared/ipc.ts';
import { request as usageRow, turn } from '../helpers/monthly.ts';

const T = Date.UTC(2026, 10, 10);
const DAY = 86_400_000;
const sid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** 1 /w/app (Nov 1-3, model m-a in a turn) · 2 /w/app/sub (Nov 9-12, m-b in usage, pinned) · 3 /w/apple (Oct 1-2, kept) ·
 *  4 no cwd, only a start (Nov 20) · 5 /w/app (Dec 1-5, native deleted) · 6 /w/other (Nov 10, native archived) */
async function store() {
  const tmp = mkdtempSync(join(tmpdir(), 'xfilters-'));
  dirs.push(tmp);
  const { db } = await openStore({ file: join(tmp, 'xaibo.db'), backupDir: join(tmp, 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  const ins = db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id, cwd, started_at, last_activity, native_available, native_archived) VALUES ('claude', 'p1', ?, ?, ?, ?, ?, ?)");
  const d = (m: number, day: number) => Date.UTC(2026, m, day);
  ins.run(sid(1), '/w/app', d(10, 1), d(10, 3), 1, 0);
  ins.run(sid(2), '/w/app/sub', d(10, 9), d(10, 12), 1, 0);
  ins.run(sid(3), '/w/apple', d(9, 1), d(9, 2), 1, 0);
  ins.run(sid(4), null, d(10, 20), null, 1, 0);
  ins.run(sid(5), '/w/app', d(11, 1), d(11, 5), 0, 0);
  ins.run(sid(6), '/w/other', d(10, 10), d(10, 10), 1, 1);
  ins.run(sid(7), null, null, null, 1, 0); // review L: no time at all never falls in a date range
  turn(db, 1, 't1', d(10, 1), 'm-a');
  usageRow(db, 2, { identity: 's2-r1', ts: d(10, 10), model: 'm-b', input: 1, output: 1 });
  applyOverlay(db, { kind: 'pin', session: 2, on: true }, { readOnly: false, now: T });
  applyOverlay(db, { kind: 'keep', session: 3, on: true }, { readOnly: false, now: T });
  return db;
}
const base: HistoryFilter = { mode: 'all', agent: null, project: null, folder: null };
const ids = (db: DatabaseSync, f: Partial<HistoryFilter>) => listHistory(db, { ...base, ...f }, null, 100).rows.map((r) => r.id).sort((a, b) => a - b);
const request = (filter: unknown) => parsePortRequest({ v: 1, type: 'history', id: 1, filter, cursor: null, limit: 50 });

test('IPC: each new key only in its valid shape; unknown keys and bad values are refused', () => {
  for (const f of [{ cwd: '/w/app' }, { from: T, to: T + DAY }, { from: T, to: T }, { state: 'pinned' }, { state: 'kept' }, { state: 'native-deleted' },
    { state: 'native-archived' }, { model: 'm-a' }, { cwd: '/w', from: T, to: T + DAY, state: 'kept', model: 'm-b' }]) {
    const r = request({ ...base, ...f });
    assert.ok(r && r.type === 'history', JSON.stringify(f));
    assert.deepEqual(r.filter, { ...base, ...f });
  }
  for (const f of [{ cwd: '' }, { cwd: 'x'.repeat(4097) }, { cwd: 5 }, { from: T }, { to: T }, { from: T + 1, to: T }, { from: 1.5, to: 2 },
    { from: -1, to: 2 }, { state: 'live' }, { state: 'PINNED' }, { state: '__proto__' }, { model: '' }, { model: 'x'.repeat(257) }, { unknown: 1 }]) {
    assert.equal(request({ ...base, ...f }), null, JSON.stringify(f));
  }
  assert.equal(request(JSON.parse('{"mode":"all","agent":null,"project":null,"folder":null,"__proto__":{"cwd":"/w"}}')), null, 'an own __proto__ key is an unknown key');
});

test('cwd: the folder and below on a path boundary (/w/app never matches /w/apple)', async () => {
  const db = await store();
  assert.deepEqual(ids(db, { cwd: '/w/app' }), [1, 2, 5]);
  assert.deepEqual(ids(db, { cwd: '/w/app/' }), [1, 2, 5], 'a trailing slash is the same folder');
  assert.deepEqual(ids(db, { cwd: '/w/app/sub' }), [2]);
  assert.deepEqual(ids(db, { cwd: '/w' }), [1, 2, 3, 5, 6]);
  assert.deepEqual(ids(db, { cwd: '/w/app%' }), [], 'LIKE wildcards are plain text');
});

test('date range: sessions whose activity overlaps [from, to); a start-only session counts at its start', async () => {
  const db = await store();
  assert.deepEqual(ids(db, { from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 11, 1) }), [1, 2, 4, 6]);
  assert.deepEqual(ids(db, { from: Date.UTC(2026, 10, 11), to: Date.UTC(2026, 10, 12) }), [2], 'inside a session span');
  assert.deepEqual(ids(db, { from: Date.UTC(2026, 10, 3), to: Date.UTC(2026, 10, 3) + 1 }), [1], 'its last activity is in range');
  assert.deepEqual(ids(db, { from: Date.UTC(2026, 11, 1), to: Date.UTC(2027, 0, 1) }), [5]);
});

test('state: pinned, kept, native deleted, native archived', async () => {
  const db = await store();
  assert.deepEqual(ids(db, { state: 'pinned' }), [2]);
  assert.deepEqual(ids(db, { state: 'kept' }), [3]);
  assert.deepEqual(ids(db, { state: 'native-deleted' }), [5]);
  assert.deepEqual(ids(db, { state: 'native-archived' }), [6]);
});

test('model: a usage row or a turn of that model; combined with the other filters (the month link query)', async () => {
  const db = await store();
  assert.deepEqual(ids(db, { model: 'm-a' }), [1]);
  assert.deepEqual(ids(db, { model: 'm-b' }), [2]);
  assert.deepEqual(ids(db, { model: 'm-none' }), []);
  assert.deepEqual(ids(db, { model: 'm-b', from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 11, 1), cwd: '/w/app' }), [2]);
  assert.deepEqual(ids(db, { model: 'm-b', state: 'kept' }), []);
});
