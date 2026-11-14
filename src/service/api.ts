// Read-only session list API (P1-T12, S-29, FR-09): keyset pages over (last_activity DESC with unknown last, id),
// default 50 rows, hard cap 100; rows by session key for the coalesced deltas the service pushes after commits.
import type { DatabaseSync } from 'node:sqlite';
import { IPC_VERSION } from '../shared/ipc.ts';
import type { Credits, Cursor, HistoryCursor, LiveStatus, Page, PortMessage, PortRequest, SessionRow, UsageRecord, UsageScope } from '../shared/ipc.ts';
import { MAX_RECORDS, MAX_SCOPES } from '../shared/ipc.ts';
import type { SessionKind } from './catalog/validate.ts';
import { sessionKind } from './resume.ts';
import { LIVE_WINDOW_MS } from './status/feed.ts'; // D-P3-09 feed eligibility
import { sessionCost } from './usage/cost.ts';
import { displayName, modelLabel, type ModelEntry } from './usage/models.ts';

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;
/** Display strings (cwd, entrypoint, title) are cut to this many UTF-16 units plus "…" before IPC, far below the
 *  64 KiB per-string limit the renderer validates, so one long transcript value cannot void a page. The store keeps
 *  the original. */
export const DISPLAY_MAX = 4096;

export interface SessionKey { agent: string; profileId: string; nativeSessionId: string }

const ROW = `SELECT s.id, s.agent, s.profile_id, s.native_session_id, s.entrypoint, s.originator, s.current_model, s.current_effort, s.cwd, s.title, s.last_activity, s.drift, s.quarantined_count,
  EXISTS (SELECT 1 FROM source_files f WHERE f.session_id = s.id AND f.status = 'compressed_not_imported') AS compressed,
  (SELECT c.percentage FROM context_snapshots c WHERE c.session_id = s.id ORDER BY c.generation DESC, c.id DESC LIMIT 1) AS context_pct,
  (SELECT CASE WHEN COUNT(u.uncached_input) + COUNT(u.cache_read) + COUNT(u.cache_write) + COUNT(u.output) = 0 THEN NULL
    ELSE TOTAL(COALESCE(u.uncached_input, 0) + COALESCE(u.cache_read, 0) + COALESCE(u.cache_write, 0) + COALESCE(u.output, 0)) END
    FROM usage u WHERE u.session_id = s.id AND u.scope = 'message') AS tokens,
  EXISTS (SELECT 1 FROM usage u WHERE u.session_id = s.id AND u.scope = 'message' AND (u.uncached_input IS NULL OR u.cache_read IS NULL
    OR u.output IS NULL OR (u.cache_write IS NULL AND json_extract(u.completeness, '$.cacheWrite') = 'missing'))) AS tokens_gap
  FROM sessions s`;
// SQLite sorts NULL lowest, so DESC puts unknown activity last; the WHERE clauses continue exactly that order.
const ORDER = 'ORDER BY s.last_activity DESC, s.id LIMIT ?';

