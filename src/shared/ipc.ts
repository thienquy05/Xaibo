// Versioned IPC messages (P1-T06, §7.1) with hand-written validation: every receiver parses what arrives and drops
// (and counts) anything malformed, of an unknown version or of an unknown type. Parsers return fresh objects holding
// only the known fields. Main <-> service over the parent port; main -> renderer health; renderer <-> service over the
// brokered port (P1-T12).
export const IPC_VERSION = 1;

export type ReadOnlyReason = 'migration-failed' | 'insufficient-space' | 'newer-schema';
export const READ_ONLY_BANNER: Record<ReadOnlyReason, string> = {
  'migration-failed': 'Database migration failed: read-only',
  'insufficient-space': 'Not enough disk space to migrate the database: read-only',
  'newer-schema': 'Database is from a newer Xaibo version: read-only',
};

/** main -> service; setPath carries a file the user picked in the native dialog (validated again by the service);
 *  reloadPrices re-reads the private price override (P2-T09; sent by Settings in P6-T11). */
export type ServiceCommand = { v: 1; type: 'quit' | 'wake' | 'port' | 'reloadPrices' } | { v: 1; type: 'setPath'; agent: string; path: string }
  /** P3-T12: the machine is about to sleep; `at` is main's clock at the power event (ms since epoch). */
  | { v: 1; type: 'suspend'; at: number };
/** service -> main; notify (P3-T11, EC-59) carries only the agent display name, the approved project label (null until
 *  one exists, FR-10) and the wait state. */
export type NotifyState = 'waiting-for-permission' | 'needs-input';
/** P4-T10c2 (PRD §7.4): content-free service metrics, numbers only. `*Ms` peaks cover the interval since the previous
 *  report; deltaResyncs counts since service start; diskFull is 0 or 1. */
export const SERVICE_METRICS = ['writerQueueAgeMs', 'parseLagMs', 'walBytes', 'watchHandles', 'statusSessions', 'deltaResyncs', 'diskFull'] as const;
export type ServiceMetrics = Record<(typeof SERVICE_METRICS)[number], number>;
export type ServiceEvent =
  | { v: 1; type: 'ready'; readOnly: ReadOnlyReason | null }
  | { v: 1; type: 'notify'; agent: string; label: string | null; state: NotifyState }
  | { v: 1; type: 'metrics'; metrics: ServiceMetrics };
export type HealthState = 'starting' | 'running' | 'restarting' | 'stopped';
/** main -> renderer; attempt counts consecutive restarts (0 unless restarting). */
export interface Health { v: 1; type: 'health'; state: HealthState; attempt: number; readOnly: ReadOnlyReason | null }

type Msg = Record<string, unknown>;
const envelope = (x: unknown): Msg | null =>
  typeof x === 'object' && x !== null && !Array.isArray(x) && (x as Msg).v === IPC_VERSION ? (x as Msg) : null;
const oneOf = <T extends string>(values: readonly T[], x: unknown): x is T => typeof x === 'string' && (values as readonly string[]).includes(x);
const READ_ONLY = ['migration-failed', 'insufficient-space', 'newer-schema'] as const;
const readOnlyOk = (x: unknown): x is ReadOnlyReason | null => x === null || oneOf(READ_ONLY, x);

export const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_TEXT = 64 * 1024; // any single transcript-derived string in a list row
const text = (x: unknown, max = MAX_TEXT): x is string => typeof x === 'string' && x.length <= max;
const textOrNull = (x: unknown): x is string | null => x === null || text(x);
const boolOrNull = (x: unknown): x is boolean | null => x === null || typeof x === 'boolean';
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
/** A plain object (not null, not an array); the one shared guard for untrusted JSON (the SEA mains keep a copy). */
export const isObj = (x: unknown): x is Msg => typeof x === 'object' && x !== null && !Array.isArray(x);
const timeOrNull = (x: unknown): x is number | null => x === null || Number.isFinite(x);

export function parseServiceCommand(x: unknown): ServiceCommand | null {
  const m = envelope(x);
  if (!m) return null;
  if (oneOf(['quit', 'wake', 'port', 'reloadPrices'] as const, m.type)) return { v: 1, type: m.type };
  if (m.type === 'suspend') return Number.isFinite(m.at) && (m.at as number) > 0 ? { v: 1, type: 'suspend', at: m.at as number } : null;
  if (m.type !== 'setPath' || !text(m.agent) || !AGENT_ID.test(m.agent)) return null;
  if (!text(m.path, 4096) || !m.path.startsWith('/') || m.path.includes('\0')) return null;
  return { v: 1, type: 'setPath', agent: m.agent, path: m.path };
}

export function parseServiceEvent(x: unknown): ServiceEvent | null {
  const m = envelope(x);
  if (m?.type === 'notify') {
    if (!text(m.agent, 64) || !m.agent || !(m.label === null || text(m.label, 128))) return null;
    return oneOf(['waiting-for-permission', 'needs-input'] as const, m.state) ? { v: 1, type: 'notify', agent: m.agent, label: m.label, state: m.state } : null;
  }
  if (m?.type === 'metrics') { // every known key, a safe non-negative integer; anything else is dropped (never content)
    const raw = m.metrics;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const metrics = {} as ServiceMetrics;
    for (const k of SERVICE_METRICS) {
      const v = (raw as Msg)[k];
      if (!Number.isSafeInteger(v) || (v as number) < 0) return null;
      metrics[k] = v as number;
    }
    return { v: 1, type: 'metrics', metrics };
  }
  return m && m.type === 'ready' && readOnlyOk(m.readOnly) ? { v: 1, type: 'ready', readOnly: m.readOnly } : null;
}

export function parseHealth(x: unknown): Health | null {
  const m = envelope(x);
  if (!m || m.type !== 'health' || !oneOf(['starting', 'running', 'restarting', 'stopped'] as const, m.state)) return null;
  if (!Number.isSafeInteger(m.attempt) || (m.attempt as number) < 0 || !readOnlyOk(m.readOnly)) return null;
  return { v: 1, type: 'health', state: m.state, attempt: m.attempt as number, readOnly: m.readOnly };
}

// Renderer <-> service over the brokered port (P1-T12). Rows are the session list columns (OQ-P1-04).
export interface Cursor { lastActivity: number | null; id: number }
export interface SessionRow {
  id: number; agent: string; entrypoint: string | null; cwd: string | null; title: string | null;
  /** XAIBO-PROD-509 (EC-66): an untitled session's first-prompt excerpt, in-app only; absent or null = none. */
  excerpt?: string | null;
  /** XAIBO-PROD-519 (P5-T12): absent from older services. */
  native?: NativeState;
  /** Catalog origin badge, null for an unknown kind; interactive null when unknown (P2-T04). */
  origin: string | null; interactive: boolean | null;
  /** "<display name> · <effort>", the raw id, or "Model unavailable" (P2-T08). */
  model: string;
  lastActivity: number | null; drift: boolean; compressed: boolean; quarantined: number;
  /** P3-T10: the status engine's view; null when it has no evidence for the session. */
  live: LiveStatus | null;
  /** Latest context generation's percentage (0–100), null when unavailable. */
  contextPct: number | null;
  /** Session ~$ estimate (Phase 2); null with coverage 'unavailable'. */
  costUsd: number | null; costCoverage: CostCoverage;
  /** P4-T04a: normalized input plus output over message-scope usage; null without usage (never 0); tokensComplete is
   *  false when a counted component is missing (a known subtotal). */
  tokens: number | null; tokensComplete: boolean;
}
export const LIFECYCLES = ['idle', 'busy', 'waiting-for-permission', 'needs-input', 'error', 'ended', 'unknown'] as const;
export const REASONS = ['Finishing…', 'Background work', 'Probably waiting'] as const;
export const OUTCOMES = ['interrupted', 'denied', 'declined', 'cancelled'] as const;
export const RULES = ['R1', 'R2', 'R3', 'R4', 'R5'] as const;
const CONFIDENCES = ['confirmed', 'inferred', 'heuristic'] as const;
const HEALTHS = ['connected', 'stale', 'detached'] as const;
const COSTS = ['full', 'partial', 'uncertain', 'unavailable'] as const;
export type CostCoverage = typeof COSTS[number];
export interface LiveStatus {
  lifecycle: typeof LIFECYCLES[number]; confidence: typeof CONFIDENCES[number]; health: typeof HEALTHS[number];
  reason: typeof REASONS[number] | null; outcome: typeof OUTCOMES[number] | null; findings: typeof RULES[number][];
  /** P4-T04a: onset of the current wait or error (ms), null otherwise or when unknown. */
  since: number | null;
}
export const GAP_REASONS = ['spool-overflow', 'spool-saturated', 'spool-torn', 'disk-full'] as const;
/** Service coverage banners (P3-T10; EC-12, EC-44, EC-49, EC-25). Agents are catalog ids; the renderer names them. */
export type Banner =
  | { kind: 'hook-gap'; reason: typeof GAP_REASONS[number]; agent: string | null; count: number | null; from: number | null; to: number | null }
  | { kind: 'disk-full' }
  | { kind: 'hooks-blocked'; agent: string; state: 'blocked' | 'unknown' }
  | { kind: 'awaiting-trust'; agent: string; steps: string[] };
export const MAX_BANNERS = 64;
const MAX_STEPS = 16;
export interface Page { rows: SessionRow[]; next: Cursor | null }
/** P4-T04b1: allowlisted credit fields (P3-T15 H2), as stored. */
export interface Credits { hasCredits: boolean | null; unlimited: boolean | null; balance: string | null }
/** P4-T04b1: one usage scope and stream with its newest stored measurement as raw fields (the renderer derives
 *  stale / reset-passed at render time), or a profile row with no values: `passive` (agy: unavailable from passive
 *  sources) or `no-observation` (no scope yet). */
