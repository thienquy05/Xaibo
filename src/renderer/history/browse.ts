// XAIBO-PROD-529 (P5-T18 part 3a; design §6.4; look D-P5-09): the Session list as a history browser. The query becomes
// the service filter (Live shows the Dashboard's evidenced live set instead of paging); rows take live updates by id,
// and only the unfiltered All view inserts and reorders them; row lines say what the overlay and the native state know,
// nothing guessed; snippets split into text runs with the search terms emphasized (rendered as text, never HTML).
import { nativeBadge, type HistoryFilter, type HistoryKey, type HistoryRow, type MapGroup, type MapNode, type SessionRow } from '../../shared/ipc.ts';
import { formatTime, PAGE } from '../model.ts';
import { repoName } from '../agent-map/tree.ts';

export type Mode = 'all' | 'live' | 'archived' | 'trash' | 'suppressed';
export const MODES: { mode: Mode; label: string }[] = [
  { mode: 'all', label: 'All sessions' }, { mode: 'live', label: 'Live' }, { mode: 'archived', label: 'Archived' }, { mode: 'trash', label: 'Trash' },
  { mode: 'suppressed', label: 'Suppressed' }, // XAIBO-PROD-536 (D-P5-09): purged sessions' suppression metadata (suppressed.ts)
];
/** search: the applied query ('' = none); group: the Projects and folders choice (null = all). */
export interface Query { mode: Mode; search: string; agent: string | null; group: MapGroup | null }
export const initialQuery: Query = { mode: 'all', search: '', agent: null, group: null };

export const NO_MATCH = 'No matches. Change filters or clear search.';
// Gate 5 G5c-3 (PRD §5.7): the second sentence is the service's SEARCH_ITEM_LIMIT (service/search/query.ts, FTS_MAX_BYTES)
export const COVERAGE = 'Search covers retained indexed content; incomplete sources may have gaps. Only the first 64 KiB of each item is searchable.';
/** Gate 5 round 2 B: a search page the service's bounded scan cut short (Load more continues it). */
export const INCOMPLETE = 'Results may be incomplete: the search stopped at its scan limit. Load more continues it.';

/** The service filter; null for Live, which shows the live set, and for Suppressed, which pages suppression metadata. */
export function filterOf(q: Query): HistoryFilter | null {
  if (q.mode === 'live' || q.mode === 'suppressed') return null;
  return { mode: q.mode, agent: q.agent, project: null, folder: null, ...(q.group ? { group: q.group } : {}) };
}
/** Only search results carry an order label (design §6.4); the default order needs none, so the header stays one line. */
export const orderLabel = (q: Query) => (q.search && q.mode !== 'live' ? 'Search relevance' : null);
/** Only the unfiltered All view takes new sessions and reorders on activity. */
export const isPlain = (q: Query) => q.mode === 'all' && q.search === '' && q.agent === null && q.group === null;
/** XAIBO-PROD-541 (design §6.13 B4): after collector loss, plain All sessions with no page loaded (its request waits on
 *  the dead port until the restart, D-P4-09, or failed) falls back to the last-known live rows held in memory; live rows
 *  cannot answer a search, filter, group or another mode. The resync on reconnect reloads the list. */
export function lastKnownRows<K>(q: Query, list: ListState<K>, live: SessionRow[], lost: boolean): SessionRow[] | null {
  return lost && isPlain(q) && (list.status === 'loading' || list.status === 'failed') && list.rows.length === 0 && live.length > 0 ? live : null;
}

/** Design §6.4 default order: pinned first, then last activity descending (unknown last), then id ascending, exactly the
 *  service's ORDER BY and keyset (review M1: a trimmed tie group continues with id > cursor). */
export function order(a: HistoryRow, b: HistoryRow): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const x = a.lastActivity ?? -Infinity, y = b.lastActivity ?? -Infinity;
  return x !== y ? y - x : a.id - b.id;
}

/** A row of the browser; historyUnknown = inserted from a live update, its overlay fields not read yet (review L6). */
export type BrowseRow = HistoryRow & { historyUnknown?: true };
const HISTORY_DEFAULTS = { project: null, folder: null, pinned: false, archivedAt: null, trashedAt: null, trashPurgeAt: null, keep: false, purgeAt: null, historyUnknown: true as const };
/** Live updates by id keep each row's history fields; the plain view also inserts new sessions and reorders. With
 *  `more` pages to load, a new session past the last loaded row arrives with Load more instead (as model.applyDelta). */
