// XAIBO-PROD-529 (P5-T18 part 3a; design §6.4; look D-P5-09): the Session list as a history browser. Pure logic in
// history/browse.ts: the query becomes the service filter, rows merge live updates by id (plain All view reorders and
// inserts), row lines say pin/Keep/purge/Archived/Trash/native state, snippets split into text runs with the search
// terms emphasized (never HTML), the mode group's roving keys, and map-group labels. Synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryRow, MapNode, SessionRow } from '../../../src/shared/ipc.ts';
import { canLoadMore, capped, COVERAGE, emphasis, failureNote, filterOf, groupLabel, initialQuery, isPlain, listTexts, mergeLive, mergeRows, MODES, modeKey, NO_MATCH, order, orderLabel,
  refill, rowLines, startLoad, type ListState } from '../../../src/renderer/history/browse.ts';

const at = (d: number) => new Date(2026, 10, d, 12).getTime();
const session = (id: number, extra: Partial<SessionRow> = {}): SessionRow => ({ id, agent: 'claude', entrypoint: null, origin: null, interactive: null, model: 'Model unavailable',
  cwd: null, title: null, lastActivity: at(id), drift: false, compressed: false, quarantined: 0, live: null, contextPct: null, costUsd: null,
  costCoverage: 'unavailable', tokens: null, tokensComplete: false, ...extra });
const hrow = (id: number, extra: Partial<HistoryRow> = {}): HistoryRow => ({ ...session(id), project: null, folder: null, pinned: false, archivedAt: null,
  trashedAt: null, trashPurgeAt: null, keep: false, purgeAt: null, ...extra });

test('modes: All sessions, Live, Archived, Trash in design §6.4 order', () => {
  assert.deepEqual(MODES.map((m) => m.label), ['All sessions', 'Live', 'Archived', 'Trash', 'Suppressed']); // XAIBO-PROD-536: D-P5-09
  assert.equal(initialQuery.mode, 'all');
});

test('filterOf: the service filter for a query; Live pages nothing (it shows the live set)', () => {
  assert.deepEqual(filterOf(initialQuery), { mode: 'all', agent: null, project: null, folder: null });
  assert.deepEqual(filterOf({ ...initialQuery, mode: 'trash', agent: 'codex' }), { mode: 'trash', agent: 'codex', project: null, folder: null });
  const group = { project: null, at: { repo: '/r/atlas', worktree: null } };
  assert.deepEqual(filterOf({ ...initialQuery, mode: 'archived', group }), { mode: 'archived', agent: null, project: null, folder: null, group });
  assert.equal(filterOf({ ...initialQuery, mode: 'live' }), null);
  assert.equal(filterOf({ ...initialQuery, mode: 'suppressed' }), null, 'XAIBO-PROD-536: Suppressed pages suppression metadata, not history');
});

test('isPlain: only the unfiltered All view takes new and reordered sessions from live updates', () => {
  assert.equal(isPlain(initialQuery), true);
  assert.equal(isPlain({ ...initialQuery, search: 'x' }), false);
  assert.equal(isPlain({ ...initialQuery, agent: 'codex' }), false);
  assert.equal(isPlain({ ...initialQuery, mode: 'archived' }), false);
  assert.equal(isPlain({ ...initialQuery, group: { project: 3, at: null } }), false);
});

test('order: pinned first, then last activity descending (unknown last), then id ascending (the service ORDER BY; review M1)', () => {
  const rows = [hrow(1), hrow(2, { lastActivity: null }), hrow(3, { pinned: true, lastActivity: at(1) }), hrow(4), hrow(5, { lastActivity: at(4) })];
  assert.deepEqual([...rows].sort(order).map((r) => r.id), [3, 4, 5, 1, 2]);
  const ties = [hrow(9, { lastActivity: null }), hrow(1, { lastActivity: null }), hrow(5, { lastActivity: null })];
  assert.deepEqual([...ties].sort(order).map((r) => r.id), [1, 5, 9], 'a trimmed tie group continues by id > cursor');
});

test('review L6: a session inserted from a live update has unknown history fields and shows no overlay lines', () => {
  const merged = mergeRows([hrow(5)], [session(9, { lastActivity: at(20), native: { available: false, archived: false } })], true);
  const added = merged.find((r) => r.id === 9)!;
  assert.equal(added.historyUnknown, true);
  assert.deepEqual(rowLines(added), [{ text: 'native deleted', tone: 'warning' }], 'only what the session row itself says');
});

