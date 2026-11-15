// Read-only session list API (P1-T12, S-29, FR-09): keyset pages over (last_activity DESC with unknown last, id),
// default 50 rows, hard cap 100; rows by session key for the coalesced deltas the service pushes after commits.
import type { DatabaseSync } from 'node:sqlite';
import { IPC_VERSION } from '../shared/ipc.ts';
import type { CoverageCode, Credits, Cursor, HistoryCursor, LiveStatus, Page, PortMessage, PortRequest, SessionRow, TCursor, TranscriptItem, UsageRecord, UsageScope } from '../shared/ipc.ts';
import { MAX_ITEMS, MAX_RECORDS, MAX_SCOPES, PREVIEW_BYTES, SLICE_BYTES } from '../shared/ipc.ts';
import { classifyItem, utf8Slice, type StoredRecord } from './transcript.ts';
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

// XAIBO-PROD-410 (P4-T05b1; design §5.2, §6.3): one session's detail, transcript pages and text slices. The transcript
// is the session's own main transcript/rollout: current revision, not injected, no subagent records. Untrusted text
// goes out as plain strings, bounded by PREVIEW_BYTES / SLICE_BYTES.
export const TRANSCRIPT_MAX = MAX_ITEMS;
export const SCAN_MAX = 1000;
export const RAW_BUDGET = 32 * 1024 * 1024; // characters of stored record text read per transcript request
/** Rows the last transcript request loaded (tests check the budget bounds loading). */
export const transcriptStats = { rowsRead: 0 };
const VISIBLE = `e.session_id = ? AND e.source IN ('transcript', 'rollout') AND e.subagent_native_id IS NULL AND e.revision_status = 'current' AND e.injected = 0`;
const TR_COLS = 'e.id, e.kind, e.role, e.content, e.raw, e.source_seq AS seq, e.source_ts AS ts';
interface TrRow { id: number; kind: string; role: string | null; content: string | null; raw: string | null; seq: number; ts: number | null }
const stored = (agent: string, r: Pick<TrRow, 'kind' | 'role' | 'content' | 'raw'>): StoredRecord => ({ agent, kind: r.kind, role: r.role, injected: false, content: r.content, raw: r.raw });

export function answerSession(db: DatabaseSync, req: PortRequest & { type: 'session' }, kinds: SessionKind[] = [], models: ModelEntry[] = [], live?: LiveOf): PortMessage & { type: 'session' } {
  try {
    const r = db.prepare(`${ROW} WHERE s.id = ?`).get(req.session) as Raw | undefined;
    if (!r) return { v: IPC_VERSION, type: 'session', id: req.id, detail: null };
    const row = toRow(db, kinds, models, live)(r);
    const coverage: CoverageCode[] = [];
    if (row.compressed) coverage.push('compressed');
    if (row.quarantined > 0) coverage.push('quarantined');
    if (row.drift) coverage.push('drift');
    if (db.prepare(`SELECT 1 FROM source_files WHERE session_id = ? AND status = 'oversized' LIMIT 1`).get(r.id)) coverage.push('oversized');
    if (db.prepare('SELECT 1 FROM hook_gaps WHERE agent = ? AND native_session_id = ? LIMIT 1').get(r.agent, r.native_session_id)) coverage.push('hook-gap');
    return { v: IPC_VERSION, type: 'session', id: req.id, detail: { row, coverage } };
  } catch { return { v: IPC_VERSION, type: 'session', id: req.id, detail: null }; }
}

