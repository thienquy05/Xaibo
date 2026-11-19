// XAIBO-PROD-532 (P5-T18 part 3b-3; design §6.4, §5.1, §5.4; look D-P5-09): Session list row actions. The More menu is
// built from the session's fresh history row (never the list's possibly stale copy); an item sends one overlay op; the
// refreshed row is placed back in the service order, or removed when gone or outside the current list, never at a
// guessed position; focus falls back to the following record, then the previous (VirtualList's neighbour handover),
// then the results heading.
import type { HistoryRow, OVERLAY_ERRORS, OverlayOp } from '../../shared/ipc.ts';
import { order, type BrowseRow, type Query } from './browse.ts';

export type ActionKind = 'pin' | 'archive' | 'keep' | 'trash';
/** checked: a toggle's state (menuitemcheckbox), null for a plain action. */
export interface MenuItem { kind: ActionKind; label: string; checked: boolean | null }

/** A Trash row has no menu: it offers Restore and Purge. */
export function menuItems(r: HistoryRow): MenuItem[] {
  if (r.trashedAt !== null) return [];
  return [
    { kind: 'pin', label: 'Pin', checked: r.pinned }, { kind: 'archive', label: 'Archive', checked: r.archivedAt !== null },
    { kind: 'keep', label: 'Keep', checked: r.keep }, { kind: 'trash', label: 'Move to Trash', checked: null },
  ];
}

/** review M3: why a fresh row has no menu (gone, or in Trash since the list was read); null = it has one. */
export function menuClosed(r: HistoryRow | null): string | null {
  if (!r) return 'This session is no longer available.';
  return r.trashedAt !== null ? 'This session is in Trash.' : null;
}

const isOn = (kind: ActionKind, r: HistoryRow) => (kind === 'pin' ? r.pinned : kind === 'archive' ? r.archivedAt !== null : kind === 'keep' ? r.keep : r.trashedAt !== null);
export const opOf = (kind: ActionKind, r: HistoryRow): OverlayOp => ({ kind, session: r.id, on: !isOn(kind, r) });

/** Whether a row belongs to the current list by mode and agent. A map-group filter is not re-evaluated: none of these
 *  actions changes a row's group (Trash leaves every group by its mode). */
export function matches(q: Query, r: HistoryRow): boolean {
  if (q.agent !== null && r.agent !== q.agent) return false;
  switch (q.mode) {
    case 'all': return r.trashedAt === null;
    case 'archived': return r.archivedAt !== null && r.trashedAt === null;
    case 'trash': return r.trashedAt !== null;
    case 'live': return true;
  }
}

/** The refreshed row `row` (null = gone) for session `id`. A present row is replaced (in the service order unless
 *  searching); a row that belongs here but is not shown (Undo) is inserted only where its place is known: not in search
 *  results (rank unknown) and not past the loaded window while `more` pages remain. placed = the row is in the list. */
export function place(rows: BrowseRow[], id: number, row: HistoryRow | null, q: Query, more: boolean): { rows: BrowseRow[]; placed: boolean } {
  const rest = rows.filter((r) => r.id !== id);
  if (!row || !matches(q, row)) return { rows: rest, placed: false };
  const searching = q.search !== '';
  const last = rows.at(-1);
  const past = !searching && more && last !== undefined && order(row, last) > 0; // review L4: beyond the loaded window
  if (rest.length < rows.length) {
    if (past) return { rows: rest, placed: false }; // Load more brings it in its place
    const replaced = rows.map((r) => (r.id === id ? row : r));
    return { rows: searching ? replaced : replaced.sort(order), placed: true };
  }
  if (searching || past) return { rows, placed: false };
  return { rows: [...rows, row].sort(order), placed: true };
}

const DONE: Record<Exclude<ActionKind, 'trash'>, [string, string]> = {
  pin: ['Pinned.', 'Unpinned.'], archive: ['Archived.', 'Unarchived.'], keep: ['Kept. Retention will not purge this session.', 'Keep removed.'],
};
export const doneText = (kind: Exclude<ActionKind, 'trash'>, on: boolean) => DONE[kind][on ? 0 : 1];
export function errorText(e: (typeof OVERLAY_ERRORS)[number]): string {
  switch (e) {
    case 'read-only': return 'Xaibo is read-only. Nothing was changed.';
    case 'disk-full': return 'The disk is full. Nothing was changed.';
    case 'not-found': return 'This session is no longer available.';
    default: return 'The change could not be saved.';
  }
}

export const NOTICE = 'Moved to Trash. Only the Xaibo copy is affected; native files are untouched.';
/** The Undo notice (design §5.1): one at a time; a Trash while one is shown updates it to undo the latest. */
export interface Undo { id: number; stacked: boolean; status: 'ready' | 'undoing' | 'failed' | 'restored'; note: string | null }
export const trashed = (prev: Undo | null, id: number): Undo => ({ id, stacked: prev !== null && prev.status !== 'restored', status: 'ready', note: null });
/** review M1: an Undo reply for session `id` changes the notice only while it is still that session's. */
export const undone = (cur: Undo | null, id: number, patch: Pick<Undo, 'status' | 'note'>): Undo | null => (cur?.id === id ? { ...cur, ...patch } : cur);
export const undoLabel = (u: Undo) => (u.stacked ? 'Undo latest Trash' : 'Undo');