export interface UsageScope {
  scope: number | null; agent: string; profile: string; verified: boolean | null; stream: string | null;
  windowMinutes: number | null; usedPercent: number | null; resetsAt: number | null; plan: string | null; credits: Credits | null;
  asOf: number | null; firstObservedAt: number | null; measuredAt: number | null; unavailable: 'passive' | 'no-observation' | null;
}
export interface HistoryCursor { measuredAt: number; id: number }
export interface UsageRecord {
  id: number; kind: 'sample' | 'transition'; measuredAt: number; usedPercent: number | null; windowMinutes: number | null; resetsAt: number | null; sourceTimeKnown: boolean;
}
export const MAX_SCOPES = 256;
export const MAX_RECORDS = 100;
const MAX_STREAM = 80; // a 64-character limit id plus ':secondary'
export interface AgentStatus { agent: string; name: string; state: 'detected' | 'not-detected'; version: string | null }
// XAIBO-PROD-410 (P4-T05b1): one session's detail, transcript page and text slices (design §5.2, §6.3).
export const COVERAGE_CODES = ['compressed', 'quarantined', 'drift', 'oversized', 'hook-gap'] as const;
export type CoverageCode = (typeof COVERAGE_CODES)[number];
export const CONTEXT_SOURCES = ['transcript', 'statusline', 'compaction', 'rollout'] as const;
export const WINDOW_BASES = ['reported', 'inferred', 'unavailable'] as const;
/** XAIBO-PROD-414 (P4-T06a): the latest reading of the session's newest context generation (context_snapshots). */
export interface ContextReading {
  generation: number; used: number | null; window: number | null; basis: (typeof WINDOW_BASES)[number];
  source: (typeof CONTEXT_SOURCES)[number]; asOf: number | null; observedAt: number;
}
/** XAIBO-PROD-519 (P5-T12; EC-23, EC-24, FR-13): the native transcript's state. available false = the native session's
 *  files are confirmed gone (Xaibo's copy stays); archived = seen under the agent's archive. */
export interface NativeState { available: boolean; archived: boolean }
export const TRANSCRIPT_ONLY = 'Transcript only, not resumable';
/** Design C15: the native-state marker, never overlay state. */
export const nativeBadge = (n: NativeState): 'native deleted' | 'native archived' | null => (!n.available ? 'native deleted' : n.archived ? 'native archived' : null);
/** nativeExpiresAt: when the agent's own cleanup is estimated to delete the native transcript (Claude; an estimate). */
export interface SessionDetail { row: SessionRow; coverage: CoverageCode[]; context: ContextReading | null; nativeExpiresAt?: number | null }

/** XAIBO-PROD-417 (P4-T07a; design §6.3.2): the session's cost breakdown. Groups are the per-request estimates of one
 *  (model, price revision, basis); a component's ~$ comes only from its applied rate over priced requests. */
export const COST_COMPONENTS = ['uncached_input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h', 'output'] as const;
export interface CostComponent {
  name: (typeof COST_COMPONENTS)[number]; tokens: number | null; missing: number;
  /** Review M1: requests with tokens of this component the engine did not price (unpriced request or this component a gap). */
  unpriced: number; rate: number | null; rateVaries: boolean; usd: number | null;
}
export interface CostGroup {
  model: string; revision: number | null; basis: 'token_table' | 'owner_fallback'; requests: number; priced: number;
  from: number | null; to: number | null; components: CostComponent[];
}
export interface PriceRevisionInfo { id: number; label: string; pricesAsOf: string | null; source: 'bundled' | 'override'; references: string[] }
export interface CostDetail {
  amountUsd: number | null; basis: 'agent_reported' | 'token_table'; coverage: CostCoverage; reportedUsd: number | null;
  requests: number; priced: number; gaps: string[]; reasons: string[]; groups: CostGroup[]; more: boolean; revisions: PriceRevisionInfo[];
}
export const MAX_COST_GROUPS = 32;
export const MAX_COST_CODES = 16;
export const MAX_REFERENCES = 8;
export const REFERENCE_MAX = 512;
/** 'large' (P4-T09a): a record above the parse cap; its length is UTF-8 bytes and its slice cursor is opaque. */
export const ITEM_KINDS = ['prompt', 'response', 'tool-call', 'tool-result', 'compaction', 'interrupted', 'large'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export interface TCursor { seq: number; id: number }
export type TranscriptAt = 'first' | 'latest' | { after: TCursor } | { before: TCursor };
export interface TranscriptItem { event: number; seq: number; ts: number | null; kind: ItemKind; preview: string | null; length: number; reasoning: boolean; callId: string | null }
export const PREVIEW_BYTES = 4096;
export const SLICE_BYTES = 16 * 1024;
export const MAX_ITEMS = 100;
const MAX_CALL_ID = 256;
// XAIBO-PROD-411 (P4-T05b2): forward keyset pages of one session's tool calls, subagents, files touched and model markers.
export const APPROVALS = ['not_requested', 'requested', 'approved', 'denied'] as const;
export const SUB_LIFECYCLES = ['running', 'ended'] as const;
export const TOUCH_KINDS = ['read', 'write_attempted', 'write_confirmed'] as const;
/** approval/durationMs/error null = unknown; argsEvent/resultEvent only when a slice can serve them. */
export interface ToolItem {
  call: number; callId: string | null; tool: string | null; sources: string[]; argsEvent: number | null; resultEvent: number | null;
  ts: number | null; durationMs: number | null; approval: (typeof APPROVALS)[number] | null; error: boolean | null;
}
export interface SubagentItem {
  id: number; nativeId: string; agentType: string | null; model: string; start: number | null; end: number | null; records: number;
  lifecycle: (typeof SUB_LIFECYCLES)[number] | null;
}
export interface FileItem { path: string; kind: (typeof TOUCH_KINDS)[number]; callId: string | null; call: number }
export interface ModelMarker { turn: number; ts: number; model: string }
export interface MCursor { ts: number; id: number }
/** A forward page by row id; cursor is the last row id of the previous page. */
type IdPage<T extends string> = { v: 1; type: T; id: number; session: number; cursor: number | null; limit: number };
export const MAX_FILE_TOUCHES = 2 * MAX_ITEMS; // a page holds up to MAX_ITEMS calls, at most two touches each
const MAX_SOURCES = 8, MAX_SOURCE = 32, MAX_LABEL = 4097; // labels are cut to DISPLAY_MAX plus "…" by the service
// XAIBO-PROD-504 (P5-T01; FR-10, US-5): the history overlay. The renderer names a session only by its row id.
export const NAME_MAX = 200;
export const HISTORY_MODES = ['all', 'archived', 'trash'] as const;
/** XAIBO-PROD-510 (P5-T01c; design §6.5.1): a map group. project null = automatic grouping (moved sessions excluded),
 *  else that Project override; at = a repository (worktree null: all its worktrees) or a cwd folder (repository grouping
 *  absent; cwd null: Cwd unavailable); at null only under a project. Keys are the stored canonical paths. */
export type MapAt = { repo: string; worktree: string | null } | { cwd: string | null };
export interface MapGroup { project: number | null; at: MapAt | null }
export const REPO_REASONS = ['no-git', 'unreadable', 'inconsistent', 'back-pointer', 'not-repository'] as const;
/** reasons: a cwd group's recorded repository-grouping reasons, null = none recorded (a pre-015 row); counts are exact
 *  service aggregates over the whole group, null when unavailable; agents are catalog ids, sorted. */
export interface MapNode {
  group: MapGroup; project: Named | null; reasons: ((typeof REPO_REASONS)[number] | null)[];
  sessions: number | null; live: number | null; agents: string[] | null;
}
export interface HistoryFilter { mode: (typeof HISTORY_MODES)[number]; agent: string | null; project: number | null; folder: number | null; group?: MapGroup }
/** History keyset: pinned first, then last activity descending (unknown last), then id. */
export interface HistoryKey { pinned: boolean; lastActivity: number | null; id: number }
export interface Named { id: number; name: string }
export interface HistoryRow extends SessionRow { project: Named | null; folder: Named | null; pinned: boolean; archivedAt: number | null;
  /** P5-T03: when the session went to Trash, and when Trash auto-empty makes it eligible for purge (30 × 24 h later). */
  trashedAt: number | null; trashPurgeAt: number | null;
  /** XAIBO-PROD-527 (P5-T18 part 1; US-6): Keep, and when retention makes the session eligible (null: Keep, Never, an
   *  unreadable setting, no time, or a Trash row, which has trashPurgeAt). */
  keep: boolean; purgeAt: number | null }
export type OverlayOp =
  | { kind: 'pin'; session: number; on: boolean } | { kind: 'archive'; session: number; on: boolean } | { kind: 'trash'; session: number; on: boolean }
  | { kind: 'keep'; session: number; on: boolean }
  | { kind: 'move'; session: number; project: number | null; folder: number | null }
  | { kind: 'newProject'; name: string } | { kind: 'newFolder'; project: number; name: string } | { kind: 'confirmLabel'; session: number };
export const OVERLAY_ERRORS = ['not-found', 'invalid', 'read-only', 'disk-full', 'store', 'limit'] as const;
/** `id`: the project or folder a create or confirmLabel produced or reused. */
export type OverlayResult = { ok: true; id?: number } | { ok: false; error: (typeof OVERLAY_ERRORS)[number] };
// XAIBO-PROD-527 (P5-T18 part 1; design §6.4, §6.6): search, purge, suppressed sessions, Re-import, retention, storage.
export const QUERY_MAX = 256, SNIPPET_MAX = 200, RETENTION_MAX = 3650;
/** XAIBO-PROD-551 (D-P5-15 item 15): search reads at most this many terms (later ones are not searched or emphasized);
 *  retention defaults to this many days; retention never purges a session in an active lifecycle (EC-22). */
export const QUERY_MAX_TERMS = 16, RETENTION_DEFAULT = 45;
export const isActive = (lifecycle: LiveStatus['lifecycle'] | null): boolean =>
  lifecycle === 'busy' || lifecycle === 'waiting-for-permission' || lifecycle === 'needs-input';
/** event: the rowid of the last match read (Gate 5 round 2 review: exact continuation inside equal-rank ties). */
export interface SearchKey { rank: number; session: number; event: number }
export interface SearchHit { row: HistoryRow; event: number; snippet: string }
export const PURGE_RESULTS = ['purged', 'pending', 'not-found', 'busy', 'read-only', 'disk-full', 'failed'] as const; // pending: Gate 5 second review M1
export const REIMPORT_RESULTS = ['ok', 'none', 'pending', 'native-gone', 'not-found', 'read-only', 'disk-full', 'failed'] as const;
export const SAVE_RESULTS = ['saved', 'invalid', 'read-only', 'disk-full', 'failed'] as const;
export type PurgeResult = (typeof PURGE_RESULTS)[number];
export type ReimportResult = (typeof REIMPORT_RESULTS)[number];
export type SaveRetentionResult = (typeof SAVE_RESULTS)[number];
/** A suppressed (purged) session: key = opaque HMAC handle; profile = its label, 'Unavailable' when the profile is gone. */
export interface SuppressedRow { key: string; agent: string; profile: string; reason: 'manual' | 'retention'; at: number; filesPending: boolean }
export interface SuppressedCursor { at: number; key: string }
export type RetentionSetting = { days: number } | 'never';
export const STORAGE_CATEGORIES = ['content', 'search', 'usage', 'prices', 'other', 'free'] as const;
export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];
export interface StorageReport {
  measuredAt: number;
  /** Bytes on disk per part; null = unavailable. */
  files: { database: number | null; wal: number | null; contentChunks: number | null; spool: number | null; backups: number | null };
  total: number | null;
  /** page_count x page_size and its DBSTAT breakdown (tables with their indexes); null = unavailable. */
  database: { bytes: number; categories: Record<StorageCategory, number> } | null;
}
/** XAIBO-PROD-523 (P5-T17a; design §6.1.1, US-20, FR-52): one month of the usage ledger. observed false = no observations
 *  under the filter (every value null), never a zero; cost usd null = nothing priced (coverage counts say why). */
