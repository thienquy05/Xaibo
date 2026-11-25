// XAIBO-PROD-579 (P6-T10 unit 5; design §6.5.2, §5.1 Dialog and dialog transactions, §5.4; .handoff/p6-t10-design.md
// section 3, review R1/R8): the integration diff dialog for Connect, Disconnect, Full Uninstall, Clean up and (XAIBO-PROD-581)
// the separate status-line tee, over the
// model in integration-dialog.ts. Native showModal (browser modality, no manual trap), named by its heading; Cancel takes
// focus first; item checkboxes, then the named wrapped diff scrollport, conflicts and effects, then Cancel and Apply.
// Escape is Cancel before submission and does nothing while applying; a failure or a lost result keeps Close only. A close
// we did not ask for while applying (Chromium allows a second Escape) reopens the dialog (code review M1); a service lost
// meanwhile settles the request as Outcome unavailable (M2).
import { useEffect, useRef, useState } from 'react';
import type { CleanupReply, ConnectReply, IntegrationDetail, RemovalReply } from '../../shared/ipc.ts';
import { visible } from '../text.ts';
import { actionTitle, applyLabel, canApply, conflictTexts, dialogStep, effectTexts, nativeClose, openDialog, previewItems, type DialogAction, type DialogEvent, type DialogState, type Send } from './integration-dialog.ts';

/** The previewed writes; a refusal is a result. Connect never asks for the tee; the tee has its own previews. */
export interface WriteApi {
  connectPreview(profileId: string, retention: boolean): Promise<ConnectReply>;
  connectApply(previewId: string): Promise<ConnectReply>;
  removalPreview(profileId: string | null): Promise<RemovalReply>;
  removalApply(previewId: string): Promise<RemovalReply>;
  cleanupPreview(profileId: string): Promise<CleanupReply>;
  cleanupApply(previewId: string): Promise<CleanupReply>;
  /** XAIBO-PROD-581: the separate tee's previews (unit 6a); applied by connectApply / removalApply. */
  teePreview(profileId: string): Promise<ConnectReply>;
  teeRemovalPreview(profileId: string): Promise<RemovalReply>;
}
function request(api: WriteApi, a: DialogAction, send: Send): Promise<ConnectReply | RemovalReply | CleanupReply> {
  if (a.kind === 'tee') return send.kind === 'apply' ? (a.enabled ? api.connectApply(send.previewId) : api.removalApply(send.previewId)) : a.enabled ? api.teePreview(a.profileId) : api.teeRemovalPreview(a.profileId);
  if (send.kind === 'apply') return a.kind === 'connect' ? api.connectApply(send.previewId) : a.kind === 'cleanup' ? api.cleanupApply(send.previewId) : api.removalApply(send.previewId);
  return a.kind === 'connect' ? api.connectPreview(a.profileId, send.retention) : a.kind === 'cleanup' ? api.cleanupPreview(a.profileId) : api.removalPreview(a.kind === 'uninstall' ? null : a.profileId);
}
/** focus: where focus goes now (heading after a success, the trigger otherwise, null for a late outcome); sent: an apply was
 *  sent, so evidence may have changed. */
export type Done = { note: string | null; focus: 'heading' | 'trigger' | null; sent: boolean };
const SIGN = { add: '+', remove: '−', note: ' ' } as const, SAID = { add: 'Added: ', remove: 'Removed: ', note: '' } as const;

