// XAIBO-PROD-537 (P5-T18a part 1; design §6.5.1, S-37, US-21; look D-P5-13): the Agent Map tree model. One semantic
// tree of map groups (service P5-T01c): repository → worktree → sessions, a cwd fallback folder → sessions, or a Project
// override → repository-qualified worktree or folder → sessions. Labels and counts come from service evidence only
// (exact aggregates or unavailable words, never loaded-row sums, never a guessed repository). Paging and expansion are
// bounded: 10 roots / 20 branch children / 50 sessions a page, three resident pages a level with Load previous after
// eviction, four expanded leafward paths with focus-safe eviction. Rendering lives in AgentMap.tsx (part 2).
import type { HistoryKey, HistoryRow, MapGroup, MapNode, REPO_REASONS } from '../../shared/ipc.ts';
import { menuKey } from '../components/menu-model.ts';
import { capText, formatTime, recordLabel, titleLabel } from '../model.ts';

export const ROOT_PAGE = 10, BRANCH_PAGE = 20, LEAF_PAGE = 50, RESIDENT = 3, PATHS = 4;

export type Kind = 'project' | 'repo' | 'worktree' | 'folder';
export function kindOf(g: MapGroup): Kind {
  if (g.at === null) return 'project';
  if ('repo' in g.at) return g.at.worktree === null ? 'repo' : 'worktree';
  return 'folder';
}
/** Worktrees and folders hold sessions; repositories and projects hold groups. */
export const holdsSessions = (g: MapGroup) => { const k = kindOf(g); return k === 'worktree' || k === 'folder'; };
export const pageSize = (parent: MapGroup | null) => (parent === null ? ROOT_PAGE : holdsSessions(parent) ? LEAF_PAGE : BRANCH_PAGE);
export const nounOf = (parent: MapGroup | null) => (parent === null ? 'groups' : holdsSessions(parent) ? 'sessions' : 'worktrees');

/** One stable key per group (property order never matters); sessions use their own key space. */
export function keyOf(g: MapGroup): string {
  const at = g.at;
  return `g:${JSON.stringify([g.project, at === null ? null : 'repo' in at ? ['r', at.repo, at.worktree] : ['c', at.cwd]])}`;
}
export const sessionKey = (id: number) => `s:${id}`;

const trim = (p: string) => p.replace(/\/+$/, '');
/** The last path segment ('' for a path of slashes only: the map then says the label is unavailable). */
export const base = (p: string) => trim(p).split('/').pop() ?? '';
const parentDir = (p: string) => trim(p).split('/').slice(0, -1).join('/');
/** The evidenced repository folder of a common git directory: `<repo>/.git` names `<repo>`; a bare `<repo>.git` drops
 *  the suffix. */
export function repoName(key: string): string {
  const b = base(key);
  return b === '.git' ? base(parentDir(key)) : b.endsWith('.git') && b.length > 4 ? b.slice(0, -4) : b;
}
/** review M1: only the `<worktree>/.git` layout proves a main checkout, and a worktree elsewhere of such a repository is
 *  linked; any other common directory (bare, submodule, separate git dir) proves neither, so the node says Worktree. */
function worktreeKind(repo: string, worktree: string): string {
  if (base(repo) !== '.git') return 'Worktree';
  return parentDir(repo) === trim(worktree) ? 'Main checkout' : 'Linked worktree';
}
/** review M2: where a repository lives, so two of the same name are told apart: the folder holding `.git`, else the
 *  common directory itself. */
const repoPath = (repo: string) => (base(repo) === '.git' ? parentDir(repo) : trim(repo));

type Reason = (typeof REPO_REASONS)[number] | null;
const REASON: Record<Exclude<Reason, null | 'no-git'>, string> = {
  unreadable: 'git metadata unreadable', inconsistent: 'git metadata inconsistent', 'back-pointer': 'worktree back-pointer check failed',
  'not-repository': 'not a repository',
};
function fallbackReason(reasons: Reason[]): string {
  if (reasons.length === 1 && reasons[0] === 'no-git') return 'No git directory observed';
  const words = reasons.map((r) => (r === null ? 'reason not recorded' : r === 'no-git' ? 'no git directory observed' : REASON[r]));
  return words.length ? `Repository grouping unavailable — ${words.join('; ')}` : 'Repository grouping unavailable';
}

