// XAIBO-PROD-506 (P5-T01b; FR-53, Q24; EC-106 I, EC-108): a session's repository grouping is resolved from its cwd when
// that cwd is first stored, persisted with it, and never regrouped: not by replay, a later cwd (relocation, EC-06), a
// deleted worktree or a manual move (which wins in the overlay). Rows from before the change stay ungrouped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadMigrations, openStore } from '../../src/service/store/db.ts';
import { commitBatch, type SessionUpsert } from '../../src/service/store/writer.ts';
import { applyOverlay, listHistory } from '../../src/service/history/overlay.ts';

function gitDir(dir: string) {
  mkdirSync(join(dir, 'objects'), { recursive: true });
  mkdirSync(join(dir, 'refs'), { recursive: true });
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}
function layout() {
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'xgroup-')));
  const common = gitDir(join(r, 'main', '.git'));
  const admin = join(common, 'worktrees', 'wt');
  mkdirSync(admin, { recursive: true });
  mkdirSync(join(r, 'wt'));
  writeFileSync(join(admin, 'commondir'), '../..\n');
  writeFileSync(join(admin, 'gitdir'), `${join(r, 'wt', '.git')}\n`);
  writeFileSync(join(r, 'wt', '.git'), `gitdir: ${admin}\n`);
  mkdirSync(join(r, 'main', 'src'));
  mkdirSync(join(r, 'plain'));
  const other = gitDir(join(r, 'other', '.git'));
  return { r, common, other };
}
async function store(migrations = loadMigrations()) {
  const dir = mkdtempSync(join(tmpdir(), 'xgroup-db-'));
  const s = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'backups'), migrations });
  s.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  return { ...s, dir };
}
const commit = (db: DatabaseSync, ...sessions: SessionUpsert[]) => commitBatch(db, { profileId: 'p1', agent: 'claude', sessions, events: [] });
const grouping = (db: DatabaseSync, sid: string) =>
  db.prepare('SELECT id, repo_key AS key, worktree, repo_reason AS reason FROM sessions WHERE native_session_id = ?').get(sid) as { id: number; key: string | null; worktree: string | null; reason: string | null };

test('EC-106: main and linked worktree sessions share the verified key, each with its worktree; a plain cwd keeps cwd grouping', async () => {
  const { r, common } = layout();
  const { db } = await store();
  commit(db, { nativeSessionId: 'a', cwd: join(r, 'main', 'src') }, { nativeSessionId: 'b', cwd: join(r, 'wt') }, { nativeSessionId: 'c', cwd: join(r, 'plain') });
  assert.deepEqual({ ...grouping(db, 'a') }, { id: 1, key: common, worktree: join(r, 'main'), reason: null });
  assert.deepEqual({ ...grouping(db, 'b') }, { id: 2, key: common, worktree: join(r, 'wt'), reason: null });
  assert.deepEqual({ ...grouping(db, 'c') }, { id: 3, key: null, worktree: null, reason: 'no-git' });
});

test('a session first stored without a cwd is grouped when its cwd arrives (hook or statusLine first)', async () => {
  const { r, common } = layout();
  const { db } = await store();
  commit(db, { nativeSessionId: 's', lastActivity: 1 });
  assert.deepEqual({ ...grouping(db, 's') }, { id: 1, key: null, worktree: null, reason: null });
  commit(db, { nativeSessionId: 's', cwd: join(r, 'wt') });
  assert.equal(grouping(db, 's').key, common);
});

test('EC-108: replay, relocation (EC-06), a deleted worktree and a manual move never regroup; identity unchanged', async () => {
  const { r, common, other } = layout();
  const { db } = await store();
  commit(db, { nativeSessionId: 's', cwd: join(r, 'wt') });
  const first = { ...grouping(db, 's') };
  commit(db, { nativeSessionId: 's', cwd: join(r, 'wt') });
  commit(db, { nativeSessionId: 's', cwd: join(r, 'other'), cwds: [{ cwd: join(r, 'other'), cwdKey: join(r, 'other'), source: 'transcript' }] });
  assert.deepEqual({ ...grouping(db, 's') }, first, 'relocation keeps the first grouping');
  assert.equal((db.prepare('SELECT count(*) AS n FROM cwd_history WHERE session_id = ?').get(first.id) as { n: number }).n, 1);
  assert.notEqual(other, common);
  rmSync(join(r, 'wt'), { recursive: true });
  commit(db, { nativeSessionId: 's', cwd: join(r, 'wt') });
  assert.deepEqual({ ...grouping(db, 's') }, first, 'a deleted worktree keeps the stored grouping');
  const p = applyOverlay(db, { kind: 'newProject', name: 'Manual' }, { readOnly: false, now: 1 });
  assert.ok(p.ok);
  assert.deepEqual(applyOverlay(db, { kind: 'move', session: first.id, project: p.ok ? p.id! : 0, folder: null }, { readOnly: false, now: 1 }), { ok: true });
  commit(db, { nativeSessionId: 's', cwd: join(r, 'wt') });
  assert.deepEqual({ ...grouping(db, 's') }, first, 'the overlay move leaves the grouping columns alone');
  const row = listHistory(db, { mode: 'all', agent: null, project: null, folder: null }, null, 10).rows[0]!;
  assert.deepEqual([row.id, row.project?.name], [first.id, 'Manual'], 'the manual move is what the history shows');
});

// Review of XAIBO-PROD-506: an unreadable answer is not remembered, so a later new session in that cwd is grouped.
test('review: an unreadable cwd is not memoized; a later session there is grouped once it exists', async () => {
  const { r } = layout();
  const { db } = await store();
  const late = join(r, 'late');
  commit(db, { nativeSessionId: 'first', cwd: late });
  assert.deepEqual({ ...grouping(db, 'first') }, { id: 1, key: null, worktree: null, reason: 'unreadable' });
  const common = gitDir(join(late, '.git'));
  commit(db, { nativeSessionId: 'second', cwd: late });
  assert.equal(grouping(db, 'second').key, common);
  assert.equal(grouping(db, 'first').reason, 'unreadable', 'the first session is never regrouped');
});

test('Q24: a session stored before migration 015 is never grouped, even when its cwd is seen again', async () => {
  const { r } = layout();
  const before = await store(loadMigrations().filter((m) => m.version < 15));
  before.db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id, cwd) VALUES ('claude', 'p1', 'old', ?)").run(join(r, 'wt'));
  before.db.close();
  const { db } = await openStore({ file: join(before.dir, 'xaibo.db'), backupDir: join(before.dir, 'backups') });
  assert.deepEqual({ ...grouping(db, 'old') }, { id: 1, key: null, worktree: null, reason: null });
  commit(db, { nativeSessionId: 'old', cwd: join(r, 'wt') });
  assert.deepEqual({ ...grouping(db, 'old') }, { id: 1, key: null, worktree: null, reason: null });
});
