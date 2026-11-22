// XAIBO-PROD-537 (P5-T18a part 1; design §6.5.1, S-37, US-21; look D-P5-13): the Agent Map tree model in
// agent-map/tree.ts: node kinds and evidence labels with exact counts or unavailable words, page sizes, at most three
// resident pages per level with Load previous after eviction, at most four expanded leafward paths with focus-safe
// eviction or a refusal, collapse moving focus to the surviving node, the flattened rows with synthetic paging items, and
// the tree keyboard. Synthetic groups and rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryRow, MapGroup, MapNode } from '../../../src/shared/ipc.ts';
import { BRANCH_PAGE, collapse, cursorFor, emptyLevel, expand, keyOf, kindOf, LEAF_PAGE, nodeText, pageArrived, pageFailed, pageSize, repoName, ROOT_PAGE,
  rows, sessionKey, touch, treeKey, groupDetail, sessionDetail, rowLabel, typeLabel, loadedText, evictedText, REFUSED, nounOf, pagingAnchor, setPositions, connectorPath, returnTarget, dropSession, resumeLevel, type Expansion, type Kids, type Level } from '../../../src/renderer/agent-map/tree.ts';

const repo = (r: string): MapGroup => ({ project: null, at: { repo: r, worktree: null } });
const wt = (r: string, w: string, project: number | null = null): MapGroup => ({ project, at: { repo: r, worktree: w } });
const cwd = (c: string | null, project: number | null = null): MapGroup => ({ project, at: { cwd: c } });
const proj = (id: number): MapGroup => ({ project: id, at: null });
const node = (group: MapGroup, extra: Partial<MapNode> = {}): MapNode => ({ group, project: null, reasons: [], sessions: 3, live: 1, agents: ['claude', 'codex'], ...extra });
const names = (id: string) => ({ claude: 'Claude Code', codex: 'Codex' } as Record<string, string>)[id] ?? id;
const session = (id: number): HistoryRow => ({ id, agent: 'claude', entrypoint: null, origin: null, interactive: null, model: 'Model unavailable', cwd: '/w/app',
  title: `Session ${id}`, lastActivity: id, drift: false, compressed: false, quarantined: 0, live: null, contextPct: null, costUsd: null, costCoverage: 'unavailable',
  tokens: null, tokensComplete: false, project: null, folder: null, pinned: false, archivedAt: null, trashedAt: null, trashPurgeAt: null, keep: false, purgeAt: null });

test('kindOf and pageSize: 10 roots, 20 worktrees or folders under a repository or project, 50 sessions under a worktree or folder', () => {
  assert.equal(kindOf(repo('/w/app/.git')), 'repo');
  assert.equal(kindOf(wt('/w/app/.git', '/w/app')), 'worktree');
  assert.equal(kindOf(cwd('/tmp/notes')), 'folder');
  assert.equal(kindOf(cwd(null)), 'folder');
  assert.equal(kindOf(proj(7)), 'project');
  assert.deepEqual([ROOT_PAGE, BRANCH_PAGE, LEAF_PAGE], [10, 20, 50]);
  assert.equal(pageSize(null), 10);
  assert.equal(pageSize(repo('/w/app/.git')), 20);
  assert.equal(pageSize(proj(7)), 20);
  assert.equal(pageSize(wt('/w/app/.git', '/w/app')), 50);
  assert.equal(pageSize(cwd('/tmp/notes')), 50);
});

test('keyOf: one stable key per group whatever its key order; sessions have their own key space', () => {
  assert.equal(keyOf({ at: { worktree: '/w/app', repo: '/w/app/.git' }, project: null } as MapGroup), keyOf(wt('/w/app/.git', '/w/app')));
  assert.notEqual(keyOf(wt('/w/app/.git', '/w/app')), keyOf(wt('/w/app/.git', '/w/app', 7)), 'the same worktree under a project is another node');
  assert.notEqual(keyOf(cwd(null)), keyOf(cwd('null')));
  assert.notEqual(sessionKey(5), keyOf(proj(5)));
});

test('repoName: the evidenced folder of the common git directory (a bare repository without its .git suffix)', () => {
  assert.equal(repoName('/w/example-app/.git'), 'example-app');
  assert.equal(repoName('/srv/example-app.git'), 'example-app');
  assert.equal(repoName('/srv/example-app'), 'example-app');
});

test('nodeText: repository root and its worktrees, main checkout or linked, with exact counts', () => {
  assert.deepEqual(nodeText(node(repo('/w/example-app/.git'), { sessions: 5 }), names), { label: 'example-app', sub: 'Repository', path: '/w/example-app', count: 'Sessions 5' });
  assert.deepEqual(nodeText(node(wt('/w/example-app/.git', '/w/example-app'), { sessions: 3, live: 2 }), names),
    { label: 'example-app', sub: 'Main checkout', path: '/w/example-app', count: '3 sessions · 2 live · Claude Code, Codex' });
  assert.deepEqual(nodeText(node(wt('/w/example-app/.git', '/w/example-app-docs'), { sessions: 1, live: 0, agents: ['claude'] }), names),
    { label: 'example-app-docs', sub: 'Linked worktree', path: '/w/example-app-docs', count: '1 session · 0 live · Claude Code' });
});

