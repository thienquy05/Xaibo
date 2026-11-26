// XAIBO-PROD-504 (P5-T01; FR-10, US-5): the history overlay. Projects, folders, pin and archive live only in Xaibo's DB,
// keyed by the session identity (agent, profile, native_session_id); native agent files are never touched. The renderer
// names a session by its row id only; these ops write projects, folders and overlays, nothing else. A read-only store
// refuses before any statement (design security review: every read-only reason, including a newer schema).
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { NAME_MAX, type HistoryFilter, type HistoryKey, type HistoryRow, type Named, type OverlayOp, type OverlayResult } from '../../shared/ipc.ts';
import { cut, hasTable, pageSize, ROW, toRow, type LiveOf, type Raw } from '../api.ts';
import type { SessionKind } from '../catalog/validate.ts';
import { isDiskFull } from '../store/db.ts';
import { groupWhere } from './map.ts';
import { trashPurgeAt } from './trash.ts';
import { retentionOf, sessionPurgeAt } from '../retention/policy.ts';
import type { ModelEntry } from '../usage/models.ts';
import { notPurging } from './suppression.ts';

// ponytail: fixed caps bound what a renderer can create; make them settings if an owner ever needs more.
export const PROJECTS_MAX = 1000, FOLDERS_MAX = 1000;
/** Notification label length (design review: a short plain-text label). */
export const LABEL_MAX = 40;
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u; // controls, format (bidi, zero-width), lone surrogates, separators

/** A project or folder name: NFC, trimmed, 1..NAME_MAX units, no control or format characters; else null. */
export function cleanName(s: string): string | null {
  const n = s.normalize('NFC').trim();
  return n.length >= 1 && n.length <= NAME_MAX && !UNSAFE.test(n) ? n : null;
}

const fail = (error: Extract<OverlayResult, { ok: false }>['error']): OverlayResult => ({ ok: false, error });
/** A filter only the overlay tables can answer (Archived, Trash, a project, folder or map group). */
export const needsOverlay = (f: HistoryFilter): boolean => f.mode !== 'all' || f.project !== null || f.folder !== null || !!f.group
  || f.state === 'pinned' || f.state === 'kept';
interface Key { agent: string; profile_id: string; native_session_id: string; cwd: string | null }

/** XAIBO-PROD-542 G5b2-4: a Trash or restore that succeeded changes what every window lists: they resync. */
export const resyncAfter = (op: OverlayOp, r: OverlayResult): boolean => r.ok && op.kind === 'trash';

export function applyOverlay(db: DatabaseSync, op: OverlayOp, o: { readOnly: boolean; now: number }): OverlayResult {
  if (o.readOnly) return fail('read-only');
  try { return run(db, op, o.now); } catch (e) { return fail(isDiskFull(e) ? 'disk-full' : 'store'); }
}

