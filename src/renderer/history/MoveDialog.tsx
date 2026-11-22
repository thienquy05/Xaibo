// XAIBO-PROD-535 (P5-T18 part 3b-6; design §5.4 Move to project/folder, §5.1 Dialog and dialog transactions; look
// D-P5-09): a form dialog opened from a More actions menu. Initial focus on Project; the current project and folder are
// preselected; New project… / New folder… reveal a name field (errors after a Save attempt or leaving the field, with
// aria-invalid; a failed Save focuses the field). Applying blocks dismissal; a failure or unknown outcome stays with
// Close and no resubmission. Cancel and Close return focus to the exact trigger; the caller places focus after a move.
import { useEffect, useRef, useState } from 'react';
import type { HistoryRow, Named, OverlayOp, OverlayResult } from '../../shared/ipc.ts';
import { PAGE } from '../model.ts';
import { visible } from '../text.ts';
import { allPages, draftError, draftOf, folderChoices, moveText, openPhase, pickProject, routeMove, runMove, type MoveDraft, type MovePhase, type Target } from './move.ts';

export interface MoveApi {
  projects(cursor: number | null, limit: number): Promise<{ projects: Named[]; next: number | null }>;
  folders(project: number, cursor: number | null, limit: number): Promise<{ folders: Named[]; next: number | null }>;
  overlay(op: OverlayOp): Promise<OverlayResult>;
}
export type MoveTarget = { row: HistoryRow; trigger: HTMLElement | null } | null;
export type MoveOutcome = ReturnType<typeof routeMove>;
type Names = { list: Named[]; status: 'loading' | 'ready' | 'failed' };

const targetOf = (v: string): Target => (v === 'none' || v === 'new' ? v : Number(v));
/** The loaded names, with the session's current one even when its page did not load. */
const withCurrent = (list: Named[], cur: Named | null) => (cur && !list.some((n) => n.id === cur.id) ? [cur, ...list] : list);