test('nodeText: a worktree under a Project override is qualified by its repository; the override is organization, not evidence', () => {
  assert.equal(nodeText(node(wt('/w/example-app/.git', '/w/example-app', 7)), names).sub, 'Main checkout · example-app');
  assert.deepEqual(nodeText(node(proj(7), { project: { id: 7, name: 'Atlas' }, sessions: 4 }), names),
    { label: 'Project override: Atlas', sub: 'Your organization, not repository evidence', path: null, count: 'Sessions 4' });
  assert.equal(nodeText(node(proj(7), { project: null }), names).label, 'Project override: Unknown project');
});

test('nodeText: cwd fallback says why there is no repository; a missing cwd is never merged into a guess', () => {
  assert.deepEqual(nodeText(node(cwd('/tmp/notes'), { reasons: ['no-git'] }), names),
    { label: 'Folder: /tmp/notes', sub: 'No git directory observed', path: '/tmp/notes', count: '3 sessions · 1 live · Claude Code, Codex' });
  assert.equal(nodeText(node(cwd('/tmp/x'), { reasons: ['unreadable', 'back-pointer'] }), names).sub,
    'Repository grouping unavailable — git metadata unreadable; worktree back-pointer check failed');
  assert.equal(nodeText(node(cwd('/tmp/x'), { reasons: [null] }), names).sub, 'Repository grouping unavailable — reason not recorded');
  assert.equal(nodeText(node(cwd('/tmp/x'), { reasons: [] }), names).sub, 'Repository grouping unavailable');
  assert.deepEqual(nodeText(node(cwd(null), { reasons: ['no-git'] }), names).label, 'Cwd unavailable');
  assert.equal(nodeText(node(cwd(null)), names).path, null);
});

test('nodeText: an unavailable count says so, each part on its own, never a sum of loaded rows', () => {
  assert.equal(nodeText(node(wt('/w/a/.git', '/w/a'), { sessions: null, live: null, agents: null }), names).count, 'Session count unavailable · Live count unavailable · Agents unavailable');
  assert.equal(nodeText(node(wt('/w/a/.git', '/w/a'), { live: null }), names).count, '3 sessions · Live count unavailable · Claude Code, Codex');
  assert.equal(nodeText(node(repo('/w/a/.git'), { sessions: null }), names).count, 'Session count unavailable');
});

