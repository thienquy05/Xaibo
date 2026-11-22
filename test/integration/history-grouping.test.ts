// XAIBO-PROD-510 (P5-T01c; FR-53, design §6.5.1): the paged repository/worktree projection over the persisted grouping
// (migration 015) plus manual project overlays. Moved sessions appear and count once under their Project override; cwd
// fallback and legacy rows keep cwd grouping with provenance; counts and agent inventory are service aggregates over the
// whole scope, exact across pages and moves; cursors never duplicate; page caps hold; queries use indexes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../src/service/store/db.ts';
import { applyOverlay, listHistory } from '../../src/service/history/overlay.ts';
import { mapGroups } from '../../src/service/history/map.ts';
import { parsePortMessage, type LiveStatus, type MapGroup, type MapNode } from '../../src/shared/ipc.ts';

const NOW = 1_700_000_000_000;
const R1 = '/tmp/xaibo-fixture/r/app/.git', R2 = '/tmp/xaibo-fixture/r/other/.git', R3 = '/tmp/xaibo-fixture/x/app/.git';
const MAIN = '/tmp/xaibo-fixture/r/app', WT = '/tmp/xaibo-fixture/r/wt', PLAIN = '/tmp/xaibo-fixture/r/plain';

async function open() {
  const dir = mkdtempSync(join(tmpdir(), 'xmap-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'backups') });
  for (const [id, agent] of [['p1', 'claude'], ['p2', 'codex'], ['p3', 'claude']]) {
    db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES (?, ?, ?, 'default')").run(id, agent, `/tmp/xaibo-fixture/${id}`);
  }
  return db;
}
const ins = (db: DatabaseSync, profile: string, sid: string, cwd: string | null, repo: string | null, worktree: string | null, reason: string | null, at: number) =>
  Number(db.prepare('INSERT INTO sessions (agent, profile_id, native_session_id, cwd, repo_key, worktree, repo_reason, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(profile === 'p2' ? 'codex' : 'claude', profile, sid, cwd, repo, worktree, reason, at).lastInsertRowid);

/** s1..s13 (see the comments); s12 trashed; s2 and s7 moved to project "Work". */
async function fixture() {
  const db = await open();
  const s: Record<number, number> = {};
  s[1] = ins(db, 'p1', 's1', MAIN, R1, MAIN, null, NOW - 1);             // claude, main checkout, live
  s[2] = ins(db, 'p2', 's2', MAIN, R1, MAIN, null, NOW - 2);             // codex, main checkout, moved
  s[3] = ins(db, 'p3', 's3', WT, R1, WT, null, NOW - 3);                 // claude second profile, linked worktree, live
  s[4] = ins(db, 'p2', 's4', WT, R1, WT, null, NOW - 4);                 // codex, linked worktree, ended
  s[5] = ins(db, 'p1', 's5', '/tmp/xaibo-fixture/r/other', R2, '/tmp/xaibo-fixture/r/other', null, NOW - 5);
  s[6] = ins(db, 'p1', 's6', '/tmp/xaibo-fixture/x/app', R3, '/tmp/xaibo-fixture/x/app', null, NOW - 6); // same folder label "app"
  s[7] = ins(db, 'p1', 's7', PLAIN, null, null, 'no-git', NOW - 7);       // cwd fallback, moved
  s[8] = ins(db, 'p1', 's8', PLAIN, null, null, null, NOW - 8);           // legacy (pre-015) row in the same folder
  s[9] = ins(db, 'p1', 's9', MAIN, null, null, null, NOW - 9);            // legacy row in the repository's folder: not merged
  s[10] = ins(db, 'p1', 's10', null, null, null, null, NOW - 10);         // cwd unavailable
  s[11] = ins(db, 'p2', 's11', null, null, null, null, NOW - 11);
  s[12] = ins(db, 'p1', 's12', MAIN, R1, MAIN, null, NOW - 12);           // trashed
  s[13] = ins(db, 'p1', 's13', PLAIN, null, null, 'no-git', NOW - 13);
  db.prepare("INSERT INTO overlays (agent, profile_id, native_session_id, trashed_at) VALUES ('claude', 'p1', 's12', ?)").run(NOW);
  const work = applyOverlay(db, { kind: 'newProject', name: 'Work' }, { readOnly: false, now: NOW });
  assert.ok(work.ok && work.id);
  const move = (n: number, project: number | null) => assert.deepEqual(applyOverlay(db, { kind: 'move', session: s[n]!, project, folder: null }, { readOnly: false, now: NOW }), { ok: true });
  move(2, work.id); move(7, work.id);
  return { db, s, work: work.id, move };
}
const status = (lifecycle: LiveStatus['lifecycle']): LiveStatus =>
  ({ lifecycle, confidence: 'confirmed', health: 'connected', reason: null, outcome: null, findings: [], since: null });
const live = (_agent: string, sid: string) => (sid === 's1' || sid === 's3' ? status('busy') : sid === 's4' ? status('ended') : null);

const auto = (at: MapGroup['at']): MapGroup => ({ project: null, at });
function all(db: DatabaseSync, parent: MapGroup | null, limit: number) {
  const out: MapNode[] = [];
  let cursor: MapGroup | null = null;
  for (let i = 0; i < 50; i++) {
    const page = mapGroups(db, parent, cursor, limit, live, NOW);
    assert.ok(page.groups.length <= limit);
    out.push(...page.groups);
    if (!page.next) return out;
    cursor = page.next;
  }
  throw new Error('cursor did not end');
}
const brief = (n: MapNode) => ({ group: n.group, sessions: n.sessions, live: n.live, agents: n.agents });
const leaves = (db: DatabaseSync, group: MapGroup, limit = 100) => {
  const ids: number[] = [];
  let cursor = null;
  do {
    const page = listHistory(db, { mode: 'all', agent: null, project: null, folder: null, group }, cursor, limit);
    ids.push(...page.rows.map((r) => r.id));
    cursor = page.next;
  } while (cursor);
  return ids;
};

test('roots: Project overrides, then repositories, then cwd folders, then Cwd unavailable; exact counts, live and agents', async () => {
  const { db, work } = await fixture();
  const roots = all(db, null, 10);
  assert.deepEqual(roots.map(brief), [
    { group: { project: work, at: null }, sessions: 2, live: 0, agents: ['claude', 'codex'] },
    { group: auto({ repo: R1, worktree: null }), sessions: 3, live: 2, agents: ['claude', 'codex'] },
    { group: auto({ repo: R2, worktree: null }), sessions: 1, live: 0, agents: ['claude'] },
    { group: auto({ repo: R3, worktree: null }), sessions: 1, live: 0, agents: ['claude'] },
    { group: auto({ cwd: MAIN }), sessions: 1, live: 0, agents: ['claude'] },
    { group: auto({ cwd: PLAIN }), sessions: 2, live: 0, agents: ['claude'] },
    { group: auto({ cwd: null }), sessions: 2, live: 0, agents: ['claude', 'codex'] },
  ]);
  assert.deepEqual(roots[0]!.project, { id: work, name: 'Work' });
  assert.ok(roots.slice(1).every((n) => n.project === null));
  // provenance: cwd groups carry their recorded reasons (null = none recorded: a legacy row); repository groups none
  assert.deepEqual(roots.map((n) => n.reasons), [[], [], [], [], [null], ['no-git', null], [null]]);
  // paging by 1, 2 and 3 gives the same roots exactly once
  for (const n of [1, 2, 3]) assert.deepEqual(all(db, null, n).map(brief), roots.map(brief), `limit ${n}`);
  // without a live source the live count is unavailable, the rest stays exact
  const blind = mapGroups(db, null, null, 10, undefined, NOW).groups;
  assert.deepEqual(blind.map((n) => n.live), roots.map(() => null));
  assert.deepEqual(blind.map((n) => n.sessions), roots.map((n) => n.sessions));
});

test('branches: repository worktrees and Project override children (repository-qualified worktree or cwd); cwd groups have none', async () => {
  const { db, work } = await fixture();
  assert.deepEqual(all(db, auto({ repo: R1, worktree: null }), 20).map(brief), [
    { group: auto({ repo: R1, worktree: MAIN }), sessions: 1, live: 1, agents: ['claude'] },
    { group: auto({ repo: R1, worktree: WT }), sessions: 2, live: 1, agents: ['claude', 'codex'] },
  ]);
  assert.deepEqual(all(db, auto({ repo: R1, worktree: null }), 1).map(brief), all(db, auto({ repo: R1, worktree: null }), 20).map(brief));
  const kids = all(db, { project: work, at: null }, 20);
  assert.deepEqual(kids.map(brief), [
    { group: { project: work, at: { repo: R1, worktree: MAIN } }, sessions: 1, live: 0, agents: ['codex'] },
    { group: { project: work, at: { cwd: PLAIN } }, sessions: 1, live: 0, agents: ['claude'] },
  ]);
  assert.deepEqual(kids.map((n) => n.reasons), [[], ['no-git']]);
  assert.deepEqual(kids.map((n) => n.project), [{ id: work, name: 'Work' }, { id: work, name: 'Work' }]);
  assert.deepEqual(all(db, { project: work, at: null }, 1).map(brief), kids.map(brief));
  assert.deepEqual(mapGroups(db, auto({ cwd: PLAIN }), null, 20, live, NOW), { groups: [], next: null });
  assert.deepEqual(mapGroups(db, auto({ repo: R1, worktree: WT }), null, 20, live, NOW), { groups: [], next: null });
});

test('leaves: the history group filter matches each displayed scope exactly once, pages without duplicates', async () => {
  const { db, s, work } = await fixture();
  const ids = (...n: number[]) => n.map((i) => s[i]!);
  assert.deepEqual(leaves(db, auto({ repo: R1, worktree: null })), ids(1, 3, 4));
  assert.deepEqual(leaves(db, auto({ repo: R1, worktree: null }), 1), ids(1, 3, 4));
  assert.deepEqual(leaves(db, auto({ repo: R1, worktree: WT })), ids(3, 4));
  assert.deepEqual(leaves(db, { project: work, at: null }), ids(2, 7));
  assert.deepEqual(leaves(db, { project: work, at: { repo: R1, worktree: MAIN } }), ids(2));
  assert.deepEqual(leaves(db, { project: work, at: { cwd: PLAIN } }), ids(7));
  assert.deepEqual(leaves(db, auto({ cwd: PLAIN })), ids(8, 13));
  assert.deepEqual(leaves(db, auto({ cwd: MAIN })), ids(9));
  assert.deepEqual(leaves(db, auto({ cwd: null })), ids(10, 11));
  // every non-trashed session is in exactly one root scope
  const roots = all(db, null, 10);
  const seen = roots.flatMap((n) => leaves(db, n.group, 2)).sort((a, b) => a - b);
  assert.deepEqual(seen, ids(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13).sort((a, b) => a - b));
  assert.deepEqual(roots.map((n) => n.sessions), roots.map((n) => leaves(db, n.group).length));
});

test('counts stay exact across a move and its undo; the moved session counts once, under its Project override', async () => {
  const { db, work, move } = await fixture();
  const total = () => all(db, null, 2).reduce((a, n) => a + n.sessions!, 0);
  const r1 = () => all(db, null, 10).find((n) => n.group.project === null && n.group.at !== null && 'repo' in n.group.at && n.group.at.repo === R1)!;
  assert.equal(total(), 12);
  move(1, work);
  assert.equal(all(db, null, 10).find((n) => n.group.project === work)!.sessions, 3);
  assert.equal(r1().sessions, 2);
  assert.deepEqual(all(db, auto({ repo: R1, worktree: null }), 20).map((n) => n.group.at), [{ repo: R1, worktree: WT }]);
  assert.deepEqual(all(db, { project: work, at: null }, 20).map((n) => n.sessions), [2, 1]); // s1 + s2 in MAIN, s7 in PLAIN
  assert.equal(total(), 12);
  move(1, null);
  assert.equal(r1().sessions, 3);
  assert.equal(total(), 12);
});

test('page caps: 10 roots, 20 children per branch, 100 leaves, whatever the request asks', async () => {
  const db = await open();
  const pad = (i: number) => String(i).padStart(2, '0');
  for (let i = 0; i < 12; i++) ins(db, 'p1', `c${i}`, `/tmp/xaibo-fixture/c/${pad(i)}`, null, null, 'no-git', NOW - i);
  for (let i = 0; i < 25; i++) ins(db, 'p1', `w${i}`, `/tmp/xaibo-fixture/w/${pad(i)}`, R1, `/tmp/xaibo-fixture/w/${pad(i)}`, null, NOW - i);
  for (let i = 0; i < 101; i++) ins(db, 'p2', `l${i}`, MAIN, R2, MAIN, null, NOW - i);
  assert.equal(mapGroups(db, null, null, 100, live, NOW).groups.length, 10);
  assert.equal(mapGroups(db, auto({ repo: R1, worktree: null }), null, 100, live, NOW).groups.length, 20);
  assert.equal(listHistory(db, { mode: 'all', agent: null, project: null, folder: null, group: auto({ repo: R2, worktree: null }) }, null, 500).rows.length, 100);
});

test('review M1: an empty or oversized stored cwd is Cwd unavailable, so every reply passes the IPC parser', async () => {
  const db = await open();
  const a = ins(db, 'p1', 'e1', '', null, null, null, NOW - 1);
  const b = ins(db, 'p1', 'e2', `/${'x'.repeat(70_000)}`, null, null, null, NOW - 2);
  const c = ins(db, 'p1', 'e3', `/${'\u{1F600}'.repeat(40_000)}`, null, null, null, NOW - 3); // 40,001 characters, 80,001 UTF-16 units
  const d = ins(db, 'p1', 'e4', PLAIN, null, null, 'no-git', NOW - 4);
  const page = mapGroups(db, null, null, 10, live, NOW);
  assert.deepEqual(page.groups.map(brief), [
    { group: auto({ cwd: PLAIN }), sessions: 1, live: 0, agents: ['claude'] },
    { group: auto({ cwd: null }), sessions: 3, live: 0, agents: ['claude'] },
  ]);
  assert.ok(parsePortMessage({ v: 1, type: 'mapGroups', id: 1, ...page }));
  assert.deepEqual(leaves(db, auto({ cwd: null })).sort(), [a, b, c].sort());
  assert.deepEqual(leaves(db, auto({ cwd: PLAIN })), [d]);
});

test('query plans: every map and leaf query reaches sessions through an index', async () => {
  const { db, work } = await fixture();
  const seen: { sql: string; args: unknown[] }[] = [];
  const spy = new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') {
        return (sql: string) => new Proxy(t.prepare(sql), { get(u, m) {
          const v = Reflect.get(u, m) as unknown;
          if (typeof v !== 'function') return v;
          return (...args: unknown[]) => { if (m === 'all' || m === 'get' || m === 'iterate') seen.push({ sql, args }); return (v as (...a: unknown[]) => unknown).apply(u, args); };
        } });
      }
      const v = Reflect.get(t, k) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  for (const parent of [null, auto({ repo: R1, worktree: null }), { project: work, at: null }]) {
    mapGroups(spy, parent, null, 10, live, NOW);
    const page = mapGroups(spy, parent, null, 1, live, NOW);
    if (page.next) mapGroups(spy, parent, page.next, 1, live, NOW);
  }
  for (const group of [auto({ repo: R1, worktree: WT }), auto({ cwd: PLAIN }), auto({ cwd: null }), { project: work, at: { cwd: PLAIN } }]) {
    listHistory(spy, { mode: 'all', agent: null, project: null, folder: null, group }, null, 1);
  }
  assert.ok(seen.length > 0);
  for (const q of seen) {
    if (!/\bsessions s\b/.test(q.sql)) continue;
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.args as never[])) as { detail: string }[]).map((r) => r.detail);
    for (const d of plan) assert.ok(!/^SCAN s$/.test(d), `full scan of sessions in:\n${q.sql}\n${plan.join('\n')}`);
  }
});