const sessionsText = (n: number | null) => (n === null ? 'Session count unavailable' : `${n} session${n === 1 ? '' : 's'}`);
function countText(n: MapNode, name: (agent: string) => string, k: Kind): string {
  if (k === 'repo' || k === 'project') return n.sessions === null ? 'Session count unavailable' : `Sessions ${n.sessions}`;
  return [sessionsText(n.sessions), n.live === null ? 'Live count unavailable' : `${n.live} live`,
    n.agents === null || n.agents.length === 0 ? 'Agents unavailable' : n.agents.map(name).join(', ')].join(' · '); // review L2
}

/** A node's visible label, its evidence line, its path (worktree or cwd) and its count chip. */
export function nodeText(n: MapNode, name: (agent: string) => string): { label: string; sub: string; path: string | null; count: string } {
  const k = kindOf(n.group), at = n.group.at, count = countText(n, name, k);
  if (k === 'project') return { label: `Project override: ${n.project?.name ?? 'Unknown project'}`, sub: 'Your organization, not repository evidence', path: null, count };
  if (at && 'repo' in at) {
    if (at.worktree === null) return { label: repoName(at.repo) || 'Repository label unavailable', sub: 'Repository', path: repoPath(at.repo), count };
    const kind = worktreeKind(at.repo, at.worktree);
    return { label: base(at.worktree) || 'Worktree label unavailable', sub: n.group.project === null ? kind : `${kind} · ${repoName(at.repo)}`, path: at.worktree, count };
  }
  const c = at && 'cwd' in at ? at.cwd : null;
  return { label: c === null ? 'Cwd unavailable' : `Folder: ${c}`, sub: fallbackReason(n.reasons), path: c, count };
}

// --- paging: at most RESIDENT pages a level; the cursors of pages dropped from the front allow Load previous ---
export type Dir = 'first' | 'more' | 'prev';
export interface Level<T, C> { pages: { items: T[]; from: C | null }[]; before: (C | null)[]; next: C | null; loading: Dir | null; failed: Dir | null }
export const emptyLevel = (): Level<never, never> => ({ pages: [], before: [], next: null, loading: null, failed: null });
export function cursorFor<T, C>(l: Level<T, C>, dir: Dir): C | null {
  return dir === 'first' ? null : dir === 'more' ? l.next : (l.before.at(-1) ?? null);
}
export function pageArrived<T, C>(l: Level<T, C>, dir: Dir, from: C | null, items: T[], next: C | null): Level<T, C> {
  if (dir === 'first') return { pages: [{ items, from }], before: [], next, loading: null, failed: null };
  if (dir === 'more') {
    const pages = [...l.pages, { items, from }], before = [...l.before];
    if (pages.length > RESIDENT) before.push(pages.shift()!.from);
    return { pages, before, next, loading: null, failed: null };
  }
  const pages = [{ items, from }, ...l.pages];
  let after = l.next;
  if (pages.length > RESIDENT) after = pages.pop()!.from; // the dropped last page is fetched again from its own cursor
  return { pages, before: l.before.slice(0, -1), next: after, loading: null, failed: null };
}
export const pageFailed = <T, C>(l: Level<T, C>, dir: Dir): Level<T, C> => ({ ...l, loading: null, failed: dir });
/** Gate 5 G5d-1: a resident page fetched again from its own cursor (activity, Return) replaces that page's items in place;
 *  the last page also takes the new next. A page no longer resident leaves the level unchanged; paging state is the
 *  user's and stays. ponytail: a refreshed middle page whose tail moved can overlap or skip the next page's start (rows()
 *  drops overlaps); Load more or collapsing the branch corrects it. */