function run(db: DatabaseSync, op: OverlayOp, now: number): OverlayResult {
  if (op.kind === 'newProject') return project(db, op.name, now);
  if (op.kind === 'newFolder') return folder(db, op.project, op.name);
  // XAIBO-PROD-542 G5-N1: a session being purged is gone for every operation
  const k = db.prepare(`SELECT agent, profile_id, native_session_id, cwd FROM sessions s WHERE id = ? AND ${notPurging(db)}`).get(op.session) as Key | undefined;
  if (!k) return fail('not-found');
  const set = (assign: string, ...args: (number | null)[]) => {
    db.prepare('INSERT INTO overlays (agent, profile_id, native_session_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(k.agent, k.profile_id, k.native_session_id);
    db.prepare(`UPDATE overlays SET ${assign} WHERE agent = ? AND profile_id = ? AND native_session_id = ?`).run(...args, k.agent, k.profile_id, k.native_session_id);
    // P5-T03: a row back at every default is no overlay at all, so Undo/Restore leaves exactly what was there before
    db.prepare(`DELETE FROM overlays WHERE agent = ? AND profile_id = ? AND native_session_id = ? AND project_id IS NULL AND folder_id IS NULL
      AND pinned = 0 AND archived_at IS NULL AND trashed_at IS NULL AND keep = 0`).run(k.agent, k.profile_id, k.native_session_id);
  };
  switch (op.kind) {
    case 'pin': set('pinned = ?', op.on ? 1 : 0); return { ok: true };
    case 'archive': set(op.on ? 'archived_at = coalesce(archived_at, ?)' : 'archived_at = ?', op.on ? now : null); return { ok: true };
    // P5-T03 (FR-11): Delete moves to Trash (the 30-day timer starts at the first deletion); Undo and Restore clear it
    case 'trash': set(op.on ? 'trashed_at = coalesce(trashed_at, ?)' : 'trashed_at = ?', op.on ? now : null); return { ok: true };
    case 'keep': set('keep = ?', op.on ? 1 : 0); return { ok: true }; // XAIBO-PROD-527 (US-6): retention leaves it alone
    case 'move': {
      if (op.project === null) {
        if (op.folder !== null) return fail('invalid');
      } else {
        if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(op.project)) return fail('not-found');
        const f = op.folder === null ? null : db.prepare('SELECT project_id AS p FROM folders WHERE id = ?').get(op.folder) as { p: number } | undefined;
        if (f === undefined) return fail('not-found');
        if (f !== null && f.p !== op.project) return fail('invalid');
      }
      set('project_id = ?, folder_id = ?', op.project, op.folder);
      return { ok: true };
    }
    case 'confirmLabel': {
      // EC-66: the in-app default (cwd basename) reaches notifications only once confirmed as a project here.
      const name = k.cwd === null ? null : cleanName(path.basename(k.cwd));
      if (name === null) return fail('invalid');
      const r = project(db, name, now);
      if (!r.ok) return r;
      set('folder_id = CASE WHEN project_id = ? THEN folder_id END, project_id = ?', r.id!, r.id!);
      return r;
    }
  }
}

