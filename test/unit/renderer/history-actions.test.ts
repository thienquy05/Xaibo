// XAIBO-PROD-532 (P5-T18 part 3b-3; design §6.4, §5.1, §5.4; look D-P5-09): Session list row actions. Pure logic in
// history/actions.ts: the More menu's items from the fresh history row (toggles with their state, Move to Trash; none
// for a Trash row), the overlay op an item sends, whether a refreshed row still belongs to the current list, its
// placement (replace, reorder in the service order, remove; never a guessed position), the focus fallback, the outcome
// texts and the Undo notice state. Synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryRow } from '../../../src/shared/ipc.ts';
import { initialQuery } from '../../../src/renderer/history/browse.ts';
import { doneText, errorText, goneUndo, GONE_UNDO, headerItems, matches, menuClosed, menuItems, NOTICE, opOf, place, trashed, undoLabel, undone } from '../../../src/renderer/history/actions.ts';

const at = (d: number) => new Date(2026, 10, d, 12).getTime();
const hrow = (id: number, extra: Partial<HistoryRow> = {}): HistoryRow => ({ id, agent: 'claude', entrypoint: null, origin: null, interactive: null, model: 'Model unavailable',
  cwd: null, title: null, lastActivity: at(id), drift: false, compressed: false, quarantined: 0, live: null, contextPct: null, costUsd: null,
  costCoverage: 'unavailable', tokens: null, tokensComplete: false, project: null, folder: null, pinned: false, archivedAt: null,
  trashedAt: null, trashPurgeAt: null, keep: false, purgeAt: null, ...extra });

test('menuItems: Move to…, then Pin, Archive and Keep with their state from the fresh row, then Move to Trash; none for a Trash row', () => {
  assert.deepEqual(menuItems(hrow(1)), [
    { kind: 'move', label: 'Move to…', checked: null },
    { kind: 'pin', label: 'Pin', checked: false }, { kind: 'archive', label: 'Archive', checked: false },
    { kind: 'keep', label: 'Keep', checked: false }, { kind: 'trash', label: 'Move to Trash', checked: null },
  ]);
  assert.deepEqual(menuItems(hrow(1, { pinned: true, archivedAt: at(1), keep: true })).map((i) => i.checked), [null, true, true, true, null]);
  assert.deepEqual(menuItems(hrow(1, { trashedAt: at(2), trashPurgeAt: at(30) })), [], 'Trash rows get Restore and Purge instead');
});

test('headerItems (XAIBO-PROD-535, design §6.3): the open session\'s More actions leave Keep to its own toggle; none in Trash', () => {
  assert.deepEqual(headerItems(hrow(1, { pinned: true })).map((i) => [i.kind, i.checked]), [['move', null], ['pin', true], ['archive', false], ['trash', null]]);
  assert.deepEqual(headerItems(hrow(1, { trashedAt: at(2) })), []);
});

test('matches (XAIBO-PROD-535): a map-group filter keeps a moved row only under its project override', () => {
  const auto = { ...initialQuery, group: { project: null, at: { cwd: '/w/a' } } };
  const proj = { ...initialQuery, group: { project: 7, at: null } };
  const p7 = { id: 7, name: 'P' }, p8 = { id: 8, name: 'Q' };
  assert.equal(matches(auto, hrow(1)), true, 'automatic grouping holds sessions with no project');
  assert.equal(matches(auto, hrow(1, { project: p7 })), false, 'moved into a project: it leaves automatic grouping');
  assert.equal(matches(proj, hrow(1, { project: p7 })), true);
  assert.equal(matches(proj, hrow(1, { project: p8 })), false);
  assert.equal(matches(proj, hrow(1)), false, 'moved out of the project');
});

test('opOf: a toggle sends its opposite state for this session; Move to Trash sends trash on', () => {
  assert.deepEqual(opOf('pin', hrow(4)), { kind: 'pin', session: 4, on: true });
  assert.deepEqual(opOf('pin', hrow(4, { pinned: true })), { kind: 'pin', session: 4, on: false });
  assert.deepEqual(opOf('archive', hrow(4, { archivedAt: at(1) })), { kind: 'archive', session: 4, on: false });
  assert.deepEqual(opOf('keep', hrow(4)), { kind: 'keep', session: 4, on: true });
  assert.deepEqual(opOf('trash', hrow(4)), { kind: 'trash', session: 4, on: true });
});

