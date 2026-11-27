// XAIBO-PROD-624 (P7-T04 slice E; design §6.7, §5.1; mock approved 2026-11-27): the launch dialog. Native showModal, named by
// its heading, initial focus Agent. Order: Agent → Profile → Project → Working directory → capability → Command preview →
// Cancel / Launch in terminal. Disabled agents and profiles stay listed with their reasons. The cwd defaults only from the chosen
// project's evidenced folder and is editable (an edited folder is never replaced). The preview is main's exact command
// (read-only, wrapped, a named region; the working directory and the environment names beside it); Launch acts only on a held
// preview of the current choices, and otherwise says why. Main asks for the launch grant natively; a cancelled grant keeps this
// dialog open with its reason. Escape or Cancel closes it before submission; while a launch runs it stays open.
// Reviews (624): every reopen starts from nothing (layout effect, before paint); a reply for earlier choices is dropped (the
// sequence moves on every change); state changes are announced once through the dialog's polite status line.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LaunchOption, LaunchPreviewReply, SessionRow } from '../../shared/ipc.ts';
import { visible } from '../text.ts';
import { CANCELLED_TEXT, cwdChoices, envHint, FAILED_TEXT, REFUSAL_TEXT, type LaunchApi } from './launch.ts';

export interface Prefill { agent: string; profileId: string; cwd: string }
/** key: the provisional row of an accepted launch; null when closed without one. */
export type LaunchDone = { key: string; note: string | null } | null;
const LAUNCHING = 'Launching… Xaibo is checking the agent and opening Terminal.';

