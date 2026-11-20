// XAIBO-PROD-532 (P5-T18 part 3b-3; design §6.4, §5.1, §5.4; look D-P5-09): Session list row actions. The More menu is
// built from the session's fresh history row (never the list's possibly stale copy); an item sends one overlay op; the
// refreshed row is placed back in the service order, or removed when gone or outside the current list, never at a
// guessed position; focus falls back to the following record, then the previous (VirtualList's neighbour handover),
// then the results heading.
import type { HistoryRow, LiveStatus, OVERLAY_ERRORS, OverlayOp } from '../../shared/ipc.ts';
import { formatTime } from '../model.ts';
import { order, type BrowseRow, type Query } from './browse.ts';

export type ActionKind = 'move' | 'pin' | 'archive' | 'keep' | 'trash';
/** checked: a toggle's state (menuitemcheckbox), null for a plain action. */
export interface MenuItem { kind: ActionKind; label: string; checked: boolean | null }

/** A Trash row has no menu: it offers Restore and Purge. */
export function menuItems(r: HistoryRow): MenuItem[] {
  if (r.trashedAt !== null) return [];
  return [
    { kind: 'move', label: 'Move to…', checked: null }, // XAIBO-PROD-535: opens the Move dialog
    { kind: 'pin', label: 'Pin', checked: r.pinned }, { kind: 'archive', label: 'Archive', checked: r.archivedAt !== null },
    { kind: 'keep', label: 'Keep', checked: r.keep }, { kind: 'trash', label: 'Move to Trash', checked: null },
  ];
}

/** XAIBO-PROD-535 (design §6.3): the open session's More actions; Keep is its own toggle in the header. */
export const headerItems = (r: HistoryRow): MenuItem[] => menuItems(r).filter((i) => i.kind !== 'keep');

/** review M3: why a fresh row has no menu (gone, or in Trash since the list was read); null = it has one. */
export function menuClosed(r: HistoryRow | null): string | null {
  if (!r) return 'This session is no longer available.';
  return r.trashedAt !== null ? 'This session is in Trash.' : null;
}

export type Toggle = Exclude<ActionKind, 'move'>;
const isOn = (kind: Toggle, r: HistoryRow) => (kind === 'pin' ? r.pinned : kind === 'archive' ? r.archivedAt !== null : kind === 'keep' ? r.keep : r.trashedAt !== null);
export const opOf = (kind: Toggle, r: HistoryRow): OverlayOp => ({ kind, session: r.id, on: !isOn(kind, r) });

/** Whether a row belongs to the current list by mode, agent and map group. Of a map group only the project override is
 *  re-evaluated (XAIBO-PROD-535: Move changes it; its place, repository or cwd, never changes; Trash leaves every group
 *  by its mode). */
export function matches(q: Query, r: HistoryRow): boolean {
  if (q.agent !== null && r.agent !== q.agent) return false;
  if (q.group && (q.group.project === null ? r.project !== null : r.project?.id !== q.group.project)) return false;
  switch (q.mode) {
    case 'all': return r.trashedAt === null;
    case 'archived': return r.archivedAt !== null && r.trashedAt === null;
    case 'trash': return r.trashedAt !== null;
    case 'live': return true;
    case 'suppressed': return false; // XAIBO-PROD-536: suppression metadata, never history rows
  }
}

/** The refreshed row `row` (null = gone) for session `id`. A present row is replaced (in the service order unless
 *  searching); a row that belongs here but is not shown (Undo) is inserted only where its place is known: not in search
 *  results (rank unknown), not past the loaded window while `more` pages remain, and (Gate 5 G5c-1) not into a repository
 *  or cwd group, whose membership a history row does not carry. placed = the row is in the list. */
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
  if (searching || past || (q.group && q.group.at !== null)) return { rows, placed: false };
  return { rows: [...rows, row].sort(order), placed: true };
}

const DONE: Record<Exclude<Toggle, 'trash'>, [string, string]> = {
  pin: ['Pinned.', 'Unpinned.'], archive: ['Archived.', 'Unarchived.'], keep: ['Kept. Retention will not purge this session.', 'Keep removed.'],
};
export const doneText = (kind: Exclude<Toggle, 'trash'>, on: boolean) => DONE[kind][on ? 0 : 1];
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
export interface Undo { id: number; stacked: boolean; status: 'ready' | 'undoing' | 'failed' | 'restored' | 'gone'; note: string | null }
export const trashed = (prev: Undo | null, id: number): Undo => ({ id, stacked: prev !== null && prev.status !== 'restored' && prev.status !== 'gone', status: 'ready', note: null });
/** XAIBO-PROD-534 review L4: a session that is gone (purged) can no longer be undone; never while its own Undo runs. */
export const GONE_UNDO = 'This session is no longer available, so it cannot be restored.';
export const goneUndo = (u: Undo | null, id: number): Undo | null =>
  (u?.id === id && (u.status === 'ready' || u.status === 'failed') ? { ...u, status: 'gone', note: GONE_UNDO } : u);
/** review M1: an Undo reply for session `id` changes the notice only while it is still that session's. */
export const undone = (cur: Undo | null, id: number, patch: Pick<Undo, 'status' | 'note'>): Undo | null => (cur?.id === id ? { ...cur, ...patch } : cur);
export const undoLabel = (u: Undo) => (u.stacked ? 'Undo latest Trash' : 'Undo');
/** Gate 5 G5d-3 (design §5.4): where focus goes after Undo: the open session's title when it is the restored one, else
 *  the restored record in the list, else the list heading (with Open restored session). */
export const undoFocus = (id: number, openId: number | null, placed: boolean): 'title' | 'record' | 'heading' =>
  (id === openId ? 'title' : placed ? 'record' : 'heading');

const day = (ms: number) => formatTime(ms).slice(0, 10);
/** Retention never purges an active session (EC-22; service retention/policy.isActive). */
const ACTIVE: readonly LiveStatus['lifecycle'][] = ['busy', 'waiting-for-permission', 'needs-input'];
/** XAIBO-PROD-533 (design §6.3): the open session's retention line from its fresh history row (undefined = not read
 *  yet: Loading) and its current live state. Not read, failed or gone never shows a default (design security review L3). */
export function retentionLine(h: { row: HistoryRow | null; failed: boolean } | undefined, live: LiveStatus | null): string {
  if (!h) return 'Loading retention…'; // E2E-found: the line is reserved while the row loads (no later header growth)
  const r = h.row;
  if (h.failed || !r) return 'Retention unavailable';
  if (r.trashedAt !== null) return r.trashPurgeAt !== null ? `In Trash · Auto-empty ${day(r.trashPurgeAt)}` : 'In Trash';
  if (r.keep) return 'Kept';
  if (r.purgeAt === null) return 'No purge scheduled';
  return live && ACTIVE.includes(live.lifecycle) ? 'Active; retention paused' : `Purge scheduled ${day(r.purgeAt)}`;
}

/** XAIBO-PROD-533: a history row shared between the list and the open session; row null = the session is gone. */
export interface Shared { id: number; row: HistoryRow | null; n: number }
/** The open session's state from a shared row: its own session only (review #1: a gone row applies as gone), and never
 *  a row that changes nothing: its own share coming back, or gone onto gone (`held`: its state; E2E-found and
 *  re-review: either would clear its outcome note). After a failed read any shared row applies. */
export const sharedRow = (s: Shared, id: number, held?: { row: HistoryRow | null; failed: boolean }): { row: HistoryRow | null; failed: false } | null =>
  (s.id === id && !(held && !held.failed && s.row === held.row) ? { row: s.row, failed: false } : null);
