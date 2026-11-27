// XAIBO-PROD-551 (D-P5-15 item 1; design §5.1 Dialog and dialog transactions, §5.4): the one modal confirmation behind
// Purge, Re-import and Clear usage history. Initial focus on Cancel; Escape is Cancel before submission and blocked while
// applying (the dialog says so and cannot be dismissed); a settled failure or unknown outcome keeps Close only, never a
// resubmission. The caller owns the transaction (phase, text, where focus returns) and the native close event.
import type { ReactNode, RefObject } from 'react';

export function ConfirmDialog({ dialog, name, title, body, phase, text, confirm, danger = false, onConfirm, onDismiss, onClosed }: {
  dialog: RefObject<HTMLDialogElement | null>;
  /** The id prefix of the title and body (aria-labelledby, aria-describedby). */
  name: string; title: string; body: ReactNode;
  /** null = not submitted; 'applying'; anything else = settled (Close only). */
  phase: string | null; text: string; confirm: string; danger?: boolean;
  onConfirm: () => void;
  /** Cancel, Close or Escape before submission. */
  onDismiss: () => void;
  /** The native close event (also a close we did not ask for). */
  onClosed: () => void;
}) {
  const applying = phase === 'applying';
  return (
    <dialog ref={dialog} className="x-dialog" aria-labelledby={`${name}-title`} aria-describedby={`${name}-body`}
      onCancel={(e) => { e.preventDefault(); if (!applying) onDismiss(); }} onClose={onClosed}>
      <h2 id={`${name}-title`}>{title}</h2>
      <p id={`${name}-body`}>{body}</p>
      <p aria-live="polite">{text}</p>
      <div className="x-dialog-actions">{/* Close replaces the pressed buttons after a failure, so it takes focus */}
        {phase === null || applying ? <>
          <button type="button" className="x-btn x-btn-secondary" autoFocus aria-disabled={applying || undefined}
            onClick={() => { if (phase === null) onDismiss(); }}>Cancel</button>
          <button type="button" className={`x-btn ${danger ? 'x-btn-danger' : 'x-btn-primary'}`} aria-disabled={applying || undefined} aria-busy={applying || undefined}
            onClick={() => { if (phase === null) onConfirm(); }}>{confirm}</button>
        </> : <button type="button" className="x-btn x-btn-secondary" autoFocus onClick={onDismiss}>Close</button>}
      </div>
    </dialog>
  );
}