export function pageRefreshed<T, C>(l: Level<T, C>, from: C | null, items: T[], next: C | null): Level<T, C> {
  const key = JSON.stringify(from), i = l.pages.findIndex((p) => JSON.stringify(p.from) === key);
  if (i < 0) return l;
  const pages = l.pages.map((p, j) => (j === i ? { items, from: p.from } : p));
  return { ...l, pages, next: i === pages.length - 1 ? next : l.next };
}

// --- expansion: at most PATHS leafward paths (an expanded node with no expanded child ends one) ---
export interface Expansion { expanded: string[]; visit: Record<string, number>; tick: number }
export type ParentOf = (key: string) => string | null;
const DEPTH = 8; // the schema is at most four levels deep; a cycle in parentOf can never loop
function chain(key: string, parentOf: ParentOf): string[] {
  const out: string[] = [];
  for (let k: string | null = key; k !== null && out.length < DEPTH; k = parentOf(k)) out.push(k);
  return out;
}
const endsOf = (keys: string[], parentOf: ParentOf) => { const inner = new Set(keys.map(parentOf)); return keys.filter((k) => !inner.has(k)); };

/** A visit (focus) makes the expanded nodes on its path recent. */
export function touch(e: Expansion, key: string, parentOf: ParentOf): Expansion {
  const tick = e.tick + 1, visit = { ...e.visit };
  for (const k of chain(key, parentOf)) if (e.expanded.includes(k)) visit[k] = tick;
  return { ...e, visit, tick };
}

/** Expands `key`. Past `limit` paths, the least recently visited path whose own part (up to an ancestor another path
 *  still uses) holds neither focus nor the new node's ancestors is collapsed first; evicted lists it top first. With no
 *  such path the expansion is refused and nothing changes. */
export function expand(e: Expansion, key: string, parentOf: ParentOf, focus: string, limit = PATHS): { e: Expansion; evicted: string[]; refused: boolean } {
  if (e.expanded.includes(key)) return { e: touch(e, key, parentOf), evicted: [], refused: false };
  let open = [...e.expanded, key];
  const keep = new Set([...chain(focus, parentOf), ...chain(key, parentOf)]);
  const evicted: string[] = [];
  while (endsOf(open, parentOf).length > limit) {
    const segment = (end: string) => {
      const seg: string[] = [];
      for (let k: string | null = end, from: string | null = null; k !== null && open.includes(k) && !keep.has(k); from = k, k = parentOf(k)) {
        if (open.some((x) => x !== from && parentOf(x) === k)) break; // another path still uses it
        seg.push(k);
      }
      return seg;
    };
    // review H1: a segment stopped by a kept node with no other open child would leave that node as a new end (the
    // focused path would lose its tail and the count would not drop): not a candidate
    const lowers = (seg: string[]) => { const top = parentOf(seg.at(-1)!); return top === null || open.some((x) => !seg.includes(x) && parentOf(x) === top); };
    const pick = endsOf(open, parentOf).filter((k) => k !== key).map((end) => ({ end, seg: segment(end) })).filter((c) => c.seg.length && lowers(c.seg))
      .sort((a, b) => (e.visit[a.end] ?? -1) - (e.visit[b.end] ?? -1))[0];
    if (!pick) return { e, evicted: [], refused: true };
    open = open.filter((k) => !pick.seg.includes(k));
    evicted.push(...[...pick.seg].reverse());
  }
  const visit = { ...e.visit };
  for (const k of evicted) delete visit[k];
  return { e: touch({ ...e, expanded: open, visit }, key, parentOf), evicted, refused: false };
}

/** Collapses `key` and every expanded node below it (their pages are discarded by the caller); focus inside moves to it. */
export function collapse(e: Expansion, key: string, parentOf: ParentOf, focus: string): { e: Expansion; removed: string[]; focus: string } {
  const removed = e.expanded.filter((k) => chain(k, parentOf).includes(key));
  const visit = { ...e.visit };
  for (const k of removed) delete visit[k];
  const inside = focus !== key && chain(focus, parentOf).includes(key);
  return { e: { ...e, expanded: e.expanded.filter((k) => !removed.includes(k)), visit }, removed, focus: inside ? key : focus };
}

