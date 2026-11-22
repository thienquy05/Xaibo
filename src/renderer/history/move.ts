// XAIBO-PROD-535 (P5-T18 part 3b-6; design §5.4 Move to project/folder, §5.1 dialog transactions; look D-P5-09): the
// Move dialog's logic. The draft starts at the session's current project and folder; a new project or folder is named
// in the dialog and created first (the service reuses an existing name); then one move op. Only Xaibo's overlay
// changes, never cwd or native files. Every outcome is said in words; a lost reply is unavailable, never success.
import { NAME_MAX, type HistoryRow, type Named, type OVERLAY_ERRORS, type OverlayOp, type OverlayResult } from '../../shared/ipc.ts';

/** A select's value: an existing id, none, or a new one named in the dialog. */
export type Target = number | 'none' | 'new';
export interface MoveDraft { project: Target; projectName: string; folder: Target; folderName: string }
export type MoveResult = 'moved' | (typeof OVERLAY_ERRORS)[number] | 'unavailable';
export type MovePhase = 'applying' | MoveResult | null;

export const draftOf = (r: HistoryRow): MoveDraft => ({ project: r.project?.id ?? 'none', projectName: '', folder: r.folder?.id ?? 'none', folderName: '' });
/** Folders belong to one project: another project starts without one. */
export const pickProject = (d: MoveDraft, project: Target): MoveDraft => (project === d.project ? d : { ...d, project, folder: 'none' });

function nameError(raw: string, what: string): string | null {
  const n = raw.trim();
  if (!n) return `Enter a ${what} name.`;
  return n.length > NAME_MAX ? `Use at most ${NAME_MAX} characters.` : null; // the service's cleanName rules the rest (invalid)
}
export function draftError(d: MoveDraft): { field: 'projectName' | 'folderName'; text: string } | null {
  const p = d.project === 'new' ? nameError(d.projectName, 'project') : null;
  if (p) return { field: 'projectName', text: p };
  const f = d.project !== 'none' && d.folder === 'new' ? nameError(d.folderName, 'folder') : null;
  return f ? { field: 'folderName', text: f } : null;
}

/** Creates what the draft names, then moves; the first failure ends it. Call only with draftError(d) === null. */
export async function runMove(d: MoveDraft, session: number, overlay: (op: OverlayOp) => Promise<OverlayResult>): Promise<MoveResult> {
  const create = async (op: OverlayOp): Promise<number | MoveResult> => {
    const r = await overlay(op).catch(() => null);
    if (!r) return 'unavailable';
    if (!r.ok) return r.error;
    return r.id ?? 'unavailable'; // a create without its id is no known result
  };
  let project: number | null = null;
  if (d.project === 'new') {
    const r = await create({ kind: 'newProject', name: d.projectName.trim() });
    if (typeof r !== 'number') return r;
    project = r;
  } else if (d.project !== 'none') project = d.project;
  let folder: number | null = null;
  if (project !== null && d.folder === 'new') {
    const r = await create({ kind: 'newFolder', project, name: d.folderName.trim() });
    if (typeof r !== 'number') return r;
    folder = r;
  } else if (project !== null && typeof d.folder === 'number') folder = d.folder;
  const r = await overlay({ kind: 'move', session, project, folder }).catch(() => null);
  return !r ? 'unavailable' : r.ok ? 'moved' : r.error;
}

export function moveText(p: MovePhase): string {
  switch (p) {
    case null: return '';
    case 'applying': return 'Applying changes…';
    case 'moved': return 'Moved. Only Xaibo\'s organization changed; the working folder and native files are untouched.';
    case 'invalid': return 'That name cannot be used. Nothing was moved.';
    case 'limit': return 'Too many projects or folders. Nothing was moved.';
    case 'not-found': return 'The session, project or folder is no longer available. Nothing was moved.';
    case 'read-only': return 'Xaibo is read-only. Nothing was moved.';
    case 'disk-full': return 'The disk is full. Nothing was moved.';
    case 'store': return 'The change could not be saved. Nothing was moved.';
    case 'unavailable': return 'The result is unavailable. Closing this dialog does not cancel the operation.';
  }
}

/** close: close the dialog; moved: place focus (§5.4); refresh: read the row again (review M3: also after a lost reply
 *  or not-found, as the plain row actions do); dialog: the phase an open dialog keeps showing with Close only; note: the
 *  text beside the trigger (the dialog is closed, or it moved). */
export function routeMove(r: MoveResult, dialogOpen: boolean): { close: boolean; moved: boolean; refresh: boolean; dialog: MovePhase; note: string | null } {
  if (r === 'moved') return { close: dialogOpen, moved: true, refresh: true, dialog: null, note: moveText(r) };
  const refresh = r === 'unavailable' || r === 'not-found';
  return dialogOpen ? { close: false, moved: false, refresh, dialog: r, note: null } : { close: false, moved: false, refresh, dialog: null, note: moveText(r) };
}

/** Where focus goes once a move result's row was read again (design §5.4): the moved record, the list heading (the
 *  record left this list: View moved session), or the trigger (the row could not be read). review L1 (re-review): only
 *  a result that closed its own dialog places focus, and only then may an emptied list hand focus to its heading. */
export function moveFocus(to: { close: boolean }, at: 'placed' | 'left' | 'failed'): { focus: 'record' | 'heading' | 'trigger' | null; fallback: boolean } {
  if (!to.close) return { focus: null, fallback: false };
  return { focus: at === 'placed' ? 'record' : at === 'left' ? 'heading' : 'trigger', fallback: true };
}

/** review M1: a dialog opened while a move runs says Applying only when that move is its own session's. */
export const openPhase = (inflight: number | null, id: number): MovePhase => (inflight === id ? 'applying' : null);

/** review M2: the folders of the chosen project only (none for a new project), with the session's current folder
 *  when the choice is its current project. */
export function folderChoices(d: MoveDraft, folders: { list: Named[]; project: number | null }, row: HistoryRow): Named[] {
  if (typeof d.project !== 'number' || folders.project !== d.project) return [];
  const cur = d.project === row.project?.id ? row.folder : null;
  return cur && !folders.list.some((f) => f.id === cur.id) ? [cur, ...folders.list] : folders.list;
}

/** Every page of an id-cursor list. ponytail: at most `max` pages (the service caps projects and folders at 1000 each,
 *  50 a page: 20 pages); a picker with search replaces whole-list loading if those caps grow. */
export async function allPages<T>(page: (cursor: number | null) => Promise<{ items: T[]; next: number | null }>, max = 20): Promise<T[]> {
  const out: T[] = [];
  let cursor: number | null = null;
  for (let i = 0; i < max; i++) {
    const p = await page(cursor);
    out.push(...p.items);
    if (p.next === null) break;
    cursor = p.next;
  }
  return out;
}