export const LEDGER_MONTHS = 12;
export const LEDGER_DETAIL = ['full', 'some-expired', 'totals-only'] as const;
export interface LedgerTokens { uncachedInput: number; cacheRead: number; cacheWrite: number; output: number; total: number; gaps: number }
export interface LedgerCost { usd: number | null; full: number; partial: number; none: number; pending: number }
export interface LedgerMonth {
  month: string; monthToDate: boolean; detail: (typeof LEDGER_DETAIL)[number]; observed: boolean;
  sessions: number | null; turns: number | null; tokens: LedgerTokens | null; cost: LedgerCost | null; priceRevisions: number[];
}
/** A quota peak; scope is a response-local ordinal (never an identity), label a current scope's label or null. */
export interface LedgerQuota { month: string; scope: number; label: string | null; agent: string | null; limitId: string; windowMinutes: number | null; verified: boolean; peakPercent: number; observations: number }
/** older/newer: the `end` month of the previous/next page, null at either end. */
export interface LedgerPage { months: LedgerMonth[]; quota: LedgerQuota[]; older: string | null; newer: string | null; agents: string[]; models: string[] }
export interface LedgerFilter { agent: string | null; model: string | null }
/** P5-T16: cleared; read-only = the store refused writes; failed = the transaction did not commit (nothing changed). */
export const CLEAR_USAGE_RESULTS = ['cleared', 'read-only', 'failed'] as const;
export type ClearUsageResult = (typeof CLEAR_USAGE_RESULTS)[number];
export type PortRequest = { v: 1; type: 'listSessions'; id: number; cursor: Cursor | null; limit: number }
  /** P5-T17a: the ledger page of at most `limit` (1..12) observed months ending at `end` (null = the latest). */
  | { v: 1; type: 'monthly'; id: number; filter: LedgerFilter; end: string | null; limit: number }
  /** P5-T16: Clear usage history (Settings, after the owner's confirmation). */
  | { v: 1; type: 'clearUsage'; id: number }
  /** XAIBO-PROD-527 (P5-T18 part 1): history tools and retention/storage settings. */
  | { v: 1; type: 'search'; id: number; query: string; filter: HistoryFilter; cursor: SearchKey | null; limit: number }
  | { v: 1; type: 'purge'; id: number; session: number }
  /** XAIBO-PROD-531 (P5-T18 part 3b-2): one session's history row (row actions, the open session's Keep and purge date). */
  | { v: 1; type: 'historyRow'; id: number; session: number }
  | { v: 1; type: 'suppressed'; id: number; cursor: SuppressedCursor | null; limit: number }
  | { v: 1; type: 'reimport'; id: number; key: string }
  | { v: 1; type: 'retention'; id: number }
  | { v: 1; type: 'setRetention'; id: number; value: RetentionSetting }
  | { v: 1; type: 'storage'; id: number; refresh: boolean }
  | { v: 1; type: 'history'; id: number; filter: HistoryFilter; cursor: HistoryKey | null; limit: number }
  | { v: 1; type: 'projects'; id: number; cursor: number | null; limit: number }
  | { v: 1; type: 'folders'; id: number; project: number; cursor: number | null; limit: number }
  | { v: 1; type: 'overlay'; id: number; op: OverlayOp }
  /** P5-T01c: a page of map groups under parent (null = roots); cursor is the last group of the previous page. */
  | { v: 1; type: 'mapGroups'; id: number; parent: MapGroup | null; cursor: MapGroup | null; limit: number }
  /** P4-T02: the window is visible (live session deltas wanted) or hidden (paused; the renderer resyncs by cursor). */
  | { v: 1; type: 'live'; on: boolean }
  /** P4-T04a: the live-session set (tracked, non-ended, active within 24 h), capped; deltas keep it current. */
  | { v: 1; type: 'liveSet'; id: number }
  /** P4-T04b1: usage scopes; one scope+stream's observations with measured time in [from, to), by keyset cursor. */
  | { v: 1; type: 'usage'; id: number }
  | { v: 1; type: 'usageHistory'; id: number; scope: number; stream: string; from: number; to: number; cursor: HistoryCursor | null; limit: number }
  | { v: 1; type: 'session'; id: number; session: number }
  | { v: 1; type: 'transcript'; id: number; session: number; at: TranscriptAt; limit: number }
  /** call (XAIBO-PROD-446): a tool step's own call id; the slice is then that call's tool_use or tool_result block. */
  | { v: 1; type: 'slice'; id: number; session: number; event: number; part: 'text' | 'reasoning'; offset: number; call?: string }
  | IdPage<'tools'> | IdPage<'subagents'> | IdPage<'files'>
  | { v: 1; type: 'markers'; id: number; session: number; cursor: MCursor | null; limit: number }
  | { v: 1; type: 'cost'; id: number; session: number };
export type PortMessage =
  // P5-T17a: failed = the store could not answer (the renderer offers Retry), never an empty ledger
  | ({ v: 1; type: 'monthly'; id: number; failed?: true } & LedgerPage)
  | { v: 1; type: 'clearUsage'; id: number; result: ClearUsageResult }
  /** capped (Gate 5 round 2 B): the bounded scan stopped before the page filled; results may be incomplete, next continues. */
  | { v: 1; type: 'search'; id: number; hits: SearchHit[]; next: SearchKey | null; failed?: true; capped?: true }
  | { v: 1; type: 'purge'; id: number; result: PurgeResult }
  /** row null = no such session (gone: purged); failed (row null) = the store could not answer (keep the record, Retry). */
  | { v: 1; type: 'historyRow'; id: number; row: HistoryRow | null; failed?: true }
  | { v: 1; type: 'suppressed'; id: number; rows: SuppressedRow[]; next: SuppressedCursor | null; failed?: true }
  | { v: 1; type: 'reimport'; id: number; result: ReimportResult }
  /** setting null = the stored value is unreadable (no session retention runs on it). */
  | { v: 1; type: 'retention'; id: number; setting: RetentionSetting | null; lastRunAt: number | null }
  | { v: 1; type: 'setRetention'; id: number; result: SaveRetentionResult }
  | { v: 1; type: 'storage'; id: number; report: StorageReport | null; failed?: true }
  | { v: 1; type: 'history'; id: number; rows: HistoryRow[]; next: HistoryKey | null; failed?: true }
  | { v: 1; type: 'projects'; id: number; projects: Named[]; next: number | null; failed?: true }
  | { v: 1; type: 'folders'; id: number; folders: Named[]; next: number | null; failed?: true }
  | { v: 1; type: 'overlay'; id: number; result: OverlayResult }
  | { v: 1; type: 'mapGroups'; id: number; groups: MapNode[]; next: MapGroup | null; failed?: true }
  | { v: 1; type: 'cost'; id: number; cost: CostDetail | null }
  | { v: 1; type: 'session'; id: number; detail: SessionDetail | null }
  | { v: 1; type: 'transcript'; id: number; items: TranscriptItem[]; prev: TCursor | null; next: TCursor | null }
  | { v: 1; type: 'slice'; id: number; text: string; next: number | null }
  | { v: 1; type: 'tools'; id: number; calls: ToolItem[]; next: number | null }
  | { v: 1; type: 'subagents'; id: number; subagents: SubagentItem[]; next: number | null }
  | { v: 1; type: 'files'; id: number; touches: FileItem[]; next: number | null }
  // XAIBO-PROD-454: failed = the store could not answer (the renderer shows Retry), never an empty page
  | { v: 1; type: 'markers'; id: number; markers: ModelMarker[]; next: MCursor | null; failed?: true }
  | { v: 1; type: 'page'; id: number; rows: SessionRow[]; next: Cursor | null }
  | { v: 1; type: 'liveSet'; id: number; rows: SessionRow[]; more: boolean }
  | { v: 1; type: 'usage'; id: number; scopes: UsageScope[] }
  | { v: 1; type: 'usageHistory'; id: number; records: UsageRecord[]; next: HistoryCursor | null }
  // coalesced deltas: current rows of changed sessions; delta only with XAIBO_PERF_TRACE=1 (the renderer acks its paint)
  | { v: 1; type: 'sessions'; rows: SessionRow[]; delta?: number }
  // P4-T10c1: too many sessions changed in one window for a delta; reload the list and live set by cursor
  | { v: 1; type: 'resync' }
  | { v: 1; type: 'agents'; agents: AgentStatus[] | null } // null while detection runs
  | { v: 1; type: 'coverage'; banners: Banner[] };