// --- the visible rows: loaded nodes in tree order with synthetic Load previous / Load more / Retry items ---
type Child = MapNode | HistoryRow;
interface Base { key: string; parent: string | null; level: number }
export type Row = (Base & { type: 'group'; node: MapNode; expanded: boolean; loading: boolean }) | (Base & { type: 'session'; row: HistoryRow })
  | (Base & { type: 'more' | 'prev' | 'retry'; label: string; dir: Dir; busy: boolean });
export type Kids = Record<string, Level<Child, MapGroup | HistoryKey>>;

const itemKey = (it: Child) => ('group' in it ? keyOf(it.group) : sessionKey(it.id));
/** review M2: where focus goes when a paging item's page arrives: the last row loaded before Load more (so Down reaches
 *  the first new one), the first row before Load previous (so Up reaches the last new one). */
export function pagingAnchor<T extends Child, C>(l: Level<T, C>, dir: Dir): string | null {
  const it = dir === 'prev' ? l.pages[0]?.items[0] : l.pages.at(-1)?.items.at(-1);
  return it ? itemKey(it) : null;
}

export function rows(roots: Level<MapNode, MapGroup>, kids: Kids, expanded: string[]): Row[] {
  const out: Row[] = [], open = new Set(expanded), seen = new Set<string>(); // review M4: a re-fetched page can overlap a resident one
  const walk = (l: Level<Child, MapGroup | HistoryKey>, parent: string | null, parentGroup: MapGroup | null, level: number) => {
    const noun = nounOf(parentGroup);
    const syn = (type: 'more' | 'prev' | 'retry', dir: Dir, label: string) =>
      out.push({ type, key: `${dir === 'prev' ? 'start' : 'end'}:${parent ?? ''}`, parent, level, label, dir, busy: l.loading === dir }); // review M3: positional, so Retry keeps the key
    if (l.failed === 'prev') syn('retry', 'prev', `Retry loading ${noun}`);
    else if (l.before.length) syn('prev', 'prev', `Load previous ${noun}`);
    for (const p of l.pages) {
      for (const it of p.items) {
        const key = itemKey(it);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!('group' in it)) { out.push({ type: 'session', key, parent, level, row: it }); continue; }
        const isOpen = open.has(key), k = kids[key];
        out.push({ type: 'group', key, parent, level, node: it, expanded: isOpen, loading: isOpen && k?.loading === 'first' });
        if (isOpen && k) walk(k, key, it.group, level + 1);
      }
    }
    if (l.failed === 'first' || l.failed === 'more') syn('retry', l.failed, `Retry loading ${noun}`);
    else if (l.next !== null) syn('more', 'more', `Load more ${noun}`);
  };
  walk(roots, null, null, 1);
  return out;
}

// --- keyboard (design §6.5.1): loaded visible rows only; typeahead never fetches ---
export type Action = { move: number } | { expand: string } | { collapse: string } | { activate: number };
export function treeKey(list: Row[], i: number, key: string, label?: (r: Row) => string): Action | null {
  const r = list[i], n = list.length;
  if (!r) return null;
  switch (key) {
    case 'ArrowDown': return { move: Math.min(i + 1, n - 1) };
    case 'ArrowUp': return { move: Math.max(i - 1, 0) };
    case 'Home': return { move: 0 };
    case 'End': return { move: n - 1 };
    case 'ArrowRight':
      if (r.type !== 'group') return null;
      if (!r.expanded) return { expand: r.key };
      return list[i + 1]?.parent === r.key ? { move: i + 1 } : null;
    case 'ArrowLeft': {
      if (r.type === 'group' && r.expanded) return { collapse: r.key };
      const p = list.findIndex((x) => x.key === r.parent);
      return p < 0 ? null : { move: p };
    }
    case 'Enter': return { activate: i };
    case ' ':
      if (r.type === 'group') return r.expanded ? { collapse: r.key } : { expand: r.key };
      return r.type === 'session' ? null : { activate: i };
  }
  if (!label) return null;
  const j = menuKey(key, i, list.map(label));
  return j === null ? null : { move: j };
}