/** The status engine's view of a session by agent and native id (P3-T10); null when it has no evidence. */
export type LiveOf = (agent: string, nativeSessionId: string, profileId: string) => LiveStatus | null;
interface Raw { tokens: number | null; tokens_gap: number; id: number; agent: string; profile_id: string; native_session_id: string; context_pct: number | null; entrypoint: string | null; originator: string | null; current_model: string | null; current_effort: string | null; cwd: string | null; title: string | null; last_activity: number | null; drift: number; quarantined_count: number; compressed: number }
const display = (s: string | null): string | null => {
  if (s === null || s.length <= DISPLAY_MAX) return s;
  const c = s.charCodeAt(DISPLAY_MAX - 1);
  return `${s.slice(0, c >= 0xd800 && c < 0xdc00 ? DISPLAY_MAX - 1 : DISPLAY_MAX)}…`; // never ends inside a surrogate pair
};
// Origin badge and interactive flag come from the catalog kind (P2-T04); an unknown kind leaves both null. The model
// label is "<display name> · <effort>", the raw id when unlisted, "Model unavailable" without evidence (P2-T08).
// P3-T10: live status from the engine, the latest context percentage (clamped to the 0–100 the IPC accepts) and the
// session ~$ estimate (Phase 2 selection; an unreadable estimate is unavailable, never zero).
const toRow = (db: DatabaseSync, kinds: SessionKind[], models: ModelEntry[], live?: LiveOf) => (r: Raw): SessionRow => {
  const k = sessionKind(kinds, r);
  let cost: { amountUsd: number | null; coverage: SessionRow['costCoverage'] };
  try { cost = sessionCost(db, r.id); } catch { cost = { amountUsd: null, coverage: 'unavailable' }; }
  const pct = r.context_pct;
  const usable = cost.amountUsd !== null && Number.isFinite(cost.amountUsd) && cost.amountUsd >= 0;
  return {
    id: r.id, agent: r.agent, entrypoint: display(r.entrypoint), origin: k?.badge ?? null, interactive: k?.interactive ?? null,
    model: display(modelLabel(displayName(models, r.current_model), r.current_effort))!, cwd: display(r.cwd), title: display(r.title), lastActivity: r.last_activity,
    drift: r.drift === 1, compressed: r.compressed === 1, quarantined: r.quarantined_count,
    live: live?.(r.agent, r.native_session_id, r.profile_id) ?? null,
    contextPct: pct === null || !Number.isFinite(pct) ? null : Math.min(100, Math.max(0, pct)),
    costUsd: usable ? cost.amountUsd : null,
    costCoverage: usable ? cost.coverage : 'unavailable', // never "full" without an amount (review L6)
    // P4-T04a: TOTAL (a REAL, never an overflow error; security review HIGH) past 2^53 is unavailable via the safe-integer check.
    // Message-scope rows only (a session-scope cumulative reading is never added on top); Codex/agy cache write
    // has no separate count (relation-unverified/unavailable), so only Claude's reported-missing one is a gap.
    tokens: r.tokens !== null && Number.isSafeInteger(r.tokens) && r.tokens >= 0 ? r.tokens : null, tokensComplete: r.tokens_gap === 0,
  };
};

export function listSessions(db: DatabaseSync, cursor: Cursor | null, limit: number, kinds: SessionKind[] = [], models: ModelEntry[] = [], live?: LiveOf): Page {
  const n = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : PAGE_DEFAULT, PAGE_MAX);
  let raw: Raw[];
  if (!cursor) raw = db.prepare(`${ROW} ${ORDER}`).all(n) as unknown as Raw[];
  else if (cursor.lastActivity === null) raw = db.prepare(`${ROW} WHERE s.last_activity IS NULL AND s.id > ? ${ORDER}`).all(cursor.id, n) as unknown as Raw[];
  else {
    raw = db.prepare(`${ROW} WHERE s.last_activity < ? OR s.last_activity IS NULL OR (s.last_activity = ? AND s.id > ?) ${ORDER}`)
      .all(cursor.lastActivity, cursor.lastActivity, cursor.id, n) as unknown as Raw[];
  }
  const rows = raw.map(toRow(db, kinds, models, live));
  const last = rows.at(-1);
  return { rows, next: rows.length === n && last ? { lastActivity: last.lastActivity, id: last.id } : null };
}

export function sessionsByKey(db: DatabaseSync, keys: SessionKey[], kinds: SessionKind[] = [], models: ModelEntry[] = [], live?: LiveOf): SessionRow[] {
  const one = db.prepare(`${ROW} WHERE s.agent = ? AND s.profile_id = ? AND s.native_session_id = ?`);
  return keys.flatMap((k) => (one.all(k.agent, k.profileId, k.nativeSessionId) as unknown as Raw[]).map(toRow(db, kinds, models, live)));
}

/** The reply to a renderer request; a store that cannot answer (e.g. read-only without tables) gives an empty page. */
export function answer(db: DatabaseSync, req: PortRequest & { type: 'listSessions' }, kinds: SessionKind[] = [], models: ModelEntry[] = [], live?: LiveOf): PortMessage & { type: 'page' } {
  let page: Page;
  try { page = listSessions(db, req.cursor, req.limit, kinds, models, live); } catch { page = { rows: [], next: null }; }
  return { v: IPC_VERSION, type: 'page', id: req.id, ...page };
}

export const LIVE_SET_MAX = 100;
/** P4-T04a: the live-session set: sessions active within 24 h whose engine status exists and is not ended, in list
 *  order, at most LIVE_SET_MAX (`more` when capped). Rows are built only for members.
 *  ponytail: capped at 100 live sessions (EC-57 needs 50); page the set if more ever run at once. */