export function LaunchDialog({ open, api, rows, refresh, onDone }: {
  open: { n: number; prefill: Prefill | null } | null; api: LaunchApi; rows: readonly SessionRow[];
  /** Changes when detection changes (agent states): the options are read again while the dialog is open. */
  refresh: string; onDone: (d: LaunchDone) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), agentRef = useRef<HTMLSelectElement>(null);
  const [agents, setAgents] = useState<LaunchOption[] | null>(null);
  const [agent, setAgent] = useState(''), [profile, setProfile] = useState(''), [project, setProject] = useState(''), [cwd, setCwd] = useState('');
  const [preview, setPreview] = useState<LaunchPreviewReply | null>(null);
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false), [touched, setTouched] = useState(false), [again, setAgain] = useState(0);
  const seq = useRef(0), live = useRef(false), edited = useRef(false), busyRef = useRef(false);
  const optSeq = useRef(0), sel = useRef({ agent: '', profile: '' }); // Gate 7 (c3): only the latest options reply; reconcile the current choice
  const choices = useMemo(() => (open ? cwdChoices(rows, agent || null) : []), [open, rows, agent]);
  const opt = agents?.find((a) => a.agent === agent && a.disabled === null) ?? null;
  sel.current = { agent, profile };

  const pick = (a: LaunchOption | undefined, pre: Prefill | null) => {
    setAgent(a?.agent ?? '');
    const p = a?.profiles.find((x) => x.id === pre?.profileId && x.disabled === null) ?? a?.profiles.find((x) => x.disabled === null);
    setProfile(p?.id ?? '');
    if (edited.current) return;
    const own = cwdChoices(rows, a?.agent ?? null), c = pre?.cwd ?? own[0]?.cwd ?? '';
    setProject(own.some((x) => x.cwd === c) ? c : '');
    setCwd(c);
  };
  useLayoutEffect(() => { // before paint: a reopened dialog never shows (or takes edits on) the previous open's state
    if (!open) return;
    live.current = true; edited.current = false; busyRef.current = false; seq.current++;
    setAgents(null); setAgent(''); setProfile(''); setProject(''); setCwd(''); setPreview(null); setNote(''); setBusy(false); setTouched(false);
    if (!dialog.current?.open) dialog.current?.showModal();
    agentRef.current?.focus();
    const n = ++optSeq.current;
    void api.options().then((r) => {
      if (!live.current || n !== optSeq.current) return;
      if (r.status !== 'ok') { setAgents([]); setNote(REFUSAL_TEXT[r.code]); return; }
      setAgents(r.agents);
      const pre = open.prefill;
      pick(r.agents.find((a) => a.agent === pre?.agent && a.disabled === null) ?? r.agents.find((a) => a.disabled === null), pre);
    });
  }, [open?.n]);
  useEffect(() => { // detection finished or changed while open: read the options again, keeping a still-enabled choice
    if (!open || agents === null) return;
    const n = ++optSeq.current;
    void api.options().then((r) => {
      if (!live.current || n !== optSeq.current || r.status !== 'ok') return;
      setAgents(r.agents);
      const { agent, profile } = sel.current;
      const cur = r.agents.find((a) => a.agent === agent && a.disabled === null);
      if (!cur) pick(r.agents.find((a) => a.disabled === null), open.prefill);
      else if (!cur.profiles.some((p) => p.id === profile && p.disabled === null)) setProfile(cur.profiles.find((p) => p.disabled === null)?.id ?? '');
    });
  }, [refresh]);
  useEffect(() => { // a preview for every complete choice (main validates; the renderer never assembles a command)
    const n = ++seq.current; // a reply for any earlier choice is dropped, even when this one asks for nothing
    setPreview(null);
    if (!open || !opt || !profile || !cwd.startsWith('/')) return;
    const t = setTimeout(() => {
      void api.preview({ agent, profileId: profile, cwd }).then((r) => {
        if (n !== seq.current || !live.current) return;
        setPreview(r);
        if (r.status === 'refused' && r.code !== 'cwd') setNote(REFUSAL_TEXT[r.code]);
      });
    }, 150);
    return () => clearTimeout(t);
  }, [open?.n, opt, profile, cwd, again]);

  const close = (d: LaunchDone) => { live.current = false; seq.current++; dialog.current?.close(); onDone(d); };
  const notReady = () => (!opt ? 'Choose an agent that can be launched.' : !profile ? 'Choose a profile that can be launched.'
    : !cwd.startsWith('/') ? REFUSAL_TEXT.cwd : preview?.status === 'refused' ? REFUSAL_TEXT[preview.code] : 'Wait for the command preview.');
  const launch = async () => {
    if (busyRef.current) return;
    if (preview?.status !== 'ok') { setNote(notReady()); return; }
    busyRef.current = true; setBusy(true); setNote(LAUNCHING);
    const r = await api.launch(preview.previewId);
    busyRef.current = false;
    if (!live.current) return;
    setBusy(false);
    if (r.status === 'started') { close({ key: r.key, note: null }); return; }
    if (r.status === 'failed') { close({ key: r.key, note: FAILED_TEXT[r.reason] }); return; }
    setNote(r.status === 'cancelled' ? CANCELLED_TEXT : REFUSAL_TEXT[r.code]);
    setAgain((x) => x + 1); // a preview is used once: ask again for the current choices
  };
  const cwdBad = touched && (!cwd.startsWith('/') || (preview?.status === 'refused' && preview.code === 'cwd'));
  const refusal = preview?.status === 'refused' ? REFUSAL_TEXT[preview.code] : null;
  const capability = !opt ? 'Choose an agent.' : opt.preallocatedId
    ? 'Interactive session with a new session ID, so Xaibo can match it when it starts. Never headless.'
    : 'Interactive session. Xaibo matches it by its first start in this folder. Never headless.';
  const anyAgent = agents?.some((a) => a.disabled === null) ?? false;
  const anyProfile = agents?.find((a) => a.agent === agent)?.profiles.some((p) => p.disabled === null) ?? false;
  return (
    <dialog ref={dialog} className="x-dialog x-launch-dialog" aria-labelledby="launch-title" aria-describedby="launch-desc"
      onCancel={(e) => { e.preventDefault(); if (busyRef.current) setNote(LAUNCHING); else close(null); }}
      onClose={() => { if (!live.current) return; if (busyRef.current) { dialog.current?.showModal(); return; } live.current = false; onDone(null); }}>
      {open ? <>
        <h2 id="launch-title">Launch an agent</h2>
        <p id="launch-desc" className="x-hint">Starts the agent's own interactive CLI in Terminal. Xaibo observes it; Terminal keeps control.</p>
        <div className="x-form">
          <div className="x-field">
            <label htmlFor="launch-agent">Agent</label>
            <select ref={agentRef} id="launch-agent" className="x-input" value={agent} onChange={(e) => pick(agents?.find((x) => x.agent === e.target.value), null)}>
              {agents === null ? <option value="">Loading…</option> : !anyAgent ? <option value="">No agent available</option> : null}
              {(agents ?? []).map((a) => (
                <option key={a.agent} value={a.agent} disabled={a.disabled !== null}>
                  {visible(a.disabled === null ? `${a.name}${a.version ? ` · ${a.version}` : ''}` : `${a.name}: ${a.disabled}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="x-field">
            <label htmlFor="launch-profile">Profile</label>
            <select id="launch-profile" className="x-input" value={profile} onChange={(e) => setProfile(e.target.value)}>
              {!anyProfile ? <option value="">No profile available</option> : null}
              {(agents?.find((a) => a.agent === agent)?.profiles ?? []).map((p) => <option key={p.id} value={p.id} disabled={p.disabled !== null}>{visible(p.disabled === null ? p.label : `${p.label}: ${p.disabled}`)}</option>)}
            </select>
          </div>
          <div className="x-field">
            <label htmlFor="launch-project">Project</label>
            <select id="launch-project" className="x-input" value={project} onChange={(e) => { setProject(e.target.value); if (e.target.value) { edited.current = true; setCwd(e.target.value); } }}>
              {choices.map((c) => <option key={c.cwd} value={c.cwd}>{visible(c.label)}</option>)}
              <option value="">(none)</option>
            </select>
          </div>
          <div className="x-field">
            <label htmlFor="launch-cwd">Working directory</label>
            <input id="launch-cwd" className="x-input" value={cwd} spellCheck={false} autoComplete="off" aria-invalid={cwdBad || undefined}
              aria-describedby={cwdBad ? 'launch-cwd-hint launch-cwd-error' : 'launch-cwd-hint'}
              onChange={(e) => { edited.current = true; setCwd(e.target.value); setProject(choices.some((c) => c.cwd === e.target.value) ? e.target.value : ''); }}
              onBlur={() => { setTouched(true); if (!cwd.startsWith('/') || (preview?.status === 'refused' && preview.code === 'cwd')) setNote(REFUSAL_TEXT.cwd); }} />
            <span id="launch-cwd-hint" className="x-hint">{project ? 'From the chosen project. Edit it if you need another folder.' : 'Type the folder to start in, or choose a project.'}</span>
            {cwdBad ? <span id="launch-cwd-error" className="x-field-error">{REFUSAL_TEXT.cwd}</span> : null}
          </div>
          <div className="x-field">
            <span className="x-label" id="launch-capability-label">Capability</span>
            <span aria-labelledby="launch-capability-label" role="note">{capability}</span>
          </div>
          <div className="x-field">
            <span className="x-label" id="launch-preview-label">Command preview</span>
            <pre className="x-code x-code-region" role="region" aria-labelledby="launch-preview-label" tabIndex={0}>
              {preview?.status === 'ok' ? visible(preview.command) : refusal ?? 'No command yet.'}
            </pre>
            {preview?.status === 'ok' ? <span className="x-hint">In: {visible(preview.cwd)} · {envHint(preview.env)}</span> : null}
          </div>
        </div>
        <p id="launch-status" aria-live="polite">{note}</p>
        <div className="x-dialog-actions">
          <button type="button" className="x-btn x-btn-secondary" aria-disabled={busy || undefined} onClick={() => { if (busyRef.current) setNote(LAUNCHING); else close(null); }}>Cancel</button>
          <button type="button" className="x-btn x-btn-primary" aria-disabled={busy || preview?.status !== 'ok' || undefined} aria-describedby="launch-status" onClick={() => { void launch(); }}>Launch in terminal</button>
        </div>
      </> : null}
    </dialog>
  );
}
