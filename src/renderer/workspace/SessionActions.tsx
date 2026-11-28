// XAIBO-PROD-627 (P7-T05, P7-T09; design §6.7, §6.8, FR-13, FR-22, EC-20; mock approved 2026-11-27): the open session's Resume,
// Fork and Open in VS Code. Main says what is available (an unavailable action stays visible with its adjacent reason). Resume of
// a session not proven idle opens the concurrency warning first: Cancel (initial focus), Open in VS Code, Fork instead, Resume
// anyway; Cancel or Escape returns to Resume; no "don't ask again". Proceeding confirms to main, which re-checks the target,
// asks for the launch grant natively and opens Terminal; the provisional Starting… row then opens like Launch. Fork writes a new
// session and needs no warning. Every outcome is said once in the polite line beside the actions.
import { useEffect, useRef, useState } from 'react';
import type { ResumeOptionsReply, SessionRow } from '../../shared/ipc.ts';
import { visible } from '../text.ts';
import { CANCELLED_TEXT, FAILED_TEXT, lastKnownLine, REFUSAL_TEXT, type LaunchApi } from './launch.ts';

export type Options = Extract<ResumeOptionsReply, { status: 'ok' }>;
/** The Details drawer's line: each action, available or why not; Transcript only when neither Resume nor Fork is offered (FR-13). */
export function resumeLine(o: Options): string {
  const say = (name: string, r: string | null) => `${name}: ${r ?? 'available'}`;
  return `${o.resume !== null && o.fork !== null ? 'Transcript only, not resumable. ' : ''}${[say('Resume', o.resume), say('Fork', o.fork), say('Open in VS Code', o.vscode)].join('; ')}`;
}
const SILENCE = 'Silence does not prove the session is safe to resume.';