function parseCursor(x: unknown): Cursor | null | undefined { // undefined = invalid
  if (x === null) return null;
  return isObj(x) && count(x.id) && timeOrNull(x.lastActivity) ? { lastActivity: x.lastActivity, id: x.id } : undefined;
}

function parseRow(x: unknown): SessionRow | null {
  if (!isObj(x)) return null;
  const r = x;
  if (!count(r.id) || !text(r.agent, 64) || !textOrNull(r.entrypoint) || !textOrNull(r.cwd) || !textOrNull(r.title)) return null;
  if (!(r.origin === null || text(r.origin, 64)) || !boolOrNull(r.interactive) || !text(r.model)) return null;
  if (!timeOrNull(r.lastActivity) || typeof r.drift !== 'boolean' || typeof r.compressed !== 'boolean' || !count(r.quarantined)) return null;
  const live = r.live === null ? null : parseLive(r.live);
  if (live === undefined || !(r.contextPct === null || (Number.isFinite(r.contextPct) && (r.contextPct as number) >= 0 && (r.contextPct as number) <= 100))) return null;
  if (!(r.costUsd === null || (Number.isFinite(r.costUsd) && (r.costUsd as number) >= 0)) || !oneOf(COSTS, r.costCoverage)) return null;
  if (!(r.tokens === null || count(r.tokens)) || typeof r.tokensComplete !== 'boolean') return null;
  if (r.excerpt !== undefined && !textOrNull(r.excerpt)) return null;
  const n = r.native;
  if (n !== undefined && !(isObj(n) && typeof n.available === 'boolean' && typeof n.archived === 'boolean')) return null;
  return { id: r.id, agent: r.agent, entrypoint: r.entrypoint, origin: r.origin, interactive: r.interactive, model: r.model, cwd: r.cwd, title: r.title,
    ...(r.excerpt !== undefined ? { excerpt: r.excerpt } : {}), ...(isObj(n) ? { native: { available: n.available as boolean, archived: n.archived as boolean } } : {}), lastActivity: r.lastActivity, drift: r.drift, compressed: r.compressed, quarantined: r.quarantined,
    live, contextPct: r.contextPct as number | null, costUsd: r.costUsd as number | null, costCoverage: r.costCoverage, tokens: r.tokens as number | null, tokensComplete: r.tokensComplete };
}

function parseLive(x: unknown): LiveStatus | undefined { // undefined = invalid
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return undefined;
  const l = x as Msg;
  if (!oneOf(LIFECYCLES, l.lifecycle) || !oneOf(CONFIDENCES, l.confidence) || !oneOf(HEALTHS, l.health)) return undefined;
  if (!(l.reason === null || oneOf(REASONS, l.reason)) || !(l.outcome === null || oneOf(OUTCOMES, l.outcome))) return undefined;
  const f = l.findings;
  if (!Array.isArray(f) || !f.every((r) => oneOf(RULES, r)) || new Set(f).size !== f.length || !timeOrNull(l.since)) return undefined;
  return { lifecycle: l.lifecycle, confidence: l.confidence, health: l.health, reason: l.reason, outcome: l.outcome, findings: [...f] as LiveStatus['findings'], since: l.since };
}

const agentOk = (x: unknown): x is string => text(x, 32) && AGENT_ID.test(x);
function parseBanner(x: unknown): Banner | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const b = x as Msg;
  switch (b.kind) {
    case 'hook-gap':
      if (!oneOf(GAP_REASONS, b.reason) || !(b.agent === null || agentOk(b.agent)) || !(b.count === null || count(b.count))) return null;
      return timeOrNull(b.from) && timeOrNull(b.to) ? { kind: 'hook-gap', reason: b.reason, agent: b.agent, count: b.count, from: b.from, to: b.to } : null;
    case 'disk-full': return { kind: 'disk-full' };
    case 'hooks-blocked': return agentOk(b.agent) && oneOf(['blocked', 'unknown'] as const, b.state) ? { kind: 'hooks-blocked', agent: b.agent, state: b.state } : null;
    case 'awaiting-trust': {
      const s = b.steps;
      if (!agentOk(b.agent) || !Array.isArray(s) || s.length > MAX_STEPS || !s.every((t) => text(t, 4096))) return null;
      return { kind: 'awaiting-trust', agent: b.agent, steps: [...s] as string[] };
    }
    default: return null;
  }
}

function parseRows(x: unknown): SessionRow[] | null {
  if (!Array.isArray(x)) return null;
  const rows = x.map(parseRow);
  return rows.every((r) => r !== null) ? (rows as SessionRow[]) : null;
}

function parseAgent(x: unknown): AgentStatus | null {
  if (!isObj(x)) return null;
  const a = x;
  if (!text(a.agent) || !AGENT_ID.test(a.agent) || !text(a.name, 128) || !oneOf(['detected', 'not-detected'] as const, a.state)) return null;
  return a.version === null || text(a.version, 64) ? { agent: a.agent, name: a.name, state: a.state, version: a.version } : null;
}

const finite = (x: unknown): x is number => Number.isFinite(x);
const numOrNull = (x: unknown, ok: (n: number) => boolean) => x === null || (finite(x) && ok(x));
const percentOk = (n: number) => n >= 0 && n <= 10_000; // the service's stored bound (spend above 100 % is kept)
/** A `{ <key>, id }` keyset cursor: null stays null, an invalid one is undefined; a fresh object, never `x` itself. */
const keyset = <K extends string>(key: K, keyOk: (v: unknown) => v is number, idOk: (v: unknown) => v is number) =>
  (x: unknown): ({ [P in K]: number } & { id: number }) | null | undefined => {
    if (x === null) return null;
    return isObj(x) && keyOk(x[key]) && idOk(x.id) ? ({ [key]: x[key], id: x.id } as { [P in K]: number } & { id: number }) : undefined;
  };
const safeInt = (x: unknown): x is number => Number.isSafeInteger(x);
const parseHistoryCursor = keyset('measuredAt', finite, count);
function parseCredits(x: unknown): Credits | null | undefined {
  if (x === null) return null;
  if (!isObj(x) || !boolOrNull(x.hasCredits) || !boolOrNull(x.unlimited) || !(x.balance === null || text(x.balance, 32))) return undefined;
  return { hasCredits: x.hasCredits, unlimited: x.unlimited, balance: x.balance };
}
function parseScope(x: unknown): UsageScope | null {
  if (!isObj(x) || !(x.scope === null || count(x.scope)) || !agentOk(x.agent) || !text(x.profile, 4097) || !boolOrNull(x.verified)) return null;
  if (!(x.stream === null || text(x.stream, MAX_STREAM)) || !(x.plan === null || text(x.plan, 32))) return null;
  if (!numOrNull(x.windowMinutes, (n) => Number.isSafeInteger(n) && n > 0) || !numOrNull(x.usedPercent, percentOk) || !timeOrNull(x.resetsAt)) return null;
  if (!timeOrNull(x.asOf) || !timeOrNull(x.firstObservedAt) || !timeOrNull(x.measuredAt)) return null;
  if (!(x.unavailable === null || oneOf(['passive', 'no-observation'] as const, x.unavailable))) return null;
  const credits = parseCredits(x.credits);
  if (credits === undefined) return null;
  return { scope: x.scope, agent: x.agent, profile: x.profile, verified: x.verified, stream: x.stream, windowMinutes: x.windowMinutes as number | null,
    usedPercent: x.usedPercent as number | null, resetsAt: x.resetsAt, plan: x.plan, credits, asOf: x.asOf, firstObservedAt: x.firstObservedAt,
    measuredAt: x.measuredAt, unavailable: x.unavailable };
}
function parseRecord(x: unknown): UsageRecord | null {
  if (!isObj(x) || !count(x.id) || !oneOf(['sample', 'transition'] as const, x.kind) || !finite(x.measuredAt) || typeof x.sourceTimeKnown !== 'boolean') return null;
  if (!numOrNull(x.usedPercent, percentOk) || !numOrNull(x.windowMinutes, (n) => Number.isSafeInteger(n) && n > 0) || !timeOrNull(x.resetsAt)) return null;
  return { id: x.id, kind: x.kind, measuredAt: x.measuredAt, usedPercent: x.usedPercent as number | null, windowMinutes: x.windowMinutes as number | null,
    resetsAt: x.resetsAt, sourceTimeKnown: x.sourceTimeKnown };
}
const all = <T>(xs: unknown, max: number, parse: (x: unknown) => T | null): T[] | null => {
  if (!Array.isArray(xs) || xs.length > max) return null;
  const out = xs.map(parse);
  return out.every((v) => v !== null) ? (out as T[]) : null;
};

