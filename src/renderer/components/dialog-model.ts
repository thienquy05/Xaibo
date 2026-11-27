// XAIBO-PROD-551 (D-P5-15 item 2; design §5.1 dialog transactions, §5.4): the one model behind the confirmation dialogs
// that run a request (Purge, Re-import; Move routes its results the same way). Where a result goes: a success closes an
// open dialog and is said beside the trigger; any other result stays in the open dialog with Close only (no
// resubmission), or goes beside the trigger when the dialog was already closed (Chromium can close a dialog on a second
// Escape even while applying). One request is in flight at a time, keyed by what the dialog asks about.

export interface Routed<P> { close: boolean; done: boolean; dialog: P | null; note: string | null }
export function routeResult<P>(r: P, done: boolean, dialogOpen: boolean, text: (p: P) => string): Routed<P> {
  if (done) return { close: dialogOpen, done: true, dialog: null, note: text(r) };
  return dialogOpen ? { close: false, done: false, dialog: r, note: null } : { close: false, done: false, dialog: null, note: text(r) };
}

/** shown: what the open dialog asks about; inflight: whose request runs (a dialog reopened meanwhile says Applying and
 *  cannot send another); phase: what the open dialog shows. */
export interface DialogState<K, R> { shown: K | null; inflight: K | null; phase: R | 'applying' | null }
export type DialogEvent<K, R> = { type: 'open'; id: K } | { type: 'confirm' } | { type: 'closed' } | { type: 'result'; id: K; result: R; dialogOpen: boolean };
/** send: the id to request now; close: close the dialog; outcome: where the result goes. A result changes the dialog
 *  only while it still shows that id. */
export function dialogStep<K, R, O extends Routed<R>>(s: DialogState<K, R>, e: DialogEvent<K, R>, route: (r: R, dialogOpen: boolean) => O):
  { s: DialogState<K, R>; send?: K; close?: boolean; outcome?: O } {
  switch (e.type) {
    case 'open': return { s: { shown: e.id, inflight: s.inflight, phase: s.inflight !== null ? 'applying' : null } };
    case 'confirm':
      if (s.shown === null || s.inflight !== null || s.phase !== null) return { s };
      return { s: { ...s, inflight: s.shown, phase: 'applying' }, send: s.shown };
    case 'closed': return { s: { ...s, shown: null, phase: null } };
    case 'result': {
      const mine = s.shown === e.id;
      const outcome = route(e.result, e.dialogOpen && mine);
      return { s: { shown: s.shown, inflight: null, phase: mine ? outcome.dialog : null }, close: outcome.close, outcome };
    }
  }
}