export function answerLiveSet(db: DatabaseSync, req: PortRequest & { type: 'liveSet' }, now: number, kinds: SessionKind[] = [], models: ModelEntry[] = [], live?: LiveOf): PortMessage & { type: 'liveSet' } {
  const rows: SessionRow[] = [];
  let more = false;
  try {
    const build = toRow(db, kinds, models, live);
    const one = db.prepare(`${ROW} WHERE s.id = ?`);
    // Review M1: membership from the bare key columns; the per-session subqueries run for members only.
    for (const k of db.prepare('SELECT s.id, s.agent, s.profile_id, s.native_session_id FROM sessions s WHERE s.last_activity >= ? ORDER BY s.last_activity DESC, s.id')
      .iterate(now - LIVE_WINDOW_MS) as Iterable<Pick<Raw, 'id' | 'agent' | 'profile_id' | 'native_session_id'>>) {
      const st = live?.(k.agent, k.native_session_id, k.profile_id);
      if (!st || st.lifecycle === 'ended') continue;
      if (rows.length === LIVE_SET_MAX) { more = true; break; }
      const r = one.get(k.id) as Raw | undefined;
      if (r) rows.push(build(r));
    }
  } catch { return { v: IPC_VERSION, type: 'liveSet', id: req.id, rows: [], more: false }; }
  return { v: IPC_VERSION, type: 'liveSet', id: req.id, rows, more };
}

/** P4-T04b1: a profile's label for the UI: "Default profile", else its root with the home directory as `~`. */
export function profileLabel(origin: string, root: string, home: string): string {
  if (origin === 'default') return 'Default profile';
  const h = home.replace(/\/+$/, ''); // review L: os.homedir() returns $HOME as set, trailing slash included; '/' becomes '' (no rewrite)
  const label = h && (root === h || root.startsWith(`${h}/`)) ? `~${root.slice(h.length)}` : root;
  return display(label)!;
}
function credits(raw: string | null): Credits | null {
  if (raw === null) return null;
  try {
    const c = JSON.parse(raw) as Record<string, unknown>;
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);
    const balance = typeof c.balance === 'string' || typeof c.balance === 'number' ? String(c.balance).slice(0, 32) : null;
    return { hasCredits: bool(c.has_credits), unlimited: bool(c.unlimited), balance };
  } catch { return null; }
}
const finiteOrNull = (v: number | null) => (v !== null && Number.isFinite(v) ? v : null);
type Latest = { scope: number; agent: string; verified: number; limit_id: string; used_percent: number | null; window_minutes: number | null; resets_at: number | null;
  plan: string | null; credits: string | null; as_of: number | null; first_observed_at: number; measured_at: number; profile_id: string };
/** P4-T04b1: per profile (agent, id order): agy -> one passive-unavailable row; others -> the newest measurement per
 *  scope and stream (raw: state is derived at render time against the local clock), else one no-observation row.
 *  ponytail: streams found by a scan of the history index, as usageStatusList; capped at MAX_SCOPES rows. */