const positive = (x: unknown): x is number => count(x) && x > 0;
const limitOk = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 1;
const parseTCursor = keyset('seq', safeInt, positive);
function parseAt(x: unknown): TranscriptAt | null {
  if (x === 'first' || x === 'latest') return x;
  if (!isObj(x) || Object.keys(x).length !== 1) return null;
  const after = Object.hasOwn(x, 'after');
  const c = parseTCursor(after ? x.after : x.before);
  if (!c) return null;
  return after ? { after: c } : Object.hasOwn(x, 'before') ? { before: c } : null;
}
function parseItem(x: unknown): TranscriptItem | null {
  if (!isObj(x) || !positive(x.event) || !Number.isSafeInteger(x.seq) || !timeOrNull(x.ts) || !oneOf(ITEM_KINDS, x.kind)) return null;
  if (!(x.preview === null || text(x.preview, PREVIEW_BYTES)) || !count(x.length) || typeof x.reasoning !== 'boolean') return null;
  if (!callIdOk(x.callId)) return null;
  return { event: x.event, seq: x.seq as number, ts: x.ts, kind: x.kind, preview: x.preview, length: x.length, reasoning: x.reasoning, callId: x.callId };
}
function parseDetail(x: unknown): SessionDetail | null | undefined { // undefined = invalid
  if (x === null) return null;
  if (!isObj(x)) return undefined;
  const row = parseRow(x.row);
  const coverage = all(x.coverage, COVERAGE_CODES.length, (c) => (oneOf(COVERAGE_CODES, c) ? c : null));
  const context = x.context === null ? null : parseContext(x.context);
  const expires = x.nativeExpiresAt;
  // review L3: a time the renderer's Date can show (0 .. 8.64e15 ms)
  if (expires !== undefined && !(expires === null || (typeof expires === 'number' && expires >= 0 && expires <= 8.64e15))) return undefined;
  return row && coverage && context !== undefined ? { row, coverage, context, ...(expires !== undefined ? { nativeExpiresAt: expires } : {}) } : undefined;
}
const CONTEXT_KEYS = ['generation', 'used', 'window', 'basis', 'source', 'asOf', 'observedAt'];
export function parseContext(x: unknown): ContextReading | undefined {
  if (!exactKeys(x, CONTEXT_KEYS)) return undefined;
  if (!count(x.generation) || !(x.used === null || count(x.used)) || !(x.window === null || count(x.window))) return undefined;
  if (!oneOf(WINDOW_BASES, x.basis) || !oneOf(CONTEXT_SOURCES, x.source) || !timeOrNull(x.asOf) || !Number.isFinite(x.observedAt)) return undefined;
  if ((x.window === null) !== (x.basis === 'unavailable')) return undefined; // review M1: no meter for a window called unavailable
  return { generation: x.generation, used: x.used, window: x.window, basis: x.basis, source: x.source, asOf: x.asOf, observedAt: x.observedAt as number };
}

// XAIBO-PROD-417: cost breakdown reply; exact key sets at every level, fixed names, finite non-negative numbers.
const exactKeys = (x: unknown, keys: string[]): x is Msg => isObj(x) && Object.keys(x).length === keys.length && keys.every((k) => Object.hasOwn(x, k));
const usd = (x: unknown): x is number | null => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0);
export const COST_CODE = /^[a-z0-9_-]{1,48}$/;
const code = (x: unknown) => (typeof x === 'string' && COST_CODE.test(x) ? x : null);
function parseComponent(x: unknown): CostComponent | null {
  if (!exactKeys(x, ['name', 'tokens', 'missing', 'unpriced', 'rate', 'rateVaries', 'usd']) || !oneOf(COST_COMPONENTS, x.name)) return null;
  if (!(x.tokens === null || count(x.tokens)) || !count(x.missing) || !count(x.unpriced) || !usd(x.rate) || typeof x.rateVaries !== 'boolean' || !usd(x.usd)) return null;
  return { name: x.name, tokens: x.tokens, missing: x.missing, unpriced: x.unpriced, rate: x.rate, rateVaries: x.rateVaries, usd: x.usd };
}
function parseGroup(x: unknown): CostGroup | null {
  if (!exactKeys(x, ['model', 'revision', 'basis', 'requests', 'priced', 'from', 'to', 'components'])) return null;
  if (!text(x.model, MAX_TEXT) || !(x.revision === null || positive(x.revision)) || !(x.basis === 'token_table' || x.basis === 'owner_fallback')) return null;
  const components = all(x.components, COST_COMPONENTS.length, parseComponent);
  if (!components || !count(x.requests) || !count(x.priced) || x.priced > x.requests || !timeOrNull(x.from) || !timeOrNull(x.to)) return null;
  if (new Set(components.map((c) => c.name)).size !== components.length) return null; // review L7
  return { model: x.model, revision: x.revision, basis: x.basis, requests: x.requests, priced: x.priced, from: x.from, to: x.to, components };
}
function parseRevision(x: unknown): PriceRevisionInfo | null {
  if (!exactKeys(x, ['id', 'label', 'pricesAsOf', 'source', 'references']) || !positive(x.id) || !text(x.label, REFERENCE_MAX)) return null;
  if (!(x.pricesAsOf === null || text(x.pricesAsOf, 64)) || !(x.source === 'bundled' || x.source === 'override')) return null;
  const references = all(x.references, MAX_REFERENCES, (r) => (text(r, REFERENCE_MAX) ? r : null));
  return references ? { id: x.id, label: x.label, pricesAsOf: x.pricesAsOf, source: x.source, references } : null;
}
export function parseCost(x: unknown): CostDetail | undefined {
  if (!exactKeys(x, ['amountUsd', 'basis', 'coverage', 'reportedUsd', 'requests', 'priced', 'gaps', 'reasons', 'groups', 'more', 'revisions'])) return undefined;
  if (!usd(x.amountUsd) || !(x.basis === 'agent_reported' || x.basis === 'token_table') || !oneOf(COSTS, x.coverage) || !usd(x.reportedUsd)) return undefined;
  if (!count(x.requests) || !count(x.priced) || x.priced > x.requests || typeof x.more !== 'boolean') return undefined;
  const gaps = all(x.gaps, MAX_COST_CODES, code), reasons = all(x.reasons, MAX_COST_CODES, code);
  const groups = all(x.groups, MAX_COST_GROUPS, parseGroup), revisions = all(x.revisions, MAX_COST_GROUPS, parseRevision);
  if (!gaps || !reasons || !groups || !revisions) return undefined;
  return { amountUsd: x.amountUsd, basis: x.basis, coverage: x.coverage, reportedUsd: x.reportedUsd, requests: x.requests, priced: x.priced,
    gaps, reasons, groups, more: x.more, revisions };
}

const idOrNull = (x: unknown): x is number | null => x === null || positive(x);
const label = (x: unknown): x is string => text(x, MAX_LABEL) && x !== '';
const labelOrNull = (x: unknown): x is string | null => x === null || label(x);
const callIdOk = (x: unknown): x is string | null => x === null || (text(x, MAX_CALL_ID) && x !== '');
const parseMCursor = keyset('ts', safeInt, positive);
function parseTool(x: unknown): ToolItem | null {
  if (!isObj(x) || !positive(x.call) || !callIdOk(x.callId) || !labelOrNull(x.tool) || !idOrNull(x.argsEvent) || !idOrNull(x.resultEvent)) return null;
  const s = x.sources;
  if (!Array.isArray(s) || s.length > MAX_SOURCES || !s.every((v) => text(v, MAX_SOURCE) && v !== '')) return null;
  if (!timeOrNull(x.ts) || !(x.durationMs === null || count(x.durationMs)) || !(x.approval === null || oneOf(APPROVALS, x.approval)) || !boolOrNull(x.error)) return null;
  return { call: x.call, callId: x.callId, tool: x.tool, sources: [...s] as string[], argsEvent: x.argsEvent, resultEvent: x.resultEvent, ts: x.ts,
    durationMs: x.durationMs as number | null, approval: x.approval, error: x.error };
}
function parseSubagent(x: unknown): SubagentItem | null {
  if (!isObj(x) || !positive(x.id) || !label(x.nativeId) || !labelOrNull(x.agentType) || !label(x.model) || !timeOrNull(x.start) || !timeOrNull(x.end)) return null;
  if (!count(x.records) || !(x.lifecycle === null || oneOf(SUB_LIFECYCLES, x.lifecycle))) return null;
  return { id: x.id, nativeId: x.nativeId, agentType: x.agentType, model: x.model, start: x.start, end: x.end, records: x.records, lifecycle: x.lifecycle };
}
function parseTouch(x: unknown): FileItem | null {
  if (!isObj(x) || !text(x.path, 4096) || x.path === '' || !oneOf(TOUCH_KINDS, x.kind) || !callIdOk(x.callId) || !positive(x.call)) return null;
  return { path: x.path, kind: x.kind, callId: x.callId, call: x.call };
}
function parseMarker(x: unknown): ModelMarker | null {
  return isObj(x) && positive(x.turn) && Number.isSafeInteger(x.ts) && label(x.model) ? { turn: x.turn, ts: x.ts as number, model: x.model } : null;
}