export function mergeRows(rows: BrowseRow[], updates: SessionRow[], plain: boolean, more = false): BrowseRow[] {
  if (!updates.length) return rows;
  const byId = new Map(updates.map((u) => [u.id, u]));
  const merged = rows.map((r) => { const u = byId.get(r.id); return u ? { ...r, ...u } : r; });
  if (!plain) return merged;
  const have = new Set(rows.map((r) => r.id));
  const last = rows.at(-1);
  for (const u of updates) {
    const row: BrowseRow = { ...HISTORY_DEFAULTS, ...u };
    if (!have.has(u.id) && (!more || !last || order(row, last) < 0)) merged.push(row);
  }
  return merged.sort(order);
}

/** The paged list; status 'more' = Load more in flight; capacity = rows the loaded pages may hold (PAGE per page);
 *  failed = which load failed last (its Retry repeats it). */
export interface ListState<K> {
  rows: BrowseRow[]; snippets: Map<number, string>; next: K | null; status: 'loading' | 'more' | 'ready' | 'failed'; capacity: number;
  failed: 'new' | 'resync' | 'more' | null;
}
export const freshList = <K>(): ListState<K> => ({ rows: [], snippets: new Map(), next: null, status: 'loading', capacity: PAGE, failed: null });
/** Re-review N1: another query starts empty; a resync keeps rows and cursor (no false end of records; 'loading' already
 *  blocks Load more); Load more keeps everything. */
export function startLoad<K>(s: ListState<K>, kind: 'new' | 'resync' | 'more'): ListState<K> {
  if (kind === 'new') return freshList<K>();
  return { ...s, status: kind === 'more' ? 'more' : 'loading', failed: null };
}
/** Re-review N2: Load more runs when the list is ready, and again after its own failure. */
export const canLoadMore = <K>(s: ListState<K>) => s.next !== null && (s.status === 'ready' || (s.status === 'failed' && s.failed === 'more'));
export function failureNote<K>(s: ListState<K>): string | null {
  if (s.status !== 'failed') return null;
  return s.failed === 'more' ? 'More records could not be loaded.' : s.rows.length ? 'The list could not be refreshed.' : 'The list could not be loaded.';
}
/** Live updates into the list. Re-review N3: while a first page or resync loads (`holding`: the updates are replayed on
 *  its reply) they only change rows already shown; otherwise the plain view also inserts within the loaded window. */
export function mergeLive<K>(s: ListState<K>, updates: SessionRow[], plain: boolean, holding: boolean): { rows: BrowseRow[]; next: HistoryKey | K | null } {
  const rows = mergeRows(s.rows, updates, plain && !holding, s.next !== null);
  if (!plain || holding) return { rows, next: s.next };
  const c = capped(rows, s.capacity);
  return { rows: c.rows, next: c.next ?? s.next };
}

export interface LiveState { loaded: boolean; failed: boolean; more: boolean }
/** The results header and empty text; Live says loading or unavailable instead of a guessed empty, and an applied
 *  search counts only outside Live (review L4, L5); filters are named before the mode's own empty text (L7). */
export function listTexts(q: Query, live: LiveState): { title: string; empty: string; order: string | null; searching: boolean } {
  const label = MODES.find((m) => m.mode === q.mode)!.label;
  if (q.mode === 'live') {
    return { title: label, order: null, searching: false, empty: live.failed ? 'Live sessions are unavailable.' : !live.loaded ? 'Loading live sessions…' : 'No live sessions.' };
  }
  if (q.mode === 'suppressed') return { title: label, order: null, searching: false, empty: 'No suppressed sessions.' }; // XAIBO-PROD-536
  const searching = q.search !== '';
  const empty = searching ? NO_MATCH : q.agent || q.group ? 'No sessions match these filters.' : q.mode === 'trash' ? 'Trash is empty.'
    : q.mode === 'archived' ? 'No archived sessions.' : 'No sessions yet.';
  return { title: searching ? 'Matches' : label, empty, order: orderLabel(q), searching };
}

/** Review L9: a resync reloads the loaded window (at least one page) page by page; a later failure keeps the pages
 *  already fetched and the cursor continues after them (as data/pages.reloadWindow). Gate 5 round 2 review: a capped
 *  search page ends the refill (its cursor kept: Load more continues), so one reload runs at most one capped scan. */
export async function refill<R, K>(want: number, page: number, fetch: (cursor: K | null, limit: number) => Promise<{ rows: R[]; next: K | null; capped?: boolean }>):
  Promise<{ rows: R[]; next: K | null; capped?: true }> {
  const target = Math.max(want, page);
  const rows: R[] = [];
  let cursor: K | null = null, capped = false;
  do {
    let p: { rows: R[]; next: K | null; capped?: boolean };
    try { p = await fetch(cursor, Math.min(page, target - rows.length)); } catch (e) {
      if (!rows.length) throw e;
      break;
    }
    rows.push(...p.rows);
    cursor = p.next;
    capped = !!p.capped;
  } while (cursor !== null && !capped && rows.length < target);
  return { rows, next: cursor, ...(capped ? { capped: true as const } : {}) };
}

