// XAIBO-PROD-511 (P5-T03; FR-11, FR-12, EC-42): manual Delete moves a session to Trash (overlay only); Undo and Restore
// put the overlay back exactly; Trash auto-empty eligibility is elapsed 30 × 24 h; trashed sessions leave All sessions,
// the live set and deltas; Trash and restore touch no table but overlays (monthly totals, FR-52).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../../src/service/store/db.ts';
import { applyOverlay, listHistory } from '../../../src/service/history/overlay.ts';
import { expiredTrash, TRASH_MS, trashExpired, trashPurgeAt } from '../../../src/service/history/trash.ts';
import { answerLiveSet, listSessions, sessionsByKey } from '../../../src/service/api.ts';
import type { HistoryFilter, LiveStatus, OverlayOp } from '../../../src/shared/ipc.ts';

const T = 1_700_000_000_000;
const DAY = 24 * 3600_000;
const sid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

async function store(n = 4) {
  const tmp = mkdtempSync(join(tmpdir(), 'xtrash-'));
  const { db } = await openStore({ file: join(tmp, 'xaibo.db'), backupDir: join(tmp, 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  const ins = db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id, cwd, last_activity) VALUES ('claude', 'p1', ?, ?, ?)");
  for (let i = 1; i <= n; i++) ins.run(sid(i), `/tmp/xaibo-fixture/w${i}`, T - i);
  return db;
}
const op = (db: DatabaseSync, o: OverlayOp, now = T, readOnly = false) => applyOverlay(db, o, { readOnly, now });
const trash = (db: DatabaseSync, session: number, on: boolean, now = T) => assert.deepEqual(op(db, { kind: 'trash', session, on }, now), { ok: true });
const history = (db: DatabaseSync, mode: HistoryFilter['mode']) => listHistory(db, { mode, agent: null, project: null, folder: null }, null, 100).rows;
const overlay = (db: DatabaseSync, n: number) => db.prepare('SELECT * FROM overlays WHERE native_session_id = ?').get(sid(n)) ?? null;
const status: LiveStatus = { lifecycle: 'busy', confidence: 'confirmed', health: 'connected', reason: null, outcome: null, findings: [], since: null };

test('Delete moves to Trash: out of All sessions, in Trash with its deletion and purge times; a second Delete keeps the first time', async () => {
  const db = await store();
  trash(db, 2, true);
  assert.deepEqual(history(db, 'all').map((r) => r.id), [1, 3, 4]);
  const rows = history(db, 'trash');
  assert.deepEqual(rows.map((r) => [r.id, r.trashedAt, r.trashPurgeAt]), [[2, T, T + 30 * DAY]]);
  trash(db, 2, true, T + 5);
  assert.equal(history(db, 'trash')[0]!.trashedAt, T);
  assert.ok(history(db, 'all').every((r) => r.trashedAt === null && r.trashPurgeAt === null));
  op(db, { kind: 'archive', session: 2, on: true }); // an archived and trashed session is in Trash only
  assert.deepEqual(history(db, 'archived'), []);
});

test('Undo and Restore put the overlay back exactly, including no overlay row at all', async () => {
  const db = await store();
  const p = op(db, { kind: 'newProject', name: 'Alpha' });
  assert.ok(p.ok && p.id);
  op(db, { kind: 'pin', session: 1, on: true });
  op(db, { kind: 'archive', session: 1, on: true }, T - 10);
  op(db, { kind: 'move', session: 1, project: p.id, folder: null });
  const before = overlay(db, 1);
  trash(db, 1, true);
  trash(db, 1, false, T + DAY);
  assert.deepEqual(overlay(db, 1), before);
  // a session with no overlay row has none after Delete + Undo
  assert.equal(overlay(db, 3), null);
  trash(db, 3, true);
  trash(db, 3, false);
  assert.equal(overlay(db, 3), null);
  // restoring a session that is not in Trash changes nothing
  trash(db, 4, false);
  assert.equal(overlay(db, 4), null);
  assert.deepEqual(history(db, 'trash'), []);
  assert.deepEqual(op(db, { kind: 'trash', session: 1, on: true }, T, true), { ok: false, error: 'read-only' });
  assert.deepEqual(op(db, { kind: 'trash', session: 99, on: true }), { ok: false, error: 'not-found' });
});

test('EC-42: expiry is elapsed 30 × 24 h from deletion, whatever the zone or DST; Keep does not protect Trash', async () => {
  assert.equal(TRASH_MS, 30 * DAY);
  const db = await store(1);
  const at = Date.UTC(2026, 2, 1, 12); // a span crossing a spring-forward change in DST zones
  trash(db, 1, true, at);
  db.prepare('UPDATE overlays SET keep = 1').run();
  assert.equal(trashPurgeAt(at), at + 30 * DAY);
  assert.deepEqual(expiredTrash(db, at + 30 * DAY - 1, 10), []);
  assert.deepEqual(expiredTrash(db, at + 30 * DAY, 10), [1]);
  assert.deepEqual(expiredTrash(db, at + 30 * DAY - 3600_000, 10), []); // 30 local calendar days across a DST change is 1 h short
  assert.deepEqual(expiredTrash(db, at - 1, 10), []); // a clock set back never expires early
  for (const [now, want] of [[at + 30 * DAY - 1, false], [at + 30 * DAY, true], [at + 30 * DAY - 3600_000, false], [at - 1, false]] as const) {
    assert.equal(trashExpired(at, now), want, String(now - at)); // the same rule for a single row
  }
});

test('expiredTrash lists eligible sessions oldest deletion first, bounded, through the trashed_at index', async () => {
  const db = await store(5);
  trash(db, 3, true, T - 40 * DAY);
  trash(db, 1, true, T - 31 * DAY);
  trash(db, 2, true, T - 30 * DAY);
  trash(db, 4, true, T - 29 * DAY);  // not yet
  trash(db, 5, true, T - 50 * DAY);
  trash(db, 5, false);               // restored
  assert.deepEqual(expiredTrash(db, T, 100), [3, 1, 2]);
  assert.deepEqual(expiredTrash(db, T, 2), [3, 1]);
  const seen: string[] = [];
  const spy = new Proxy(db, { get(t, k) {
    if (k === 'prepare') return (sql: string) => { seen.push(sql); return t.prepare(sql); };
    const v = Reflect.get(t, k) as unknown;
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  } });
  expiredTrash(spy, T, 10);
  const plan = seen.flatMap((sql) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(T, 10) as { detail: string }[]).map((r) => r.detail));
  assert.ok(plan.some((d) => d.includes('overlays_trashed')), plan.join(' | '));
});

test('trashed sessions leave the session list page, the live set and live deltas; restore brings them back', async () => {
  const db = await store();
  const live = () => status;
  trash(db, 2, true);
  assert.deepEqual(listSessions(db, null, 100).rows.map((r) => r.id), [1, 3, 4]);
  assert.deepEqual(answerLiveSet(db, { v: 1, type: 'liveSet', id: 1 }, T, [], [], live).rows.map((r) => r.id), [1, 3, 4]);
  const key = { agent: 'claude', profileId: 'p1', nativeSessionId: sid(2) };
  assert.deepEqual(sessionsByKey(db, [key], [], [], live), []);
  trash(db, 2, false);
  assert.deepEqual(listSessions(db, null, 100).rows.map((r) => r.id), [1, 2, 3, 4]);
  assert.deepEqual(sessionsByKey(db, [key], [], [], live).map((r) => r.id), [2]);
});

test('FR-52: Delete and Restore write only the overlay, so usage, cost and monthly data are untouched', async () => {
  const db = await store();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'overlays' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'").all() as { name: string }[]).map((t) => t.name);
  const snap = () => JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM "${t}"`).all()));
  const before = snap();
  trash(db, 1, true);
  assert.equal(snap(), before);
  trash(db, 1, false);
  assert.equal(snap(), before);
});
