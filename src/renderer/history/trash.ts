// XAIBO-PROD-534 (P5-T18 part 3b-5; design §6.4, §5.4, §5.1; D-P5-07, D-P5-09): Trash Restore and Purge. Purge always
// asks first with the §5.4 copy; its outcome is said in words; purged (or already gone) closes the dialog and removes the
// record; any other result stays in the open dialog with Close (no resubmission), or goes next to the trigger when the
// dialog was already closed (Chromium can close a dialog on a second Escape even while applying).
import type { HistoryRow, PURGE_RESULTS } from '../../shared/ipc.ts';
import { formatTime } from '../model.ts';

export type PurgeResult = (typeof PURGE_RESULTS)[number];
export type PurgePhase = 'applying' | PurgeResult | 'unavailable' | null;

export const PURGE_TITLE = 'Purge Xaibo copy?';
/** One session per purge (no batch form: D-P5-07). */
export const PURGE_BODY = '1 session. Xaibo removes its copy and suppresses the session, so it is not imported again unless you choose Re-import in'
  + ' Suppressed. Native files are untouched. This is logical deletion, not forensic secure erasure.';

export function purgeText(p: PurgePhase): string {
  switch (p) {
    case null: return '';
    case 'applying': return 'Applying changes…';
    case 'purged': return 'Purged. Only the Xaibo copy was removed; native files are untouched.';
    case 'pending': return 'Purge started but could not finish now. The session stays hidden and is not imported again; Xaibo finishes removing its copy automatically, at the next start or within a day.';
    case 'not-found': return 'This session is no longer available.';
    case 'busy': return 'Nothing was purged: at most 10 purges a minute. Try again shortly.'; // D-P5-07
    case 'read-only': return 'Nothing was purged: the store is read-only.';
    case 'disk-full': return 'Nothing was purged: the disk is full.';
    case 'failed': return 'Nothing was purged.';
    case 'unavailable': return 'The result is unavailable. Closing this dialog does not cancel the operation.';
  }
}

/** close: close the dialog; gone: remove the record (and close its conversation); dialog: the phase it keeps showing;
 *  note: the text next to the trigger. */
export function routePurge(r: Exclude<PurgePhase, 'applying' | null>, dialogOpen: boolean): { close: boolean; gone: boolean; dialog: PurgePhase; note: string | null } {
  if (r === 'purged' || r === 'pending' || r === 'not-found') return { close: dialogOpen, gone: true, dialog: null, note: purgeText(r) };
  return dialogOpen ? { close: false, gone: false, dialog: r, note: null } : { close: false, gone: false, dialog: null, note: purgeText(r) };
}

const day = (ms: number) => formatTime(ms).slice(0, 10);
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

/** The Purge dialog (review M1): shown = the session the open dialog asks about; inflight = the session whose purge is
 *  running (one at a time: Chromium can close the dialog on a second Escape while applying, and it can be reopened). */
export interface PurgeState { shown: number | null; inflight: number | null; phase: PurgePhase }
export type PurgeEvent = { type: 'open'; id: number } | { type: 'confirm' } | { type: 'closed' }
  | { type: 'result'; session: number; result: Exclude<PurgePhase, 'applying' | null>; dialogOpen: boolean };
/** send: the session to purge now; close: close the dialog; outcome: where the result goes (removal, note). A result
 *  changes the dialog only while it still shows that session. */
export function purgeStep(s: PurgeState, e: PurgeEvent): { s: PurgeState; send?: number; close?: boolean; outcome?: ReturnType<typeof routePurge> } {
  switch (e.type) {
    case 'open': return { s: { shown: e.id, inflight: s.inflight, phase: s.inflight !== null ? 'applying' : null } };
    case 'confirm':
      if (s.shown === null || s.inflight !== null || s.phase !== null) return { s };
      return { s: { ...s, inflight: s.shown, phase: 'applying' }, send: s.shown };
    case 'closed': return { s: { ...s, shown: null, phase: null } };
    case 'result': {
      const mine = s.shown === e.session;
      const outcome = routePurge(e.result, e.dialogOpen && mine);
      return { s: { shown: s.shown, inflight: null, phase: mine ? outcome.dialog : null }, close: outcome.close, outcome };
    }
  }
}