export function usageScopes(db: DatabaseSync, home: string): UsageScope[] {
  const latest = db.prepare(`SELECT s.id AS scope, s.agent, s.verified, s.profile_id, h.limit_id, h.used_percent, h.window_minutes, h.resets_at, h.plan, h.credits,
      h.as_of, h.first_observed_at, h.measured_at
    FROM (SELECT DISTINCT usage_scope_id, limit_id FROM usage_history) k
    JOIN usage_history h ON h.id = (SELECT id FROM usage_history x WHERE x.usage_scope_id = k.usage_scope_id AND x.limit_id = k.limit_id
      ORDER BY x.measured_at DESC, x.id DESC LIMIT 1)
    JOIN usage_scopes s ON s.id = h.usage_scope_id
    ORDER BY s.id, h.limit_id`).all() as Latest[];
  const blank = { scope: null, verified: null, stream: null, windowMinutes: null, usedPercent: null, resetsAt: null, plan: null, credits: null, asOf: null, firstObservedAt: null, measuredAt: null };
  const out: UsageScope[] = [];
  for (const p of db.prepare('SELECT id, agent, root, origin FROM profiles ORDER BY agent, id').all() as { id: string; agent: string; root: string; origin: string }[]) {
    const profile = profileLabel(p.origin, p.root, home);
    if (p.agent === 'agy') { out.push({ ...blank, agent: p.agent, profile, unavailable: 'passive' }); continue; }
    const mine = latest.filter((r) => r.profile_id === p.id);
    // Review M: only agents with a passive usage source get a no-observation row (a custom registration agent has none).
    if (!mine.length) { if (p.agent === 'claude' || p.agent === 'codex') out.push({ ...blank, agent: p.agent, profile, unavailable: 'no-observation' }); continue; }
    for (const r of mine) {
      out.push({ scope: r.scope, agent: r.agent, profile, verified: r.verified === 1, stream: r.limit_id, windowMinutes: r.window_minutes,
        usedPercent: finiteOrNull(r.used_percent), resetsAt: r.resets_at, plan: r.plan, credits: credits(r.credits), asOf: r.as_of,
        firstObservedAt: r.first_observed_at, measuredAt: r.measured_at, unavailable: null });
    }
  }
  return out.slice(0, MAX_SCOPES);
}
export function answerUsage(db: DatabaseSync, req: PortRequest & { type: 'usage' }, home: string): PortMessage & { type: 'usage' } {
  let scopes: UsageScope[] = [];
  try { scopes = usageScopes(db, home); } catch { /* unreadable store: no scopes */ }
  return { v: IPC_VERSION, type: 'usage', id: req.id, scopes };
}

export const HISTORY_MAX = MAX_RECORDS;
/** P4-T04b1: one scope+stream's stored observations with measured time in [from, to), oldest first; keyset
 *  (measured_at, id) on the usage_history_stream index. Nothing interpolated: absent minutes are absent. */
export function answerUsageHistory(db: DatabaseSync, req: PortRequest & { type: 'usageHistory' }): PortMessage & { type: 'usageHistory' } {
  const n = Math.min(req.limit, HISTORY_MAX);
  const c = req.cursor;
  try {
    // Review L: the cursor is the index lower bound, so later pages seek instead of rescanning the window.
    const raw = db.prepare(`SELECT id, kind, measured_at, used_percent, window_minutes, resets_at, as_of FROM usage_history
      WHERE usage_scope_id = ? AND limit_id = ? AND measured_at >= ? AND measured_at < ? AND (? IS NULL OR measured_at > ? OR id > ?)
      ORDER BY measured_at, id LIMIT ?`).all(req.scope, req.stream, Math.max(req.from, c?.measuredAt ?? req.from), req.to, c?.measuredAt ?? null, c?.measuredAt ?? null, c?.id ?? null, n) as
      { id: number; kind: UsageRecord['kind']; measured_at: number; used_percent: number | null; window_minutes: number | null; resets_at: number | null; as_of: number | null }[];
    const records: UsageRecord[] = raw.map((r) => ({ id: r.id, kind: r.kind, measuredAt: r.measured_at, usedPercent: finiteOrNull(r.used_percent), windowMinutes: r.window_minutes,
      resetsAt: r.resets_at, sourceTimeKnown: r.as_of !== null }));
    const last = records.at(-1);
    const next: HistoryCursor | null = records.length === n && last ? { measuredAt: last.measuredAt, id: last.id } : null;
    return { v: IPC_VERSION, type: 'usageHistory', id: req.id, records, next };
  } catch { return { v: IPC_VERSION, type: 'usageHistory', id: req.id, records: [], next: null }; }
}

/** Renderer ports (P4-T02): session deltas go only to live (visible) ports; every other push goes to all ports. */
export function createHub<P extends { postMessage(m: PortMessage): void }>() {
  const ports = new Map<P, boolean>();
  return {
    add(p: P): void { ports.set(p, true); },
    remove(p: P): void { ports.delete(p); },
    setLive(p: P, on: boolean): void { if (ports.has(p)) ports.set(p, on); },
    anyLive(): boolean { return [...ports.values()].some(Boolean); },
    sessions(m: PortMessage & { type: 'sessions' }): void { for (const [p, live] of ports) if (live) p.postMessage(m); },
    broadcast(m: PortMessage): void { for (const p of ports.keys()) p.postMessage(m); },
  };
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
