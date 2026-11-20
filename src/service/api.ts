// Read-only session list API (P1-T12, S-29, FR-09): keyset pages over (last_activity DESC with unknown last, id),
// default 50 rows, hard cap 100; rows by session key for the coalesced deltas the service pushes after commits.
import { nativeExpiresAt } from './history/native-availability.ts';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { IPC_VERSION, isObj } from '../shared/ipc.ts';
import type { ContextReading, CoverageCode, Credits, Cursor, HistoryCursor, LiveStatus, Page, PortMessage, PortRequest, SessionRow, TCursor, TranscriptItem, UsageRecord, UsageScope } from '../shared/ipc.ts';
import { COST_CODE, COST_COMPONENTS, MAX_COST_CODES, MAX_COST_GROUPS, MAX_ITEMS, MAX_RECORDS, MAX_REFERENCES, MAX_SCOPES, parseContext, parseCost, PREVIEW_BYTES,
  REFERENCE_MAX, SLICE_BYTES } from '../shared/ipc.ts';
import type { CostDetail, CostGroup, PriceRevisionInfo } from '../shared/ipc.ts';
import type { FileItem, MCursor, ModelMarker, SubagentItem, ToolItem } from '../shared/ipc.ts';
import { classifyItem, utf8Slice, type StoredRecord } from './transcript.ts';
import { blockText } from './adapters/claude/parse.ts';
import { callApprovals, callDuration, claudeCallError, MAX_MODEL, message, type ConfEv } from './session-detail.ts';
import { deriveFileTouches, FILE_TOOLS } from './filetouch.ts';
import { parseEvidence, type Confidence } from './status/engine.ts';
import type { SessionKind } from './catalog/validate.ts';
import { sessionKind } from './resume.ts';
import { LIVE_WINDOW_MS } from './status/feed.ts'; // D-P3-09 feed eligibility
import { sessionCost } from './usage/cost.ts';
import { notPurging } from './history/suppression.ts';
import { displayName, modelLabel, type ModelEntry, type ModelList } from './usage/models.ts';

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;
/** Display strings (cwd, entrypoint, title) are cut to this many UTF-16 units plus "…" before IPC, far below the
 *  64 KiB per-string limit the renderer validates, so one long transcript value cannot void a page. The store keeps
 *  the original. */
export const DISPLAY_MAX = 4096;

export interface SessionKey { agent: string; profileId: string; nativeSessionId: string }

const titles = new WeakMap<DatabaseSync, string>();
/** Gate 5 G5b2-1 (EC-45): a store left read-only before migration 016 has no ai_title column; checked once per
 *  connection (a connection never migrates after its first read). */