export function IntegrationDiffDialog({ open, detail, api, lastKnown, onDone }: {
  open: { action: DialogAction; n: number } | null; detail: IntegrationDetail; api: WriteApi; lastKnown: string | null; onDone: (d: Done) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [s, setS] = useState<DialogState | null>(null);
  const sRef = useRef<DialogState | null>(null); // null: closed (so a native close event after our own close is ignored)
  const sent = useRef(false), last = useRef(0); // last: the highest seq sent by any open (code review H1)
  const close = (focus: 'heading' | 'trigger', note: string | null) => {
    sRef.current = null;
    setS(null);
    dialog.current?.close();
    onDone({ note, focus, sent: sent.current });
  };
  const step = (e: DialogEvent) => {
    const cur = sRef.current;
    if (!cur) return;
    const r = dialogStep(cur, e);
    if (r.s === cur) return;
    sRef.current = r.s;
    if (r.send) go(r.s.action, r.send);
    setS(r.s);
    if (r.s.phase === 'success') close('heading', r.s.text);
  };
  const go = (a: DialogAction, send: Send) => {
    if (send.kind === 'apply') sent.current = true;
    last.current = Math.max(last.current, send.seq);
    request(api, a, send).then((reply) => step({ type: 'reply', seq: send.seq, reply }), () => step({ type: 'lost', seq: send.seq }));
  };
  useEffect(() => {
    if (!open) return;
    const o = openDialog(open.action, last.current + 1);
    sRef.current = o.s;
    sent.current = false;
    setS(o.s);
    if (!dialog.current?.open) dialog.current?.showModal();
    go(o.s.action, o.send);
  }, [open?.n]);
  const reviewing = s?.phase === 'review' ? s.preview : null;
  useEffect(() => { // Apply goes off when the held preview expires
    if (!reviewing) return;
    const id = reviewing.previewId, t = setTimeout(() => step({ type: 'expired', previewId: id }), reviewing.ttlMs);
    return () => clearTimeout(t);
  }, [reviewing?.previewId]);
  useEffect(() => { // code review M2: the service is gone, so a pending request never answers: lost (applying: Outcome unavailable)
    const cur = sRef.current;
    if (lastKnown !== null && cur) step({ type: 'lost', seq: cur.seq });
  }, [lastKnown]);
  const closed = () => { // the native close event (queued: a stale one after a quick reopen is ignored)
    const what = nativeClose(sRef.current, dialog.current?.open === true);
    if (what === 'ignore') return;
    if (what === 'reopen') { dialog.current?.showModal(); return; } // applying blocks dismissal
    sRef.current = null;
    setS(null);
    onDone({ note: null, focus: 'trigger', sent: sent.current });
  };

  const pending = s !== null && (s.phase === 'loading' || s.phase === 'review' || s.phase === 'recalculating' || s.phase === 'applying');
  const items = s ? previewItems(s, detail) : [], conflicts = s ? conflictTexts(s, detail) : [], effects = s && s.preview ? effectTexts(s) : [];
  const choices = items.filter((i) => i.check !== null), applying = s?.phase === 'applying';
  const scope = !s ? '' : s.action.kind === 'uninstall' ? 'All profiles: every Xaibo integration below is removed.'
    : `Profile: ${detail.row.profileLabel === null ? 'No profile' : visible(detail.row.profileLabel)}. Nothing is written until you apply.`;
  return (
    <dialog ref={dialog} className="x-dialog x-diff-dialog" aria-labelledby="diff-title" aria-describedby="diff-scope"
      onCancel={(e) => { e.preventDefault(); if (sRef.current && sRef.current.phase !== 'applying') close('trigger', null); }} onClose={closed}>
      {s ? (
        <>
          <h2 id="diff-title">{actionTitle(s.action, visible(detail.row.name))}</h2>
          <p id="diff-scope">{scope}</p>
          {choices.length ? (
            <fieldset className="x-radios">
              <legend>Changes</legend>
              {choices.map((i) => (
                <label key={i.id} className="x-radio">
                  <input type="checkbox" checked={i.check !== 'off'} disabled={i.check === 'required'} aria-disabled={s.phase !== 'review' || undefined} onChange={(e) => step({ type: 'retention', on: e.target.checked })} />
                  {visible(i.title)}
                </label>
              ))}
            </fieldset>
          ) : null}
          {items.length ? (
            <div className="x-diff" role="region" aria-label="Changes to apply" tabIndex={0}>
              {items.map((i) => (
                <section key={i.id}>
                  <h3>{visible(i.title)}</h3>
                  {i.lines.length ? <ul>{i.lines.map((l, k) => <li key={k} className={`x-diff-${l.kind}`}><span aria-hidden="true">{SIGN[l.kind]} </span><span className="x-sr-only">{SAID[l.kind]}</span>{visible(l.text)}</li>)}</ul> : null}
                </section>
              ))}
            </div>
          ) : null}
          {conflicts.length ? <><h3>Conflicts</h3><ul className="x-integration-list">{conflicts.map((c, k) => <li key={k}>{visible(c)}</li>)}</ul></> : null}
          {effects.length ? <><h3>What happens</h3><ul className="x-integration-list">{effects.map((f, k) => <li key={k}>{visible(f)}</li>)}</ul></> : null}
          <p aria-live="polite">{s.text}</p>
          <div className="x-dialog-actions">{/* Close replaces the pressed buttons after a failure, so it takes focus */}
            {pending ? <>
              <button type="button" className="x-btn x-btn-secondary" autoFocus aria-disabled={applying || undefined} onClick={() => { if (!applying) close('trigger', null); }}>Cancel</button>
              <button type="button" className={`x-btn ${s.action.kind === 'connect' || s.action.kind === 'cleanup' || (s.action.kind === 'tee' && s.action.enabled) ? 'x-btn-primary' : 'x-btn-danger'}`} aria-disabled={!canApply(s) || undefined} aria-busy={applying || undefined}
                onClick={() => step({ type: 'apply' })}>{applyLabel(s.action)}</button>
            </> : <button type="button" className="x-btn x-btn-secondary" autoFocus onClick={() => close('trigger', null)}>Close</button>}
          </div>
        </>
      ) : null}
    </dialog>
  );
}