// --- XAIBO-PROD-538 (P5-T18a part 2a): the screen's texts. Untrusted strings are escaped (visible()) where rendered. ---
export interface Detail { heading: string; lines: [string, string][] }
const num = (n: number | null) => (n === null ? 'Unavailable' : String(n));
const agentList = (a: string[] | null, name: (agent: string) => string) => (a === null || a.length === 0 ? 'Unavailable' : a.map(name).join(', '));

/** The Details pane for a selected group: evidence, path (none for a Project override) and each exact count. */
export function groupDetail(n: MapNode, name: (agent: string) => string): Detail {
  const t = nodeText(n, name), lines: [string, string][] = [['Membership evidence', t.sub]];
  if (kindOf(n.group) !== 'project') lines.push(['Path', t.path ?? 'Unavailable']);
  lines.push(['Sessions', num(n.sessions)], ['Live', num(n.live)], ['Agents', agentList(n.agents, name)]);
  return { heading: t.label, lines };
}
/** The Details pane for a selected session leaf (Open in Session sits below it). */
export function sessionDetail(r: HistoryRow, name: (agent: string) => string): Detail {
  return { heading: titleLabel(r), lines: [['Agent', name(r.agent)], ['Model', r.model], ['Last activity', formatTime(r.lastActivity)], ['Cwd', r.cwd ?? 'Unavailable']] };
}
/** A treeitem's accessible name: short and stable, never its whole content. */
export function rowLabel(r: Row, name: (agent: string) => string): string {
  if (r.type === 'group') { const t = nodeText(r.node, name); return `${capText(t.label, 120)} · ${capText(t.count, 120)}`; } // review M3
  return r.type === 'session' ? recordLabel({ ...r.row, agent: name(r.row.agent) }) : r.label;
}
/** What typeahead matches: the visible label of loaded rows. */
export const typeLabel = (r: Row) => (r.type === 'group' ? nodeText(r.node, (a) => a).label : r.type === 'session' ? titleLabel(r.row) : r.label);

export const REFUSED = 'Collapse another branch to expand this one';
/** review L1: labels escaped and capped; null = a branch no longer shown. */
export const evictedText = (labels: (string | null)[]) => `Collapsed ${labels.map((l) => (l === null ? 'a branch' : capText(l, 80))).join(', ')} to keep four branches open`;

/** review L5: each treeitem's position among its level's rows (paging items included). A position is exact only when no
 *  page before it was dropped (no Load previous / Retry at the level's start); the size is unknown (-1) while a paging item
 *  says more exists. */
export function setPositions(list: Row[]): Map<string, { pos: number | undefined; size: number }> {
  const byParent = new Map<string | null, Row[]>();
  for (const r of list) { const g = byParent.get(r.parent); if (g) g.push(r); else byParent.set(r.parent, [r]); }
  const out = new Map<string, { pos: number | undefined; size: number }>();
  for (const sibs of byParent.values()) {
    const before = sibs[0]!.type === 'prev' || (sibs[0]!.type === 'retry' && sibs[0]!.dir === 'prev');
    const paged = sibs.some((r) => r.type === 'more' || r.type === 'prev' || r.type === 'retry');
    sibs.forEach((r, i) => out.set(r.key, { pos: before ? undefined : i + 1, size: paged ? -1 : sibs.length }));
  }
  return out;
}
export function loadedText(dir: Dir, noun: string, n: number): string {
  if (n === 0) return `No ${noun}`;
  const word = n === 1 ? noun.slice(0, -1) : noun;
  return dir === 'more' ? `${n} more ${word} loaded` : dir === 'prev' ? `${n} earlier ${word} loaded` : `${n} ${word} loaded`;
}