test('review L4/L5/L7: list texts; Live says loading or unavailable, never a guessed empty; search applies only outside Live', () => {
  const ok = { loaded: true, failed: false, more: false };
  assert.deepEqual(listTexts(initialQuery, ok), { title: 'All sessions', empty: 'No sessions yet.', order: null, searching: false });
  assert.deepEqual(listTexts({ ...initialQuery, search: 'x' }, ok), { title: 'Matches', empty: NO_MATCH, order: 'Search relevance', searching: true });
  const live = { ...initialQuery, mode: 'live' as const, search: 'x' };
  assert.deepEqual(listTexts(live, ok), { title: 'Live', empty: 'No live sessions.', order: null, searching: false });
  assert.equal(listTexts(live, { ...ok, loaded: false }).empty, 'Loading live sessions…');
  assert.equal(listTexts(live, { ...ok, failed: true }).empty, 'Live sessions are unavailable.');
  assert.equal(listTexts({ ...initialQuery, mode: 'trash', agent: 'codex' }, ok).empty, 'No sessions match these filters.', 'filters before the mode');
  assert.equal(listTexts({ ...initialQuery, mode: 'trash' }, ok).empty, 'Trash is empty.');
  assert.equal(listTexts({ ...initialQuery, mode: 'archived' }, ok).empty, 'No archived sessions.');
});

test('review L9: refill reloads the loaded window page by page; a later failure keeps the pages already fetched', async () => {
  const calls: [number | null, number][] = [];
  const fetch = async (cursor: number | null, limit: number) => {
    calls.push([cursor, limit]);
    const from = cursor ?? 0;
    if (from >= 200) throw new Error('down');
    return { rows: Array.from({ length: limit }, (_, i) => from + i), next: from + limit < 130 ? from + limit : null };
  };
  const r = await refill(120, 50, fetch);
  assert.deepEqual(calls, [[null, 50], [50, 50], [100, 20]]);
  assert.equal(r.rows.length, 120);
  assert.equal(r.next, 120, 'the cursor continues after the reloaded window');
  calls.length = 0;
  const short = await refill(10, 50, fetch);
  assert.deepEqual(calls, [[null, 50]], 'at least one page');
  assert.equal(short.rows.length, 50);
  const failing = async (cursor: number | null, limit: number) => { if (cursor) throw new Error('down'); return { rows: [1, 2], next: 2 }; };
  assert.deepEqual(await refill(4, 2, failing), { rows: [1, 2], next: 2 });
  await assert.rejects(refill(4, 2, async () => { throw new Error('down'); }));
});

test('mergeRows: updates keep history fields; the plain view inserts new sessions and reorders; other views only update', () => {
  const rows = [hrow(5, { pinned: true }), hrow(4, { keep: true }), hrow(3)];
  const live = { kind: 'busy' } as unknown as SessionRow['live'];
  const updates = [session(3, { lastActivity: at(30), live }), session(9, { lastActivity: at(20) })];
  const plain = mergeRows(rows, updates, true);
  assert.deepEqual(plain.map((r) => r.id), [5, 3, 9, 4], 'pinned stays first; updated and new rows by activity');
  assert.equal(plain.find((r) => r.id === 3)!.live, live);
  assert.equal(plain.find((r) => r.id === 4)!.keep, true, 'history fields kept');
  assert.deepEqual(plain.find((r) => r.id === 9)!.pinned, false, 'a new session has default history fields');
  const filtered = mergeRows(rows, updates, false);
  assert.deepEqual(filtered.map((r) => r.id), [5, 4, 3], 'search relevance or filtered order is kept; no insertion');
  assert.equal(filtered.find((r) => r.id === 3)!.live, live);
  assert.equal(mergeRows(rows, [], true), rows, 'no updates: the same array');
});

test('E2E-found: with more pages to load, a new session older than the last loaded row arrives with Load more, not as an update', () => {
  const rows = [hrow(8), hrow(6), hrow(4)];
  const updates = [session(7), session(2), session(9)];
  assert.deepEqual(mergeRows(rows, updates, true, true).map((r) => r.id), [9, 8, 7, 6, 4], 'only rows before the last loaded one');
  assert.deepEqual(mergeRows(rows, updates, true, false).map((r) => r.id), [9, 8, 7, 6, 4, 2], 'everything loaded: all new rows');
  assert.deepEqual(mergeRows([], [session(3)], true, true).map((r) => r.id), [3], 'an empty first page takes the row');
});

