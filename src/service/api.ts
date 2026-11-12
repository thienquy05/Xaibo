// Read-only session list API (P1-T12, S-29, FR-09): keyset pages over (last_activity DESC with unknown last, id),
// default 50 rows, hard cap 100; rows by session key for the coalesced deltas the service pushes after commits.
import type { DatabaseSync } from 'node:sqlite';
import { IPC_VERSION } from '../shared/ipc.ts';
import type { Cursor, Page, PortMessage, PortRequest, SessionRow } from '../shared/ipc.ts';
import type { SessionKind } from './catalog/validate.ts';
import { sessionKind } from './resume.ts';
import { displayName, modelLabel, type ModelEntry } from './usage/models.ts';

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;
/** Display strings (cwd, entrypoint, title) are cut to this many UTF-16 units plus "…" before IPC, far below the
 *  64 KiB per-string limit the renderer validates, so one long transcript value cannot void a page. The store keeps
 *  the original. */
export const DISPLAY_MAX = 4096;

export interface SessionKey { agent: string; profileId: string; nativeSessionId: string }

const ROW = `SELECT s.id, s.agent, s.entrypoint, s.originator, s.current_model, s.current_effort, s.cwd, s.title, s.last_activity, s.drift, s.quarantined_count,
  EXISTS (SELECT 1 FROM source_files f WHERE f.session_id = s.id AND f.status = 'compressed_not_imported') AS compressed
  FROM sessions s`;
// SQLite sorts NULL lowest, so DESC puts unknown activity last; the WHERE clauses continue exactly that order.
const ORDER = 'ORDER BY s.last_activity DESC, s.id LIMIT ?';

interface Raw { id: number; agent: string; entrypoint: string | null; originator: string | null; current_model: string | null; current_effort: string | null; cwd: string | null; title: string | null; last_activity: number | null; drift: number; quarantined_count: number; compressed: number }
const display = (s: string | null): string | null => {
  if (s === null || s.length <= DISPLAY_MAX) return s;
  const c = s.charCodeAt(DISPLAY_MAX - 1);
  return `${s.slice(0, c >= 0xd800 && c < 0xdc00 ? DISPLAY_MAX - 1 : DISPLAY_MAX)}…`; // never ends inside a surrogate pair
};
// Origin badge and interactive flag come from the catalog kind (P2-T04); an unknown kind leaves both null. The model
// label is "<display name> · <effort>", the raw id when unlisted, "Model unavailable" without evidence (P2-T08).
const toRow = (kinds: SessionKind[], models: ModelEntry[]) => (r: Raw): SessionRow => {
  const k = sessionKind(kinds, r);
  return {
    id: r.id, agent: r.agent, entrypoint: display(r.entrypoint), origin: k?.badge ?? null, interactive: k?.interactive ?? null,
    model: display(modelLabel(displayName(models, r.current_model), r.current_effort))!, cwd: display(r.cwd), title: display(r.title), lastActivity: r.last_activity,
    drift: r.drift === 1, compressed: r.compressed === 1, quarantined: r.quarantined_count,
  };
};

export function listSessions(db: DatabaseSync, cursor: Cursor | null, limit: number, kinds: SessionKind[] = [], models: ModelEntry[] = []): Page {
  const n = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : PAGE_DEFAULT, PAGE_MAX);
  let raw: Raw[];
  if (!cursor) raw = db.prepare(`${ROW} ${ORDER}`).all(n) as unknown as Raw[];
  else if (cursor.lastActivity === null) raw = db.prepare(`${ROW} WHERE s.last_activity IS NULL AND s.id > ? ${ORDER}`).all(cursor.id, n) as unknown as Raw[];
  else {
    raw = db.prepare(`${ROW} WHERE s.last_activity < ? OR s.last_activity IS NULL OR (s.last_activity = ? AND s.id > ?) ${ORDER}`)
      .all(cursor.lastActivity, cursor.lastActivity, cursor.id, n) as unknown as Raw[];
  }
  const rows = raw.map(toRow(kinds, models));
  const last = rows.at(-1);
  return { rows, next: rows.length === n && last ? { lastActivity: last.lastActivity, id: last.id } : null };
}

export function sessionsByKey(db: DatabaseSync, keys: SessionKey[], kinds: SessionKind[] = [], models: ModelEntry[] = []): SessionRow[] {
  const one = db.prepare(`${ROW} WHERE s.agent = ? AND s.profile_id = ? AND s.native_session_id = ?`);
  return keys.flatMap((k) => (one.all(k.agent, k.profileId, k.nativeSessionId) as unknown as Raw[]).map(toRow(kinds, models)));
}

/** The reply to a renderer request; a store that cannot answer (e.g. read-only without tables) gives an empty page. */
export function answer(db: DatabaseSync, req: PortRequest, kinds: SessionKind[] = [], models: ModelEntry[] = []): PortMessage & { type: 'page' } {
  let page: Page;
  try { page = listSessions(db, req.cursor, req.limit, kinds, models); } catch { page = { rows: [], next: null }; }
  return { v: IPC_VERSION, type: 'page', id: req.id, ...page };
}

/** Collects keys and flushes each distinct key once per window of `ms`. */
export function coalesce(flush: (keys: string[]) => void, ms: number, setTimer: (fn: () => void, ms: number) => unknown = setTimeout): (key: string) => void {
  let keys: Set<string> | undefined;
  return (key) => {
    if (keys) { keys.add(key); return; }
    keys = new Set([key]);
    setTimer(() => { const k = [...keys!]; keys = undefined; flush(k); }, ms);
  };
}