test('matches: a refreshed row stays in its mode and agent filter (All leaves Trash out; Archived only archived outside Trash)', () => {
  const all = initialQuery;
  assert.equal(matches(all, hrow(1)), true);
  assert.equal(matches(all, hrow(1, { archivedAt: at(1) })), true, 'All includes archived');
  assert.equal(matches(all, hrow(1, { trashedAt: at(1) })), false);
  const archived = { ...all, mode: 'archived' as const };
  assert.equal(matches(archived, hrow(1, { archivedAt: at(1) })), true);
  assert.equal(matches(archived, hrow(1)), false, 'unarchived leaves Archived');
  assert.equal(matches(archived, hrow(1, { archivedAt: at(1), trashedAt: at(2) })), false);
  assert.equal(matches({ ...all, mode: 'trash' }, hrow(1, { trashedAt: at(1) })), true);
  assert.equal(matches({ ...all, agent: 'codex' }, hrow(1)), false);
  assert.equal(matches({ ...all, agent: 'claude' }, hrow(1)), true);
});

test('place: replace and reorder in the service order; remove when gone or filtered out; search keeps relevance order', () => {
  const rows = [hrow(3), hrow(2), hrow(1)];
  assert.deepEqual(place(rows, 1, hrow(1, { pinned: true }), initialQuery, false).rows.map((r) => r.id), [1, 3, 2], 'pinned first');
  assert.equal(place(rows, 2, hrow(2, { keep: true }), initialQuery, false).rows[1]!.keep, true);
  assert.deepEqual(place(rows, 2, null, initialQuery, false), { rows: [hrow(3), hrow(1)], placed: false }, 'gone');
  assert.deepEqual(place(rows, 2, hrow(2, { trashedAt: at(5) }), initialQuery, false).rows.map((r) => r.id), [3, 1], 'trashed leaves All');
  const searching = { ...initialQuery, search: 'notes' };
  assert.deepEqual(place(rows, 1, hrow(1, { pinned: true }), searching, false).rows.map((r) => r.id), [3, 2, 1], 'relevance order kept');
  const inserted = { historyUnknown: true as const, ...hrow(2) };
  assert.equal('historyUnknown' in place([hrow(3), inserted], 2, hrow(2), initialQuery, false).rows[1]!, false, 'a fresh row is known');
  // review L4: a reorder past the loaded window while more pages remain drops the row (Load more brings it), never parks it
  assert.deepEqual(place([hrow(1, { pinned: true }), hrow(4), hrow(3)], 1, hrow(1), initialQuery, true), { rows: [hrow(4), hrow(3)], placed: false });
  assert.deepEqual(place([hrow(1, { pinned: true }), hrow(4), hrow(3)], 1, hrow(1), initialQuery, false).rows.map((r) => r.id), [4, 3, 1], 'all loaded');
  assert.deepEqual(place([hrow(4), hrow(3), hrow(1)], 1, hrow(1, { keep: true }), initialQuery, true).rows.map((r) => r.id), [4, 3, 1], 'the last row stays');
});

test('place (Undo): a restored row returns in order when it belongs here; never a guessed position', () => {
  const rows = [hrow(5), hrow(3)];
  assert.deepEqual(place(rows, 4, hrow(4), initialQuery, false), { rows: [hrow(5), hrow(4), hrow(3)], placed: true });
  assert.equal(place(rows, 1, hrow(1), initialQuery, true).placed, false, 'past the loaded window with more to load');
  assert.equal(place(rows, 1, hrow(1), initialQuery, false).placed, true, 'the whole list is loaded');
  assert.equal(place(rows, 4, hrow(4), { ...initialQuery, search: 'x' }, false).placed, false, 'search rank unknown');
  assert.equal(place(rows, 4, hrow(4), { ...initialQuery, mode: 'archived' }, false).placed, false, 'not in this mode');
});

// review M3: a fresh row with no menu (gone, or in Trash since the list was read) closes the menu with a reason
test('menuClosed: gone or in Trash closes the menu with a note; an ordinary row keeps it open', () => {
  assert.equal(menuClosed(null), 'This session is no longer available.');
  assert.equal(menuClosed(hrow(1, { trashedAt: at(2) })), 'This session is in Trash.');
  assert.equal(menuClosed(hrow(1)), null);
});

// review M1: an Undo reply changes only its own notice, never a newer Trash's
test('undone: the reply for the notice shown applies; a reply for an older notice leaves the newer one', () => {
  const a = { ...trashed(null, 4), status: 'undoing' as const };
  assert.deepEqual(undone(a, 4, { status: 'restored', note: null }), { ...a, status: 'restored', note: null });
  const b = trashed(a, 9);
  assert.equal(undone(b, 4, { status: 'restored', note: null }), b);
  assert.equal(undone(null, 4, { status: 'failed', note: 'x' }), null);
});

