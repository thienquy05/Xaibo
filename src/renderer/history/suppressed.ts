// XAIBO-PROD-536 (P5-T18 part 3b-7; design §6.4 Suppressed, §5.4 Re-import, §5.1 dialog transactions; D-P5-08, D-P5-09):
// the Suppressed mode's logic. A record shows only what the suppression metadata holds (agent, profile label or
// Unavailable, reason, date, pending file cleanup); a purged session has no title or transcript, and none is invented.
// Re-import asks first; its outcome is said in words; ok, none and not-found leave the list (the session comes back
// through the next scan, kept per D-P5-08); any other result keeps the record and says why.
import type { ReimportResult, SuppressedRow } from '../../shared/ipc.ts';
import { routeResult, type DialogState } from '../components/dialog-model.ts';
import { APPLYING, day, RESULT_UNAVAILABLE } from '../model.ts';

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

export type ReimportPhase = 'applying' | ReimportResult | 'unavailable' | null;
export function reimportText(p: ReimportPhase): string {
  switch (p) {
    case null: return '';
    case 'applying': return APPLYING;
    case 'ok': return 'Re-imported. The session returns to the list once its native files are read again; Keep is set.';
    case 'none': return 'This session is no longer suppressed.';
    case 'pending': return 'Nothing was re-imported yet: the purge is still finishing its file cleanup. Try again shortly.';
    case 'native-gone': return 'Nothing was re-imported: the session\'s native files no longer exist.';
    case 'not-found': return 'This suppressed session is no longer listed.';
    case 'read-only': return 'Nothing was re-imported: the store is read-only.';
    case 'disk-full': return 'Nothing was re-imported: the disk is full.';
    case 'failed': return 'Nothing was re-imported.';
    case 'unavailable': return RESULT_UNAVAILABLE;
  }
}

export type Settled = Exclude<ReimportPhase, 'applying' | null>;
const GONE = new Set<Settled>(['ok', 'none', 'not-found']);
/** ok, none or not-found is done: the record leaves the list (and its pane closes); anything else stays
 *  (components/dialog-model.ts routeResult). review L3: beside the trigger no dialog is left to close. */
export const routeReimport = (r: Settled, dialogOpen: boolean) =>
  routeResult(r, GONE.has(r), dialogOpen, (p) => (p === 'unavailable' ? 'The result is unavailable.' : reimportText(p)));

/** review M1: a result for the record the pane shows goes to that pane; otherwise (the pane closed or shows another
 *  record) beside the list heading, removing the record when it left. ponytail (re-review): results arriving after the
 *  Session area unmounted (another area chosen) are dropped and its in-flight guard with them, as Purge and Move; a
 *  second send then reads none or not-found (gone). Lift both into main.tsx if that matters. */
export function deliver(r: Settled, key: string, shownKey: string | null): { to: 'pane' } | { to: 'list'; gone: boolean; note: string } {
  if (shownKey === key) return { to: 'pane' };
  const out = routeReimport(r, false);
  return { to: 'list', gone: out.done, note: out.note ?? '' };
}

/** The pane's one Re-import dialog, keyed by the record's key: one Re-import at a time (Chromium can close a dialog on a
 *  second Escape while applying, and it can be reopened); runs on dialogStep with routeReimport. */
export type ReimportState = DialogState<string, Settled>;

/** re-review M: a Re-import result present when the list mounts is old news (a fresh list loads from the service; a
 *  record purged again after an earlier Re-import must stay listed); only a later result removes a record. */
export const newGone = (g: { n: number } | null, seen: number | undefined) => g !== null && g.n !== seen;

/** A later page adds only records not shown yet (a marker can move between pages while they load). */
export const appendPage = (rows: SuppressedRow[], page: SuppressedRow[]) => {
  const have = new Set(rows.map((r) => r.key));
  return [...rows, ...page.filter((r) => !have.has(r.key))];
};