const pageLimit = (x: unknown): x is number => limitOk(x) && x <= MAX_ITEMS;
function parseHistoryKey(x: unknown): HistoryKey | null | undefined { // undefined = invalid
  if (x === null) return null;
  return exactKeys(x, ['pinned', 'lastActivity', 'id']) && typeof x.pinned === 'boolean' && timeOrNull(x.lastActivity) && positive(x.id)
    ? { pinned: x.pinned, lastActivity: x.lastActivity, id: x.id } : undefined;
}
function parseFilter(x: unknown): HistoryFilter | null {
  const grouped = isObj(x) && Object.hasOwn(x, 'group');
  if (!exactKeys(x, ['mode', 'agent', 'project', 'folder', ...(grouped ? ['group'] : [])]) || !oneOf(HISTORY_MODES, x.mode)) return null;
  const group = grouped ? parseMapGroup(x.group) : undefined;
  if (group === null || !((x.agent === null || agentOk(x.agent)) && idOrNull(x.project) && idOrNull(x.folder))) return null;
  return { mode: x.mode, agent: x.agent, project: x.project, folder: x.folder, ...(group ? { group } : {}) };
}
const keyText = (x: unknown): x is string => text(x) && x !== '';
/** Exact shapes only; a group with neither project nor place names nothing and is refused. */
function parseMapGroup(x: unknown): MapGroup | null {
  if (!exactKeys(x, ['project', 'at']) || !idOrNull(x.project)) return null;
  const a = x.at;
  let at: MapAt | null;
  if (a === null) at = null;
  else if (exactKeys(a, ['repo', 'worktree']) && keyText(a.repo) && (a.worktree === null || keyText(a.worktree))) at = { repo: a.repo, worktree: a.worktree };
  else if (exactKeys(a, ['cwd']) && (a.cwd === null || keyText(a.cwd))) at = { cwd: a.cwd };
  else return null;
  return x.project === null && at === null ? null : { project: x.project, at };
}
const groupOrNull = (x: unknown): MapGroup | null | undefined => (x === null ? null : parseMapGroup(x) ?? undefined); // undefined = invalid
function parseMapNode(x: unknown): MapNode | null {
  if (!exactKeys(x, ['group', 'project', 'reasons', 'sessions', 'live', 'agents'])) return null;
  const group = parseMapGroup(x.group), project = x.project === null ? null : parseNamed(x.project);
  const reasons = all(x.reasons, REPO_REASONS.length + 1, (r) => (r === null ? { r } : oneOf(REPO_REASONS, r) ? { r } : null));
  const agents = x.agents === null ? null : all(x.agents, 32, (a) => (agentOk(a) ? a : null));
  if (!group || (x.project !== null && !project) || !reasons || (x.agents !== null && !agents)) return null;
  if (!(x.sessions === null || count(x.sessions)) || !(x.live === null || count(x.live))) return null;
  return { group, project, reasons: reasons.map((v) => v.r), sessions: x.sessions, live: x.live, agents };
}
const nameOk = (x: unknown): x is string => text(x, NAME_MAX);
/** Exact shapes only: an extra key (e.g. a smuggled agent or native id) voids the op. */
function parseOp(x: unknown): OverlayOp | null {
  if (!isObj(x)) return null;
  const keys = (...k: string[]) => exactKeys(x, ['kind', ...k]);
  switch (x.kind) {
    case 'pin': case 'archive': case 'trash': case 'keep': return keys('session', 'on') && positive(x.session) && typeof x.on === 'boolean' ? { kind: x.kind, session: x.session, on: x.on } : null;
    case 'move': return keys('session', 'project', 'folder') && positive(x.session) && idOrNull(x.project) && idOrNull(x.folder)
      ? { kind: 'move', session: x.session, project: x.project, folder: x.folder } : null;
    case 'newProject': return keys('name') && nameOk(x.name) ? { kind: 'newProject', name: x.name } : null;
    case 'newFolder': return keys('project', 'name') && positive(x.project) && nameOk(x.name) ? { kind: 'newFolder', project: x.project, name: x.name } : null;
    case 'confirmLabel': return keys('session') && positive(x.session) ? { kind: 'confirmLabel', session: x.session } : null;
    default: return null;
  }
}
const parseNamed = (x: unknown): Named | null => (isObj(x) && positive(x.id) && nameOk(x.name) && x.name !== '' ? { id: x.id, name: x.name } : null);
function parseHistoryRow(x: unknown): HistoryRow | null {
  const row = parseRow(x);
  if (!row || !isObj(x) || typeof x.pinned !== 'boolean' || !timeOrNull(x.archivedAt) || !timeOrNull(x.trashedAt) || !timeOrNull(x.trashPurgeAt)) return null;
  if (typeof x.keep !== 'boolean' || !timeOrNull(x.purgeAt)) return null;
  const project = x.project === null ? null : parseNamed(x.project), folder = x.folder === null ? null : parseNamed(x.folder);
  return (x.project === null || project) && (x.folder === null || folder)
    ? { ...row, project, folder, pinned: x.pinned, archivedAt: x.archivedAt, trashedAt: x.trashedAt, trashPurgeAt: x.trashPurgeAt, keep: x.keep, purgeAt: x.purgeAt } : null;
}
// XAIBO-PROD-527: strict shapes for the history tools (design review L1: finite numbers, safe-integer ids, hex keys)
const KEY = /^[0-9a-f]{64}$/;
const keyOk = (x: unknown): x is string => typeof x === 'string' && KEY.test(x);
const parseSearchKey = (x: unknown): SearchKey | null | undefined => (x === null ? null
  : exactKeys(x, ['rank', 'session', 'event']) && finite(x.rank) && count(x.session) && positive(x.event) ? { rank: x.rank, session: x.session, event: x.event } : undefined);
const parseSuppressedCursor = (x: unknown): SuppressedCursor | null | undefined => (x === null ? null
  : exactKeys(x, ['at', 'key']) && finite(x.at) && keyOk(x.key) ? { at: x.at, key: x.key } : undefined);
export function parseRetentionSetting(x: unknown): RetentionSetting | null {
  if (x === 'never') return 'never';
  return exactKeys(x, ['days']) && Number.isInteger(x.days) && (x.days as number) >= 1 && (x.days as number) <= RETENTION_MAX ? { days: x.days as number } : null;
}
function parseSearchHit(x: unknown): SearchHit | null {
  // review H1: the service caps a snippet in code points (an emoji is two UTF-16 units)
  if (!exactKeys(x, ['row', 'event', 'snippet']) || !positive(x.event) || !text(x.snippet, 2 * SNIPPET_MAX) || [...x.snippet].length > SNIPPET_MAX) return null;
  const row = parseHistoryRow(x.row);
  return row ? { row, event: x.event, snippet: x.snippet } : null;
}
const parseSuppressedRow = (x: unknown): SuppressedRow | null => (exactKeys(x, ['key', 'agent', 'profile', 'reason', 'at', 'filesPending']) && keyOk(x.key)
  && agentOk(x.agent) && text(x.profile, MAX_LABEL) && oneOf(['manual', 'retention'] as const, x.reason) && finite(x.at) && typeof x.filesPending === 'boolean'
  ? { key: x.key, agent: x.agent, profile: x.profile, reason: x.reason, at: x.at, filesPending: x.filesPending } : null);
const bytesOrNull = (x: unknown): x is number | null => x === null || count(x);
function parseStorage(x: unknown): StorageReport | null | undefined {
  if (x === null) return null;
  if (!exactKeys(x, ['measuredAt', 'files', 'total', 'database']) || !finite(x.measuredAt) || !bytesOrNull(x.total)) return undefined;
  const f = x.files;
  if (!exactKeys(f, ['database', 'wal', 'contentChunks', 'spool', 'backups']) || !Object.values(f).every(bytesOrNull)) return undefined;
  const d = x.database;
  if (d !== null && !(exactKeys(d, ['bytes', 'categories']) && count(d.bytes) && exactKeys(d.categories, [...STORAGE_CATEGORIES])
    && Object.values(d.categories).every(count))) return undefined;
  return x as unknown as StorageReport;
}
// P5-T17a: the ledger. A month is YYYY-MM; observed false carries nulls only; observed true carries counts, and tokens and
// cost unless no usage request was seen (review L7: no evidence is unavailable, not 0); total = the sum. The service
// applies the same bounds before it replies (review M2), so agent-supplied values never make the whole reply unreadable.
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthOk = (x: unknown): x is string => typeof x === 'string' && MONTH.test(x);
const monthOrNull = (x: unknown): x is string | null => x === null || monthOk(x);
export const MAX_MODEL = 256, MAX_LEDGER_AGENTS = 64, MAX_LEDGER_MODELS = 256, MAX_REVISIONS = 64, MAX_LEDGER_QUOTA = LEDGER_MONTHS * MAX_SCOPES;
const modelOk = (x: unknown): x is string => text(x, MAX_MODEL);
function parseLedgerFilter(x: unknown): LedgerFilter | null {
  return exactKeys(x, ['agent', 'model']) && (x.agent === null || agentOk(x.agent)) && (x.model === null || modelOk(x.model)) ? { agent: x.agent, model: x.model } : null;
}
function parseLedgerMonth(x: unknown): LedgerMonth | null {
  if (!exactKeys(x, ['month', 'monthToDate', 'detail', 'observed', 'sessions', 'turns', 'tokens', 'cost', 'priceRevisions'])) return null;
  if (!monthOk(x.month) || typeof x.monthToDate !== 'boolean' || !oneOf(LEDGER_DETAIL, x.detail) || typeof x.observed !== 'boolean') return null;
  const revisions = all(x.priceRevisions, MAX_REVISIONS, (r) => (positive(r) ? r : null));
  if (!revisions) return null;
  const base = { month: x.month, monthToDate: x.monthToDate, detail: x.detail };
  if (!x.observed) return x.sessions === null && x.turns === null && x.tokens === null && x.cost === null && !revisions.length
    ? { ...base, observed: false, sessions: null, turns: null, tokens: null, cost: null, priceRevisions: [] } : null;
  const t = x.tokens, c = x.cost;
  if (!count(x.sessions) || !count(x.turns)) return null;
  let tokens: LedgerTokens | null = null, cost: LedgerCost | null = null;
  if (t !== null) {
    if (!exactKeys(t, ['uncachedInput', 'cacheRead', 'cacheWrite', 'output', 'total', 'gaps']) || ![t.uncachedInput, t.cacheRead, t.cacheWrite, t.output, t.total, t.gaps].every(count)) return null;
    tokens = { uncachedInput: t.uncachedInput as number, cacheRead: t.cacheRead as number, cacheWrite: t.cacheWrite as number, output: t.output as number, total: t.total as number, gaps: t.gaps as number };
    if (tokens.total !== tokens.uncachedInput + tokens.cacheRead + tokens.cacheWrite + tokens.output) return null;
  }
  if (c !== null) {
    if (!exactKeys(c, ['usd', 'full', 'partial', 'none', 'pending']) || !usd(c.usd) || ![c.full, c.partial, c.none, c.pending].every(count)) return null;
    cost = { usd: c.usd, full: c.full as number, partial: c.partial as number, none: c.none as number, pending: c.pending as number };
  }
  return { ...base, observed: true, sessions: x.sessions, turns: x.turns, tokens, cost, priceRevisions: revisions };
}
function parseLedgerQuota(x: unknown): LedgerQuota | null {
  if (!exactKeys(x, ['month', 'scope', 'label', 'agent', 'limitId', 'windowMinutes', 'verified', 'peakPercent', 'observations'])) return null;
  return monthOk(x.month) && positive(x.scope) && (x.label === null || label(x.label)) && (x.agent === null || agentOk(x.agent)) && text(x.limitId, MAX_STREAM) && x.limitId !== ''
    && (x.windowMinutes === null || count(x.windowMinutes)) && typeof x.verified === 'boolean' && finite(x.peakPercent) && percentOk(x.peakPercent) && count(x.observations)
    ? { month: x.month, scope: x.scope, label: x.label, agent: x.agent, limitId: x.limitId, windowMinutes: x.windowMinutes, verified: x.verified, peakPercent: x.peakPercent, observations: x.observations }
    : null;
}