test('E2E-found: capped at the loaded window; trimming moves the cursor back so Load more brings the rest', () => {
  const rows = [hrow(9, { pinned: true }), hrow(8), hrow(7), hrow(6)];
  assert.deepEqual(capped(rows, 4), { rows, next: undefined }, 'within the window: unchanged, cursor kept');
  const c = capped(rows, 3);
  assert.deepEqual(c.rows.map((r) => r.id), [9, 8, 7]);
  assert.deepEqual(c.next, { pinned: false, lastActivity: at(7), id: 7 }, 'the keyset cursor of the last kept row');
});

test('rowLines: Keep, purge date, Archived, Trash dates and the native marker; nothing guessed', () => {
  assert.deepEqual(rowLines(hrow(1)), []);
  assert.deepEqual(rowLines(hrow(1, { keep: true })), [{ text: 'Keep', tone: 'success' }]);
  assert.deepEqual(rowLines(hrow(1, { purgeAt: at(30) })), [{ text: 'Purges 2026-11-30', tone: null }]);
  assert.deepEqual(rowLines(hrow(1, { archivedAt: at(2), purgeAt: at(25) })), [{ text: 'Archived', tone: null }, { text: 'Purges 2026-11-25', tone: null }]);
  assert.deepEqual(rowLines(hrow(1, { trashedAt: at(17), trashPurgeAt: at(47) })),
    [{ text: 'Trashed 2026-11-17', tone: null }, { text: 'Auto-empty 2026-12-17', tone: null }]);
  assert.deepEqual(rowLines(hrow(1, { native: { available: false, archived: false } })), [{ text: 'native deleted', tone: 'warning' }]);
  assert.deepEqual(rowLines(hrow(1, { native: { available: true, archived: true } })), [{ text: 'native archived', tone: null }]);
  assert.deepEqual(rowLines(session(1) as HistoryRow), [], 'a live-set row without history fields');
});

test('emphasis: search terms emphasized case-insensitively as text runs; no pattern injection; never HTML', () => {
  assert.deepEqual(emphasis('add a Rate limiter to the rate path', 'rate limiter'),
    [{ text: 'add a ', hit: false }, { text: 'Rate', hit: true }, { text: ' ', hit: false }, { text: 'limiter', hit: true }, { text: ' to the ', hit: false },
      { text: 'rate', hit: true }, { text: ' path', hit: false }]);
  assert.deepEqual(emphasis('a (b) [c]', '(b) .*'), [{ text: 'a ', hit: false }, { text: '(b)', hit: true }, { text: ' [c]', hit: false }]);
  assert.deepEqual(emphasis('<b>x</b>', 'x'), [{ text: '<b>', hit: false }, { text: 'x', hit: true }, { text: '</b>', hit: false }]);
  assert.deepEqual(emphasis('plain', ''), [{ text: 'plain', hit: false }]);
  assert.deepEqual(emphasis('"quoted" words', '"quoted"'), [{ text: '"', hit: false }, { text: 'quoted', hit: true }, { text: '" words', hit: false }]);
  // review L8: case folding that changes length never shifts the emphasis; only the service's first 16 terms count
  assert.deepEqual(emphasis('İstanbul rate limiter', 'rate'), [{ text: 'İstanbul ', hit: false }, { text: 'rate', hit: true }, { text: ' limiter', hit: false }]);
  const terms = Array.from({ length: 17 }, (_, i) => `t${String.fromCharCode(97 + i)}`).join(' ');
  assert.deepEqual(emphasis('tq', terms), [{ text: 'tq', hit: false }], 'the 17th term is not searched');
  assert.deepEqual(emphasis('tp', terms), [{ text: 'tp', hit: true }]);
});

test('modeKey: Left/Right in DOM order without wrapping, Home/End; other keys do nothing', () => {
  assert.equal(modeKey('ArrowRight', 0, 4), 1);
  assert.equal(modeKey('ArrowRight', 3, 4), 3);
  assert.equal(modeKey('ArrowLeft', 0, 4), 0);
  assert.equal(modeKey('ArrowLeft', 2, 4), 1);
  assert.equal(modeKey('Home', 2, 4), 0);
  assert.equal(modeKey('End', 0, 4), 3);
  assert.equal(modeKey('ArrowDown', 1, 4), null);
  assert.equal(modeKey('Enter', 1, 4), null);
});

const node = (group: MapNode['group'], extra: Partial<MapNode> = {}): MapNode => ({ group, project: null, reasons: [], sessions: 3, live: 0, agents: ['claude'], ...extra });

