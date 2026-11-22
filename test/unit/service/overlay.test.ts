// XAIBO-PROD-504 (P5-T01; FR-10, US-5): overlay state keyed by (agent, profile, native_session_id), only in Xaibo's DB.
// Ops are idempotent and validated; a move keeps identity; read-only refuses; pinned first, then last activity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../../src/service/store/db.ts';
import { applyOverlay, approvedLabel, FOLDERS_MAX, LABEL_MAX, listFolders, listHistory, listProjects, PROJECTS_MAX } from '../../../src/service/history/overlay.ts';
import * as overlay from '../../../src/service/history/overlay.ts';
import type { HistoryFilter, HistoryKey, OverlayOp, OverlayResult } from '../../../src/shared/ipc.ts';

const T = 1_700_000_000_000;
const sid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

async function store(n = 5) {
  const tmp = mkdtempSync(join(tmpdir(), 'xoverlay-'));
  const { db } = await openStore({ file: join(tmp, 'xaibo.db'), backupDir: join(tmp, 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', '/tmp/xaibo-fixture/codex', 'default')").run();
  const ins = db.prepare('INSERT INTO sessions (agent, profile_id, native_session_id, cwd, last_activity) VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i <= n; i++) ins.run(i % 2 ? 'claude' : 'codex', i % 2 ? 'p1' : 'p2', sid(i), `/tmp/xaibo-fixture/${i === 5 ? 'alpha' : `w${i}`}`, T + i);
  return db;
}
const op = (db: DatabaseSync, o: OverlayOp, readOnly = false) => applyOverlay(db, o, { readOnly, now: T });
const rows = (db: DatabaseSync, filter: Partial<HistoryFilter> = {}, limit = 100, cursor: HistoryKey | null = null) =>
  listHistory(db, { mode: 'all', agent: null, project: null, folder: null, ...filter }, cursor, limit);
const ids = (db: DatabaseSync, filter: Partial<HistoryFilter> = {}) => rows(db, filter).rows.map((r) => r.id);
const sessionsSnapshot = (db: DatabaseSync) => JSON.stringify(db.prepare('SELECT * FROM sessions ORDER BY id').all());
const idOf = (r: ReturnType<typeof op>) => (r.ok ? r.id! : 0);

test('pin and archive are idempotent toggles; archive keeps its first time', async () => {
  const db = await store();
  assert.deepEqual(op(db, { kind: 'pin', session: 2, on: true }), { ok: true });
  assert.deepEqual(op(db, { kind: 'pin', session: 2, on: true }), { ok: true });
  assert.deepEqual(rows(db).rows.filter((r) => r.pinned).map((r) => r.id), [2]);
  op(db, { kind: 'pin', session: 2, on: false });
  assert.deepEqual(rows(db).rows.filter((r) => r.pinned), []);
  op(db, { kind: 'archive', session: 3, on: true });
  applyOverlay(db, { kind: 'archive', session: 3, on: true }, { readOnly: false, now: T + 99 });
  assert.equal(rows(db).rows.find((r) => r.id === 3)!.archivedAt, T);
  op(db, { kind: 'archive', session: 3, on: false });
  assert.equal(rows(db).rows.find((r) => r.id === 3)!.archivedAt, null);
});

test('projects and folders: trimmed NFC names, idempotent create, folder belongs to its project; a move keeps identity', async () => {
  const db = await store();
  const before = sessionsSnapshot(db);
  const a = op(db, { kind: 'newProject', name: '  Alpha  ' });
  assert.ok(a.ok && a.id);
  assert.deepEqual(op(db, { kind: 'newProject', name: 'Alpha' }), a, 'the same name returns the existing project');
  const [pa, pb] = [a, op(db, { kind: 'newProject', name: 'Beta' })].map(idOf);
  const [fA, fB] = [op(db, { kind: 'newFolder', project: pa, name: 'Docs' }), op(db, { kind: 'newFolder', project: pb, name: 'Docs' })].map(idOf);
  assert.ok(fA && fB && fA !== fB, 'the same folder name in two projects');
  assert.deepEqual(op(db, { kind: 'move', session: 1, project: pa, folder: fB }), { ok: false, error: 'invalid' }, 'folder of another project');
  assert.deepEqual(op(db, { kind: 'move', session: 1, project: null, folder: fA }), { ok: false, error: 'invalid' }, 'a folder needs its project');
  assert.deepEqual(op(db, { kind: 'move', session: 1, project: pa, folder: fA }), { ok: true });
  assert.deepEqual(op(db, { kind: 'move', session: 1, project: pa, folder: fA }), { ok: true });
  const r = rows(db).rows.find((x) => x.id === 1)!;
  assert.deepEqual([r.project, r.folder], [{ id: pa, name: 'Alpha' }, { id: fA, name: 'Docs' }]);
  assert.deepEqual(ids(db, { project: pa }), [1]);
  assert.deepEqual(ids(db, { project: pb }), []);
  assert.deepEqual(ids(db, { project: pa, folder: fA }), [1]);
  op(db, { kind: 'move', session: 1, project: null, folder: null });
  const cleared = rows(db).rows.find((x) => x.id === 1)!;
  assert.deepEqual([cleared.project, cleared.folder], [null, null]);
  assert.equal(sessionsSnapshot(db), before, 'ops change only overlay tables');
  assert.deepEqual(op(db, { kind: 'newProject', name: 'Cafe\u0301' }), op(db, { kind: 'newProject', name: 'Caf\u00E9' }), 'NFC before uniqueness');
});

test('names: empty, too long, controls, bidi, zero-width, separators and lone surrogates are invalid', async () => {
  const db = await store();
  for (const name of ['', '   ', 'x'.repeat(201), 'a\u0007b', 'a\u202Eb', 'a\u200Bb', 'a\u2028b', 'a\uD800b', 'a\u2066b'])
    assert.deepEqual(op(db, { kind: 'newProject', name }), { ok: false, error: 'invalid' }, JSON.stringify(name));
  assert.ok(op(db, { kind: 'newProject', name: 'x'.repeat(200) }).ok);
  assert.ok(op(db, { kind: 'newProject', name: 'Projekt 東京 ✓' }).ok);
});

test('unknown sessions, projects and folders are not found; caps give limit', async () => {
  const db = await store();
  assert.deepEqual(op(db, { kind: 'pin', session: 999, on: true }), { ok: false, error: 'not-found' });
  assert.deepEqual(op(db, { kind: 'move', session: 1, project: 999, folder: null }), { ok: false, error: 'not-found' });
  assert.deepEqual(op(db, { kind: 'newFolder', project: 999, name: 'x' }), { ok: false, error: 'not-found' });
  const pid = idOf(op(db, { kind: 'newProject', name: 'P' }));
  const ins = db.prepare('INSERT INTO folders (project_id, name) VALUES (?, ?)');
  for (let i = 1; i < FOLDERS_MAX; i++) ins.run(pid, `f${i}`);
  assert.ok(op(db, { kind: 'newFolder', project: pid, name: 'last' }).ok);
  assert.deepEqual(op(db, { kind: 'newFolder', project: pid, name: 'over' }), { ok: false, error: 'limit' });
  const insP = db.prepare('INSERT INTO projects (name, created_at) VALUES (?, ?)');
  for (let i = 2; i < PROJECTS_MAX; i++) insP.run(`p${i}`, T);
  assert.ok(op(db, { kind: 'newProject', name: 'last' }).ok);
  assert.deepEqual(op(db, { kind: 'newProject', name: 'over' }), { ok: false, error: 'limit' });
  assert.ok(op(db, { kind: 'newProject', name: 'P' }).ok, 'an existing name is still returned at the cap');
});

test('confirmLabel: the cwd basename becomes the approved project label (created or reused); none before; invalid without a safe cwd', async () => {
  const db = await store(6);
  assert.equal(approvedLabel(db, 'claude', 'p1', sid(5)), null);
  assert.deepEqual(op(db, { kind: 'confirmLabel', session: 5 }), { ok: true, id: 1 });
  assert.equal(approvedLabel(db, 'claude', 'p1', sid(5)), 'alpha');
  db.prepare("UPDATE sessions SET cwd = '/tmp/xaibo-fixture/other/alpha' WHERE id = 6").run();
  assert.deepEqual(op(db, { kind: 'confirmLabel', session: 6 }), { ok: true, id: 1 }, 'the same name reuses the project');
  db.prepare('UPDATE sessions SET cwd = NULL WHERE id = 4').run();
  assert.deepEqual(op(db, { kind: 'confirmLabel', session: 4 }), { ok: false, error: 'invalid' });
  db.prepare("UPDATE sessions SET cwd = '/tmp/xaibo-fixture/a\u202Eb' WHERE id = 3").run();
  assert.deepEqual(op(db, { kind: 'confirmLabel', session: 3 }), { ok: false, error: 'invalid' }, 'an unsafe basename is never a label');
  assert.equal(approvedLabel(db, 'codex', 'p2', sid(4)), null);
});

test('read-only: every op is refused before any statement; nothing changes', async () => {
  const db = await store();
  for (const o of [{ kind: 'pin', session: 1, on: true }, { kind: 'newProject', name: 'x' }, { kind: 'confirmLabel', session: 5 }] as OverlayOp[])
    assert.deepEqual(op(db, o, true), { ok: false, error: 'read-only' });
  assert.equal((db.prepare('SELECT count(*) AS n FROM overlays').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n, 0);
});

test('history: pinned first, then last activity (unknown last), then id; modes and agent filter; keyset continues the order', async () => {
  const db = await store(7);
  db.prepare('UPDATE sessions SET last_activity = NULL WHERE id = 7').run();
  op(db, { kind: 'pin', session: 2, on: true });
  op(db, { kind: 'pin', session: 4, on: true });
  op(db, { kind: 'archive', session: 3, on: true });
  db.prepare("INSERT INTO overlays (agent, profile_id, native_session_id, trashed_at) VALUES ('claude', 'p1', ?, ?)").run(sid(1), T);
  assert.deepEqual(ids(db), [4, 2, 6, 5, 3, 7], 'trashed 1 excluded; archived 3 included');
  assert.deepEqual(ids(db, { mode: 'archived' }), [3]);
  assert.deepEqual(ids(db, { agent: 'codex' }), [4, 2, 6]);
  for (const limit of [1, 2, 4]) {
    const seen: number[] = [];
    let cursor: HistoryKey | null = null;
    for (let i = 0; i < 20; i++) {
      const page = rows(db, {}, limit, cursor);
      seen.push(...page.rows.map((r) => r.id));
      if (!page.next) break;
      cursor = page.next;
    }
    assert.deepEqual(seen, [4, 2, 6, 5, 3, 7], `limit ${limit}`);
  }
  assert.equal(rows(db, {}, 1000).rows.length, 6, 'the limit is clamped, not refused');
});

test('projects and folders are paged by id', async () => {
  const db = await store();
  for (const n of ['A', 'B', 'C']) op(db, { kind: 'newProject', name: n });
  const p1 = listProjects(db, null, 2);
  assert.deepEqual(p1.projects.map((p) => p.name), ['A', 'B']);
  assert.deepEqual(listProjects(db, p1.next, 2), { projects: [{ id: 3, name: 'C' }], next: null });
  for (const n of ['x', 'y']) op(db, { kind: 'newFolder', project: 1, name: n });
  assert.deepEqual(listFolders(db, 1, null, 1).folders.map((f) => f.name), ['x']);
  assert.deepEqual(listFolders(db, 2, null, 10), { folders: [], next: null });
});

test('approved label: the project name only, cut to LABEL_MAX for notifications', async () => {
  const db = await store();
  const pid = idOf(op(db, { kind: 'newProject', name: 'L'.repeat(60) }));
  op(db, { kind: 'move', session: 1, project: pid, folder: null });
  const label = approvedLabel(db, 'claude', 'p1', sid(1))!;
  assert.equal(label.length, LABEL_MAX);
  assert.ok(label.endsWith('…'));
});

// Gate 5 U1 G5b2-4 (XAIBO-PROD-542): Trash and restore change what every window lists, so a successful one resyncs them
test('G5b2-4: a successful Trash or restore asks for a renderer resync; other operations and failures do not', () => {
  const o = overlay as unknown as { resyncAfter?: (op: OverlayOp, r: OverlayResult) => boolean };
  assert.equal(typeof o.resyncAfter, 'function', 'resyncAfter exported');
  const ok: OverlayResult = { ok: true };
  assert.equal(o.resyncAfter!({ kind: 'trash', session: 1, on: true }, ok), true);
  assert.equal(o.resyncAfter!({ kind: 'trash', session: 1, on: false }, ok), true);
  assert.equal(o.resyncAfter!({ kind: 'trash', session: 1, on: true }, { ok: false, error: 'not-found' }), false);
  assert.equal(o.resyncAfter!({ kind: 'pin', session: 1, on: true }, ok), false);
});
