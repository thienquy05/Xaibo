// XAIBO-PROD-532 (P5-T18 part 3b-3; design §6.4, §5.1, §5.4; look D-P5-09): Session list row actions. Pure logic in
// history/actions.ts: the More menu's items from the fresh history row (toggles with their state, Move to Trash; none
// for a Trash row), the overlay op an item sends, whether a refreshed row still belongs to the current list, its
// placement (replace, reorder in the service order, remove; never a guessed position), the focus fallback, the outcome
// texts and the Undo notice state. Synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryRow } from '../../../src/shared/ipc.ts';
import { initialQuery } from '../../../src/renderer/history/browse.ts';
import { doneText, errorText, matches, menuClosed, menuItems, NOTICE, opOf, place, trashed, undoLabel, undone } from '../../../src/renderer/history/actions.ts';

const at = (d: number) => new Date(2026, 10, d, 12).getTime();
const hrow = (id: number, extra: Partial<HistoryRow> = {}): HistoryRow => ({ id, agent: 'claude', entrypoint: null, origin: null, interactive: null, model: 'Model unavailable',
  cwd: null, title: null, lastActivity: at(id), drift: false, compressed: false, quarantined: 0, live: null, contextPct: null, costUsd: null,
  costCoverage: 'unavailable', tokens: null, tokensComplete: false, project: null, folder: null, pinned: false, archivedAt: null,
  trashedAt: null, trashPurgeAt: null, keep: false, purgeAt: null, ...extra });

test('menuItems: Pin, Archive and Keep with their state from the fresh row, then Move to Trash; none for a Trash row', () => {
  assert.deepEqual(menuItems(hrow(1)), [
    { kind: 'pin', label: 'Pin', checked: false }, { kind: 'archive', label: 'Archive', checked: false },
    { kind: 'keep', label: 'Keep', checked: false }, { kind: 'trash', label: 'Move to Trash', checked: null },
  ]);
  assert.deepEqual(menuItems(hrow(1, { pinned: true, archivedAt: at(1), keep: true })).map((i) => i.checked), [true, true, true, null]);
  assert.deepEqual(menuItems(hrow(1, { trashedAt: at(2), trashPurgeAt: at(30) })), [], 'Trash rows get Restore and Purge instead');
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