function parseResult(x: unknown): OverlayResult | null {
  if (!isObj(x)) return null;
  if (x.ok === true) return x.id === undefined ? { ok: true } : positive(x.id) ? { ok: true, id: x.id } : null;
  return x.ok === false && oneOf(OVERLAY_ERRORS, x.error) ? { ok: false, error: x.error } : null;
}

export function parsePortRequest(x: unknown): PortRequest | null {
  const m = envelope(x);
  if (m?.type === 'history') {
    const filter = parseFilter(m.filter), cursor = parseHistoryKey(m.cursor);
    return count(m.id) && filter && cursor !== undefined && pageLimit(m.limit) ? { v: 1, type: 'history', id: m.id, filter, cursor, limit: m.limit } : null;
  }
  if (m?.type === 'projects') return count(m.id) && idOrNull(m.cursor) && pageLimit(m.limit) ? { v: 1, type: 'projects', id: m.id, cursor: m.cursor, limit: m.limit } : null;
  if (m?.type === 'folders') {
    return count(m.id) && positive(m.project) && idOrNull(m.cursor) && pageLimit(m.limit) ? { v: 1, type: 'folders', id: m.id, project: m.project, cursor: m.cursor, limit: m.limit } : null;
  }
  if (m?.type === 'mapGroups') {
    const parent = groupOrNull(m.parent), cursor = groupOrNull(m.cursor);
    return count(m.id) && parent !== undefined && cursor !== undefined && pageLimit(m.limit) ? { v: 1, type: 'mapGroups', id: m.id, parent, cursor, limit: m.limit } : null;
  }
  if (m?.type === 'overlay') {
    const op = parseOp(m.op);
    return count(m.id) && op ? { v: 1, type: 'overlay', id: m.id, op } : null;
  }
  if (m?.type === 'tools' || m?.type === 'subagents' || m?.type === 'files') {
    if (!count(m.id) || !positive(m.session) || !idOrNull(m.cursor) || !limitOk(m.limit)) return null;
    return { v: 1, type: m.type, id: m.id, session: m.session, cursor: m.cursor, limit: m.limit } as IdPage<typeof m.type> as PortRequest;
  }
  if (m?.type === 'markers') {
    const cursor = parseMCursor(m.cursor);
    return count(m.id) && positive(m.session) && cursor !== undefined && limitOk(m.limit) ? { v: 1, type: 'markers', id: m.id, session: m.session, cursor, limit: m.limit } : null;
  }
  if (m?.type === 'session') return count(m.id) && positive(m.session) ? { v: 1, type: 'session', id: m.id, session: m.session } : null;
  if (m?.type === 'cost') return count(m.id) && positive(m.session) ? { v: 1, type: 'cost', id: m.id, session: m.session } : null;
  if (m?.type === 'transcript') {
    const at = parseAt(m.at);
    return count(m.id) && positive(m.session) && at && limitOk(m.limit) ? { v: 1, type: 'transcript', id: m.id, session: m.session, at, limit: m.limit } : null;
  }
  if (m?.type === 'slice') {
    if (!count(m.id) || !positive(m.session) || !positive(m.event) || !oneOf(['text', 'reasoning'] as const, m.part) || !count(m.offset)) return null;
    if (m.call !== undefined && !(text(m.call, MAX_CALL_ID) && m.call !== '')) return null;
    return { v: 1, type: 'slice', id: m.id, session: m.session, event: m.event, part: m.part, offset: m.offset, ...(m.call !== undefined ? { call: m.call } : {}) };
  }
  if (m?.type === 'live') return typeof m.on === 'boolean' ? { v: 1, type: 'live', on: m.on } : null;
  if (m?.type === 'liveSet') return count(m.id) ? { v: 1, type: 'liveSet', id: m.id } : null;
  if (m?.type === 'usage') return count(m.id) ? { v: 1, type: 'usage', id: m.id } : null;
  if (m?.type === 'usageHistory') {
    const cursor = parseHistoryCursor(m.cursor);
    if (!count(m.id) || !count(m.scope) || !text(m.stream, MAX_STREAM) || !m.stream || !finite(m.from) || !finite(m.to) || m.from > m.to) return null;
    if (cursor === undefined || !limitOk(m.limit)) return null;
    return { v: 1, type: 'usageHistory', id: m.id, scope: m.scope, stream: m.stream, from: m.from, to: m.to, cursor, limit: m.limit };
  }
  if (m?.type === 'clearUsage') return count(m.id) ? { v: 1, type: 'clearUsage', id: m.id } : null;
  if (m?.type === 'search') { // the query length first (design review L1)
    if (!count(m.id) || typeof m.query !== 'string' || m.query.length < 1 || m.query.length > QUERY_MAX) return null;
    const filter = parseFilter(m.filter), cursor = parseSearchKey(m.cursor);
    return filter && cursor !== undefined && pageLimit(m.limit) ? { v: 1, type: 'search', id: m.id, query: m.query, filter, cursor, limit: m.limit } : null;
  }
  if (m?.type === 'purge') return count(m.id) && positive(m.session) ? { v: 1, type: 'purge', id: m.id, session: m.session } : null;
  if (m?.type === 'historyRow') { // design review L4: exact keys
    return exactKeys(m, ['v', 'type', 'id', 'session']) && count(m.id) && positive(m.session) ? { v: 1, type: 'historyRow', id: m.id, session: m.session } : null;
  }
  if (m?.type === 'suppressed') {
    const cursor = parseSuppressedCursor(m.cursor);
    return count(m.id) && cursor !== undefined && pageLimit(m.limit) ? { v: 1, type: 'suppressed', id: m.id, cursor, limit: m.limit } : null;
  }
  if (m?.type === 'reimport') return count(m.id) && keyOk(m.key) ? { v: 1, type: 'reimport', id: m.id, key: m.key } : null;
  if (m?.type === 'retention') return count(m.id) ? { v: 1, type: 'retention', id: m.id } : null;
  if (m?.type === 'setRetention') {
    const value = parseRetentionSetting(m.value);
    return count(m.id) && value ? { v: 1, type: 'setRetention', id: m.id, value } : null;
  }
  if (m?.type === 'storage') return count(m.id) && typeof m.refresh === 'boolean' ? { v: 1, type: 'storage', id: m.id, refresh: m.refresh } : null;
  if (m?.type === 'monthly') {
    const filter = parseLedgerFilter(m.filter);
    return count(m.id) && filter && monthOrNull(m.end) && Number.isSafeInteger(m.limit) && (m.limit as number) >= 1 && (m.limit as number) <= LEDGER_MONTHS
      ? { v: 1, type: 'monthly', id: m.id, filter, end: m.end, limit: m.limit as number } : null;
  }
  if (!m || m.type !== 'listSessions' || !count(m.id) || !limitOk(m.limit)) return null;
  const cursor = parseCursor(m.cursor);
  return cursor === undefined ? null : { v: 1, type: 'listSessions', id: m.id, cursor, limit: m.limit };
}

