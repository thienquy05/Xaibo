// XAIBO-PROD-536 (P5-T18 part 3b-7; design §6.4, §5.4 Re-import, §5.1 Dialog and dialog transactions; D-P5-08, D-P5-09):
// an opened suppressed record: its metadata and reason, never a transcript (purged content is never reconstructed), and
// Re-import behind a confirmation (Cancel focused; Applying blocks dismissal; a failure or unknown outcome keeps Close
// only). ok, none and not-found go to `onGone` (the caller removes the record, closes this pane and focuses the list
// heading); any other result stays in the dialog, or beside Re-import when the dialog was already closed.
// review M1: the request and its result go through the Workspace (`send`, `outcome`), so a result is never lost when this
// pane closes, and a record reopened while its Re-import runs starts as applying.
import { useEffect, useRef, useState } from 'react';
import type { SuppressedRow } from '../../shared/ipc.ts';
import { formatTime } from '../model.ts';
import { Icon } from '../status/StatusBadge.tsx';
import { visible } from '../text.ts';
import { REIMPORT_BODY, REIMPORT_TITLE, reimportStep, reimportText, type ReimportEvent, type ReimportPhase, type ReimportState } from './suppressed.ts';
import type { Settled } from './suppressed.ts';

/** A Re-import result for the pane showing its record; n: each result once. */
export interface Outcome { key: string; result: Settled; n: number }

export function SuppressedPane({ row, inflight, send, outcome, onBack, onGone }: {
  row: SuppressedRow; inflight: boolean; send: (key: string) => void; outcome: Outcome | null; onBack: () => void;
  onGone: (key: string, note: string) => void;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const state = useRef<ReimportState>({ open: false, inflight, phase: null });
  const [phase, setPhase] = useState<ReimportPhase>(null);
  const [note, setNote] = useState<string | null>(inflight ? reimportText('applying') : null); // re-review: reopened while it runs
  useEffect(() => { title.current?.focus(); }, []);
  const step = (e: ReimportEvent) => { const r = reimportStep(state.current, e); state.current = r.s; setPhase(r.s.phase); return r; };
  const open = () => { setNote(null); step({ type: 'open' }); dialog.current?.showModal(); };
  const close = (refocus: boolean) => {
    step({ type: 'closed' });
    dialog.current?.close();
    if (refocus) trigger.current?.focus();
  };
  const confirm = () => { if (step({ type: 'confirm' }).send) send(row.key); };
  const seen = useRef(outcome?.n);
  useEffect(() => {
    if (!outcome || outcome.n === seen.current) return;
    seen.current = outcome.n;
    if (outcome.key !== row.key) return;
    const out = step({ type: 'result', result: outcome.result, dialogOpen: dialog.current?.open === true });
    if (out.close) close(false); // the record leaves; the caller moves focus
    if (out.outcome?.gone) onGone(row.key, out.outcome.note ?? '');
    else if (out.outcome?.note) setNote(out.outcome.note);
  }, [outcome]);
  // a close we did not ask for while applying (§5.1): Re-import takes focus and the pending outcome is said beside it
  const closed = () => {
    if (!state.current.open) return; // our own close
    const running = state.current.inflight;
    step({ type: 'closed' });
    trigger.current?.focus();
    if (running) setNote(reimportText('applying'));
  };

  return (
    <section className="x-pane x-open x-supp" aria-labelledby="suppressed-title">
      <div className="x-open-head">
        <div className="x-open-title">
          <button type="button" className="x-btn x-btn-quiet x-icon-btn x-narrow-only" aria-label="Back to session list" onClick={onBack}><Icon id="back" /></button>
          <h2 id="suppressed-title" ref={title} tabIndex={-1}>Suppressed session</h2>
        </div>
      </div>
      <div className="x-scroll">
        <dl className="x-facts">
          <div><dt>Agent</dt><dd>{visible(row.agent)}</dd></div>
          <div><dt>Profile</dt><dd className="x-mono">{visible(row.profile)}</dd></div>
          <div><dt>Reason</dt><dd>{row.reason === 'manual' ? 'Purged by you' : 'Purged by retention'}</dd></div>
          <div><dt>Purged</dt><dd>{formatTime(row.at)}</dd></div>
          <div><dt>File cleanup</dt><dd>{row.filesPending ? 'Pending' : 'Done'}</dd></div>
        </dl>
        <div className="x-supp-body">
          <p>Xaibo removed its copy of this session and does not import it again. Its transcript is not shown: purged content is never
            reconstructed. Native files are untouched.</p>
          <button type="button" ref={trigger} className="x-btn x-btn-primary" onClick={open}>Re-import</button>
          <p className="x-action-note" aria-live="polite">{note}</p>
        </div>
      </div>
      <dialog ref={dialog} className="x-dialog" aria-labelledby="reimport-title" aria-describedby="reimport-body"
        onCancel={(e) => { e.preventDefault(); if (phase !== 'applying') close(true); }} onClose={closed}>
        <h2 id="reimport-title">{REIMPORT_TITLE}</h2>
        <p id="reimport-body">{REIMPORT_BODY}</p>
        <p aria-live="polite">{reimportText(phase)}</p>
        <div className="x-dialog-actions">{/* Close replaces the pressed buttons after a failure, so it takes focus */}
          {phase === null || phase === 'applying' ? <>
            <button type="button" className="x-btn x-btn-secondary" autoFocus aria-disabled={phase === 'applying' || undefined}
              onClick={() => { if (phase === null) close(true); }}>Cancel</button>
            <button type="button" className="x-btn x-btn-primary" aria-disabled={phase === 'applying' || undefined} aria-busy={phase === 'applying' || undefined}
              onClick={confirm}>Re-import</button>
          </> : <button type="button" className="x-btn x-btn-secondary" autoFocus onClick={() => close(true)}>Close</button>}
        </div>
      </dialog>
    </section>
  );
}
