// Read-only session list API (P1-T12, S-29, FR-09): keyset pages over (last_activity DESC with unknown last, id),
// default 50 rows, hard cap 100; rows by session key for the coalesced deltas the service pushes after commits.
import type { DatabaseSync } from 'node:sqlite';
import { IPC_VERSION } from '../shared/ipc.ts';
import type { ContextReading, CoverageCode, Credits, Cursor, HistoryCursor, LiveStatus, Page, PortMessage, PortRequest, SessionRow, TCursor, TranscriptItem, UsageRecord, UsageScope } from '../shared/ipc.ts';
import { MAX_ITEMS, MAX_RECORDS, MAX_SCOPES, parseContext, PREVIEW_BYTES, SLICE_BYTES } from '../shared/ipc.ts';
import type { FileItem, MCursor, ModelMarker, SubagentItem, ToolItem } from '../shared/ipc.ts';
import { classifyItem, utf8Slice, type StoredRecord } from './transcript.ts';
import { callApprovals, callDuration, claudeCallError, MAX_MODEL } from './session-detail.ts';
import { deriveFileTouches, FILE_TOOLS } from './filetouch.ts';
import type { Ev } from './status/engine.ts';
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
    // XAIBO-PROD-414: the newest generation's latest reading (same order as the writer's lastContext); a stored row
    // outside the port contract, or one node:sqlite cannot read (an INTEGER above 2^53 - 1 throws), degrades to null
    // rather than failing the whole detail.
    let context: ContextReading | null = null;
    try {
      const ctx = db.prepare(`SELECT generation, used_tokens AS used, window_tokens AS window, window_basis AS basis, source, as_of AS asOf,
        observed_at AS observedAt FROM context_snapshots WHERE session_id = ? ORDER BY generation DESC, id DESC LIMIT 1`).get(r.id);
      context = ctx ? parseContext({ ...ctx }) ?? null : null;
    } catch { context = null; }
    return { v: IPC_VERSION, type: 'session', id: req.id, detail: { row, coverage, context } };
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

// XAIBO-PROD-411 (P4-T05b2; design §6.3 Tools/Subagents/Files/Timeline): forward keyset pages by row id (markers by
// turn time). Tools and files hold the session's own main-thread calls (no subagent record, current revision); event ids
// are given only where answerSlice can serve their text. Unknown stays null.
export const EVIDENCE_MAX = 100_000;
const SAFE = 9007199254740991; // node:sqlite throws on integers past 2^53; such a stored time is unknown (review L7)
const safeTs = (col: string) => `CASE WHEN ${col} BETWEEN -${SAFE} AND ${SAFE} THEN ${col} END`; // re-review: abs() raises on -2^63
type Sess = { agent: string; profile_id: string; native_session_id: string; last_activity: number | null };
const sessionOf = (db: DatabaseSync, id: number) =>
  db.prepare(`SELECT agent, profile_id, native_session_id, ${safeTs('last_activity')} AS last_activity FROM sessions WHERE id = ?`).get(id) as Sess | undefined;
/** Review M4: a pending state (approval requested, subagent running) is current only while the session is live: tracked,
 *  not ended and active within the live window (as the live set). Otherwise its outcome is unknown. */