export function parsePortMessage(x: unknown): PortMessage | null {
  const m = envelope(x);
  if (!m) return null;
  // review L1: failed only where it is defined; a failed page carries nothing
  const failedOf = (empty: boolean) => (m.failed === undefined ? {} : m.failed === true && empty ? { failed: true as const } : null);
  if (m.type === 'history') { // Gate 5 G5b2-5: failed = the store could not answer (the renderer keeps its rows, Retry)
    const rows = all(m.rows, MAX_ITEMS, parseHistoryRow), next = parseHistoryKey(m.next), failed = failedOf(rows !== null && rows.length === 0 && next === null);
    return count(m.id) && rows && next !== undefined && failed ? { v: 1, type: 'history', id: m.id, rows, next, ...failed } : null;
  }
  if (m.type === 'projects' || m.type === 'folders') {
    const list = all(m[m.type], MAX_ITEMS, parseNamed);
    if (!count(m.id) || !list || !idOrNull(m.next)) return null;
    const failed = failedOf(list.length === 0 && m.next === null);
    if (!failed) return null;
    return m.type === 'projects' ? { v: 1, type: 'projects', id: m.id, projects: list, next: m.next, ...failed } : { v: 1, type: 'folders', id: m.id, folders: list, next: m.next, ...failed };
  }
  if (m.type === 'mapGroups') {
    const groups = all(m.groups, MAX_ITEMS, parseMapNode), next = groupOrNull(m.next);
    if (m.failed !== undefined && m.failed !== true) return null;
    return count(m.id) && groups && next !== undefined ? { v: 1, type: 'mapGroups', id: m.id, groups, next, ...(m.failed ? { failed: true as const } : {}) } : null;
  }
  if (m.type === 'overlay') {
    const result = parseResult(m.result);
    return count(m.id) && result ? { v: 1, type: 'overlay', id: m.id, result } : null;
  }
  if (m.type === 'session') {
    const detail = parseDetail(m.detail);
    return count(m.id) && detail !== undefined ? { v: 1, type: 'session', id: m.id, detail } : null;
  }
  if (m.type === 'cost') {
    const cost = m.cost === null ? null : parseCost(m.cost);
    return count(m.id) && cost !== undefined ? { v: 1, type: 'cost', id: m.id, cost } : null;
  }
  if (m.type === 'transcript') {
    const items = all(m.items, MAX_ITEMS, parseItem);
    const prev = parseTCursor(m.prev), next = parseTCursor(m.next);
    return count(m.id) && items && prev !== undefined && next !== undefined ? { v: 1, type: 'transcript', id: m.id, items, prev, next } : null;
  }
  if (m.type === 'slice') {
    return count(m.id) && text(m.text, SLICE_BYTES) && (m.next === null || count(m.next)) ? { v: 1, type: 'slice', id: m.id, text: m.text, next: m.next as number | null } : null;
  }
  if (m.type === 'tools') {
    const calls = all(m.calls, MAX_ITEMS, parseTool);
    return count(m.id) && calls && idOrNull(m.next) ? { v: 1, type: 'tools', id: m.id, calls, next: m.next } : null;
  }
  if (m.type === 'subagents') {
    const subagents = all(m.subagents, MAX_ITEMS, parseSubagent);
    return count(m.id) && subagents && idOrNull(m.next) ? { v: 1, type: 'subagents', id: m.id, subagents, next: m.next } : null;
  }
  if (m.type === 'files') {
    const touches = all(m.touches, MAX_FILE_TOUCHES, parseTouch);
    return count(m.id) && touches && idOrNull(m.next) ? { v: 1, type: 'files', id: m.id, touches, next: m.next } : null;
  }
  if (m.type === 'markers') {
    const markers = all(m.markers, MAX_ITEMS, parseMarker);
    const next = parseMCursor(m.next);
    if (m.failed !== undefined && m.failed !== true) return null;
    return count(m.id) && markers && next !== undefined ? { v: 1, type: 'markers', id: m.id, markers, next, ...(m.failed ? { failed: true as const } : {}) } : null;
  }
  if (m.type === 'page') {
    const rows = parseRows(m.rows);
    const next = parseCursor(m.next);
    return count(m.id) && rows && next !== undefined ? { v: 1, type: 'page', id: m.id, rows, next } : null;
  }
  if (m.type === 'clearUsage') return count(m.id) && oneOf(CLEAR_USAGE_RESULTS, m.result) ? { v: 1, type: 'clearUsage', id: m.id, result: m.result } : null;
  if (m.type === 'search') {
    const hits = all(m.hits, MAX_ITEMS, parseSearchHit), next = parseSearchKey(m.next), failed = failedOf(hits !== null && hits.length === 0 && next === null);
    const capped = m.capped === undefined ? {} : m.capped === true ? { capped: true as const } : null;
    return count(m.id) && hits && next !== undefined && failed && capped ? { v: 1, type: 'search', id: m.id, hits, next, ...failed, ...capped } : null;
  }
  if (m.type === 'suppressed') {
    const rows = all(m.rows, MAX_ITEMS, parseSuppressedRow), next = parseSuppressedCursor(m.next), failed = failedOf(rows !== null && rows.length === 0 && next === null);
    return count(m.id) && rows && next !== undefined && failed ? { v: 1, type: 'suppressed', id: m.id, rows, next, ...failed } : null;
  }
  if (m.type === 'purge') return count(m.id) && m.failed === undefined && oneOf(PURGE_RESULTS, m.result) ? { v: 1, type: 'purge', id: m.id, result: m.result } : null;
  if (m.type === 'historyRow') { // design review L1: failed only with no row; a malformed row rejects, never reads as gone
    const row = m.row === null ? null : parseHistoryRow(m.row), failed = failedOf(m.row === null);
    const keys = ['v', 'type', 'id', 'row', ...(m.failed === undefined ? [] : ['failed'])];
    return exactKeys(m, keys) && count(m.id) && (m.row === null || row) && failed ? { v: 1, type: 'historyRow', id: m.id, row, ...failed } : null;
  }
  if (m.type === 'reimport') return count(m.id) && m.failed === undefined && oneOf(REIMPORT_RESULTS, m.result) ? { v: 1, type: 'reimport', id: m.id, result: m.result } : null;
  if (m.type === 'setRetention') return count(m.id) && m.failed === undefined && oneOf(SAVE_RESULTS, m.result) ? { v: 1, type: 'setRetention', id: m.id, result: m.result } : null;
  if (m.type === 'retention') {
    const setting = m.setting === null ? null : parseRetentionSetting(m.setting);
    return count(m.id) && m.failed === undefined && (m.setting === null || setting) && timeOrNull(m.lastRunAt) ? { v: 1, type: 'retention', id: m.id, setting, lastRunAt: m.lastRunAt } : null;
  }
  if (m.type === 'storage') {
    const report = parseStorage(m.report), failed = failedOf(true); // a failed refresh still carries the last report
    return count(m.id) && report !== undefined && failed ? { v: 1, type: 'storage', id: m.id, report, ...failed } : null;
  }
  if (m.type === 'monthly') {
    const months = all(m.months, LEDGER_MONTHS, parseLedgerMonth), quota = all(m.quota, MAX_LEDGER_QUOTA, parseLedgerQuota);
    // review L10: unique ascending months, quota only for listed months, a failed reply carries nothing
    if (months && months.some((x, i) => i > 0 && x.month <= months[i - 1]!.month)) return null;
    if (months && quota && quota.some((x) => !months.some((y) => y.month === x.month))) return null;
    if (m.failed === true && (months?.length || quota?.length || (m.agents as unknown[] | undefined)?.length || (m.models as unknown[] | undefined)?.length || m.older !== null || m.newer !== null)) return null;
    const agents = all(m.agents, MAX_LEDGER_AGENTS, (a) => (agentOk(a) ? a : null)), models = all(m.models, MAX_LEDGER_MODELS, (x) => (modelOk(x) ? x : null));
    if (m.failed !== undefined && m.failed !== true) return null;
    return count(m.id) && months && quota && agents && models && monthOrNull(m.older) && monthOrNull(m.newer)
      ? { v: 1, type: 'monthly', id: m.id, months, quota, older: m.older, newer: m.newer, agents, models, ...(m.failed ? { failed: true as const } : {}) } : null;
  }
  if (m.type === 'usage') {
    const scopes = all(m.scopes, MAX_SCOPES, parseScope);
    return count(m.id) && scopes ? { v: 1, type: 'usage', id: m.id, scopes } : null;
  }
  if (m.type === 'usageHistory') {
    const records = all(m.records, MAX_RECORDS, parseRecord);
    const next = parseHistoryCursor(m.next);
    return count(m.id) && records && next !== undefined ? { v: 1, type: 'usageHistory', id: m.id, records, next } : null;
  }
  if (m.type === 'liveSet') {
    const rows = parseRows(m.rows);
    return count(m.id) && rows && typeof m.more === 'boolean' ? { v: 1, type: 'liveSet', id: m.id, rows, more: m.more } : null;
  }
  if (m.type === 'sessions') {
    const rows = parseRows(m.rows);
    if (!rows) return null;
    if (m.delta === undefined) return { v: 1, type: 'sessions', rows };
    return Number.isSafeInteger(m.delta) && (m.delta as number) > 0 ? { v: 1, type: 'sessions', rows, delta: m.delta as number } : null;
  }
  if (m.type === 'resync') return { v: 1, type: 'resync' };
  if (m.type === 'coverage') {
    if (!Array.isArray(m.banners) || m.banners.length > MAX_BANNERS) return null;
    const banners = m.banners.map(parseBanner);
    return banners.every((b) => b !== null) ? { v: 1, type: 'coverage', banners: banners as Banner[] } : null;
  }
  if (m.type === 'agents') {
    if (m.agents === null) return { v: 1, type: 'agents', agents: null };
    if (!Array.isArray(m.agents)) return null;
    const agents = m.agents.map(parseAgent);
    return agents.every((a) => a !== null) ? { v: 1, type: 'agents', agents: agents as AgentStatus[] } : null;
  }
  return null;
}

export function healthText(h: Health): string {
  switch (h.state) {
    case 'starting': return 'Starting';
    case 'running': return 'Running';
    case 'restarting': return `Restarting (attempt ${h.attempt})`;
    case 'stopped': return 'Stopped';
  }
}

/** A receiver that passes valid messages (plus any extra arguments, e.g. transferred ports) to `handle` and counts
 *  the rest in `.dropped`. */
export function accept<T, A extends unknown[] = []>(parse: (x: unknown) => T | null, handle: (m: T, ...rest: A) => void) {
  const receive = (x: unknown, ...rest: A) => {
    const m = parse(x);
    if (m) handle(m, ...rest);
    else receive.dropped++;
  };
  receive.dropped = 0;
  return receive;
}