function project(db: DatabaseSync, raw: string, now: number): OverlayResult {
  const name = cleanName(raw);
  if (name === null) return fail('invalid');
  const found = db.prepare('SELECT id FROM projects WHERE name = ?').get(name) as { id: number } | undefined;
  if (found) return { ok: true, id: found.id };
  if ((db.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n >= PROJECTS_MAX) return fail('limit');
  return { ok: true, id: Number(db.prepare('INSERT INTO projects (name, created_at) VALUES (?, ?)').run(name, now).lastInsertRowid) };
}

function folder(db: DatabaseSync, projectId: number, raw: string): OverlayResult {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return fail('not-found');
  const name = cleanName(raw);
  if (name === null) return fail('invalid');
  const found = db.prepare('SELECT id FROM folders WHERE project_id = ? AND name = ?').get(projectId, name) as { id: number } | undefined;
  if (found) return { ok: true, id: found.id };
  if ((db.prepare('SELECT count(*) AS n FROM folders WHERE project_id = ?').get(projectId) as { n: number }).n >= FOLDERS_MAX) return fail('limit');
  return { ok: true, id: Number(db.prepare('INSERT INTO folders (project_id, name) VALUES (?, ?)').run(projectId, name).lastInsertRowid) };
}

/** The approved project label for notifications (FR-10, EC-59): the session's overlay project name, cut to LABEL_MAX;
 *  null when there is none or the store has no overlay tables (a read-only older or newer schema). */
export function approvedLabel(db: DatabaseSync, agent: string, profileId: string, nativeSessionId: string): string | null {
  try {
    const r = db.prepare('SELECT p.name FROM overlays o JOIN projects p ON p.id = o.project_id WHERE o.agent = ? AND o.profile_id = ? AND o.native_session_id = ?')
      .get(agent, profileId, nativeSessionId) as { name: string } | undefined;
    return r ? cut(r.name, LABEL_MAX) : null;
  } catch { return null; }
}

interface HistoryRaw extends Raw { pinned: number; archived_at: number | null; trashed_at: number | null; keep: number; started_at: number | null; p_id: number | null; p_name: string | null; f_id: number | null; f_name: string | null }
const named = (id: number | null, name: string | null): Named | null => (id === null || name === null ? null : { id, name });

/** The session list scope over `s` (sessions) and `o` (its overlay row): mode all leaves Trash out, archived and trash
 *  restrict; agent, project, folder, map group. Without overlay tables only the agent applies (callers refuse the rest).
 *  Shared by listHistory and search (P5-T14, Q-5.3). */
export function scopeWhere(f: HistoryFilter, overlay: boolean): { where: string[]; args: (string | number)[] } {
  const where: string[] = [], args: (string | number)[] = [];
  if (overlay) where.push(f.mode === 'trash' ? 'o.trashed_at IS NOT NULL' : f.mode === 'archived' ? 'o.archived_at IS NOT NULL AND o.trashed_at IS NULL' : 'o.trashed_at IS NULL');
  if (f.agent !== null) { where.push('s.agent = ?'); args.push(f.agent); }
  if (f.project !== null) { where.push('o.project_id = ?'); args.push(f.project); }
  if (f.folder !== null) { where.push('o.folder_id = ?'); args.push(f.folder); }
  if (f.group) { const g = groupWhere(f.group); where.push(...g.where); args.push(...g.args); } // P5-T01c: one map group's scope
  // XAIBO-PROD-554 (design §6.4, D-P6-05): the folder and below on a path boundary (substr, so no LIKE wildcard applies)
  if (f.cwd !== undefined) { const c = f.cwd.replace(/\/+$/, ''); where.push('(s.cwd = ? OR substr(s.cwd, 1, ?) = ?)'); args.push(c, [...c].length + 1, `${c}/`); } // Gate 6 G6E-2: characters, as substr counts
  // activity overlapping [from, to): a start-only or activity-only session counts at the time it has
  if (f.from !== undefined && f.to !== undefined) { where.push('coalesce(s.started_at, s.last_activity) < ? AND coalesce(s.last_activity, s.started_at) >= ?'); args.push(f.to, f.from); }
  if (f.state !== undefined) {
    where.push({ pinned: 'coalesce(o.pinned, 0) = 1', kept: 'coalesce(o.keep, 0) = 1', 'native-deleted': 's.native_available = 0', 'native-archived': 's.native_archived = 1' }[f.state]);
  }
  if (f.model !== undefined) {
    where.push('(EXISTS (SELECT 1 FROM usage u WHERE u.session_id = s.id AND u.model_id = ?) OR EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id AND t.model_id = ?))');
    args.push(f.model, f.model);
  }
  return { where, args };
}

/** Pinned first, then last activity descending (unknown last), then id; mode all leaves Trash out. Without overlay tables
 *  (a read-only older schema) the list degrades to sessions with no overlay data. */
export function listHistory(db: DatabaseSync, f: HistoryFilter, cursor: HistoryKey | null, limit: number,
  kinds: SessionKind[] = [], models: ModelEntry[] = [], live?: LiveOf): { rows: HistoryRow[]; next: HistoryKey | null } {
  const overlay = hasTable(db, 'overlays');
  if (!overlay && needsOverlay(f)) return { rows: [], next: null };
  const n = pageSize(limit);
  const P = overlay ? 'coalesce(o.pinned, 0)' : '0';
  const { cols, joins } = historySql(overlay, P);
  const s = scopeWhere(f, overlay);
  const where = [...s.where, notPurging(db)], args: (string | number | null)[] = s.args; // XAIBO-PROD-542 G5-N1
  if (cursor) {
    const p = cursor.pinned ? 1 : 0;
    const after = cursor.lastActivity === null ? '(s.last_activity IS NULL AND s.id > ?)' : '(s.last_activity < ? OR s.last_activity IS NULL OR (s.last_activity = ? AND s.id > ?))';
    where.push(`(${P} < ? OR (${P} = ? AND ${after}))`);
    args.push(p, p, ...(cursor.lastActivity === null ? [cursor.id] : [cursor.lastActivity, cursor.lastActivity, cursor.id]));
  }
  const sql = `${ROW(db).replace(/^SELECT /, `SELECT ${cols}`)}${joins}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${P} DESC, s.last_activity DESC, s.id LIMIT ?`;
  const rows = historyOf(db, kinds, models, live)(db.prepare(sql).all(...args, n) as unknown as HistoryRaw[]);
  const last = rows.at(-1);
  return { rows, next: rows.length === n && last ? { pinned: last.pinned, lastActivity: last.lastActivity, id: last.id } : null };
}

function historySql(overlay: boolean, P = overlay ? 'coalesce(o.pinned, 0)' : '0') {
  const cols = overlay ? `${P} AS pinned, o.archived_at, o.trashed_at, coalesce(o.keep, 0) AS keep, s.started_at, p.id AS p_id, p.name AS p_name, d.id AS f_id, d.name AS f_name, `
    : '0 AS pinned, NULL AS archived_at, NULL AS trashed_at, 0 AS keep, s.started_at, NULL AS p_id, NULL AS p_name, NULL AS f_id, NULL AS f_name, ';
  const joins = overlay ? ` LEFT JOIN overlays o ON o.agent = s.agent AND o.profile_id = s.profile_id AND o.native_session_id = s.native_session_id
    LEFT JOIN projects p ON p.id = o.project_id LEFT JOIN folders d ON d.id = o.folder_id` : '';
  return { cols, joins };
}

/** Raw history rows to HistoryRow, with Keep and the retention purge date (XAIBO-PROD-527; the job's rule: sessionPurgeAt). */
function historyOf(db: DatabaseSync, kinds: SessionKind[], models: ModelEntry[], live?: LiveOf) {
  const base = toRow(db, kinds, models, live);
  const policy = retentionOf(db);
  return (raw: HistoryRaw[]) => raw.map((r): HistoryRow => ({ ...base(r), project: named(r.p_id, r.p_name), folder: named(r.f_id, r.f_name), pinned: r.pinned === 1,
    archivedAt: r.archived_at, trashedAt: r.trashed_at, trashPurgeAt: r.trashed_at === null ? null : trashPurgeAt(r.trashed_at), keep: r.keep === 1,
    purgeAt: sessionPurgeAt({ lastActivity: r.last_activity, startedAt: r.started_at, keep: r.keep === 1, trashed: r.trashed_at !== null }, policy) }));
}

/** XAIBO-PROD-527: the history rows of `ids` (search hits), in no particular order; ids no longer present are absent. */
export function historyRows(db: DatabaseSync, ids: number[], kinds: SessionKind[] = [], models: ModelEntry[] = [], live?: LiveOf): Map<number, HistoryRow> {
  if (!ids.length) return new Map();
  const overlay = hasTable(db, 'overlays');
  const { cols, joins } = historySql(overlay);
  const sql = `${ROW(db).replace(/^SELECT /, `SELECT ${cols}`)}${joins} WHERE s.id IN (${ids.map(() => '?').join(', ')}) AND ${notPurging(db)}`;
  return new Map(historyOf(db, kinds, models, live)(db.prepare(sql).all(...ids) as unknown as HistoryRaw[]).map((r) => [r.id, r]));
}

function idPage(db: DatabaseSync, sql: string, args: number[], cursor: number | null, limit: number): { list: Named[]; next: number | null } {
  const n = pageSize(limit);
  const list = db.prepare(sql).all(...args, cursor ?? 0, n) as unknown as Named[];
  return { list: list.map((x) => ({ id: x.id, name: x.name })), next: list.length === n ? list.at(-1)!.id : null };
}
export function listProjects(db: DatabaseSync, cursor: number | null, limit: number): { projects: Named[]; next: number | null } {
  const p = idPage(db, 'SELECT id, name FROM projects WHERE id > ? ORDER BY id LIMIT ?', [], cursor, limit);
  return { projects: p.list, next: p.next };
}
export function listFolders(db: DatabaseSync, project: number, cursor: number | null, limit: number): { folders: Named[]; next: number | null } {
  const p = idPage(db, 'SELECT id, name FROM folders WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?', [project], cursor, limit);
  return { folders: p.list, next: p.next };
}