function titleOf(db: DatabaseSync): string {
  let t = titles.get(db);
  if (t === undefined) titles.set(db, t = db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'ai_title'").get() ? 'coalesce(s.title, s.ai_title)' : 's.title');
  return t;
}
/** The session row query for this connection's schema. */
export const ROW = (db: DatabaseSync) => `SELECT s.id, s.agent, s.profile_id, s.native_session_id, s.entrypoint, s.originator, s.current_model, s.current_effort, s.cwd, ${titleOf(db)} AS title, s.last_activity, s.drift, s.quarantined_count, s.native_available, s.native_archived,
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
export interface Raw { tokens: number | null; tokens_gap: number; id: number; agent: string; profile_id: string; native_session_id: string; context_pct: number | null; entrypoint: string | null; originator: string | null; current_model: string | null; current_effort: string | null; cwd: string | null; title: string | null; last_activity: number | null; drift: number; quarantined_count: number; compressed: number;
  native_available: number | null; native_archived: number }
/** At most `max` UTF-16 units, ending in "…" when cut; never ends inside a surrogate pair. */
export const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, (s.charCodeAt(max - 2) & 0xfc00) === 0xd800 ? max - 2 : max - 1)}…`);
const display = (s: string | null): string | null => (s === null ? null : cut(s, DISPLAY_MAX + 1));
// Origin badge and interactive flag come from the catalog kind (P2-T04); an unknown kind leaves both null. The model
// label is "<display name> · <effort>", the raw id when unlisted, "Model unavailable" without evidence (P2-T08).
// P3-T10: live status from the engine, the latest context percentage (clamped to the 0–100 the IPC accepts) and the
// session ~$ estimate (Phase 2 selection; an unreadable estimate is unavailable, never zero).
// XAIBO-PROD-509 (P5-T02c, EC-66): an untitled session's first prompt, in-app only (notifications never see it): the first
// record the transcript classifier calls a prompt among the first PROMPT_SCAN visible user records, whitespace collapsed,
// cut to EXCERPT_MAX. ponytail: computed per untitled row on each list read (an index walk plus a few small parses);
// store it on the session if list reads slow down.
// Gate 5 G5b2-3: a record over EXCERPT_RECORD_MAX bytes is skipped in the query, never loaded or parsed, so one row costs
// at most PROMPT_SCAN bounded parses. ponytail: a session whose only prompts are that large shows no excerpt; store a
// bounded prompt prefix at ingest if that matters.
export const EXCERPT_MAX = 120;
const PROMPT_SCAN = 8;
const EXCERPT_RECORD_MAX = 128 * 1024;
const excerptStatements = new WeakMap<DatabaseSync, StatementSync>(); // prepared once per connection (review L1)
function excerptOf(db: DatabaseSync, agent: string, session: number): string | null {
  try {
    const q = excerptStatements.get(db) ?? excerptStatements.set(db, db.prepare(`SELECT e.kind, e.role, e.content, e.raw FROM events e
      WHERE ${VISIBLE} AND (e.role = 'user' OR e.kind = 'user')
        AND coalesce(octet_length(e.content), 0) <= ${EXCERPT_RECORD_MAX} AND coalesce(octet_length(e.raw), 0) <= ${EXCERPT_RECORD_MAX} ORDER BY e.source_seq, e.id LIMIT ${PROMPT_SCAN}`)).get(db)!;
    for (const row of q.iterate(session) as Iterable<Pick<TrRow, 'kind' | 'role' | 'content' | 'raw'>>) {
      const it = classifyItem(stored(agent, row));
      if (it?.kind !== 'prompt' || !it.text) continue;
      // Collapse a bounded prefix (a prompt can be megabytes); drop a surrogate half left by the slice.
      const t = it.text.slice(0, 8 * EXCERPT_MAX).replace(/\s+/g, ' ').trim().replace(/[\uD800-\uDBFF]$/, '');
      if (t) return cut(it.text.length > 8 * EXCERPT_MAX ? `${t}…` : t, EXCERPT_MAX);
    }
  } catch { /* an unreadable session has no excerpt */ }
  return null;
}

