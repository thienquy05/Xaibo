// XAIBO-PROD-534 (P5-T18 part 3b-5; design §6.4, §5.4, §5.1; D-P5-07, D-P5-09): Trash Restore and Purge. Purge always
// asks first with the §5.4 copy; its outcome is said in words; purged (or already gone) closes the dialog and removes the
// record; any other result stays in the open dialog with Close (no resubmission), or goes next to the trigger when the
// dialog was already closed (Chromium can close a dialog on a second Escape even while applying).
import type { HistoryRow, PurgeResult } from '../../shared/ipc.ts';
import { routeResult, type DialogState } from '../components/dialog-model.ts';
import { APPLYING, day, RESULT_UNAVAILABLE } from '../model.ts';

export type PurgePhase = 'applying' | PurgeResult | 'unavailable' | null;

export const PURGE_TITLE = 'Purge Xaibo copy?';
/** One session per purge (no batch form: D-P5-07). */
export const PURGE_BODY = '1 session. Xaibo removes its copy and suppresses the session, so it is not imported again unless you choose Re-import in'
  + ' Suppressed. Native files are untouched. This is logical deletion, not forensic secure erasure.';

export function purgeText(p: PurgePhase): string {
  switch (p) {
    case null: return '';
    case 'applying': return APPLYING;
    case 'purged': return 'Purged. Only the Xaibo copy was removed; native files are untouched.';
    case 'pending': return 'Purge started but could not finish now. The session stays hidden and is not imported again; Xaibo finishes removing its copy automatically, at the next start or within a day.';
    case 'not-found': return 'This session is no longer available.';
    case 'busy': return 'Nothing was purged: at most 10 purges a minute. Try again shortly.'; // D-P5-07
    case 'read-only': return 'Nothing was purged: the store is read-only.';
    case 'disk-full': return 'Nothing was purged: the disk is full.';
    case 'failed': return 'Nothing was purged.';
    case 'unavailable': return RESULT_UNAVAILABLE;
  }
}

export type PurgeSettled = Exclude<PurgePhase, 'applying' | null>;
const GONE = new Set<PurgeSettled>(['purged', 'pending', 'not-found']);
/** Purged, pending (the service keeps the session hidden) or already gone is done: close the dialog, remove the record
 *  (and close its conversation); anything else stays (components/dialog-model.ts routeResult). */
export const routePurge = (r: PurgeSettled, dialogOpen: boolean) => routeResult(r, GONE.has(r), dialogOpen, purgeText);
/** The open session's Trash banner lines; an unknown date is said, never guessed. */
export function trashBanner(r: HistoryRow): { trashed: string; autoEmpty: string } {
  return {
    trashed: r.trashedAt !== null ? `Moved to Trash ${day(r.trashedAt)}` : 'In Trash',
    autoEmpty: r.trashPurgeAt !== null ? `Auto-empty ${day(r.trashPurgeAt)}` : 'Auto-empty date unavailable',
  };
}

/** Design §5.4: after a purge from the dialog (focus is not in the list, so the list's own neighbour handover does not
 *  apply) the following record, else the previous; null = the list heading. */
export function neighbourId(rows: readonly { id: number }[], id: number): number | null {
  const i = rows.findIndex((r) => r.id === id);
  return i < 0 ? null : (rows[i + 1]?.id ?? rows[i - 1]?.id ?? null);
}

/** The Purge dialog (review M1), keyed by session id: one purge at a time (Chromium can close the dialog on a second
 *  Escape while applying, and it can be reopened); runs on components/dialog-model.ts dialogStep with routePurge. */
export type PurgeState = DialogState<number, PurgeSettled>;