const isLive = (s: Sess, live: LiveOf | undefined, now: number) => {
  const st = live?.(s.agent, s.native_session_id, s.profile_id);
  return !!st && st.lifecycle !== 'ended' && s.last_activity !== null && s.last_activity >= now - LIVE_WINDOW_MS;
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const callIdOf = (id: string) => (id !== '' && id.length <= 256 ? id : null);
/** The session's status evidence in the engine's order, or null past EVIDENCE_MAX rows or RAW_BUDGET characters: a cut
 *  history could show a stale state (e.g. `requested` whose answer lies beyond the cut), so callers report unknown.
 *  Review M2: the size is checked before the sorted read, so an oversized history is never sorted.
 *  ponytail: re-read per page request; reuse the engine's in-memory entries if Tools paging over long sessions is slow. */
function sessionEvidence(db: DatabaseSync, s: Sess): Ev[] | null {
  const WHERE = 'agent = ? AND profile_id = ? AND native_session_id = ?';
  const size = db.prepare(`SELECT count(*) AS n, total(octet_length(ev)) AS bytes FROM (SELECT ev FROM status_evidence WHERE ${WHERE} LIMIT ${EVIDENCE_MAX + 1})`)
    .get(s.agent, s.profile_id, s.native_session_id) as { n: number; bytes: number };
  if (size.n > EVIDENCE_MAX || size.bytes > RAW_BUDGET) return null;
  const evs: Ev[] = [];
  let rows = 0, read = 0;
  for (const r of db.prepare(`SELECT ev FROM status_evidence WHERE ${WHERE} ORDER BY ts, rank, seq, coalesce(producer_seq, 0), id`)
    .iterate(s.agent, s.profile_id, s.native_session_id) as Iterable<{ ev: string }>) {
    if (++rows > EVIDENCE_MAX || (read += r.ev.length) > RAW_BUDGET) return null; // rows added since the size check
    try {
      const a: unknown = JSON.parse(r.ev);
      if (Array.isArray(a) && a.every((e) => isObj(e) && typeof e.k === 'string')) evs.push(...(a as Ev[])); // a malformed row is skipped, as the engine does
    } catch { /* corrupt row skipped */ }
  }
  return evs;
}

// Review H1: revision_status is stored after raw, so reading it walks a long record's overflow pages. The current-revision
// check goes through the covering partial index events_current_seq instead, and only columns stored before content/raw
// are read; raw is read only for a call that is shown.
const EV_INFO = `SELECT e.session_id AS session, e.source, ${safeTs('e.source_ts')} AS ts, e.injected, e.subagent_native_id AS sub,
  EXISTS (SELECT 1 FROM events x INDEXED BY events_current_seq WHERE x.session_id = e.session_id AND x.source = e.source AND x.source_seq = e.source_seq
    AND x.id = e.id AND x.revision_status = 'current') AS cur FROM events e WHERE e.id = ?`;
type EvInfo = { session: number; source: string; ts: number | null; injected: number; sub: string | null; cur: number };
type Cand = { id: number; callId: string; tool: string | null; sources: string; a: number | null; r: number | null };
/** Calls the session's own main thread made after `cursor`, in id order, each with its linked events' metadata (absent
 *  when unlinked or gone). `take` returns the characters it read. Stops at n shown calls, SCAN_MAX examined calls or
 *  RAW_BUDGET characters; returns the cursor to continue from (null at the end). Review L6: a link to another session's
 *  event hides the call. ponytail: candidates are sorted per request from tool_calls (small rows); add an index on
 *  (session_id, id) if sessions reach hundreds of thousands of calls. */
function eachMainCall(db: DatabaseSync, session: number, cursor: number | null, n: number, files: boolean, take: (c: Cand, a?: EvInfo, r?: EvInfo) => number): number | null {
  const info = db.prepare(EV_INFO);
  const cand = db.prepare(`SELECT id, native_call_id AS callId, tool, sources, args_event_id AS a, result_event_id AS r FROM tool_calls
    WHERE session_id = ? AND id > ?${files ? ' AND args_event_id IS NOT NULL AND tool IN (SELECT value FROM json_each(?))' : ''} ORDER BY id`);
  const ok = (e: EvInfo | undefined) => e === undefined || (e.session === session && e.sub === null && e.cur === 1);
  let shown = 0, scanned = 0, read = 0;
  for (const c of cand.iterate(...(files ? [session, cursor ?? 0, JSON.stringify(FILE_TOOLS)] : [session, cursor ?? 0])) as Iterable<Cand>) {
    scanned++;
    const a = c.a === null ? undefined : (info.get(c.a) as EvInfo | undefined);
    const r = c.r === null ? undefined : (info.get(c.r) as EvInfo | undefined);
    if (ok(a) && ok(r)) { read += take(c, a, r); shown++; }
    if (shown === n || scanned >= SCAN_MAX || read >= RAW_BUDGET) return c.id;
  }
  return null;
}
const sliceableId = (id: number | null, e?: EvInfo) => (e && (e.source === 'transcript' || e.source === 'rollout') && e.injected === 0 ? id : null);
function sourcesOf(raw: string): string[] {
  try {
    const a: unknown = JSON.parse(raw);
    return Array.isArray(a) ? [...new Set(a.filter((v): v is string => typeof v === 'string' && v !== '' && v.length <= 32))].slice(0, 8) : [];
  } catch { return []; }
}
const rawOf = (db: DatabaseSync) => { const q = db.prepare('SELECT raw FROM events WHERE id = ?'); return (id: number) => (q.get(id) as { raw: string | null } | undefined)?.raw ?? undefined; };

export function answerTools(db: DatabaseSync, req: PortRequest & { type: 'tools' }, live?: LiveOf, now = Date.now()): PortMessage & { type: 'tools' } {
  const empty = (): PortMessage & { type: 'tools' } => ({ v: IPC_VERSION, type: 'tools', id: req.id, calls: [], next: null });
  try {
    const s = sessionOf(db, req.session);
    if (!s) return empty();
    const evs = sessionEvidence(db, s);
    const approvals = evs && callApprovals(evs);
    const pending = isLive(s, live, now);
    const raw = rawOf(db);
    const calls: ToolItem[] = [];
    const next = eachMainCall(db, req.session, req.cursor, Math.min(req.limit, MAX_ITEMS), false, (c, a, r) => {
      const rRaw = s.agent === 'claude' && r ? raw(c.r!) : undefined; // only Claude results carry is_error
      const d = callDuration(a && { ts: a.ts, source: a.source }, r && { ts: r.ts, source: r.source });
      const approval = approvals?.get(c.callId) ?? null;
      calls.push({
        call: c.id, callId: callIdOf(c.callId), tool: c.tool ? display(c.tool) : null, sources: sourcesOf(c.sources), argsEvent: sliceableId(c.a, a), resultEvent: sliceableId(c.r, r),
        ts: a?.ts ?? null, durationMs: d !== null && Number.isSafeInteger(d) ? d : null,
        approval: approval === 'requested' && !pending ? null : approval, error: rRaw ? claudeCallError(rRaw, c.callId) : null,
      });
      return rRaw?.length ?? 0;
    });
    return { v: IPC_VERSION, type: 'tools', id: req.id, calls, next };
  } catch { return empty(); }
}

export function answerSubagents(db: DatabaseSync, req: PortRequest & { type: 'subagents' }, models: ModelEntry[] = [], live?: LiveOf, now = Date.now()): PortMessage & { type: 'subagents' } {
  const empty = (): PortMessage & { type: 'subagents' } => ({ v: IPC_VERSION, type: 'subagents', id: req.id, subagents: [], next: null });
  try {
    const s = sessionOf(db, req.session);
    if (!s) return empty();
    const n = Math.min(req.limit, MAX_ITEMS);
    const subs = db.prepare(`SELECT id, native_id AS nativeId, agent_type AS agentType FROM subagents WHERE session_id = ? AND id > ? AND native_id <> ''
      ORDER BY id LIMIT ?`).all(req.session, req.cursor ?? 0, n) as { id: number; nativeId: string; agentType: string | null }[];
    if (!subs.length) return empty();
    // One pass over the session's current records (covering partial index, then columns stored before content/raw) for
    // this page's subagents: span, count and latest assistant record. ponytail: O(session records) per subagents page;
    // add an index on (session_id, subagent_native_id) if sessions with many subagents and records get slow.
    type Span = { sub: string; start: number | null; end: number | null; records: number; lastAssistant: number | null };
    const spans = new Map((db.prepare(`SELECT subagent_native_id AS sub, min(${safeTs('source_ts')}) AS start, max(${safeTs('source_ts')}) AS end, count(*) AS records,
        max(CASE WHEN kind = 'message' AND role = 'assistant' THEN id END) AS lastAssistant
      FROM events INDEXED BY events_current_seq WHERE session_id = ? AND revision_status = 'current' AND subagent_native_id IN (SELECT value FROM json_each(?))
      GROUP BY subagent_native_id`).all(req.session, JSON.stringify(subs.map((x) => x.nativeId))) as Span[]).map((x) => [x.sub, x]));
    // The subagent's own reported model, read in SQLite so a long record never enters JS; never the parent's. Review M3:
    // the record sizes count against RAW_BUDGET (octet_length reads no content); past it the model is unknown.
    // ponytail: the latest assistant record only (subagentModel's rule over one record); scan earlier ones if a record without a model shows up.
    const size = db.prepare('SELECT octet_length(raw) AS n FROM events WHERE id = ?');
    const modelOf = db.prepare(`SELECT CASE WHEN json_valid(raw) THEN CASE WHEN json_type(raw, '$.message.model') = 'text' THEN json_extract(raw, '$.message.model') END END AS m
      FROM events WHERE id = ?`);
    let read = 0;
    const model = (id: number | null): string | null => {
      if (id === null) return null;
      read += (size.get(id) as { n: number | null } | undefined)?.n ?? 0;
      if (read > RAW_BUDGET) return null;
      const m = (modelOf.get(id) as { m: unknown } | undefined)?.m;
      return typeof m === 'string' && m !== '' && m !== '<synthetic>' && m.length <= MAX_MODEL ? m : null; // review L7: Claude's placeholder for a synthetic message
    };
    const evs = sessionEvidence(db, s);
    const pending = isLive(s, live, now);
    const life = new Map<string, 'running' | 'ended'>();
    for (const e of evs ?? []) {
      if (e.k === 'child.start' && !life.has(e.id)) life.set(e.id, 'running');
      else if (e.k === 'child.end') life.set(e.id, 'ended');
    }
    const out: SubagentItem[] = subs.map((x) => {
      const sp = spans.get(x.nativeId);
      const l = evs ? (life.get(x.nativeId) ?? null) : null;
      return { id: x.id, nativeId: display(x.nativeId)!, agentType: x.agentType ? display(x.agentType) : null, model: display(displayName(models, model(sp?.lastAssistant ?? null)))!,
        start: sp?.start ?? null, end: sp?.end ?? null, records: sp?.records ?? 0, lifecycle: l === 'running' && !pending ? null : l };
    });
    return { v: IPC_VERSION, type: 'subagents', id: req.id, subagents: out, next: out.length === n ? out.at(-1)!.id : null };
  } catch { return empty(); }
}

export function answerFiles(db: DatabaseSync, req: PortRequest & { type: 'files' }): PortMessage & { type: 'files' } {
  const empty = (): PortMessage & { type: 'files' } => ({ v: IPC_VERSION, type: 'files', id: req.id, touches: [], next: null });
  try {
    if (sessionOf(db, req.session)?.agent !== 'claude') return empty(); // FileTouch knows Claude shapes only (filetouch.ts ponytail)
    const raw = rawOf(db);
    const touches: FileItem[] = [];
    const next = eachMainCall(db, req.session, req.cursor, Math.min(req.limit, MAX_ITEMS), true, (c, _a, r) => {
      const argsRaw = raw(c.a!), resultRaw = r ? raw(c.r!) : undefined;
      for (const f of deriveFileTouches([{ agent: 'claude', callId: c.callId, argsRaw, resultRaw }])) touches.push({ path: f.path, kind: f.kind, callId: callIdOf(f.callId), call: c.id });
      return (argsRaw?.length ?? 0) + (resultRaw?.length ?? 0);
    });
    return { v: IPC_VERSION, type: 'files', id: req.id, touches, next };
  } catch { return empty(); }
}

/** Model markers: a timed turn whose model differs from the previous known one, or whose effort differs from the last
 *  reported effort (an effort that only becomes known is not a switch). State at a cursor is re-read from the turns at or
 *  before it, so pages agree with one scan. ponytail: at most SCAN_MAX turns per request; a longer run gives a short page. */
export function answerMarkers(db: DatabaseSync, req: PortRequest & { type: 'markers' }, models: ModelEntry[] = []): PortMessage & { type: 'markers' } {
  const empty = (): PortMessage & { type: 'markers' } => ({ v: IPC_VERSION, type: 'markers', id: req.id, markers: [], next: null });
  try {
    const n = Math.min(req.limit, MAX_ITEMS);
    const TIMED = `session_id = ? AND typeof(started_at) = 'integer' AND started_at BETWEEN -${SAFE} AND ${SAFE} AND model_id IS NOT NULL`;
    // Review L5: the bare range term lets turns_started seek to the cursor instead of walking from the session's start.
    const UPTO = 'started_at <= ? AND (started_at < ? OR (started_at = ? AND id <= ?)) ORDER BY started_at DESC, id DESC LIMIT 1';
    let c: MCursor = req.cursor ?? { ts: Number.MIN_SAFE_INTEGER, id: 0 };
    let model: string | null = null, effort: string | null = null;
    if (req.cursor) {
      model = (db.prepare(`SELECT model_id AS v FROM turns WHERE ${TIMED} AND ${UPTO}`).get(req.session, c.ts, c.ts, c.ts, c.id) as { v: string } | undefined)?.v ?? null;
      effort = (db.prepare(`SELECT effort AS v FROM turns WHERE ${TIMED} AND effort IS NOT NULL AND ${UPTO}`).get(req.session, c.ts, c.ts, c.ts, c.id) as { v: string } | undefined)?.v ?? null;
    }
    const page = db.prepare(`SELECT id, started_at AS ts, model_id AS model, effort FROM turns WHERE ${TIMED} AND started_at >= ? AND (started_at > ? OR (started_at = ? AND id > ?))
      ORDER BY started_at, id LIMIT ?`);
    const markers: ModelMarker[] = [];
    let scanned = 0, more = true;
    scan: for (;;) {
      let rows = 0;
      for (const t of page.iterate(req.session, c.ts, c.ts, c.ts, c.id, n) as Iterable<{ id: number; ts: number; model: string; effort: string | null }>) {
        rows++;
        scanned++;
        c = { ts: t.ts, id: t.id };
        if (t.model !== model || (t.effort !== null && effort !== null && t.effort !== effort)) {
          markers.push({ turn: t.id, ts: t.ts, model: display(modelLabel(displayName(models, t.model), t.effort))! });
        }
        model = t.model;
        if (t.effort !== null) effort = t.effort;
        if (markers.length === n || scanned >= SCAN_MAX) break scan;
      }
      if (rows < n) { more = false; break; }
    }
    return { v: IPC_VERSION, type: 'markers', id: req.id, markers, next: more && scanned > 0 ? c : null };
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