type L = Level<number, number>;
test('paging: at most three resident pages; a fourth drops the first and keeps its cursor for Load previous', () => {
  let l: L = emptyLevel();
  assert.equal(cursorFor(l, 'first'), null);
  l = pageArrived(l, 'first', null, [1, 2], 2);
  l = pageArrived(l, 'more', 2, [3, 4], 4);
  l = pageArrived(l, 'more', 4, [5, 6], 6);
  assert.deepEqual(l.pages.flatMap((p) => p.items), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(l.before, []);
  l = pageArrived(l, 'more', 6, [7, 8], null);
  assert.deepEqual(l.pages.flatMap((p) => p.items), [3, 4, 5, 6, 7, 8], 'three resident pages');
  assert.deepEqual(l.before, [null], 'the dropped page started at the first cursor');
  assert.equal(cursorFor(l, 'prev'), null);
  assert.equal(l.next, null);
  // Load previous brings the first page back and drops the last; Load more then fetches it again from its own cursor
  l = pageArrived(l, 'prev', null, [1, 2], 2);
  assert.deepEqual(l.pages.flatMap((p) => p.items), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(l.before, []);
  assert.equal(l.next, 6);
});

test('paging: a failure keeps the pages and the cursor and says which load to retry', () => {
  let l: L = pageArrived(emptyLevel(), 'first', null, [1, 2], 2);
  l = pageFailed({ ...l, loading: 'more' }, 'more');
  assert.equal(l.failed, 'more');
  assert.equal(l.loading, null);
  assert.deepEqual(l.pages.flatMap((p) => p.items), [1, 2]);
  assert.equal(cursorFor(l, 'more'), 2);
  l = pageArrived(l, 'more', 2, [3], null);
  assert.equal(l.failed, null);
});

const ex = (): Expansion => ({ expanded: [], visit: {}, tick: 0 });
/** A fixed tree of keys: roots ra..re, worktrees wa.. under them, sessions sa.. under worktrees. */
const P: Record<string, string | null> = { ra: null, rb: null, rc: null, rd: null, re: null, wa: 'ra', wa2: 'ra', wb: 'rb', sa: 'wa', sb: 'wb' };
const parentOf = (k: string) => P[k] ?? null;
const run = (keys: string[]) => keys.reduce((e, k) => expand(e, k, parentOf, k).e, ex());

test('expand: a path grows without counting twice; at most four leafward paths', () => {
  let e = ex();
  for (const k of ['ra', 'wa', 'rb', 'rc', 'rd']) { const r = expand(e, k, parentOf, k); assert.equal(r.refused, false, k); assert.deepEqual(r.evicted, [], k); e = r.e; }
  assert.deepEqual(new Set(e.expanded), new Set(['ra', 'wa', 'rb', 'rc', 'rd']), 'ra→wa is one path; rb, rc, rd are three more');
});

test('expand: a fifth path evicts the least recently visited path that holds neither focus nor the new node\'s ancestors', () => {
  const r = expand(run(['ra', 'wa', 'rb', 'rc', 'rd']), 're', parentOf, 'rb');
  assert.equal(r.refused, false);
  assert.deepEqual(r.evicted, ['ra', 'wa'], 'top first, so the caller can announce the top label');
  assert.deepEqual(new Set(r.e.expanded), new Set(['rb', 'rc', 'rd', 're']));
});

test('expand: a path whose descendant has focus is kept; a visit makes a path recent again', () => {
  const r = expand(run(['ra', 'wa', 'rb', 'rc', 'rd']), 're', parentOf, 'sa'); // focus on a session under wa
  assert.deepEqual(r.evicted, ['rb']);
  const t = expand(touch(run(['ra', 'wa', 'rb', 'rc', 'rd']), 'wa', parentOf), 're', parentOf, 'rd');
  assert.deepEqual(t.evicted, ['rb'], 'ra→wa was visited after rb was expanded');
});

test('expand: eviction keeps a shared ancestor that another path still uses', () => {
  const r = expand(run(['ra', 'wa', 'wa2', 'rb', 'rc']), 'rd', parentOf, 'rc'); // ra→wa and ra→wa2 are two paths
  assert.deepEqual(r.evicted, ['wa'], 'ra stays: wa2 still needs it');
  assert.ok(r.e.expanded.includes('ra'));
});

test('expand: refused with nothing changed when every other path holds focus', () => {
  const one = expand(ex(), 'ra', parentOf, 'ra').e;
  const r = expand(one, 'rb', parentOf, 'sa', 1); // a one-path limit: the only path holds focus
  assert.equal(r.refused, true);
  assert.deepEqual(r.evicted, []);
  assert.deepEqual(r.e, one);
});

test('collapse: discards the subtree and moves focus from a descendant to the node', () => {
  const e = run(['ra', 'wa', 'rb']);
  const c = collapse(e, 'ra', parentOf, 'sa');
  assert.deepEqual(new Set(c.removed), new Set(['ra', 'wa']));
  assert.deepEqual(c.e.expanded, ['rb']);
  assert.equal(c.focus, 'ra');
  assert.equal(collapse(e, 'ra', parentOf, 'rb').focus, 'rb', 'focus outside stays');
});

test('rows: roots, an expanded repository\'s worktrees and an expanded worktree\'s sessions, with synthetic paging items', () => {
  const A = repo('/w/a/.git'), W = wt('/w/a/.git', '/w/a'), F = cwd('/tmp/n');
  const roots = pageArrived(emptyLevel(), 'first', null, [node(A), node(F)], F);
  const kids = {
    [keyOf(A)]: pageArrived(emptyLevel(), 'first', null, [node(W)], null),
    [keyOf(W)]: pageArrived(emptyLevel(), 'first', null, [session(1), session(2)], { pinned: false, lastActivity: 2, id: 2 }),
  };
  const r = rows(roots, kids, [keyOf(A), keyOf(W)]);
  assert.deepEqual(r.map((x) => [x.type, x.level, x.type === 'group' || x.type === 'session' ? x.key : x.label]), [
    ['group', 1, keyOf(A)], ['group', 2, keyOf(W)], ['session', 3, sessionKey(1)], ['session', 3, sessionKey(2)], ['more', 3, 'Load more sessions'],
    ['group', 1, keyOf(F)], ['more', 1, 'Load more groups'],
  ]);
  const g = r[0]!, f = r[5]!;
  assert.ok(g.type === 'group' && g.expanded === true);
  assert.ok(f.type === 'group' && f.expanded === false);
  assert.equal(r[2]!.parent, keyOf(W));
  assert.equal(r[1]!.parent, keyOf(A));
  assert.equal(r[0]!.parent, null);
});

test('rows: Load previous after eviction, Retry in place of the failed load, and a loading branch flagged on its node', () => {
  const A = repo('/w/a/.git');
  const roots: Level<MapNode, MapGroup> = { ...pageArrived(emptyLevel(), 'first', null, [node(A)], null), before: [null] };
  const failing = pageFailed<MapNode, MapGroup>({ ...emptyLevel(), loading: 'first' }, 'first');
  const r = rows(roots, { [keyOf(A)]: failing }, [keyOf(A)]);
  assert.deepEqual(r.map((x) => (x.type === 'group' || x.type === 'session' ? x.type : `${x.type}:${x.label}`)),
    ['prev:Load previous groups', 'group', 'retry:Retry loading worktrees']);
  const loading = rows(roots, { [keyOf(A)]: { ...emptyLevel(), loading: 'first' } }, [keyOf(A)]);
  const n = loading.find((x) => x.type === 'group')!;
  assert.ok(n.type === 'group' && n.loading === true);
});

test('treeKey: Up/Down/Home/End over loaded rows; Right expands or enters; Left collapses or goes to the parent', () => {
  const A = repo('/w/a/.git'), W = wt('/w/a/.git', '/w/a'), F = cwd('/tmp/n');
  const roots = pageArrived(emptyLevel(), 'first', null, [node(A), node(F)], null);
  const kids = { [keyOf(A)]: pageArrived(emptyLevel(), 'first', null, [node(W)], null) };
  const r = rows(roots, kids, [keyOf(A)]); // A (expanded), W, F
  assert.deepEqual(treeKey(r, 0, 'ArrowDown'), { move: 1 });
  assert.deepEqual(treeKey(r, 2, 'ArrowDown'), { move: 2 }, 'no wrap');
  assert.deepEqual(treeKey(r, 0, 'ArrowUp'), { move: 0 });
  assert.deepEqual(treeKey(r, 1, 'Home'), { move: 0 });
  assert.deepEqual(treeKey(r, 0, 'End'), { move: 2 });
  assert.deepEqual(treeKey(r, 0, 'ArrowRight'), { move: 1 }, 'expanded: to its first child');
  assert.deepEqual(treeKey(r, 1, 'ArrowRight'), { expand: keyOf(W) });
  assert.deepEqual(treeKey(r, 0, 'ArrowLeft'), { collapse: keyOf(A) });
  assert.deepEqual(treeKey(r, 1, 'ArrowLeft'), { move: 0 }, 'collapsed: to its parent');
  assert.equal(treeKey(r, 2, 'ArrowLeft'), null, 'a collapsed root has no parent');
});

test('treeKey: Enter selects a group, opens a session or loads a paging item; Space toggles a branch only', () => {
  const W = wt('/w/a/.git', '/w/a');
  const roots = pageArrived(emptyLevel(), 'first', null, [node(W)], W);
  const kids = { [keyOf(W)]: pageArrived(emptyLevel(), 'first', null, [session(9)], null) };
  const r = rows(roots, kids, [keyOf(W)]); // W, s9, more (roots)
  assert.deepEqual(treeKey(r, 0, 'Enter'), { activate: 0 });
  assert.deepEqual(treeKey(r, 1, 'Enter'), { activate: 1 });
  assert.deepEqual(treeKey(r, 2, 'Enter'), { activate: 2 });
  assert.deepEqual(treeKey(r, 0, ' '), { collapse: keyOf(W) });
  assert.equal(treeKey(r, 1, ' '), null, 'Space on a session selects nothing');
  assert.deepEqual(treeKey(r, 2, ' '), { activate: 2 });
  assert.deepEqual(treeKey(r, 1, 'ArrowLeft'), { move: 0 });
});

test('treeKey: typeahead matches loaded labels after the current row, wrapping, never fetching', () => {
  const roots = pageArrived(emptyLevel(), 'first', null, [node(repo('/w/alpha/.git')), node(repo('/w/beta/.git')), node(repo('/w/apex/.git'))], null);
  const r = rows(roots, {}, []);
  const label = (x: (typeof r)[number]) => (x.type === 'group' ? nodeText(x.node, names).label : '');
  assert.deepEqual(treeKey(r, 0, 'a', label), { move: 2 });
  assert.deepEqual(treeKey(r, 2, 'a', label), { move: 0 });
  assert.equal(treeKey(r, 0, 'z', label), null);
});

test('review H1: focus on a path\'s middle node keeps that whole path; exactly one other path goes', () => {
  const r = expand(run(['ra', 'wa', 'rb', 'rc', 'rd']), 're', parentOf, 'ra'); // the chevron of re clicked while ra has focus
  assert.deepEqual(r.evicted, ['rb']);
  assert.deepEqual(new Set(r.e.expanded), new Set(['ra', 'wa', 'rc', 'rd', 're']));
});

test('review M1/M2/L1: only the <worktree>/.git layout proves a main checkout; repositories show their folder; empty names say unavailable', () => {
  assert.equal(nodeText(node(wt('/w/super/.git/modules/sub', '/w/super/sub')), names).sub, 'Worktree', 'a submodule\'s common directory proves neither');
  assert.equal(nodeText(node(wt('/srv/app.git', '/w/app')), names).sub, 'Worktree', 'a bare repository has no main checkout');
  assert.equal(nodeText(node(wt('/w/app/.git/', '/w/app/')), names).sub, 'Main checkout', 'trailing slashes');
  assert.equal(nodeText(node(wt('/w/app/.git', '/w/app-feature')), names).sub, 'Linked worktree');
  assert.equal(nodeText(node(repo('/w/a/app/.git')), names).path, '/w/a/app');
  assert.notEqual(nodeText(node(repo('/w/a/app/.git')), names).path, nodeText(node(repo('/w/b/app/.git')), names).path, 'same name, told apart by path');
  assert.equal(nodeText(node(repo('/srv/app.git')), names).path, '/srv/app.git');
  assert.equal(nodeText(node(wt('/.git', '/')), names).label, 'Worktree label unavailable');
  assert.equal(nodeText(node(repo('/.git')), names).label, 'Repository label unavailable');
});

test('review L2: an empty agent list is unavailable, never a dangling separator', () => {
  assert.equal(nodeText(node(wt('/w/a/.git', '/w/a'), { agents: [] }), names).count, '3 sessions · 1 live · Agents unavailable');
});

test('review M3: a paging item keeps its key when it becomes Retry (focus stays on it)', () => {
  const A = repo('/w/a/.git');
  const ok = pageArrived(emptyLevel(), 'first', null, [node(A)], A);
  const more = rows(ok, {}, []).at(-1)!;
  const failed = rows(pageFailed(ok, 'more'), {}, []).at(-1)!;
  assert.equal(more.type, 'more');
  assert.ok(failed.type === 'retry' && failed.label === 'Retry loading groups' && failed.dir === 'more');
  assert.equal(failed.key, more.key);
  const prev: Level<MapNode, MapGroup> = { ...ok, before: [null] };
  assert.equal(rows(pageFailed(prev, 'prev'), {}, [])[0]!.key, rows(prev, {}, [])[0]!.key);
  const busy = rows({ ...ok, loading: 'more' }, {}, []).at(-1)!;
  assert.ok(busy.type === 'more' && busy.busy === true);
});

test('review M4: a re-fetched page overlapping a resident one never shows a node twice', () => {
  const A = repo('/w/a/.git'), B = repo('/w/b/.git'), C = repo('/w/c/.git');
  let l = pageArrived(emptyLevel(), 'first', null, [node(A), node(B)], B);
  l = pageArrived(l, 'more', B, [node(B), node(C)], null); // B moved across the page boundary meanwhile
  assert.deepEqual(rows(l, {}, []).map((r) => r.key), [keyOf(A), keyOf(B), keyOf(C)]);
});

test('paging: Load more after a Load previous continues from the restored cursors', () => {
  let l: L = emptyLevel();
  l = pageArrived(l, 'first', null, [1], 1);
  for (const c of [1, 2, 3]) l = pageArrived(l, 'more', c, [c + 1], c + 1); // pages 2..4 resident, page 1 dropped
  l = pageArrived(l, 'prev', null, [1], 1); // pages 1..3, page 4 dropped
  assert.deepEqual(l.before, []);
  assert.equal(l.next, 3);
  l = pageArrived(l, 'more', 3, [4], 4);
  assert.deepEqual(l.pages.flatMap((p) => p.items), [2, 3, 4]);
  assert.deepEqual(l.before, [null]);
});

test('treeKey on paging rows: Left from a root paging item does nothing; Right on a node whose first child is a paging row enters it', () => {
  const A = repo('/w/a/.git');
  const roots = pageArrived(emptyLevel(), 'first', null, [node(A)], A);
  const kids = { [keyOf(A)]: pageFailed<MapNode, MapGroup>({ ...emptyLevel(), loading: 'first' }, 'first') };
  const r = rows(roots, kids, [keyOf(A)]); // A, retry (child), more (root)
  assert.deepEqual(treeKey(r, 0, 'ArrowRight'), { move: 1 });
  assert.equal(treeKey(r, 2, 'ArrowLeft'), null);
  assert.deepEqual(treeKey(r, 1, 'ArrowLeft'), { move: 0 });
});

// --- XAIBO-PROD-538 (P5-T18a part 2a): the screen's pure texts: Details lines, row names, announcements ---
test('groupDetail: label, membership evidence, path and each count exact or Unavailable on its own', () => {
  assert.deepEqual(groupDetail(node(wt('/w/example-app/.git', '/w/example-app'), { sessions: 3, live: 2 }), names), {
    heading: 'example-app',
    lines: [['Membership evidence', 'Main checkout'], ['Path', '/w/example-app'], ['Sessions', '3'], ['Live', '2'], ['Agents', 'Claude Code, Codex']],
  });
  assert.deepEqual(groupDetail(node(cwd(null), { reasons: ['no-git'], sessions: null, live: null, agents: null }), names).lines,
    [['Membership evidence', 'No git directory observed'], ['Path', 'Unavailable'], ['Sessions', 'Unavailable'], ['Live', 'Unavailable'], ['Agents', 'Unavailable']]);
  const p = groupDetail(node(proj(7), { project: { id: 7, name: 'Atlas' }, agents: [] }), names);
  assert.equal(p.heading, 'Project override: Atlas');
  assert.deepEqual(p.lines, [['Membership evidence', 'Your organization, not repository evidence'], ['Sessions', '3'], ['Live', '1'], ['Agents', 'Unavailable']], 'an override has no path; an empty agent list is unavailable');
});

test('sessionDetail: agent by name, model, last activity and cwd; nothing guessed', () => {
  const d = sessionDetail({ ...session(4), title: null, excerpt: 'fix the build', cwd: null }, names);
  assert.equal(d.heading, 'Untitled · fix the build');
  assert.deepEqual(d.lines.map(([k]) => k), ['Agent', 'Model', 'Last activity', 'Cwd']);
  assert.equal(d.lines[0]![1], 'Claude Code');
  assert.equal(d.lines[3]![1], 'Unavailable');
});

test('rowLabel and typeLabel: a short stable name per treeitem; typeahead matches the visible label only', () => {
  const roots = pageArrived(emptyLevel() as Level<MapNode, MapGroup>, 'first', null, [node(repo('/w/example-app/.git'), { sessions: 5 })], repo('/w/z/.git'));
  const list = rows(roots, {}, []);
  assert.equal(rowLabel(list[0]!, names), 'example-app · Sessions 5');
  assert.equal(typeLabel(list[0]!), 'example-app');
  assert.equal(rowLabel(list[1]!, names), 'Load more groups');
  const leaf = { type: 'session' as const, key: sessionKey(9), parent: null, level: 3, row: { ...session(9), title: 'Refactor' } };
  assert.equal(rowLabel(leaf, names), 'Refactor · Claude Code · /w/app');
  assert.equal(typeLabel(leaf), 'Refactor');
});

test('announcements: loaded counts with the right noun, eviction names what closed, refusal keeps focus', () => {
  assert.equal(loadedText('more', 'worktrees', 20), '20 more worktrees loaded');
  assert.equal(loadedText('prev', 'sessions', 1), '1 earlier session loaded');
  assert.equal(loadedText('first', 'groups', 0), 'No groups');
  assert.equal(evictedText(['example-app', 'main']), 'Collapsed example-app, main to keep four branches open');
  assert.equal(REFUSED, 'Collapse another branch to expand this one');
  assert.equal(nounOf(null), 'groups');
  assert.equal(nounOf(wt('/w/a/.git', '/w/a')), 'sessions');
});

// --- XAIBO-PROD-538 review fixes (M2, M3, L1, L5) ---
test('review M3: a group treeitem name is escaped and capped like record names; untrusted text never reorders it', () => {
  const roots = pageArrived(emptyLevel() as Level<MapNode, MapGroup>, 'first', null, [node(cwd(`/tmp/${'x'.repeat(300)}‮`), { reasons: ['no-git'] })], null);
  const label = rowLabel(rows(roots, {}, [])[0]!, names);
  assert.ok(!label.includes('‮'), 'the bidi override is escaped');
  assert.ok(label.length < 300, 'the path is capped');
  assert.match(label, /^Folder: \/tmp\/x+…/);
});

test('review L1: the eviction notice escapes and caps labels; a branch no longer shown is named generically', () => {
  assert.equal(evictedText([`a‮b`]), 'Collapsed a\\u202Eb to keep four branches open');
  assert.equal(evictedText([null]), 'Collapsed a branch to keep four branches open');
  assert.ok(evictedText(['y'.repeat(300)]).length < 140);
});

test('review M2: after Load more focus goes to the last row loaded before it (Down reaches the first new one); after Load previous, to the first', () => {
  let l = pageArrived(emptyLevel() as Level<MapNode, MapGroup>, 'first', null, [node(repo('/w/a/.git')), node(repo('/w/b/.git'))], repo('/w/b/.git'));
  assert.equal(pagingAnchor(l, 'more'), keyOf(repo('/w/b/.git')));
  assert.equal(pagingAnchor(l, 'prev'), keyOf(repo('/w/a/.git')));
  assert.equal(pagingAnchor(emptyLevel(), 'more'), null);
  const s = pageArrived(emptyLevel() as Level<HistoryRow, never>, 'first', null, [session(3), session(4)], null);
  assert.equal(pagingAnchor(s as never, 'more'), sessionKey(4));
  l = pageFailed(l, 'more');
  assert.equal(pagingAnchor(l, 'more'), keyOf(repo('/w/b/.git')), 'a Retry anchors the same way');
});

test('review L5: set position per level, exact only when nothing is paged out before it; size unknown (-1) while more exists', () => {
  const roots = pageArrived(emptyLevel() as Level<MapNode, MapGroup>, 'first', null, [node(repo('/w/a/.git')), node(repo('/w/b/.git'))], repo('/w/b/.git'));
  const kids = { [keyOf(repo('/w/a/.git'))]: pageArrived(emptyLevel() as Level<MapNode, MapGroup>, 'first', null, [node(wt('/w/a/.git', '/w/a'))], null) } as Kids;
  const list = rows(roots, kids, [keyOf(repo('/w/a/.git'))]);
  const pos = setPositions(list);
  assert.deepEqual(pos.get(keyOf(repo('/w/a/.git'))), { pos: 1, size: -1 }, 'a Load more sibling: the size is unknown');
  assert.deepEqual(pos.get(keyOf(wt('/w/a/.git', '/w/a'))), { pos: 1, size: 1 });
  assert.deepEqual(pos.get('end:'), { pos: 3, size: -1 });
  const later = { ...roots, before: [null] };
  assert.deepEqual(setPositions(rows(later, {}, [])).get(keyOf(repo('/w/b/.git'))), { pos: undefined, size: -1 }, 'pages before it were dropped: no exact position');
});

// --- XAIBO-PROD-539 (P5-T18a part 2b): connectors, Return to Agent Map ---
test('connectorPath: a cubic from the source right-edge centre to the target left-edge centre, inside the gap, horizontal tangents', () => {
  assert.equal(connectorPath({ x: 100, y: 20 }, { x: 160, y: 140 }), 'M 100 20 C 130 20 130 140 160 140');
  const d = connectorPath({ x: 10.4, y: 5.6 }, { x: 40.2, y: 5.6 });
  assert.equal(d, 'M 10 6 C 25 6 25 6 40 6', 'whole pixels, so a sub-pixel layout difference never changes the drawing');
  const xs = connectorPath({ x: 300, y: 0 }, { x: 348, y: 900 }).split(' ').filter((_, i) => [1, 4, 6, 8].includes(i)).map(Number);
  assert.ok(xs.every((x) => x >= 300 && x <= 348), 'never left of the source or right of the target: no box is crossed');
});

test('returnTarget: the leaf when it is still here; its parent with a notice when deleted, in Trash or moved; the leaf when the check failed', () => {
  const leaf = sessionKey(4), parent = keyOf(wt('/w/a/.git', '/w/a')), g = wt('/w/a/.git', '/w/a');
  assert.deepEqual(returnTarget(leaf, parent, g, session(4)), { focus: leaf, drop: false, notice: null });
  assert.deepEqual(returnTarget(leaf, parent, g, 'failed'), { focus: leaf, drop: false, notice: null });
  assert.deepEqual(returnTarget(leaf, parent, g, null), { focus: parent, drop: true, notice: 'That session was deleted; showing its former group.' });
  assert.deepEqual(returnTarget(leaf, parent, g, { ...session(4), trashedAt: 9 }), { focus: parent, drop: true, notice: 'That session is in Trash; showing its former group.' });
  assert.deepEqual(returnTarget(leaf, parent, g, { ...session(4), project: { id: 7, name: 'Atlas' } }),
    { focus: parent, drop: true, notice: 'That session moved to another project; showing its former group.' });
  const pg = wt('/w/a/.git', '/w/a', 7);
  assert.deepEqual(returnTarget(leaf, keyOf(pg), pg, { ...session(4), project: { id: 7, name: 'Atlas' } }).drop, false, 'still under its override');
  assert.deepEqual(returnTarget(leaf, keyOf(pg), pg, session(4)).notice, 'That session moved to another project; showing its former group.');
});

test('dropSession: removes one session from its parent\'s resident pages only', () => {
  const p = keyOf(wt('/w/a/.git', '/w/a')), other = keyOf(cwd('/tmp/n'));
  const kids = { [p]: pageArrived(emptyLevel() as Level<HistoryRow, never>, 'first', null, [session(3), session(4)], null), [other]: pageArrived(emptyLevel() as Level<HistoryRow, never>, 'first', null, [session(4)], null) } as Kids;
  const out = dropSession(kids, p, 4);
  assert.deepEqual(out[p]!.pages[0]!.items.map((r) => (r as HistoryRow).id), [3]);
  assert.equal(out[other], kids[other], 'other levels unchanged');
  assert.equal(dropSession(kids, 'missing', 4), kids);
});

test('review M1 (part 2b): a restored level whose request never answers this map is idle; a first page in flight becomes Retry', () => {
  const firstInFlight = { ...emptyLevel(), loading: 'first' as const };
  assert.deepEqual(resumeLevel(firstInFlight), { ...emptyLevel(), loading: null, failed: 'first' });
  const l = pageArrived(emptyLevel() as Level<MapNode, MapGroup>, 'first', null, [node(repo('/w/a/.git'))], repo('/w/a/.git'));
  assert.deepEqual(resumeLevel({ ...l, loading: 'more' }), l, 'Load more is offered again, the pages kept');
  assert.equal(resumeLevel(l), l, 'an idle level is unchanged');
});

// Gate 5 G5d-1: a shown map refreshes its resident pages on activity and after Return: each page is fetched again from
// its own cursor and replaces that page's items in place; expansion, selection and the other pages stay.
test('G5d-1 pageRefreshed: a resident page re-fetched from its cursor replaces its items in place; nothing else changes', async () => {
  const tree = await import('../../../src/renderer/agent-map/tree.ts') as Record<string, unknown>;
  assert.equal(typeof tree.pageRefreshed, 'function', 'tree.pageRefreshed exists');
  const pageRefreshed = tree.pageRefreshed as <T, C>(l: Level<T, C>, from: C | null, items: T[], next: C | null) => Level<T, C>;
  const a = repo('/w/a/.git'), b = repo('/w/b/.git'), c = repo('/w/c/.git');
  let l = pageArrived(emptyLevel() as Level<MapNode, MapGroup>, 'first', null, [node(a)], a);
  l = pageArrived(l, 'more', a, [node(b)], b);
  const counted = pageRefreshed(l, null, [node(a, { sessions: 9, live: 2 })], a);
  assert.deepEqual(counted.pages.map((p) => p.items.map((n) => n.sessions)), [[9], [3]], 'the first page has the fresh counts; the second is kept');
  assert.equal(counted.pages[1], l.pages[1], 'the other page is the same object');
  assert.equal(counted.next, b, 'a page before the last keeps the level cursor');
  // the last page found from a structurally equal cursor; its new next replaces the level's
  const last = pageRefreshed(l, repo('/w/a/.git'), [node(b), node(c)], null);
  assert.deepEqual(last.pages[1]!.items.map((n) => n.group), [b, c]);
  assert.equal(last.next, null);
  // a page dropped meanwhile (eviction, another load): unchanged
  assert.equal(pageRefreshed(l, c, [node(c)], null), l);
  // loading and failure state belong to the user's paging, not to the refresh
  const busy = { ...l, loading: 'more' as const };
  assert.equal(pageRefreshed(busy, null, [node(a)], a).loading, 'more');
});

// Gate 5 G5d-1: a focused (or selected) row that a refresh removed hands over to its nearest surviving ancestor, as
// Return's dropSession and collapse do; a surviving row keeps it.
test('G5d-1 refocus: the key itself when still shown, else its nearest ancestor still shown, else null', async () => {
  const tree = await import('../../../src/renderer/agent-map/tree.ts') as Record<string, unknown>;
  assert.equal(typeof tree.refocus, 'function', 'tree.refocus exists');
  const refocus = tree.refocus as (before: ReturnType<typeof rows>, after: ReturnType<typeof rows>, key: string) => string | null;
  const r = repo('/w/a/.git'), w = wt('/w/a/.git', '/w/a');
  const roots = pageArrived(emptyLevel() as Level<MapNode, MapGroup>, 'first', null, [node(r)], null);
  const leafLevel = (ids: number[]) => pageArrived(emptyLevel() as Level<HistoryRow, never>, 'first', null, ids.map(session), null);
  const kids = (ids: number[], withWt = true) => ({ [keyOf(r)]: pageArrived(emptyLevel() as Level<MapNode, never>, 'first', null, withWt ? [node(w)] : [], null), [keyOf(w)]: leafLevel(ids) }) as Kids;
  const open = [keyOf(r), keyOf(w)];
  const before = rows(roots, kids([3, 4]), open);
  assert.equal(refocus(before, rows(roots, kids([3, 4]), open), sessionKey(4)), sessionKey(4), 'still shown');
  assert.equal(refocus(before, rows(roots, kids([3]), open), sessionKey(4)), keyOf(w), 'the leaf left its group: its worktree');
  assert.equal(refocus(before, rows(roots, kids([], false), open), sessionKey(4)), keyOf(r), 'the worktree left too: the repository');
  assert.equal(refocus(before, rows(emptyLevel() as Level<MapNode, MapGroup>, {}, []), sessionKey(4)), null, 'nothing survives');
});

// Gate 5 review M (G5d-1): a refresh run starts only when the previous one has settled, and each run has a generation, so
// a reply from an older run never overwrites a newer one.
test('G5d-1 refresh gate: no new run while one is pending; only the current run\'s replies apply', async () => {
  const tree = await import('../../../src/renderer/agent-map/tree.ts') as Record<string, unknown>;
  assert.equal(typeof tree.startRefresh, 'function', 'tree.startRefresh exists');
  assert.equal(typeof tree.replyApplies, 'function', 'tree.replyApplies exists');
  type Gate = { gen: number; pending: boolean };
  const startRefresh = tree.startRefresh as (g: Gate) => Gate | null;
  const replyApplies = tree.replyApplies as (g: Gate, gen: number) => boolean;
  const g1 = startRefresh({ gen: 0, pending: false });
  assert.deepEqual(g1, { gen: 1, pending: true });
  assert.equal(startRefresh(g1!), null, 'a run still pending: skip');
  const g2 = startRefresh({ ...g1!, pending: false })!;
  assert.equal(g2.gen, 2);
  assert.equal(replyApplies(g2, 1), false, 'an older run\'s reply is dropped');
  assert.equal(replyApplies(g2, 2), true);
  assert.equal(replyApplies({ ...g2, pending: false }, 2), true, 'a run\'s replies apply until a newer run starts');
});

// Gate 5 round 2 G5Rr1-4: a tick that comes while a refresh run is pending is not dropped: the gate records it (the
// caller stores `again`) and, when that run settles, exactly one more run follows, so the final activity is shown.
test('G5Rr1-4 refresh gate: a tick during a pending run queues one rerun when it settles; none without a missed tick', async () => {
  const tree = await import('../../../src/renderer/agent-map/tree.ts') as Record<string, unknown>;
  assert.equal(typeof tree.settleRefresh, 'function', 'tree.settleRefresh exists');
  type Gate = { gen: number; pending: boolean; again?: boolean };
  const startRefresh = tree.startRefresh as (g: Gate) => Gate | null;
  const settleRefresh = tree.settleRefresh as (g: Gate, gen: number) => { gate: Gate; rerun: boolean };
  const g1 = startRefresh({ gen: 0, pending: false, again: false })!;
  assert.equal(startRefresh(g1), null, 'a tick while the run is pending starts nothing');
  const missed = { ...g1, again: true }; // what the caller stores for that tick
  const s1 = settleRefresh(missed, g1.gen);
  assert.equal(s1.rerun, true, 'the missed tick reruns once the run settles');
  assert.equal(s1.gate.pending, false);
  const g2 = startRefresh(s1.gate)!;
  assert.equal(g2.gen, 2);
  assert.ok(!g2.again, 'the rerun takes the missed tick');
  const s2 = settleRefresh(g2, g2.gen);
  assert.deepEqual([s2.rerun, s2.gate.pending], [false, false], 'no missed tick: no rerun');
  const stale = settleRefresh({ ...g2, again: true }, 1);
  assert.equal(stale.rerun, false, 'an older run settling changes nothing');
  assert.deepEqual(stale.gate, { ...g2, again: true });
});