export function answerTranscript(db: DatabaseSync, req: PortRequest & { type: 'transcript' }): PortMessage & { type: 'transcript' } {
  const empty = (): PortMessage & { type: 'transcript' } => ({ v: IPC_VERSION, type: 'transcript', id: req.id, items: [], prev: null, next: null });
  try {
    const s = db.prepare('SELECT agent FROM sessions WHERE id = ?').get(req.session) as { agent: string } | undefined;
    if (!s) return empty();
    const n = Math.min(req.limit, TRANSCRIPT_MAX);
    const at = req.at;
    const forward = at === 'first' || (typeof at === 'object' && 'after' in at);
    const AFTER = '(e.source_seq > ? OR (e.source_seq = ? AND e.id > ?))', BEFORE = '(e.source_seq < ? OR (e.source_seq = ? AND e.id < ?))';
    const page = db.prepare(`SELECT ${TR_COLS} FROM events e WHERE ${VISIBLE} AND ${forward ? AFTER : BEFORE}
      ORDER BY e.source_seq ${forward ? 'ASC' : 'DESC'}, e.id ${forward ? 'ASC' : 'DESC'} LIMIT ?`);
    // Fill the page with n items, scanning past skipped bookkeeping records; the cursor is the last record consumed.
    // Review 1: each record is parsed once, only its preview/length is kept, and a page also ends once RAW_BUDGET
    // characters of stored record text were read. ponytail: at most SCAN_MAX records and RAW_BUDGET characters per
    // request; a longer run yields a short page with a cursor.
    let c: TCursor = at === 'first' ? { seq: Number.MIN_SAFE_INTEGER, id: 0 } : at === 'latest' ? { seq: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER }
      : 'after' in at ? at.after : at.before;
    type Kept = { id: number; seq: number; ts: number | null; item: Omit<TranscriptItem, 'event' | 'seq' | 'ts' | 'callId'> | null };
    const consumed: Kept[] = [];
    let found = 0, read = 0;
    const full = () => found === n || consumed.length >= SCAN_MAX || read >= RAW_BUDGET;
    transcriptStats.rowsRead = 0;
    while (!full()) {
      // Re-review: iterate lazily, so RAW_BUDGET bounds what is loaded, not only what is classified; break closes it.
      let rows = 0;
      for (const row of page.iterate(req.session, c.seq, c.seq, c.id, n) as Iterable<TrRow>) {
        rows++;
        transcriptStats.rowsRead++;
        read += (row.raw?.length ?? 0) + (row.content?.length ?? 0);
        const it = classifyItem(stored(s.agent, row));
        const message = it !== null && (it.kind === 'prompt' || it.kind === 'response');
        consumed.push({ id: row.id, seq: row.seq, ts: Number.isFinite(row.ts) ? row.ts : null, item: it && {
          kind: it.kind, preview: message && it.text !== null ? utf8Slice(it.text, 0, PREVIEW_BYTES)!.text : null,
          length: it.text?.length ?? 0, reasoning: it.reasoning !== null,
        } });
        if (it) found++;
        if (full()) break;
      }
      if (rows < n) break;
      const tail = consumed.at(-1)!;
      c = { seq: tail.seq, id: tail.id };
    }
    if (!forward) consumed.reverse();
    const first = consumed[0], last = consumed.at(-1);
    // Review 3: a cursor means a visible record remains, not that it is a conversation item; following it can return
    // an empty page whose own cursor is null, which ends paging (the renderer shows the end of the list).
    const exists = (cond: string, r: Kept) => db.prepare(`SELECT 1 FROM events e WHERE ${VISIBLE} AND ${cond} LIMIT 1`).get(req.session, r.seq, r.seq, r.id) !== undefined;
    const call = db.prepare('SELECT native_call_id AS id FROM tool_calls WHERE session_id = ? AND (args_event_id = ? OR result_event_id = ?) LIMIT 1');
    const items: TranscriptItem[] = [];
    for (const k of consumed) {
      if (!k.item) continue;
      const callId = k.item.kind === 'tool-call' || k.item.kind === 'tool-result' ? ((call.get(req.session, k.id, k.id) as { id: string | null } | undefined)?.id ?? null) : null;
      items.push({ event: k.id, seq: k.seq, ts: k.ts, ...k.item, callId: callId !== null && callId !== '' && callId.length <= 256 ? callId : null });
    }
    return {
      v: IPC_VERSION, type: 'transcript', id: req.id, items,
      prev: first && exists(BEFORE, first) ? { seq: first.seq, id: first.id } : null,
      next: last && exists(AFTER, last) ? { seq: last.seq, id: last.id } : null,
    };
  } catch { return empty(); }
}

// Review 1: the last classified text per store, so reading a long record in 16 KiB steps parses it once. Visibility is
// re-checked on every request; a cached entry is only text the same session and event already produced.
const sliceCache = new WeakMap<DatabaseSync, { key: string; text: string | null }>();
export function answerSlice(db: DatabaseSync, req: PortRequest & { type: 'slice' }): PortMessage & { type: 'slice' } {
  const empty = (): PortMessage & { type: 'slice' } => ({ v: IPC_VERSION, type: 'slice', id: req.id, text: '', next: null });
  try {
    if (!db.prepare(`SELECT 1 FROM events e WHERE e.id = ? AND ${VISIBLE}`).get(req.event, req.session)) return empty();
    const key = `${req.session}:${req.event}:${req.part}`;
    let hit = sliceCache.get(db);
    if (hit?.key !== key) {
      const r = db.prepare(`SELECT s.agent, e.kind, e.role, e.content, e.raw FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.id = ? AND ${VISIBLE}`)
        .get(req.event, req.session) as (Pick<TrRow, 'kind' | 'role' | 'content' | 'raw'> & { agent: string }) | undefined;
      const it = r ? classifyItem(stored(r.agent, r)) : null;
      hit = { key, text: (req.part === 'text' ? it?.text : it?.reasoning) ?? null };
      sliceCache.set(db, hit);
    }
    const full = hit.text;
    const cut = full ? utf8Slice(full, req.offset, SLICE_BYTES) : null;
    return cut ? { v: IPC_VERSION, type: 'slice', id: req.id, text: cut.text, next: cut.next } : empty();
  } catch { return empty(); }
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