export function SessionActions({ row, api, onStarted, onOptions }: { row: SessionRow; api: LaunchApi; onStarted: (key: string) => void;
  /** The options as main gave them (the Details drawer shows why an action is not offered). */
  onOptions?: (o: Options | null) => void }) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false), [warn, setWarn] = useState(false);
  const resumeBtn = useRef<HTMLButtonElement>(null), cancelBtn = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDialogElement>(null), live = useRef(true), vsBusy = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []); // mounted per session (OpenSession is keyed by it)
  useEffect(() => { // 627 review: read again when the session's liveness changes; a reply for an earlier read is dropped
    let current = true;
    // options main cannot give (service busy or the session gone) offer nothing and say nothing: no header row for a non-action
    void api.resumeOptions(row.id).then((r) => { if (current && live.current && r.status === 'ok') { setOpts(r); onOptions?.(r); } });
    return () => { current = false; };
  }, [row.id, row.live?.lifecycle, row.live?.health]);
  useEffect(() => { if (warn && !dialog.current?.open) { dialog.current?.showModal(); cancelBtn.current?.focus(); } }, [warn]); // Cancel first, explicitly

  const closeWarn = (focusResume: boolean) => { setWarn(false); setNote(''); dialog.current?.close(); if (focusResume) requestAnimationFrame(() => resumeBtn.current?.focus()); };
  const go = async (mode: 'resume' | 'fork', confirmed: boolean) => {
    if (busy) return;
    setBusy(true); setNote(mode === 'resume' ? 'Resuming… Xaibo is checking the agent and opening Terminal.' : 'Forking… Xaibo is checking the agent and opening Terminal.');
    const p = await api.resumePreview(row.id, mode, confirmed);
    const r = p.status === 'ok' ? await api.launch(p.previewId) : p;
    // 627 review: a started or failed launch reaches the Session area even when this header was left meanwhile
    if (r.status === 'started' || r.status === 'failed') onStarted(r.key);
    if (!live.current) return;
    setBusy(false);
    if (r.status === 'started') { setNote(''); return; }
    if (r.status === 'failed') { setNote(FAILED_TEXT[r.reason]); return; }
    if (r.status === 'refused' && mode === 'resume' && r.code === 'concurrent') { setNote(''); setWarn(true); return; }
    setNote(r.status === 'cancelled' ? CANCELLED_TEXT : REFUSAL_TEXT[r.code]);
  };
  const resume = () => { if (!opts || opts.resume !== null || busy) return; if (opts.liveness === 'not-live') void go('resume', false); else setWarn(true); };
  const vscode = async () => {
    if (!opts || opts.vscode !== null || vsBusy.current) return;
    vsBusy.current = true;
    const r = await api.vscode(row.id).finally(() => { vsBusy.current = false; });
    if (!live.current) return;
    if (r.status === 'opened') { setNote('Opened in VS Code.'); closeWarn(warn); return; }
    setNote(r.status === 'failed' ? 'VS Code did not open.' : REFUSAL_TEXT[r.code]); // an error stays inside the dialog when it is open
  };
  const action = (label: string, reason: string | null | undefined, id: string, onClick: () => void, ref?: React.Ref<HTMLButtonElement>, danger = false) => (
    <span className="x-act" key={id}>
      <button ref={ref} type="button" className={`x-btn ${danger ? 'x-btn-danger' : 'x-btn-secondary'}`} aria-disabled={reason !== null || busy || undefined}
        aria-describedby={reason ? id : undefined} onClick={() => { if (reason === null && !busy) onClick(); }}>{label}</button>
      {reason ? <span id={id} className="x-hint x-act-reason">{visible(reason)}</span> : null}
    </span>
  );
  // 627 (layout at 960 px, 200% text): only the available actions show in the header; the Details drawer says why the others are
  // not offered (beside the session's other surface limits). An unverified VS Code route is no escape hatch here (design §6.8).
  // nothing to offer (or not known yet): render nothing, so the header is exactly as before (layout at 960 px, 200% text)
  if (!opts ? !note : opts.resume !== null && opts.fork !== null && opts.vscode !== null && !note) return null;
  return (
    <span className="x-session-actions" aria-busy={opts === null || undefined}>
      {opts?.resume === null ? action('Resume', null, `resume-reason-${row.id}`, resume, resumeBtn) : null}
      {opts?.fork === null ? action('Fork', null, `fork-reason-${row.id}`, () => { void go('fork', false); }) : null}
      {opts?.vscode === null ? action('Open in VS Code', null, `vscode-reason-${row.id}`, () => { void vscode(); }) : null}
      {/* 627: the live region always exists (hidden); the visible note takes a row only when there is something to say */}
      <span className="x-sr-only" aria-live="polite">{warn ? '' : note}</span>
      {note && !warn ? <span className="x-hint x-act-note" aria-hidden="true">{note}</span> : null}
      <dialog ref={dialog} className="x-dialog x-warn-dialog" aria-labelledby={`warn-title-${row.id}`} aria-describedby={`warn-body-${row.id}`}
        onCancel={(e) => { e.preventDefault(); closeWarn(true); }} onClose={() => { if (dialog.current?.open) return; setWarn((w) => { if (w) requestAnimationFrame(() => resumeBtn.current?.focus()); return false; }); }}> {/* a queued close of an earlier open never closes a reopened warning */}
        {warn && opts ? <>
          <h2 id={`warn-title-${row.id}`}>Resume may create concurrent work</h2>
          <div id={`warn-body-${row.id}`}>
            <p>{visible(row.agent)} · {visible(row.cwd ?? 'Folder unknown')}</p>
            <p>{lastKnownLine(row.live, row.lastActivity === null ? null : Date.now() - row.lastActivity)}</p>
            <p><strong>{SILENCE}</strong> Xaibo cannot lock sessions started outside Xaibo.</p>
          </div>
          <p aria-live="polite">{note}</p>
          <div className="x-dialog-actions x-warn-actions">
            <button ref={cancelBtn} type="button" className="x-btn x-btn-secondary" onClick={() => closeWarn(true)}>Cancel</button>
            {action('Open in VS Code', opts.vscode, `warn-vscode-${row.id}`, () => { void vscode(); })}
            {action('Fork instead', opts.fork, `warn-fork-${row.id}`, () => { closeWarn(false); void go('fork', false); })}
            <button type="button" className="x-btn x-btn-danger" onClick={() => { closeWarn(false); void go('resume', true); }}>Resume anyway</button>
          </div>
        </> : null}
      </dialog>
    </span>
  );
}