export function MoveDialog({ target, api, onDone, onClosed }: {
  target: MoveTarget; api: MoveApi;
  onDone: (session: number, outcome: MoveOutcome) => void;
  /** The dialog closed (the caller clears `target`). */
  onClosed: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const shown = useRef<number | null>(null); // the session the open dialog asks about
  const inflight = useRef<number | null>(null); // one move at a time (Chromium can close a dialog on a second Escape)
  const [row, setRow] = useState<HistoryRow | null>(null);
  const [draft, setDraft] = useState<MoveDraft>({ project: 'none', projectName: '', folder: 'none', folderName: '' });
  const [phase, setPhase] = useState<MovePhase>(null);
  const [shownErrors, setShownErrors] = useState<{ projectName: boolean; folderName: boolean }>({ projectName: false, folderName: false });
  const [projects, setProjects] = useState<Names>({ list: [], status: 'loading' });
  const [folders, setFolders] = useState<Names & { project: number | null }>({ list: [], status: 'ready', project: null });
  const projectName = useRef<HTMLInputElement>(null);
  const folderName = useRef<HTMLInputElement>(null);

  const loadProjects = () => {
    setProjects({ list: [], status: 'loading' });
    allPages((c) => api.projects(c, PAGE).then((r) => ({ items: r.projects, next: r.next })))
      .then((list) => setProjects({ list, status: 'ready' }), () => setProjects({ list: [], status: 'failed' }));
  };
  const loadFolders = (project: number) => {
    setFolders({ list: [], status: 'loading', project });
    allPages((c) => api.folders(project, c, PAGE).then((r) => ({ items: r.folders, next: r.next })))
      .then((list) => setFolders((f) => (f.project === project ? { list, status: 'ready', project } : f)),
        () => setFolders((f) => (f.project === project ? { list: [], status: 'failed', project } : f)));
  };
  useEffect(() => {
    if (!target) return;
    trigger.current = target.trigger;
    shown.current = target.row.id;
    const d = draftOf(target.row);
    setRow(target.row);
    setDraft(d);
    setShownErrors({ projectName: false, folderName: false });
    setPhase(openPhase(inflight.current, target.row.id)); // review M1
    loadProjects();
    if (typeof d.project === 'number') loadFolders(d.project); else setFolders({ list: [], status: 'ready', project: null });
    if (!dialog.current?.open) dialog.current?.showModal();
  }, [target]);

  const close = (refocus: boolean) => {
    shown.current = null;
    setPhase(null);
    dialog.current?.close();
    if (refocus) trigger.current?.focus();
    onClosed();
  };
  const error = draftError(draft);
  const save = () => {
    if (!row || inflight.current !== null || phase !== null) return;
    if (error) { // design §6.7 field rules: the attempt shows the error and focuses the field
      setShownErrors((s) => ({ ...s, [error.field]: true }));
      (error.field === 'projectName' ? projectName : folderName).current?.focus();
      return;
    }
    const session = row.id;
    inflight.current = session;
    setPhase('applying');
    void runMove(draft, session, (op) => api.overlay(op)).then((r) => {
      inflight.current = null;
      const mine = shown.current === session;
      const out = routeMove(r, mine && dialog.current?.open === true);
      if (mine) setPhase(out.dialog);
      if (out.close) close(false); // the caller places focus (§5.4)
      onDone(session, out);
    });
  };
  // a close we did not ask for while applying (§5.1): the trigger takes focus and the outcome is announced beside it
  const closed = () => {
    if (shown.current === null) return; // our own close
    const running = inflight.current;
    shown.current = null;
    setPhase(null);
    trigger.current?.focus();
    if (running !== null) onDone(running, { close: false, moved: false, refresh: false, dialog: null, note: moveText('applying') });
    onClosed();
  };

  const applying = phase === 'applying';
  const ended = phase !== null && !applying; // a failure or unknown outcome: Close only
  const set = (patch: Partial<MoveDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const err = (f: 'projectName' | 'folderName') => (error?.field === f && shownErrors[f] ? error.text : null);
  const projectList = withCurrent(projects.list, row?.project ?? null);
  const folderList = row ? folderChoices(draft, folders, row) : []; // review M2
  return (
    <dialog ref={dialog} className="x-dialog x-move" aria-labelledby="move-title" aria-describedby="move-body"
      onCancel={(e) => { e.preventDefault(); if (!applying) close(true); }} onClose={closed}>
      <h2 id="move-title">Move to project or folder</h2>
      <p id="move-body">Only Xaibo's organization changes; the working folder and native files are untouched.</p>
      <form className="x-move-form" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label>Project
          <select autoFocus value={String(draft.project)} disabled={ended} aria-disabled={applying || undefined}
            onChange={(e) => {
              if (applying) return;
              const p = targetOf(e.target.value);
              setDraft((d) => pickProject(d, p));
              if (typeof p === 'number' && p !== draft.project) loadFolders(p);
            }}>
            <option value="none">No project</option>
            {projectList.map((p) => <option key={p.id} value={p.id}>{visible(p.name)}</option>)}
            <option value="new">New project…</option>
          </select>
        </label>
        {projects.status === 'loading' ? <p className="x-hint">Loading projects…</p> : projects.status === 'failed' ? (
          <p className="x-hint">Projects could not be loaded. <button type="button" className="x-btn x-btn-quiet" onClick={loadProjects}>Retry</button></p>
        ) : null}
        {draft.project === 'new' ? <>
          <label>Project name
            <input ref={projectName} className="x-input" value={draft.projectName} readOnly={applying || ended} aria-invalid={err('projectName') ? true : undefined}
              aria-describedby={err('projectName') ? 'move-project-error' : undefined} onChange={(e) => set({ projectName: e.target.value })}
              onBlur={() => setShownErrors((s) => ({ ...s, projectName: true }))} />
          </label>
          <p className="x-error" id={err('projectName') ? 'move-project-error' : undefined}>{err('projectName')}</p>
        </> : null}
        {draft.project !== 'none' ? <>
          <label>Folder
            <select value={String(draft.folder)} disabled={ended} aria-disabled={applying || undefined}
              onChange={(e) => { if (!applying) set({ folder: targetOf(e.target.value) }); }}>
              <option value="none">No folder</option>
              {folderList.map((f) => <option key={f.id} value={f.id}>{visible(f.name)}</option>)}
              <option value="new">New folder…</option>
            </select>
          </label>
          {folders.status === 'loading' ? <p className="x-hint">Loading folders…</p> : folders.status === 'failed' && typeof draft.project === 'number' ? (
            <p className="x-hint">Folders could not be loaded. <button type="button" className="x-btn x-btn-quiet" onClick={() => loadFolders(draft.project as number)}>Retry</button></p>
          ) : null}
          {draft.folder === 'new' ? <>
            <label>Folder name
              <input ref={folderName} className="x-input" value={draft.folderName} readOnly={applying || ended} aria-invalid={err('folderName') ? true : undefined}
                aria-describedby={err('folderName') ? 'move-folder-error' : undefined} onChange={(e) => set({ folderName: e.target.value })}
                onBlur={() => setShownErrors((s) => ({ ...s, folderName: true }))} />
            </label>
            <p className="x-error" id={err('folderName') ? 'move-folder-error' : undefined}>{err('folderName')}</p>
          </> : null}
        </> : null}
        <p aria-live="polite">{moveText(phase)}</p>
        <div className="x-dialog-actions">{/* Close replaces the pressed buttons after a failure, so it takes focus */}
          {!ended ? <>
            <button type="button" className="x-btn x-btn-secondary" aria-disabled={applying || undefined} onClick={() => { if (!applying) close(true); }}>Cancel</button>
            <button type="submit" className="x-btn x-btn-primary" aria-disabled={applying || undefined} aria-busy={applying || undefined}>Save</button>
          </> : <button type="button" className="x-btn x-btn-secondary" autoFocus onClick={() => close(true)}>Close</button>}
        </div>
      </form>
    </dialog>
  );
}
