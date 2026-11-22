// XAIBO-PROD-534 (P5-T18 part 3b-5; design §5.4 Purge, §5.1 dialog transactions; D-P5-09): the Purge confirmation as a
// modal <dialog> (initial focus on Cancel; Escape = Cancel before submission; while applying it says so and cannot be
// dismissed; a failure or an unknown outcome stays with Close and no resubmission). Cancel and Close return focus to the
// exact Purge trigger. The outcome goes to `onDone` (trash.routePurge): the caller removes a gone record and moves focus.
import { useEffect, useRef, useState } from 'react';
import type { PurgeResult } from '../../shared/ipc.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { dialogStep, type DialogEvent } from '../components/dialog-model.ts';
import { PURGE_BODY, PURGE_TITLE, purgeText, routePurge, type PurgePhase, type PurgeSettled, type PurgeState } from './trash.ts';

export type PurgeTarget = { id: number; trigger: HTMLElement | null } | null;
export type PurgeOutcome = ReturnType<typeof routePurge>;

export function PurgeDialog({ target, purge, onDone, onClosed }: {
  target: PurgeTarget; purge: (session: number) => Promise<PurgeResult>;
  onDone: (session: number, outcome: PurgeOutcome) => void;
  /** The dialog closed (the caller clears `target`). */
  onClosed: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // review M1: one purge in flight; results change the dialog only while it still shows their session (dialogStep)
  const state = useRef<PurgeState>({ shown: null, inflight: null, phase: null });
  const [phase, setPhase] = useState<PurgePhase>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const step = (e: DialogEvent<number, PurgeSettled>) => { const r = dialogStep(state.current, e, routePurge); state.current = r.s; setPhase(r.s.phase); return r; };
  useEffect(() => {
    if (!target) return;
    trigger.current = target.trigger;
    step({ type: 'open', id: target.id });
    if (!dialog.current?.open) dialog.current?.showModal();
  }, [target]);
  const close = (refocus: boolean) => {
    step({ type: 'closed' });
    dialog.current?.close();
    if (refocus) trigger.current?.focus();
    onClosed();
  };
  const confirm = () => {
    const r = step({ type: 'confirm' });
    if (r.send === undefined) return;
    const session = r.send;
    const done = (result: PurgeSettled) => {
      const out = step({ type: 'result', id: session, result, dialogOpen: dialog.current?.open === true });
      if (out.close) close(false); // purged or gone: its trigger left with the record; the caller moves focus
      if (out.outcome) onDone(session, out.outcome);
    };
    purge(session).then(done, () => done('unavailable'));
  };
  // a close we did not ask for while applying (§5.1): the trigger takes focus and the outcome is announced beside it
  const closed = () => {
    if (state.current.shown === null) return; // our own close
    const running = state.current.inflight;
    step({ type: 'closed' });
    trigger.current?.focus();
    if (running !== null) onDone(running, { close: false, done: false, dialog: null, note: purgeText('applying') });
    onClosed();
  };
  return (
    <ConfirmDialog dialog={dialog} name="purge" title={PURGE_TITLE} body={PURGE_BODY} phase={phase} text={purgeText(phase)} confirm="Purge" danger
      onConfirm={confirm} onDismiss={() => close(true)} onClosed={closed} />
  );
}