test('texts: outcomes and errors in words; the Undo notice names the Xaibo copy', () => {
  assert.equal(doneText('pin', true), 'Pinned.');
  assert.equal(doneText('pin', false), 'Unpinned.');
  assert.equal(doneText('archive', true), 'Archived.');
  assert.equal(doneText('archive', false), 'Unarchived.');
  assert.equal(doneText('keep', true), 'Kept. Retention will not purge this session.');
  assert.equal(doneText('keep', false), 'Keep removed.');
  assert.equal(errorText('read-only'), 'Xaibo is read-only. Nothing was changed.');
  assert.equal(errorText('disk-full'), 'The disk is full. Nothing was changed.');
  assert.equal(errorText('not-found'), 'This session is no longer available.');
  for (const e of ['store', 'invalid', 'limit'] as const) assert.equal(errorText(e), 'The change could not be saved.');
  assert.match(NOTICE, /Xaibo copy/);
  assert.match(NOTICE, /native files are untouched/i);
});

test('Undo notice: one at a time; a second Trash updates it to Undo latest Trash; a restored notice does not stack', () => {
  const first = trashed(null, 4);
  assert.deepEqual(first, { id: 4, stacked: false, status: 'ready', note: null });
  assert.equal(undoLabel(first), 'Undo');
  const second = trashed(first, 9);
  assert.equal(second.id, 9);
  assert.equal(undoLabel(second), 'Undo latest Trash');
  assert.equal(trashed({ ...first, status: 'restored' }, 9).stacked, false);
});

// XAIBO-PROD-533 (P5-T18 part 3b-4; design §6.3): the open session's retention line from its fresh history row and its
// current live state; unknown (not read, failed, gone) never shows a default (design security review L3).
test('retentionLine: Trash, Kept, Active; retention paused, Purge scheduled, No purge scheduled, Unavailable', async () => {
  const { retentionLine } = await import('../../../src/renderer/history/actions.ts');
  const { formatTime } = await import('../../../src/renderer/model.ts');
  const day = (ms: number) => formatTime(ms).slice(0, 10);
  const ok = (row: HistoryRow | null) => ({ row, failed: false });
  const busy = { lifecycle: 'busy' } as unknown as NonNullable<HistoryRow['live']>;
  const idle = { lifecycle: 'idle' } as unknown as NonNullable<HistoryRow['live']>;
  // E2E-found (visual 640×560): the line is reserved while the row loads, so the header never grows by a line later
  assert.equal(retentionLine(undefined, null), 'Loading retention…', 'not read yet');
  assert.equal(retentionLine({ row: null, failed: true }, null), 'Retention unavailable');
  assert.equal(retentionLine(ok(null), null), 'Retention unavailable', 'gone');
  assert.equal(retentionLine(ok(hrow(1, { trashedAt: at(2), trashPurgeAt: at(32) })), null), `In Trash · Auto-empty ${day(at(32))}`);
  assert.equal(retentionLine(ok(hrow(1, { keep: true })), busy), 'Kept');
  assert.equal(retentionLine(ok(hrow(1, { purgeAt: at(40) })), busy), 'Active; retention paused');
  assert.equal(retentionLine(ok(hrow(1, { purgeAt: at(40) })), idle), `Purge scheduled ${day(at(40))}`);
  assert.equal(retentionLine(ok(hrow(1)), null), 'No purge scheduled', 'Never, unreadable setting or no time');
});

// XAIBO-PROD-533 review #1: a row shared from the list applies to the open session only when it is that session's; a
// gone row (null) is shared too, so the header says Retention unavailable instead of a stale date
test('sharedRow: this session only; null (gone) applies as gone', async () => {
  const { sharedRow, retentionLine } = await import('../../../src/renderer/history/actions.ts');
  assert.deepEqual(sharedRow({ id: 3, row: hrow(3, { keep: true }), n: 1 }, 3), { row: hrow(3, { keep: true }), failed: false });
  assert.equal(sharedRow({ id: 4, row: hrow(4), n: 2 }, 3), null);
  const gone = sharedRow({ id: 3, row: null, n: 3 }, 3);
  assert.deepEqual(gone, { row: null, failed: false });
  assert.equal(retentionLine(gone!, null), 'Retention unavailable');
});