export const toRow = (db: DatabaseSync, kinds: SessionKind[], models: ModelEntry[], live?: LiveOf) => (r: Raw): SessionRow => {
  const k = sessionKind(kinds, r);
  let cost: { amountUsd: number | null; coverage: SessionRow['costCoverage'] };
  try { cost = sessionCost(db, r.id); } catch { cost = { amountUsd: null, coverage: 'unavailable' }; }
  const pct = r.context_pct;
  const usable = cost.amountUsd !== null && Number.isFinite(cost.amountUsd) && cost.amountUsd >= 0;
  return {
    id: r.id, agent: r.agent, entrypoint: display(r.entrypoint), origin: k?.badge ?? null, interactive: k?.interactive ?? null,
    model: display(modelLabel(displayName(models, r.current_model), r.current_effort))!, cwd: display(r.cwd), title: display(r.title), excerpt: r.title === null ? excerptOf(db, r.agent, r.id) : null, lastActivity: r.last_activity,
    drift: r.drift === 1, compressed: r.compressed === 1, quarantined: r.quarantined_count,
    native: { available: r.native_available !== 0, archived: r.native_archived === 1 }, // P5-T12: false only when confirmed gone
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

/** P5-T03 (FR-11, design §6.1/§6.4): trashed sessions leave All sessions, the live set and deltas. A store without the
 *  overlay tables (a read-only older schema) has no Trash. */
function shown(db: DatabaseSync): string {
  return (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'overlays'").get() === undefined ? '1'
    : 'NOT EXISTS (SELECT 1 FROM overlays o WHERE o.agent = s.agent AND o.profile_id = s.profile_id AND o.native_session_id = s.native_session_id AND o.trashed_at IS NOT NULL)')
    + ` AND ${notPurging(db)}`; // XAIBO-PROD-542 G5-N1: a session being purged is hidden
}

export function listSessions(db: DatabaseSync, cursor: Cursor | null, limit: number, kinds: SessionKind[] = [], models: ModelEntry[] = [], live?: LiveOf): Page {
  const n = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : PAGE_DEFAULT, PAGE_MAX);
  const t = shown(db);
  let raw: Raw[];
  if (!cursor) raw = db.prepare(`${ROW(db)} WHERE ${t} ${ORDER}`).all(n) as unknown as Raw[];
  else if (cursor.lastActivity === null) raw = db.prepare(`${ROW(db)} WHERE s.last_activity IS NULL AND s.id > ? AND ${t} ${ORDER}`).all(cursor.id, n) as unknown as Raw[];
  else {
    raw = db.prepare(`${ROW(db)} WHERE (s.last_activity < ? OR s.last_activity IS NULL OR (s.last_activity = ? AND s.id > ?)) AND ${t} ${ORDER}`)
      .all(cursor.lastActivity, cursor.lastActivity, cursor.id, n) as unknown as Raw[];
  }
  const rows = raw.map(toRow(db, kinds, models, live));
  const last = rows.at(-1);
  return { rows, next: rows.length === n && last ? { lastActivity: last.lastActivity, id: last.id } : null };
}

export function sessionsByKey(db: DatabaseSync, keys: SessionKey[], kinds: SessionKind[] = [], models: ModelEntry[] = [], live?: LiveOf): SessionRow[] {
  const one = db.prepare(`${ROW(db)} WHERE s.agent = ? AND s.profile_id = ? AND s.native_session_id = ? AND ${shown(db)}`);
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
    const one = db.prepare(`${ROW(db)} WHERE s.id = ?`);
    // Review M1: membership from the bare key columns; the per-session subqueries run for members only.
    for (const k of db.prepare(`SELECT s.id, s.agent, s.profile_id, s.native_session_id FROM sessions s WHERE s.last_activity >= ? AND ${shown(db)} ORDER BY s.last_activity DESC, s.id`)
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
  // XAIBO-PROD-542: a purging session's own (unverified) scope leaves Usage with it
  const latest = db.prepare(`SELECT sc.id AS scope, sc.agent, sc.verified, sc.profile_id, h.limit_id, h.used_percent, h.window_minutes, h.resets_at, h.plan, h.credits,
      h.as_of, h.first_observed_at, h.measured_at
    FROM (SELECT DISTINCT usage_scope_id, limit_id FROM usage_history) k
    JOIN usage_history h ON h.id = (SELECT id FROM usage_history x WHERE x.usage_scope_id = k.usage_scope_id AND x.limit_id = k.limit_id
      ORDER BY x.measured_at DESC, x.id DESC LIMIT 1)
    JOIN usage_scopes sc ON sc.id = h.usage_scope_id
    WHERE sc.session_id IS NULL OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = sc.session_id AND ${notPurging(db)})
    ORDER BY sc.id, h.limit_id`).all() as Latest[];
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
/** Parameters: scope, stream, lower bound, to, cursor measuredAt (null = first page) twice, cursor id, limit. */
export const USAGE_HISTORY_PAGE = `SELECT id, kind, measured_at, used_percent, window_minutes, resets_at, as_of FROM usage_history
  WHERE usage_scope_id = ? AND limit_id = ? AND measured_at >= ? AND measured_at < ? AND (? IS NULL OR measured_at > ? OR id > ?)
  ORDER BY measured_at, id LIMIT ?`;
/** P4-T04b1: one scope+stream's stored observations with measured time in [from, to), oldest first; keyset
 *  (measured_at, id) on the usage_history_stream index. Nothing interpolated: absent minutes are absent. */
export function answerUsageHistory(db: DatabaseSync, req: PortRequest & { type: 'usageHistory' }): PortMessage & { type: 'usageHistory' } {
  const n = Math.min(req.limit, HISTORY_MAX);
  const c = req.cursor;
  try {
    // Review L: the cursor is the index lower bound, so later pages seek instead of rescanning the window.
    const raw = db.prepare(USAGE_HISTORY_PAGE).all(req.scope, req.stream, Math.max(req.from, c?.measuredAt ?? req.from), req.to, c?.measuredAt ?? null, c?.measuredAt ?? null, c?.id ?? null, n) as
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
// P4-T09a: chunk rows of an oversized line (EC-15) are storage, not records: never paged, counted or sliced on their own.
const VISIBLE = `e.session_id = ? AND e.source IN ('transcript', 'rollout') AND e.subagent_native_id IS NULL AND e.revision_status = 'current' AND e.injected = 0
  AND e.kind NOT IN ('content-chunk', 'raw-chunk')`;
const TR_COLS = 'e.id, e.kind, e.role, e.content, e.raw, e.source_seq AS seq, e.source_ts AS ts, e.ingest_id AS ingest';
interface TrRow { id: number; kind: string; role: string | null; content: string | null; raw: string | null; seq: number; ts: number | null; ingest: string | null }

// P4-T09a (EC-56, PRD §5.7): an oversized Claude line is a head row (raw '', ingest id `x:<hash>`) plus content chunks
// `<key>#c000001…` of at most 64 KiB UTF-8 each, cut on code points. Sizes come from octet_length, which reads no text,
// so paging and finding a cursor read no chunk; a slice reads only the chunk holding its byte cursor. Chunks are never
// revised (only agy revises), so revision_status, stored after the text, is not read for them. Every oversized line is
// one 'large' item whatever its role (review M1): the head keeps only small fields and the chunks join every readable
// field, so calling it a prompt, response or tool call would be a guess.
const largeKey = (bare: boolean, ingest: string | null): string | null => (bare && typeof ingest === 'string' && ingest.startsWith('x:') ? ingest : null);
const CHUNKS = "FROM events WHERE session_id = ? AND source = 'transcript' AND native_id > ? AND native_id < ? AND kind = 'content-chunk'";
const chunkSizes = (db: DatabaseSync, session: number, key: string) =>
  db.prepare(`SELECT id, octet_length(content) AS n ${CHUNKS} ORDER BY native_id`).all(session, `${key}#c`, `${key}#d`) as { id: number; n: number | null }[];
const largeBytes = (db: DatabaseSync, session: number, key: string) =>
  (db.prepare(`SELECT TOTAL(octet_length(content)) AS n ${CHUNKS}`).get(session, `${key}#c`, `${key}#d`) as { n: number }).n;

/** At most SLICE_BYTES of a large record's text from a UTF-8 byte cursor, never past its chunk; null for a cursor
 *  inside a code point, at or past the end. ponytail: re-reads the chunk size list per slice (an index walk, ~800 rows
 *  for 50 MB); cache it per event if far larger lines page slowly. */
function largeSlice(db: DatabaseSync, session: number, key: string, offset: number): { text: string; next: number | null } | null {
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  const sizes = chunkSizes(db, session, key);
  const total = sizes.reduce((t, c) => t + (c.n ?? 0), 0);
  let at = 0;
  const hit = sizes.find((c) => { if (offset < at + (c.n ?? 0)) return true; at += c.n ?? 0; return false; });
  if (!hit) return null;
  const text = (db.prepare('SELECT content FROM events WHERE id = ?').get(hit.id) as { content: string | null } | undefined)?.content ?? '';
  const buf = Buffer.from(text, 'utf8');
  const start = offset - at;
  if (start >= buf.length || (buf[start]! & 0xc0) === 0x80) return null;
  let end = Math.min(buf.length, start + SLICE_BYTES);
  while (end < buf.length && (buf[end]! & 0xc0) === 0x80) end--; // never cut inside a code point
  const next = offset + (end - start);
  return { text: buf.toString('utf8', start, end), next: next < total ? next : null };
}
const stored = (agent: string, r: Pick<TrRow, 'kind' | 'role' | 'content' | 'raw'>): StoredRecord => ({ agent, kind: r.kind, role: r.role, injected: false, content: r.content, raw: r.raw });

export function answerSession(db: DatabaseSync, req: PortRequest & { type: 'session' }, kinds: SessionKind[] = [], models: ModelEntry[] = [], live?: LiveOf,
  managedDir?: string): PortMessage & { type: 'session' } {
  try {
    const r = db.prepare(`${ROW(db)} WHERE s.id = ? AND ${notPurging(db)}`).get(req.session) as Raw | undefined;
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
    let nativeExpires: number | null = null; // P5-T12 (EC-23): an estimate; unreadable settings give none
    try { nativeExpires = nativeExpiresAt(db, r, managedDir); } catch { nativeExpires = null; }
    return { v: IPC_VERSION, type: 'session', id: req.id, detail: { row, coverage, context, nativeExpiresAt: nativeExpires } };
  } catch { return { v: IPC_VERSION, type: 'session', id: req.id, detail: null }; }
}

export function answerTranscript(db: DatabaseSync, req: PortRequest & { type: 'transcript' }): PortMessage & { type: 'transcript' } {
  const empty = (): PortMessage & { type: 'transcript' } => ({ v: IPC_VERSION, type: 'transcript', id: req.id, items: [], prev: null, next: null });
  try {
    const s = db.prepare(`SELECT agent FROM sessions s WHERE id = ? AND ${notPurging(db)}`).get(req.session) as { agent: string } | undefined;
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
        const large = largeKey(!row.raw, row.ingest);
        const bytes = large !== null ? largeBytes(db, req.session, large) : null;
        // Review M2: a line with no readable text is still listed (length 0). Review M3: its size counts toward
        // RAW_BUDGET as if read, so chunk lookups per page stay bounded too.
        if (bytes !== null) read += bytes;
        const it = bytes !== null ? { kind: 'large' as const, text: null, reasoning: null } : classifyItem(stored(s.agent, row));
        const message = it !== null && (it.kind === 'prompt' || it.kind === 'response');
        consumed.push({ id: row.id, seq: row.seq, ts: Number.isFinite(row.ts) ? row.ts : null, item: it && {
          kind: it.kind, preview: message && it.text !== null ? utf8Slice(it.text, 0, PREVIEW_BYTES)!.text : null,
          length: bytes ?? it.text?.length ?? 0, reasoning: it.reasoning !== null, // a large record's length is UTF-8 bytes
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
      items.push({ event: k.id, seq: k.seq, ts: k.ts, ...k.item, callId: callIdOf(callId) });
    }
    return {
      v: IPC_VERSION, type: 'transcript', id: req.id, items,
      prev: first && exists(BEFORE, first) ? { seq: first.seq, id: first.id } : null,
      next: last && exists(AFTER, last) ? { seq: last.seq, id: last.id } : null,
    };
  } catch { return empty(); }
}

/** A Claude record's tool_use block with id `call` (name and JSON input) or tool_result for it; null when none matches
 *  (or for reasoning, which no tool block has). */
function claudeCallText(raw: string | null, call: string, part: 'text' | 'reasoning'): string | null {
  if (part !== 'text' || raw === null) return null;
  const content = message(raw)?.content;
  const b: unknown = Array.isArray(content)
    ? content.find((x) => isObj(x) && ((x.type === 'tool_use' && x.id === call) || (x.type === 'tool_result' && x.tool_use_id === call))) : undefined;
  return blockText(b) ?? null;
}

// Review 1: the last classified text per store, so reading a long record in 16 KiB steps parses it once. Visibility is
// re-checked on every request; a cached entry is only text the same session and event already produced.
const sliceCache = new WeakMap<DatabaseSync, { key: string; text: string | null }>();
export function answerSlice(db: DatabaseSync, req: PortRequest & { type: 'slice' }): PortMessage & { type: 'slice' } {
  const empty = (): PortMessage & { type: 'slice' } => ({ v: IPC_VERSION, type: 'slice', id: req.id, text: '', next: null });
  try {
    // One visibility check that also tells a large head apart; octet_length reads no raw text (review L5).
    // XAIBO-PROD-542 (review M): checked before the cache, so a purging session is never served from it
    const head = db.prepare(`SELECT coalesce(octet_length(e.raw), 0) = 0 AS bare, e.ingest_id AS ingest FROM events e WHERE e.id = ? AND ${VISIBLE}
      AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id AND ${notPurging(db)})`)
      .get(req.event, req.session) as { bare: number; ingest: string | null } | undefined;
    if (!head) return empty();
    const large = largeKey(head.bare === 1, head.ingest);
    // ponytail: a large (chunked) record ignores `call` and serves its whole text (Claude writes one block per record, so
    // a large record with several calls is not seen); select within the chunks if one shows up.
    if (large !== null) {
      const cut = req.part === 'text' ? largeSlice(db, req.session, large, req.offset) : null;
      return cut ? { v: IPC_VERSION, type: 'slice', id: req.id, text: cut.text, next: cut.next } : empty();
    }
    const key = `${req.session}:${req.event}:${req.part}:${req.call ?? ''}`;
    let hit = sliceCache.get(db);
    if (hit?.key !== key) {
      const r = db.prepare(`SELECT s.agent, e.kind, e.role, e.content, e.raw FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.id = ? AND ${VISIBLE}`)
        .get(req.event, req.session) as (Pick<TrRow, 'kind' | 'role' | 'content' | 'raw'> & { agent: string }) | undefined;
      const it = r ? classifyItem(stored(r.agent, r)) : null;
      // XAIBO-PROD-446: a tool step's call in a Claude record the transcript shows is its own block, never the record's other text
      const own = r && it && req.call !== undefined && r.agent === 'claude' ? claudeCallText(r.raw, req.call, req.part) : undefined;
      hit = { key, text: own !== undefined ? own : (req.part === 'text' ? it?.text : it?.reasoning) ?? null };
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
  db.prepare(`SELECT agent, profile_id, native_session_id, ${safeTs('last_activity')} AS last_activity FROM sessions s WHERE id = ? AND ${notPurging(db)}`).get(id) as Sess | undefined;
/** Review M4: a pending state (approval requested, subagent running) is current only while the session is live: tracked,
 *  not ended and active within the live window (as the live set). Otherwise its outcome is unknown. */
const isLive = (s: Sess, live: LiveOf | undefined, now: number) => {
  const st = live?.(s.agent, s.native_session_id, s.profile_id);
  return !!st && st.lifecycle !== 'ended' && s.last_activity !== null && s.last_activity >= now - LIVE_WINDOW_MS;
};
const callIdOf = (id: string | null) => (id !== null && id !== '' && id.length <= 256 ? id : null);
/** The session's status evidence in the engine's order, or null past EVIDENCE_MAX rows or RAW_BUDGET characters: a cut
 *  history could show a stale state (e.g. `requested` whose answer lies beyond the cut), so callers report unknown.
 *  Review M2: the size is checked before the sorted read, so an oversized history is never sorted.
 *  ponytail: re-read per page request; reuse the engine's in-memory entries if Tools paging over long sessions is slow. */
function sessionEvidence(db: DatabaseSync, s: Sess): ConfEv[] | null {
  const WHERE = 'agent = ? AND profile_id = ? AND native_session_id = ?';
  const size = db.prepare(`SELECT count(*) AS n, total(octet_length(ev)) AS bytes FROM (SELECT ev FROM status_evidence WHERE ${WHERE} LIMIT ${EVIDENCE_MAX + 1})`)
    .get(s.agent, s.profile_id, s.native_session_id) as { n: number; bytes: number };
  if (size.n > EVIDENCE_MAX || size.bytes > RAW_BUDGET) return null;
  const evs: ConfEv[] = [];
  let rows = 0, read = 0;
  for (const r of db.prepare(`SELECT ev, confidence FROM status_evidence WHERE ${WHERE} ORDER BY ts, rank, seq, coalesce(producer_seq, 0), id`)
    .iterate(s.agent, s.profile_id, s.native_session_id) as Iterable<{ ev: string; confidence: Confidence }>) {
    if (++rows > EVIDENCE_MAX || (read += r.ev.length) > RAW_BUDGET) return null; // rows added since the size check
    // a malformed row is skipped, as the engine does; XAIBO-PROD-444: each keeps its row's confidence
    for (const e of parseEvidence(r.ev) ?? []) evs.push({ ...e, conf: r.confidence });
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
    // ponytail: the latest assistant record only (a non-empty model of at most MAX_MODEL); scan earlier ones if a record without a model shows up.
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
  // XAIBO-PROD-454: a store error is a failure the renderer shows with Retry, never a successful empty page
  const failed = (): PortMessage & { type: 'markers' } => ({ v: IPC_VERSION, type: 'markers', id: req.id, markers: [], next: null, failed: true });
  try {
    if (!sessionOf(db, req.session)) return { v: IPC_VERSION, type: 'markers', id: req.id, markers: [], next: null }; // none, or being purged
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
  } catch { return failed(); }
}

/** Renderer ports (P4-T02): session deltas go only to live (visible) ports; every other push goes to all ports. */
export function createHub<P extends { postMessage(m: PortMessage): void }>() {
  const ports = new Map<P, boolean>();
  return {
    add(p: P): void { ports.set(p, true); },
    remove(p: P): void { ports.delete(p); },
    setLive(p: P, on: boolean): void { if (ports.has(p)) ports.set(p, on); },
    anyLive(): boolean { return [...ports.values()].some(Boolean); },
    sessions(m: PortMessage & { type: 'sessions' | 'resync' }): void { for (const [p, live] of ports) if (live) p.postMessage(m); },
    broadcast(m: PortMessage): void { for (const p of ports.keys()) p.postMessage(m); },
  };
}

/** Collects keys and flushes each distinct key once per window of `ms`. P4-T10c1: past `max` distinct keys the window
 *  stops collecting and flushes null (the receiver resyncs by cursor), so a window never holds more than `max` keys. */
export function coalesce(flush: (keys: string[] | null) => void, ms: number, setTimer: (fn: () => void, ms: number) => unknown = setTimeout,
  max = Infinity): (key: string) => void {
  let keys: Set<string> | null | undefined; // undefined: no window; null: this window overflowed
  return (key) => {
    if (keys === null) return;
    if (keys) { if (!keys.has(key) && keys.size >= max) keys = null; else keys.add(key); return; }
    keys = new Set([key]);
    setTimer(() => { const k = keys ? [...keys] : null; keys = undefined; flush(k); }, ms);
  };
}

// XAIBO-PROD-417 (P4-T07a; PRD FR-48, US-18, §5.12; design §6.3.2): the session's cost breakdown. The selected total is
// sessionCost's (a reported estimate replaces the calculated one, never added). Per-request estimates group by (model,
// price revision, basis) in SQL, so memory stays bounded; a component's ~$ sums tokens × its applied rate over requests
// the engine priced without that component as a gap. Codex/agy cache write has no applied rate, so it is never priced.
type CostComp = (typeof COST_COMPONENTS)[number];
const RATE = (path: string) => `json_extract(e.applied_rates, '${path}')`;
const CLASS = (k: string) => `CASE WHEN u.cache_write = 0 THEN 0 WHEN u.cache_write_classes IS NULL THEN NULL ELSE coalesce(json_extract(u.cache_write_classes, '$."${k}"'), 0) END`;
const COST_SQL: Record<CostComp, { tokens: string; rate: string; gap: string }> = {
  uncached_input: { tokens: 'u.uncached_input', rate: RATE('$.input'), gap: 'uncached_input' },
  cache_read: { tokens: 'u.cache_read', rate: RATE('$.cache_read'), gap: 'cache_read' },
  cache_write: { tokens: 'u.cache_write', rate: 'NULL', gap: 'cache_write' },
  cache_write_5m: { tokens: CLASS('5m'), rate: RATE('$.cache_write."5m"'), gap: 'cache_write' },
  cache_write_1h: { tokens: CLASS('1h'), rate: RATE('$.cache_write."1h"'), gap: 'cache_write' },
  output: { tokens: 'u.output', rate: RATE('$.output'), gap: 'output' },
};
const CLAUDE_COMPS: CostComp[] = ['uncached_input', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'output'];
const OTHER_COMPS: CostComp[] = ['uncached_input', 'cache_read', 'cache_write', 'output'];
const COST_GROUPS_SQL = `SELECT json_extract(e.coverage, '$.model') AS model, e.price_revision_id AS rev, e.basis AS basis, COUNT(*) AS requests,
    COUNT(e.amount_usd) AS priced, MIN(e.as_of) AS "from", MAX(e.as_of) AS "to",
    ${COST_COMPONENTS.map((k) => {
      const c = COST_SQL[k];
      const ok = `e.amount_usd IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(e.coverage, '$.gaps') g WHERE g.value = '${c.gap}')`;
      return `SUM(${c.tokens}) AS ${k}_t, COUNT(*) - COUNT(${c.tokens}) AS ${k}_m, COUNT(DISTINCT ${c.rate}) AS ${k}_n, MIN(${c.rate}) AS ${k}_r,
      SUM(CASE WHEN ${ok} THEN (${c.tokens}) * (${c.rate}) END) AS ${k}_u, SUM(CASE WHEN (${c.tokens}) > 0 AND NOT (${ok}) THEN 1 ELSE 0 END) AS ${k}_p`;
    }).join(',\n    ')}
  FROM cost_estimates e JOIN usage u ON u.session_id = e.session_id AND u.source = e.source AND u.scope = 'message'
    AND u.identity = substr(e.covered_scope, length(e.source) + 8)
  WHERE e.session_id = ? AND e.basis <> 'agent_reported' AND e.covered_scope = 'usage:' || e.source || ':' || u.identity
  GROUP BY 1, 2, 3 ORDER BY MIN(e.as_of) IS NULL, MIN(e.as_of), rev, model LIMIT ${MAX_COST_GROUPS + 1}`;
const safeCount = (x: unknown): number | null => (Number.isSafeInteger(x) && (x as number) >= 0 ? (x as number) : null);
const finiteUsd = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);

export function answerCost(db: DatabaseSync, req: PortRequest & { type: 'cost' }, models: ModelEntry[] = []): PortMessage & { type: 'cost' } {
  const reply = (cost: CostDetail | null): PortMessage & { type: 'cost' } => ({ v: IPC_VERSION, type: 'cost', id: req.id, cost });
  let s: { agent: string } | undefined;
  try { s = db.prepare(`SELECT agent FROM sessions s WHERE id = ? AND ${notPurging(db)}`).get(req.session) as { agent: string } | undefined; } catch { return reply(null); }
  if (!s) return reply(null); // null means only "no such session"
  // Review M2: an unreadable estimate row (malformed JSON, an integer node:sqlite cannot read, overflow) degrades the
  // reply to what was read plus 'breakdown-unavailable'; it never nulls a known session.
  const out: CostDetail = { amountUsd: null, basis: 'token_table', coverage: 'unavailable', reportedUsd: null, requests: 0, priced: 0, gaps: [], reasons: [],
    groups: [], more: false, revisions: [] };
  const failed = (): PortMessage & { type: 'cost' } => reply(parseCost({ ...out, groups: [], revisions: [], more: false,
    reasons: [...out.reasons.filter((r) => r !== 'breakdown-unavailable').slice(0, MAX_COST_CODES - 1), 'breakdown-unavailable'] }) ?? null);
  try {
    const sel = sessionCost(db, req.session);
    out.amountUsd = finiteUsd(sel.amountUsd);
    out.basis = sel.basis;
    out.coverage = out.amountUsd === null ? 'unavailable' : sel.coverage;
    // review L4: the same row order sessionCost scans, so reportedUsd is the amount it selected
    const reported = db.prepare(`SELECT amount_usd AS a FROM cost_estimates WHERE session_id = ? AND basis = 'agent_reported' AND amount_usd IS NOT NULL
      ORDER BY id LIMIT 1`).get(req.session) as { a: number } | undefined;
    out.reportedUsd = finiteUsd(reported?.a ?? null);
    const counts = db.prepare(`SELECT COUNT(*) AS n, COUNT(amount_usd) AS p FROM cost_estimates WHERE session_id = ? AND basis <> 'agent_reported'`)
      .get(req.session) as { n: number; p: number };
    out.requests = safeCount(counts.n) ?? 0;
    out.priced = Math.min(safeCount(counts.p) ?? 0, out.requests);
    const codes = (sql: string) => (db.prepare(sql).all(req.session) as { c: unknown }[]).map((r) => r.c).filter((c): c is string => typeof c === 'string' && COST_CODE.test(c));
    out.reasons = codes(`SELECT DISTINCT unavailable_reason AS c FROM cost_estimates WHERE session_id = ? AND basis <> 'agent_reported'
      AND unavailable_reason IS NOT NULL LIMIT ${MAX_COST_CODES}`);
    out.gaps = codes(`SELECT DISTINCT g.value AS c FROM cost_estimates e, json_each(e.coverage, '$.gaps') g WHERE e.session_id = ? AND e.basis <> 'agent_reported'
      LIMIT ${MAX_COST_CODES}`);
    const rows = db.prepare(COST_GROUPS_SQL).all(req.session) as Record<string, unknown>[];
    const comps = s.agent === 'claude' ? CLAUDE_COMPS : OTHER_COMPS;
    const raw: { model: string | null; rev: number | null; basis: CostGroup['basis'] }[] = [];
    const groups: CostGroup[] = rows.slice(0, MAX_COST_GROUPS).map((r) => {
      const model = typeof r.model === 'string' ? r.model : null;
      const rev = safeCount(r.rev) || null;
      const basis = r.basis === 'owner_fallback' ? 'owner_fallback' : 'token_table';
      const requests = safeCount(r.requests) ?? 0;
      raw.push({ model, rev, basis });
      return {
        model: display(displayName(models, model))!, revision: rev, basis, requests, priced: Math.min(safeCount(r.priced) ?? 0, requests),
        from: Number.isSafeInteger(r.from) ? (r.from as number) : null, to: Number.isSafeInteger(r.to) ? (r.to as number) : null,
        components: comps.map((k) => {
          const n = safeCount(r[`${k}_n`]) ?? 0;
          return { name: k, tokens: safeCount(r[`${k}_t`]), missing: safeCount(r[`${k}_m`]) ?? 0, unpriced: safeCount(r[`${k}_p`]) ?? 0,
            rate: n === 1 ? finiteUsd(r[`${k}_r`]) : null, rateVaries: n > 1, usd: finiteUsd(typeof r[`${k}_u`] === 'number' ? (r[`${k}_u`] as number) / 1e6 : null) };
        }),
      };
    });
    const revisions: PriceRevisionInfo[] = [];
    const getRev = db.prepare('SELECT id, source, revision, prices_as_of AS asOf, body FROM price_revisions WHERE id = ?');
    for (const id of [...new Set(raw.map((g) => g.rev).filter((x): x is number => x !== null))].sort((a, b) => a - b)) {
      const p = getRev.get(id) as { id: number; source: string; revision: string; asOf: string | null; body: string } | undefined;
      if (!p || (p.source !== 'bundled' && p.source !== 'override')) continue;
      const refs = new Set<string>();
      let table: Partial<ModelList> | null = null;
      try { table = (JSON.parse(p.body) as { table: ModelList }).table ?? null; } catch { /* references unavailable */ }
      const listed = Array.isArray(table?.models) ? table.models : [], sources = Array.isArray(table?.sources) ? table.sources : [];
      for (const g of raw.filter((x) => x.rev === id)) {
        if (g.basis === 'owner_fallback') { refs.add('Owner-set fallback'); continue; }
        const m = listed.find((x) => x?.id === g.model);
        const src = m && sources.find((x) => x?.id === m.source);
        if (src) refs.add(cut(`${String(src.id)}: ${String(src.url)} (retrieved ${String(src.retrieved)})`, REFERENCE_MAX));
      }
      revisions.push({ id, label: cut(String(p.revision), REFERENCE_MAX), pricesAsOf: p.asOf === null ? null : cut(String(p.asOf), 64), source: p.source,
        references: [...refs].slice(0, MAX_REFERENCES) });
    }
    const full = parseCost({ ...out, groups, more: rows.length > MAX_COST_GROUPS, revisions });
    return full ? reply(full) : failed();
  } catch { return failed(); }
}
