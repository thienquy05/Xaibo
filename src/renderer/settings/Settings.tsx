// XAIBO-PROD-525 (P5-T16; design §6.6, §5.1 dialog transactions, §5.4, FR-52, Q-5.8): the Settings area. Only its Usage
// history section exists so far (the other §6.6 sections arrive with P5-T18): Clear usage history behind a modal
// confirmation (initial focus on Cancel). While the clear runs the dialog says Applying changes… and cannot be dismissed;
// a failure or an unknown outcome stays in the dialog with Close. Cancel, Close and success return focus to the Clear
// usage history button; success is announced next to it (the health band keeps the only status role). A read-only store
// disables the button and says why.
import { useRef, useState } from 'react';
import type { ClearUsageResult } from '../../shared/ipc.ts';

export interface SettingsApi { clearUsage(): Promise<ClearUsageResult> }
type Phase = 'applying' | ClearUsageResult | 'unavailable' | null;

export function clearStatusText(p: Phase): string {
  switch (p) {
    case null: return '';
    case 'applying': return 'Applying changes…';
    case 'cleared': return 'Usage history cleared. Usage observed from now on will appear.';
    case 'read-only': return 'Usage history was not cleared: the store is read-only.';
    case 'failed': return 'Usage history was not cleared. Nothing was changed.';
    case 'unavailable': return 'The result is unavailable. Closing this dialog does not cancel the operation.';
  }
}

/** Review M4: where a result is shown. Success closes the dialog and is announced next to the button; any other result
 *  stays in the dialog while it is open, or goes next to the button when the dialog was already closed (Chromium closes
 *  a dialog on a second Escape without a cancel event, even while applying). */
export function routeResult(r: Exclude<Phase, 'applying' | null>, dialogOpen: boolean): { close: boolean; dialog: Phase; section: Phase } {
  if (r === 'cleared') return { close: dialogOpen, dialog: null, section: 'cleared' };
  return dialogOpen ? { close: false, dialog: r, section: null } : { close: false, dialog: null, section: r };
}

export function Settings({ api, readOnly }: { api: SettingsApi; readOnly: boolean }) {
  const [phase, setPhase] = useState<Phase>(null); // the dialog's transaction
  const [section, setSection] = useState<Phase>(null); // the announcement next to the button
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { dialog.current?.close(); setPhase(null); trigger.current?.focus(); };
  const applying = useRef(false); // a request is in flight (read by the close event, which may outrun a render)
  const show = (r: Exclude<Phase, 'applying' | null>) => {
    applying.current = false;
    const to = routeResult(r, dialog.current?.open === true);
    if (to.close) close();
    setPhase(to.dialog);
    setSection(to.section);
  };
  const confirm = () => {
    applying.current = true;
    setPhase('applying');
    setSection(null);
    api.clearUsage().then(show, () => show('unavailable'));
  };
  const open = () => { setSection(null); setPhase(null); dialog.current?.showModal(); };
  // a close we did not ask for while applying: the button takes focus and the section carries the transaction
  const closed = () => { if (applying.current) { setPhase(null); setSection('applying'); trigger.current?.focus(); } };
  // ponytail: Clear usage history can be confirmed again after an unknown outcome; a second clear is the same request
  // (it also clears what was observed in between, which the confirmation says). Reconcile first if that ever matters.
  return (
    <div className="x-settings">
      <h1 id="settings-heading" tabIndex={-1}>Settings</h1>
      <section className="x-settings-section" aria-labelledby="usage-history-heading">
        <div>
          <h2 id="usage-history-heading">Usage history</h2>
          <p id="usage-history-hint">
            Removes the frozen monthly totals and excludes all usage already observed from future totals. Usage observed afterwards
            still counts. This is not a session purge or a quota reset.
          </p>
        </div>
        <div className="x-settings-controls">
          <button ref={trigger} type="button" className="x-btn x-btn-secondary" disabled={readOnly} aria-describedby="usage-history-hint"
            aria-disabled={section === 'applying' || undefined} onClick={() => { if (section !== 'applying') open(); }}>
            Clear usage history
          </button>
          {readOnly ? <p>Unavailable while the store is read-only.</p> : null}
          <span aria-live="polite">{clearStatusText(section)}</span>
        </div>
      </section>
      {/* Escape is Cancel before submission and blocked while applying (§5.1) */}
      <dialog ref={dialog} className="x-dialog" aria-labelledby="clear-usage-title" aria-describedby="clear-usage-body"
        onCancel={(e) => { e.preventDefault(); if (phase !== 'applying') close(); }} onClose={closed}>
        <h2 id="clear-usage-title">Clear usage history?</h2>
        <p id="clear-usage-body">
          The monthly totals are removed and every usage record already observed is left out of them from now on. Usage observed
          afterwards appears as usual. Sessions, account usage snapshots and quotas are not deleted.
        </p>
        <p aria-live="polite">{clearStatusText(phase)}</p>
        <div className="x-dialog-actions">{/* Close replaces the pressed button after a failure, so it takes focus */}
          {phase === null || phase === 'applying' ? <>
            <button type="button" className="x-btn x-btn-secondary" aria-disabled={phase === 'applying' || undefined} onClick={() => { if (phase === null) close(); }}>Cancel</button>
            <button type="button" className="x-btn x-btn-primary" aria-disabled={phase === 'applying' || undefined} aria-busy={phase === 'applying' || undefined}
              onClick={() => { if (phase === null) confirm(); }}>Clear usage history</button>
          </> : <button type="button" className="x-btn x-btn-secondary" autoFocus onClick={close}>Close</button>}
        </div>
      </dialog>
    </div>
  );
}