// E2E-found: the open session's own share comes back through Workspace; it is not an outside change (its Keep outcome
// stays), so a shared row that is the very row the header holds is ignored
test('sharedRow: the header\'s own share (the same row object) is not applied again', async () => {
  const { sharedRow } = await import('../../../src/renderer/history/actions.ts');
  const mine = hrow(3, { keep: true });
  assert.equal(sharedRow({ id: 3, row: mine, n: 4 }, 3, { row: mine, failed: false }), null);
  assert.deepEqual(sharedRow({ id: 3, row: hrow(3, { keep: true }), n: 5 }, 3, { row: mine, failed: false }), { row: hrow(3, { keep: true }), failed: false }, 'an equal row from the list');
  // re-review: a gone row coming back to a header that already shows gone changes nothing (its note stays); after a
  // failed read it applies (gone replaces unavailable-by-failure)
  assert.equal(sharedRow({ id: 3, row: null, n: 6 }, 3, { row: null, failed: false }), null);
  assert.deepEqual(sharedRow({ id: 3, row: null, n: 7 }, 3, { row: null, failed: true }), { row: null, failed: false });
  assert.deepEqual(sharedRow({ id: 3, row: null, n: 8 }, 3, { row: mine, failed: false }), { row: null, failed: false });
});

// XAIBO-PROD-534 review L4: a session that is gone can no longer be undone: the notice says so (a status, not a string),
// never while its own Undo is in flight or after it restored
test('goneUndo: gone ends a ready or failed Undo for that session only; never an Undo in flight or restored', () => {
  const u = trashed(null, 4);
  assert.deepEqual(goneUndo(u, 4), { ...u, status: 'gone', note: GONE_UNDO });
  assert.deepEqual(goneUndo({ ...u, status: 'failed', note: 'x' }, 4), { ...u, status: 'gone', note: GONE_UNDO });
  assert.equal(goneUndo(u, 9), u);
  assert.equal(goneUndo({ ...u, status: 'undoing' }, 4)!.status, 'undoing');
  assert.equal(goneUndo({ ...u, status: 'restored' }, 4)!.status, 'restored');
  assert.equal(goneUndo(null, 4), null);
  assert.match(GONE_UNDO, /no longer available/);
});

// Gate 5 G5c-1: a repository or cwd group's membership is its place, which a history row does not carry; an absent row
// (Undo) is inserted only where membership is known (no group, or a Project override group); otherwise the list says
// Open restored session. A row already shown is replaced as before.
test('G5c-1 place: an absent row is never inserted into a repository or cwd group view; a shown row is still replaced', () => {
  const rows = [hrow(5), hrow(3)];
  const repoGroup = { ...initialQuery, group: { project: null, at: { repo: '/w/atlas/.git', worktree: '/w/atlas' } } };
  const cwdGroup = { ...initialQuery, group: { project: null, at: { cwd: '/w/notes' } } };
  assert.deepEqual(place(rows, 4, hrow(4), repoGroup, false), { rows, placed: false }, 'a repository group: membership unknown');
  assert.deepEqual(place(rows, 4, hrow(4), cwdGroup, false), { rows, placed: false }, 'a cwd group: membership unknown');
  assert.deepEqual(place(rows, 3, hrow(3, { keep: true }), repoGroup, false), { rows: [hrow(5), hrow(3, { keep: true })], placed: true }, 'a shown row is replaced');
  const projectGroup = { ...initialQuery, group: { project: 7, at: null } };
  assert.equal(place(rows, 4, hrow(4, { project: { id: 7, name: 'Atlas' } }), projectGroup, false).placed, true, 'a Project override group: membership is the project');
});

// Gate 5 G5d-3 (design §5.4): after Undo the focus goes to the open session's title when the restored session is open,
// else the restored record in the list, else the list heading (with Open restored session).
test('G5d-3 undoFocus: the open session\'s title, else the placed record, else the list heading', async () => {
  const actions = await import('../../../src/renderer/history/actions.ts') as Record<string, unknown>;
  assert.equal(typeof actions.undoFocus, 'function', 'actions.undoFocus exists');
  const undoFocus = actions.undoFocus as (id: number, openId: number | null, placed: boolean) => string;
  assert.equal(undoFocus(4, 4, true), 'title', 'the restored session is open: its title, even when the list shows it');
  assert.equal(undoFocus(4, 4, false), 'title');
  assert.equal(undoFocus(4, 9, true), 'record');
  assert.equal(undoFocus(4, null, true), 'record');
  assert.equal(undoFocus(4, null, false), 'heading');
});