test('groupLabel: project name, repository and worktree base names, cwd groups say grouping is unavailable', () => {
  assert.deepEqual(groupLabel(node({ project: 7, at: null }, { project: { id: 7, name: 'Atlas' } })), { label: 'Atlas', note: null, kind: 'project' });
  assert.deepEqual(groupLabel(node({ project: null, at: { repo: '/w/atlas-api', worktree: null } })), { label: 'atlas-api', note: null, kind: 'repo' });
  assert.deepEqual(groupLabel(node({ project: null, at: { repo: '/w/atlas-api', worktree: '/w/atlas-api-feat' } })), { label: 'atlas-api-feat', note: null, kind: 'worktree' });
  assert.deepEqual(groupLabel(node({ project: null, at: { cwd: '/tmp/scratch' } })), { label: 'scratch', note: 'Repository grouping unavailable', kind: 'folder' });
  assert.deepEqual(groupLabel(node({ project: null, at: { cwd: null } })), { label: 'Cwd unavailable', note: null, kind: 'folder' });
  assert.deepEqual(groupLabel(node({ project: 7, at: null })), { label: 'Unknown project', note: null, kind: 'project' });
});

test('E2E-found: only search results carry an order label (design §6.4 "Search relevance"); the header stays one line', () => {
  assert.equal(orderLabel({ ...initialQuery, search: 'x' }), 'Search relevance');
  assert.equal(orderLabel(initialQuery), null);
  assert.equal(orderLabel({ ...initialQuery, mode: 'live' }), null);
});

// re-review N1-N3: the list's load transitions
const base = (extra: Partial<ListState<number>> = {}): ListState<number> => ({ rows: [hrow(8), hrow(6)], snippets: new Map(), next: 6, status: 'ready', capacity: 2, failed: null, ...extra });

test('re-review N1: a resync keeps the cursor (no false end of records); a new query starts empty; Load more keeps rows', () => {
  const r = startLoad(base(), 'resync');
  assert.equal(r.next, 6);
  assert.equal(r.status, 'loading');
  assert.equal(r.rows.length, 2);
  assert.deepEqual(startLoad(base(), 'new'), { rows: [], snippets: new Map(), next: null, status: 'loading', capacity: 50, failed: null });
  assert.equal(startLoad(base(), 'more').status, 'more');
});

test('re-review N2: Load more runs when ready, and again after its own failure; the failure note names what failed', () => {
  assert.equal(canLoadMore(base()), true);
  assert.equal(canLoadMore(base({ status: 'loading' })), false);
  assert.equal(canLoadMore(base({ next: null })), false);
  assert.equal(canLoadMore(base({ status: 'failed', failed: 'more' })), true);
  assert.equal(canLoadMore(base({ status: 'failed', failed: 'resync' })), false);
  assert.equal(failureNote(base({ status: 'failed', failed: 'more' })), 'More records could not be loaded.');
  assert.equal(failureNote(base({ status: 'failed', failed: 'resync' })), 'The list could not be refreshed.');
  assert.equal(failureNote(base({ status: 'failed', failed: 'new', rows: [] })), 'The list could not be loaded.');
  assert.equal(failureNote(base()), null);
});

test('re-review N3: while a first page or resync loads (updates held), updates only change rows already shown', () => {
  const empty = startLoad(base(), 'new');
  assert.deepEqual(mergeLive(empty, [session(9)], true, true).rows, [], 'held: no insert into the loading list');
  const shown = mergeLive(base({ status: 'loading' }), [session(8, { lastActivity: at(30) }), session(9)], true, true);
  assert.deepEqual(shown.rows.map((r) => r.id), [8, 6], 'held: updates by id only');
  const idle = mergeLive(base({ next: null }), [session(9, { lastActivity: at(20) })], true, false);
  assert.deepEqual(idle.rows.map((r) => r.id), [9, 8], 'not held: the plain view inserts within the window (capacity 2)');
  assert.deepEqual(idle.next, { pinned: false, lastActivity: at(8), id: 8 }, 'the trimmed tail comes back with Load more');
});

test('fixed texts (design §6.4)', () => {
  assert.equal(NO_MATCH, 'No matches. Change filters or clear search.');
  assert.equal(COVERAGE, 'Search covers retained indexed content; incomplete sources may have gaps.');
});

test('listTexts (XAIBO-PROD-536): Suppressed has its own title and empty text; search and filters never apply there', () => {
  const ok = { loaded: true, failed: false, more: false };
  assert.deepEqual(listTexts({ ...initialQuery, mode: 'suppressed', search: 'x', agent: 'codex' }, ok),
    { title: 'Suppressed', empty: 'No suppressed sessions.', order: null, searching: false });
});
