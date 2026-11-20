// XAIBO-PROD-536 (P5-T18 part 3b-7; design §6.4 Suppressed, §5.4 Re-import, §5.1 dialog transactions; D-P5-08, D-P5-09):
// the Suppressed mode's logic. A record shows only what the suppression metadata holds (agent, profile label or
// Unavailable, reason, date, pending file cleanup); a purged session has no title or transcript, and none is invented.
// Re-import asks first; its outcome is said in words; ok, none and not-found leave the list (the session comes back
// through the next scan, kept per D-P5-08); any other result keeps the record and says why.
import type { REIMPORT_RESULTS, SuppressedRow } from '../../shared/ipc.ts';
import { formatTime } from '../model.ts';

const day = (ms: number) => formatTime(ms).slice(0, 10);
export function suppressedLines(r: SuppressedRow): { title: string; lines: string[] } {
  return {
    title: `${r.agent} · ${r.profile}`,
    lines: [r.reason === 'manual' ? 'Purged by you' : 'Purged by retention', `Purged ${day(r.at)}`, ...(r.filesPending ? ['File cleanup pending'] : [])],
  };
}
/** A record's accessible name, from metadata only. */
export const recordName = (r: SuppressedRow) => `${r.agent} session purged ${day(r.at)}`;

export const REIMPORT_TITLE = 'Re-import this session?';
export const REIMPORT_BODY = 'Xaibo removes the suppression and reads the session again from its native files where they still exist. The session'
  + ' returns with Keep set, so retention does not purge it again. Content that is no longer in the native files cannot come back.';

export type ReimportResult = (typeof REIMPORT_RESULTS)[number];
export type ReimportPhase = 'applying' | ReimportResult | 'unavailable' | null;
export function reimportText(p: ReimportPhase): string {
  switch (p) {
    case null: return '';
    case 'applying': return 'Applying changes…';
    case 'ok': return 'Re-imported. The session returns to the list once its native files are read again; Keep is set.';
    case 'none': return 'This session is no longer suppressed.';
    case 'pending': return 'Nothing was re-imported yet: the purge is still finishing its file cleanup. Try again shortly.';
    case 'native-gone': return 'Nothing was re-imported: the session\'s native files no longer exist.';
    case 'not-found': return 'This suppressed session is no longer listed.';
    case 'read-only': return 'Nothing was re-imported: the store is read-only.';
    case 'disk-full': return 'Nothing was re-imported: the disk is full.';
    case 'failed': return 'Nothing was re-imported.';
    case 'unavailable': return 'The result is unavailable. Closing this dialog does not cancel the operation.';
  }
}

export type Settled = Exclude<ReimportPhase, 'applying' | null>;
/** close: close the dialog; gone: the record leaves the list (and its pane closes); dialog: the phase an open dialog
 *  keeps with Close only; note: the text beside the trigger or the list heading. */
export function routeReimport(r: Settled, dialogOpen: boolean): { close: boolean; gone: boolean; dialog: ReimportPhase; note: string | null } {
  if (r === 'ok' || r === 'none' || r === 'not-found') return { close: dialogOpen, gone: true, dialog: null, note: reimportText(r) };
  // review L3: beside the trigger no dialog is left to close
  return dialogOpen ? { close: false, gone: false, dialog: r, note: null } : { close: false, gone: false, dialog: null, note: r === 'unavailable' ? 'The result is unavailable.' : reimportText(r) };
}

/** review M1: a result for the record the pane shows goes to that pane; otherwise (the pane closed or shows another
 *  record) beside the list heading, removing the record when it left. ponytail (re-review): results arriving after the
 *  Session area unmounted (another area chosen) are dropped and its in-flight guard with them, as Purge and Move; a
 *  second send then reads none or not-found (gone). Lift both into main.tsx if that matters. */
export function deliver(r: Settled, key: string, shownKey: string | null): { to: 'pane' } | { to: 'list'; gone: boolean; note: string } {
  if (shownKey === key) return { to: 'pane' };
  const out = routeReimport(r, false);
  return { to: 'list', gone: out.gone, note: out.note ?? '' };
}

/** The pane's one Re-import dialog: open, a Re-import in flight (one at a time: Chromium can close a dialog on a second
 *  Escape while applying, and it can be reopened), and the phase it shows. */
export interface ReimportState { open: boolean; inflight: boolean; phase: ReimportPhase }
export type ReimportEvent = { type: 'open' } | { type: 'confirm' } | { type: 'closed' } | { type: 'result'; result: Settled; dialogOpen: boolean };
export function reimportStep(s: ReimportState, e: ReimportEvent): { s: ReimportState; send?: true; close?: boolean; outcome?: ReturnType<typeof routeReimport> } {
  switch (e.type) {
    case 'open': return { s: { open: true, inflight: s.inflight, phase: s.inflight ? 'applying' : null } };
    case 'confirm': return !s.open || s.inflight || s.phase !== null ? { s } : { s: { ...s, inflight: true, phase: 'applying' }, send: true };
    case 'closed': return { s: { ...s, open: false, phase: null } };
    case 'result': {
      const outcome = routeReimport(e.result, e.dialogOpen && s.open);
      return { s: { open: s.open && !outcome.close, inflight: false, phase: s.open ? outcome.dialog : null }, close: outcome.close, outcome };
    }
  }
}

/** re-review M: a Re-import result present when the list mounts is old news (a fresh list loads from the service; a
 *  record purged again after an earlier Re-import must stay listed); only a later result removes a record. */
export const newGone = (g: { n: number } | null, seen: number | undefined) => g !== null && g.n !== seen;

/** A later page adds only records not shown yet (a marker can move between pages while they load). */
export const appendPage = (rows: SuppressedRow[], page: SuppressedRow[]) => {
  const have = new Set(rows.map((r) => r.key));
  return [...rows, ...page.filter((r) => !have.has(r.key))];
};