// --- XAIBO-PROD-539 (P5-T18a part 2b): connectors and Return to Agent Map ---
const r1 = Math.round; // review (part 2b): whole pixels, so a sub-pixel layout difference never changes the drawing
/** A decorative connector (design §6.5.1, DD2-04): a cubic from the source's right-edge centre to the target's left-edge
 *  centre with horizontal tangents, so it stays between the two x positions (the column gap) and never crosses a box. */
export function connectorPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const [ax, ay, bx, by] = [r1(a.x), r1(a.y), r1(b.x), r1(b.y)], mx = r1((ax + bx) / 2);
  return `M ${ax} ${ay} C ${mx} ${ay} ${mx} ${by} ${bx} ${by}`;
}

/** Return to Agent Map (design §6.5.1): the source leaf when the session is still in its group; else its former parent,
 *  the leaf dropped from the cached pages and a notice why. A failed check keeps the leaf (nothing is known). */
export function returnTarget(leaf: string, parent: string | null, group: MapGroup | null, check: HistoryRow | null | 'failed'): { focus: string; drop: boolean; notice: string | null } {
  if (check === 'failed' || parent === null || group === null) return { focus: leaf, drop: false, notice: null };
  const away = (notice: string) => ({ focus: parent, drop: true, notice });
  if (check === null) return away('That session was deleted; showing its former group.');
  if (check.trashedAt !== null) return away('That session is in Trash; showing its former group.');
  if ((check.project?.id ?? null) !== group.project) return away('That session moved to another project; showing its former group.');
  return { focus: leaf, drop: false, notice: null };
}

/** review M1 (part 2b): a level restored for Return whose request was answered to the map that was left: idle again; a
 *  first page still in flight becomes a Retry (else the branch would show expanded with nothing and no way on). */
export function resumeLevel<T, C>(l: Level<T, C>): Level<T, C> {
  if (!l.loading) return l;
  return l.loading === 'first' && l.pages.length === 0 ? { ...l, loading: null, failed: 'first' } : { ...l, loading: null };
}

/** Gate 5 review M (G5d-1): a refresh run starts only once the previous one settled (null = skip), with a new generation;
 *  a reply applies only while its run is the latest. */
export interface RefreshGate { gen: number; pending: boolean; again?: boolean }
export const startRefresh = (g: RefreshGate): RefreshGate | null => (g.pending ? null : { gen: g.gen + 1, pending: true });
export const replyApplies = (g: RefreshGate, gen: number) => g.gen === gen;
/** Gate 5 G5Rr1-4: run `gen` settled; a tick it missed (`again`, set by the caller while pending) reruns once. An older
 *  run settling changes nothing. */
export const settleRefresh = (g: RefreshGate, gen: number): { gate: RefreshGate; rerun: boolean } =>
  (g.gen !== gen ? { gate: g, rerun: false } : { gate: { gen: g.gen, pending: false, again: false }, rerun: !!g.again });

/** Gate 5 G5d-1: a focused or selected row a refresh removed hands over to its nearest ancestor still shown (as Return's
 *  dropSession and collapse do); null = nothing on its path is shown. */
export function refocus(before: Row[], after: Row[], key: string): string | null {
  const parent = new Map(before.map((r) => [r.key, r.parent])), shown = new Set(after.map((r) => r.key));
  for (let k: string | null = key, n = 0; k !== null && n < DEPTH; k = parent.get(k) ?? null, n++) if (shown.has(k)) return k;
  return null;
}

/** The cached pages of `parent` without session `id`. */
export function dropSession(kids: Kids, parent: string, id: number): Kids {
  const l = kids[parent];
  if (!l) return kids;
  return { ...kids, [parent]: { ...l, pages: l.pages.map((p) => ({ ...p, items: p.items.filter((it) => 'group' in it || it.id !== id) })) } };
}