/** Gate 5 round 2 review: "results may be incomplete" after an applied reply: a new query or a reload takes its own
 *  pages' state, Load more can only add to it. */
export const incompleteAfter = (prev: boolean, kind: 'new' | 'resync' | 'more', capped: boolean): boolean => (kind === 'more' ? prev || capped : capped);

/** The plain view stays within the loaded window (as model.applyDelta): past `capacity` rows the tail is trimmed and the
 *  cursor moves to the last kept row, so Load more brings the rest. next undefined = keep the current cursor. */
export function capped(rows: HistoryRow[], capacity: number): { rows: HistoryRow[]; next: HistoryKey | undefined } {
  if (rows.length <= capacity) return { rows, next: undefined };
  const kept = rows.slice(0, capacity), last = kept.at(-1)!;
  return { rows: kept, next: { pinned: last.pinned, lastActivity: last.lastActivity, id: last.id } };
}

const day = (ms: number) => formatTime(ms).slice(0, 10);
export interface Line { text: string; tone: 'success' | 'warning' | null }
/** What the row's overlay and native state say; a live-set row or one inserted from a live update (overlay not read
 *  yet) says nothing about the overlay. */
export function rowLines(r: BrowseRow): Line[] {
  const lines: Line[] = [];
  if (!r.historyUnknown) {
    if (r.keep) lines.push({ text: 'Keep', tone: 'success' });
    if (r.trashedAt != null) {
      lines.push({ text: `Trashed ${day(r.trashedAt)}`, tone: null });
      if (r.trashPurgeAt != null) lines.push({ text: `Auto-empty ${day(r.trashPurgeAt)}`, tone: null });
    } else {
      if (r.archivedAt != null) lines.push({ text: 'Archived', tone: null });
      if (r.purgeAt != null) lines.push({ text: `Purges ${day(r.purgeAt)}`, tone: null });
    }
  }
  const native = r.native ? nativeBadge(r.native) : null; // design C15: the native-state marker, never overlay state
  if (native) lines.push({ text: native, tone: native === 'native deleted' ? 'warning' : null });
  return lines;
}

/** Case folding per code point, keeping a character whose lower case has another length (e.g. 'İ'), so positions in the
 *  folded text are positions in the original (review L8). */
const fold = (s: string) => [...s].map((c) => { const l = c.toLowerCase(); return l.length === c.length ? l : c; }).join('');
const SEARCH_TERMS = 16; // the service's QUERY_MAX_TERMS (service/search/query.ts): later terms are not searched
/** Search terms (quotes stripped) emphasized case-insensitively; plain text runs, never markup. */
export function emphasis(snippet: string, search: string): { text: string; hit: boolean }[] {
  const terms = search.split(/\s+/u).filter(Boolean).slice(0, SEARCH_TERMS).map((t) => fold(t.replaceAll('"', ''))).filter((t) => t.length > 0 && /[\p{L}\p{N}]/u.test(t));
  if (!terms.length) return [{ text: snippet, hit: false }];
  const lower = fold(snippet);
  const out: { text: string; hit: boolean }[] = [];
  let i = 0, start = 0;
  const push = (text: string, hit: boolean) => { if (text) out.push({ text, hit }); };
  while (i < snippet.length) {
    const t = terms.filter((x) => lower.startsWith(x, i)).sort((a, b) => b.length - a.length)[0];
    if (t) { push(snippet.slice(start, i), false); push(snippet.slice(i, i + t.length), true); i += t.length; start = i; } else i++;
  }
  push(snippet.slice(start), false);
  return out;
}

/** Roving focus in the Session list mode group: Left/Right in DOM order (no wrap), Home/End; null = not ours. */
export function modeKey(key: string, i: number, n: number): number | null {
  switch (key) {
    case 'ArrowRight': return Math.min(n - 1, i + 1);
    case 'ArrowLeft': return Math.max(0, i - 1);
    case 'Home': return 0;
    case 'End': return n - 1;
    default: return null;
  }
}

const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
export interface GroupLabel { label: string; note: string | null; kind: 'project' | 'repo' | 'worktree' | 'folder' }
export function groupLabel(n: MapNode): GroupLabel {
  const at = n.group.at;
  if (at === null) return { label: n.project?.name ?? 'Unknown project', note: null, kind: 'project' };
  // XAIBO-PROD-540: the key is the common git directory (`<repo>/.git` for a standard checkout), so name it as the Agent Map does
  if ('repo' in at) return at.worktree === null ? { label: repoName(at.repo) || 'Repository label unavailable', note: null, kind: 'repo' } : { label: base(at.worktree), note: null, kind: 'worktree' };
  return at.cwd === null ? { label: 'Cwd unavailable', note: null, kind: 'folder' } : { label: base(at.cwd), note: 'Repository grouping unavailable', kind: 'folder' };
}
