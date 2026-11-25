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
/** XAIBO-PROD-554 (design §6.4 Filters, D-P6-05): the record markers a Session list can be filtered by; cwd filter bound. */
export const HISTORY_STATES = ['pinned', 'kept', 'native-deleted', 'native-archived'] as const;
export const CWD_FILTER_MAX = 4096;
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
export interface HistoryFilter { mode: (typeof HISTORY_MODES)[number]; agent: string | null; project: number | null; folder: number | null; group?: MapGroup;
  /** XAIBO-PROD-554 (each present only when set): the folder and below; activity overlapping [from, to) ms; a record marker;
   *  a model id (Dashboard month detail). */
  cwd?: string; from?: number; to?: number; state?: (typeof HISTORY_STATES)[number]; model?: string }
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
/** XAIBO-PROD-558 (P6-T03 part 1b; design review L1/L2): Connect replies, bounded; never an op, a plan or a foreign value
 *  (diff lines carry Xaibo's values and a replaced value's type + 12-hex hash only). An over-bound reply is refused by the
 *  service (too-large), never truncated. */
export const CONNECT_TYPES = ['connectPreview', 'connectApply', 'teePreview'] as const; // XAIBO-PROD-580: a tee-on preview is a Connect preview
export const CONNECT_ROUTES = ['claude-plugin', 'claude-settings-fallback', 'claude-retention', 'claude-tee', 'codex-hooks', 'agy-hooks'] as const;
export type ConnectRoute = (typeof CONNECT_ROUTES)[number];
export const CONNECT_LIMITS = { steps: 3, diff: 64, value: 16_384, text: 8_192, trust: 8, entries: 8, list: 256 } as const;
export interface ConnectSelections { retention: boolean; tee: boolean }
export interface ConnectDiffLine { pointer: string; new: unknown; replaced?: { type: string; sha256: string } }
/** cli: the plugin step only (XAIBO-PROD-560, part 2b): version, argv with placeholders, write surfaces relative to the profile. */
export interface ConnectStep { route: ConnectRoute; target: string; diff: ConnectDiffLine[]; cli?: { version: string; argv: string[][]; writes: string[] } }
export type ConnectOffer = { offered: true; from: number; to: number; layer: 'user' | 'default' }
  | { offered: false; reason: 'policy' | 'enough' | 'unknown' | 'connected' | 'unverified'; days: number | null };
export type ConnectPreview = { status: 'preview'; previewId: string; profileId: string; ttlMs: number; steps: ConnectStep[]; retention: ConnectOffer | null; trustSteps: string[] };
export type ConnectRefused = { status: 'refused'; code: string };
export interface ConnectOutcome {
  status: 'disconnected' | 'partial';
  reverted: { entry: string; route: ConnectRoute; result: 'restored' | 'removed' | 'structural' | 'unchanged' }[];
  conflicts: { entry: string; route: ConnectRoute; pointer: string }[];
  remaining: { entry: string; route: ConnectRoute; reason: string }[];
  code?: string;
}
export type ConnectReply = ConnectPreview | ConnectRefused | { status: 'applied'; entries: string[]; trustSteps: string[] }
  | { status: 'needs-preview'; preview: ConnectPreview | ConnectRefused } | ConnectOutcome;
/** XAIBO-PROD-576 (P6-T10 unit 3; review R1/R4/R5, plan review H1/L4): Disconnect (a profile) and Full Uninstall (profileId
 *  null) are previewed and applied by preview id; cleanup by profile. Items name an entry, its route, the profile it maps to
 *  and its reconcile state (reason: why it is unreadable, e.g. refused for a target outside the writable roots); no path or
 *  value. At most REMOVAL_LIMIT items, the core's own cap. */
export const RECONCILE_STATES = ['connected', 'disconnected-externally', 'drifted', 'pending-recovery', 'unreadable'] as const;
export const LEFTOVERS = ['manifest-entry', 'backup', 'plugin-copy', 'marketplace'] as const;
export const REMOVAL_LIMIT = 256;
export interface RemovalItem { entry: string; route: ConnectRoute; profileId: string | null; state: (typeof RECONCILE_STATES)[number]; reason: string | null }
export type RemovalPreview = { status: 'preview'; previewId: string; profileId: string | null; ttlMs: number; items: RemovalItem[] };
export type RemovalReply = RemovalPreview | ConnectRefused | { status: 'needs-preview'; preview: RemovalPreview | ConnectRefused } | ConnectOutcome;
export type CleanupReply = { status: 'preview'; previewId: string; ttlMs: number; items: { entry: string; cleanup: (typeof LEFTOVERS)[number][] }[] }
  | { status: 'cleaned'; removed: string[]; left: string[] } | { status: 'needs-preview' } | { status: 'partial'; removed: string[]; left: string[]; code: string } | ConnectRefused;
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
  /** XAIBO-PROD-568 (P6-T11): Settings > Local prices: the current table, a Validate that switches nothing, a Reload. */
  | { v: 1; type: 'prices'; id: number; op: PriceOp }
  | SignInRequest
  | { v: 1; type: 'integrationPage'; id: number; cursor: IntegrationKey | null; direction: 'next' | 'previous'; limit: number }
  | { v: 1; type: 'integrationDetail'; id: number; key: IntegrationKey }
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
  | { v: 1; type: 'cost'; id: number; session: number }
  /** XAIBO-PROD-558 (P6-T03 part 1b): Connect at the renderer trust boundary: a profile id, selections or a preview id only. */
  | { v: 1; type: 'connectPreview'; id: number; profileId: string; selections: ConnectSelections }
  | { v: 1; type: 'connectApply'; id: number; previewId: string }
  | { v: 1; type: 'removalPreview'; id: number; profileId: string | null }
  | { v: 1; type: 'removalApply'; id: number; previewId: string }
  | { v: 1; type: 'cleanupPreview'; id: number; profileId: string }
  | { v: 1; type: 'cleanupApply'; id: number; previewId: string }
  /** XAIBO-PROD-580 (P6-T10 unit 6a, R6): the separate tee, by profile id: on is a tee-only Connect preview (connectApply), off the
   *  removal preview of the profile's tee entry alone (removalApply). */
  | { v: 1; type: 'teePreview'; id: number; profileId: string }
  | { v: 1; type: 'teeRemovalPreview'; id: number; profileId: string };
export type PortMessage =
  | { v: 1; type: (typeof CONNECT_TYPES)[number]; id: number; result: ConnectReply }
  | { v: 1; type: 'removalPreview' | 'removalApply' | 'teeRemovalPreview'; id: number; result: RemovalReply }
  | { v: 1; type: 'cleanupPreview' | 'cleanupApply'; id: number; result: CleanupReply }
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
  /** view null = the service has no prices (a bundled-list build error); check is set only by validate. */
  | { v: 1; type: 'prices'; id: number; view: PriceView | null; check: PriceCheck | null }
  /** XAIBO-PROD-572: view null for profile-not-found, read-only, unavailable and failed. */
  | { v: 1; type: 'signIn'; id: number; code: SignInReplyCode; view: SignInView | null }
  | { v: 1; type: 'integrationPage'; id: number; result: IntegrationPageResult }
  | { v: 1; type: 'integrationDetail'; id: number; result: IntegrationDetailResult }
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
const OPTIONAL_FILTER_KEYS = ['group', 'cwd', 'from', 'to', 'state', 'model'] as const;
const msOk = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
function parseFilter(x: unknown): HistoryFilter | null {
  const present = isObj(x) ? OPTIONAL_FILTER_KEYS.filter((k) => Object.hasOwn(x, k)) : [];
  if (!exactKeys(x, ['mode', 'agent', 'project', 'folder', ...present]) || !oneOf(HISTORY_MODES, x.mode)) return null;
  const has = (k: (typeof OPTIONAL_FILTER_KEYS)[number]) => present.includes(k);
  const group = has('group') ? parseMapGroup(x.group) : undefined;
  if (group === null || !((x.agent === null || agentOk(x.agent)) && idOrNull(x.project) && idOrNull(x.folder))) return null;
  // XAIBO-PROD-554: strict shapes; a date range needs both ends in order
  if (has('cwd') && !(text(x.cwd, CWD_FILTER_MAX) && x.cwd !== '')) return null;
  if (has('from') !== has('to') || (has('from') && !(msOk(x.from) && msOk(x.to) && x.from <= x.to))) return null;
  if (has('state') && !oneOf(HISTORY_STATES, x.state)) return null;
  if (has('model') && !(text(x.model, MAX_MODEL) && x.model !== '')) return null;
  return { mode: x.mode, agent: x.agent, project: x.project, folder: x.folder, ...(group ? { group } : {}),
    ...(has('cwd') ? { cwd: x.cwd as string } : {}), ...(has('from') ? { from: x.from as number, to: x.to as number } : {}),
    ...(has('state') ? { state: x.state as HistoryFilter['state'] } : {}), ...(has('model') ? { model: x.model as string } : {}) };
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = (x: unknown): x is string => typeof x === 'string' && UUID.test(x);
const CODE = /^[a-z][a-z-]{0,31}$/;
const connectCode = (x: unknown): x is string => typeof x === 'string' && CODE.test(x);
const bounded = (x: unknown, max: number): x is unknown[] => Array.isArray(x) && x.length <= max;
const depthOk = (v: unknown, d = 0): boolean => d <= 32 && (typeof v !== 'object' || v === null || Object.values(v).every((x) => depthOk(x, d + 1))); // review L-3
const jsonValue = (v: unknown) => { try { const t = JSON.stringify(v); return t !== undefined && t.length <= CONNECT_LIMITS.value && depthOk(v); } catch { return false; } };
const longText = (x: unknown): x is string => text(x, CONNECT_LIMITS.text);
const route = (x: unknown): x is ConnectRoute => oneOf(CONNECT_ROUTES, x);
// part 2b review H2: the plugin step's argv carries placeholders (never an absolute path), its writes are profile-relative
const argText = (x: unknown) => text(x, 256) && !x.startsWith('/');
const relPath = (x: unknown) => text(x, 256) && x.length > 0 && !x.startsWith('/') && !x.split('/').includes('..');
const cliView = (c: unknown) => exactKeys(c, ['version', 'argv', 'writes']) && typeof c.version === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(c.version)
  && bounded(c.argv, 4) && c.argv.every((a) => bounded(a, 8) && a.every(argText)) && bounded(c.writes, 8) && c.writes.every(relPath);
const stepKeys = (st: unknown) => {
  const cli = isObj(st) && st.cli !== undefined;
  return exactKeys(st, cli ? ['route', 'target', 'diff', 'cli'] : ['route', 'target', 'diff']) && (!cli || (st.route === 'claude-plugin' && cliView(st.cli)));
};
function connectPreview(x: unknown): ConnectPreview | null {
  if (!exactKeys(x, ['status', 'previewId', 'profileId', 'ttlMs', 'steps', 'retention', 'trustSteps']) || x.status !== 'preview') return null;
  if (!uuid(x.previewId) || !uuid(x.profileId) || !count(x.ttlMs) || !bounded(x.trustSteps, CONNECT_LIMITS.trust) || !x.trustSteps.every(longText)) return null;
  if (!bounded(x.steps, CONNECT_LIMITS.steps) || !x.steps.every((st) => stepKeys(st) && isObj(st) && route(st.route) && longText(st.target)
    && bounded(st.diff, CONNECT_LIMITS.diff) && st.diff.every((d) => exactKeys(d, isObj(d) && d.replaced !== undefined ? ['pointer', 'new', 'replaced'] : ['pointer', 'new'])
      && longText(d.pointer) && jsonValue(d.new) && (d.replaced === undefined || (exactKeys(d.replaced, ['type', 'sha256']) && text(d.replaced.type, 16) && typeof d.replaced.sha256 === 'string' && /^[0-9a-f]{12}$/.test(d.replaced.sha256)))))) return null;
  const o = x.retention;
  const offer = o === null || (exactKeys(o, ['offered', 'from', 'to', 'layer']) && o.offered === true && count(o.from) && count(o.to) && oneOf(['user', 'default'] as const, o.layer))
    || (exactKeys(o, ['offered', 'reason', 'days']) && o.offered === false && oneOf(['policy', 'enough', 'unknown', 'connected', 'unverified'] as const, o.reason) && (o.days === null || count(o.days)));
  return offer ? x as unknown as ConnectPreview : null;
}
/** XAIBO-PROD-558: the one bound check for Connect replies (the service refuses what this refuses: too-large). */
export function parseConnectReply(x: unknown): ConnectReply | null {
  if (!isObj(x)) return null;
  if (x.status === 'refused') return exactKeys(x, ['status', 'code']) && connectCode(x.code) ? { status: 'refused', code: x.code } : null;
  if (x.status === 'preview') return connectPreview(x);
  if (x.status === 'needs-preview') {
    const inner = isObj(x.preview) && x.preview.status === 'refused' ? parseConnectReply(x.preview) : connectPreview(x.preview);
    return exactKeys(x, ['status', 'preview']) && inner ? { status: 'needs-preview', preview: inner as ConnectPreview | ConnectRefused } : null;
  }
  if (x.status === 'applied') {
    return exactKeys(x, ['status', 'entries', 'trustSteps']) && bounded(x.entries, CONNECT_LIMITS.entries) && x.entries.every(uuid)
      && bounded(x.trustSteps, CONNECT_LIMITS.trust) && x.trustSteps.every(longText) ? x as unknown as ConnectReply : null;
  }
  if (x.status !== 'disconnected' && x.status !== 'partial') return null;
  if (!exactKeys(x, x.code === undefined ? ['status', 'reverted', 'conflicts', 'remaining'] : ['status', 'reverted', 'conflicts', 'remaining', 'code'])) return null;
  if (x.code !== undefined && !connectCode(x.code)) return null;
  const L = CONNECT_LIMITS.list;
  const ok = bounded(x.reverted, L) && x.reverted.every((r) => exactKeys(r, ['entry', 'route', 'result']) && uuid(r.entry) && route(r.route) && oneOf(['restored', 'removed', 'structural', 'unchanged'] as const, r.result))
    && bounded(x.conflicts, L) && x.conflicts.every((c) => exactKeys(c, ['entry', 'route', 'pointer']) && uuid(c.entry) && route(c.route) && longText(c.pointer))
    && bounded(x.remaining, L) && x.remaining.every((r) => exactKeys(r, ['entry', 'route', 'reason']) && uuid(r.entry) && route(r.route) && connectCode(r.reason));
  return ok ? x as unknown as ConnectOutcome : null;
}
const refusal = (x: unknown) => exactKeys(x, ['status', 'code']) && x.status === 'refused' && connectCode(x.code);
function removalPreview(x: unknown): RemovalPreview | null {
  if (!exactKeys(x, ['status', 'previewId', 'profileId', 'ttlMs', 'items']) || x.status !== 'preview' || !uuid(x.previewId) || !(x.profileId === null || uuid(x.profileId)) || !count(x.ttlMs)) return null;
  return bounded(x.items, REMOVAL_LIMIT) && x.items.every((i) => exactKeys(i, ['entry', 'route', 'profileId', 'state', 'reason']) && uuid(i.entry) && route(i.route)
    && (i.profileId === null || uuid(i.profileId)) && oneOf(RECONCILE_STATES, i.state) && (i.reason === null || connectCode(i.reason))) ? x as unknown as RemovalPreview : null;
}
/** XAIBO-PROD-576: a preview request answers a preview or a refusal; an apply answers an outcome, a fresh preview or a refusal. */
export function parseRemovalReply(type: 'removalPreview' | 'removalApply' | 'teeRemovalPreview', x: unknown): RemovalReply | null {
  if (refusal(x)) return x as ConnectRefused;
  if (type === 'removalPreview') return removalPreview(x);
  if (type === 'teeRemovalPreview') { const p = removalPreview(x); return p && p.profileId !== null ? p : null; } // always one profile
  if (isObj(x) && x.status === 'needs-preview') {
    return exactKeys(x, ['status', 'preview']) && (refusal(x.preview) || removalPreview(x.preview)) ? x as unknown as RemovalReply : null;
  }
  return isObj(x) && (x.status === 'disconnected' || x.status === 'partial') ? parseConnectReply(x) as ConnectOutcome | null : null;
}
export function parseCleanupReply(type: 'cleanupPreview' | 'cleanupApply', x: unknown): CleanupReply | null {
  if (refusal(x)) return x as ConnectRefused;
  if (!isObj(x)) return null;
  if (type === 'cleanupPreview') {
    return exactKeys(x, ['status', 'previewId', 'ttlMs', 'items']) && x.status === 'preview' && uuid(x.previewId) && count(x.ttlMs) && bounded(x.items, REMOVAL_LIMIT)
      && x.items.every((i) => exactKeys(i, ['entry', 'cleanup']) && uuid(i.entry) && bounded(i.cleanup, LEFTOVERS.length) && i.cleanup.every((c) => oneOf(LEFTOVERS, c))) ? x as unknown as CleanupReply : null;
  }
  if (x.status === 'needs-preview') return exactKeys(x, ['status']) ? { status: 'needs-preview' } : null;
  const ids = (v: unknown) => bounded(v, REMOVAL_LIMIT) && v.every(uuid);
  if (x.status === 'cleaned') return exactKeys(x, ['status', 'removed', 'left']) && ids(x.removed) && ids(x.left) ? x as unknown as CleanupReply : null;
  return x.status === 'partial' && exactKeys(x, ['status', 'removed', 'left', 'code']) && ids(x.removed) && ids(x.left) && connectCode(x.code) ? x as unknown as CleanupReply : null;
}

export function parsePortRequest(x: unknown): PortRequest | null {
  const m = envelope(x);
  // XAIBO-PROD-558: exact keys; a profile id (UUID), literal-boolean selections or a preview id (UUID), nothing else
  if (m?.type === 'connectPreview') {
    const sel = m.selections;
    return exactKeys(m, ['v', 'type', 'id', 'profileId', 'selections']) && count(m.id) && uuid(m.profileId)
      && exactKeys(sel, ['retention', 'tee']) && typeof sel.retention === 'boolean' && typeof sel.tee === 'boolean'
      ? { v: 1, type: 'connectPreview', id: m.id, profileId: m.profileId, selections: { retention: sel.retention, tee: sel.tee } } : null;
  }
  if (m?.type === 'connectApply') return exactKeys(m, ['v', 'type', 'id', 'previewId']) && count(m.id) && uuid(m.previewId) ? { v: 1, type: 'connectApply', id: m.id, previewId: m.previewId } : null;
  // XAIBO-PROD-576 (review R1): no bare Disconnect or Uninstall; removal and cleanup by profile id (null: every profile) or preview id
  if (m?.type === 'removalPreview') return exactKeys(m, ['v', 'type', 'id', 'profileId']) && count(m.id) && (m.profileId === null || uuid(m.profileId)) ? { v: 1, type: 'removalPreview', id: m.id, profileId: m.profileId } : null;
  if (m?.type === 'cleanupPreview') return exactKeys(m, ['v', 'type', 'id', 'profileId']) && count(m.id) && uuid(m.profileId) ? { v: 1, type: 'cleanupPreview', id: m.id, profileId: m.profileId } : null;
  if (m?.type === 'teePreview' || m?.type === 'teeRemovalPreview') return exactKeys(m, ['v', 'type', 'id', 'profileId']) && count(m.id) && uuid(m.profileId) ? { v: 1, type: m.type, id: m.id, profileId: m.profileId } : null;
  if (m?.type === 'removalApply' || m?.type === 'cleanupApply') return exactKeys(m, ['v', 'type', 'id', 'previewId']) && count(m.id) && uuid(m.previewId) ? { v: 1, type: m.type, id: m.id, previewId: m.previewId } : null;
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
  if (m?.type === 'prices') return count(m.id) && oneOf(PRICE_OPS, m.op) ? { v: 1, type: 'prices', id: m.id, op: m.op } : null;
  if (m?.type === 'signIn') return parseSignInRequest(m);
  if (m?.type === 'integrationDetail') { // XAIBO-PROD-577: one agent/profile key, nothing else
    const key = parseIntegrationKey(m.key);
    return exactKeys(m, ['v', 'type', 'id', 'key']) && count(m.id) && key ? { v: 1, type: 'integrationDetail', id: m.id, key } : null;
  }
  if (m?.type === 'integrationPage') {
    const cursor = m.cursor === null ? null : parseIntegrationKey(m.cursor);
    return exactKeys(m, ['v', 'type', 'id', 'cursor', 'direction', 'limit']) && count(m.id) && cursor !== undefined && (m.direction === 'next' || m.direction === 'previous')
      && Number.isSafeInteger(m.limit) && (m.limit as number) >= 1 && (m.limit as number) <= INTEGRATION_PAGE_MAX
      ? { v: 1, type: 'integrationPage', id: m.id, cursor, direction: m.direction, limit: m.limit as number } : null;
  }
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
  if (oneOf(CONNECT_TYPES, m.type)) {
    const result = parseConnectReply(m.result);
    // unit 6a review L1: a preview request answers a preview or a refusal, never an outcome
    if (m.type !== 'connectApply' && result && result.status !== 'preview' && result.status !== 'refused') return null;
    return exactKeys(m, ['v', 'type', 'id', 'result']) && count(m.id) && result ? { v: 1, type: m.type, id: m.id, result } : null;
  }
  if (m.type === 'removalPreview' || m.type === 'removalApply' || m.type === 'teeRemovalPreview') {
    const result = parseRemovalReply(m.type, m.result);
    return exactKeys(m, ['v', 'type', 'id', 'result']) && count(m.id) && result ? { v: 1, type: m.type, id: m.id, result } : null;
  }
  if (m.type === 'cleanupPreview' || m.type === 'cleanupApply') {
    const result = parseCleanupReply(m.type, m.result);
    return exactKeys(m, ['v', 'type', 'id', 'result']) && count(m.id) && result ? { v: 1, type: m.type, id: m.id, result } : null;
  }
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
  if (m.type === 'integrationDetail') {
    const result = exactKeys(m, ['v', 'type', 'id', 'result']) && count(m.id) ? parseIntegrationDetail(m.result) : undefined;
    return result ? { v: 1, type: 'integrationDetail', id: m.id as number, result } : null;
  }
  if (m.type === 'integrationPage') {
    const result = exactKeys(m, ['v', 'type', 'id', 'result']) && count(m.id) ? parseIntegrationPage(m.result) : undefined;
    return result ? { v: 1, type: 'integrationPage', id: m.id as number, result } : null;
  }
  if (m.type === 'signIn') {
    if (!exactKeys(m, ['v', 'type', 'id', 'code', 'view']) || !count(m.id) || !oneOf(SIGN_IN_CODES, m.code)) return null;
    const failure = m.code === 'profile-not-found' || m.code === 'read-only' || m.code === 'unavailable' || m.code === 'failed';
    const view = m.view === null ? null : parseSignInView(m.view);
    return view !== undefined && (view === null) === failure ? { v: 1, type: 'signIn', id: m.id, code: m.code, view } : null;
  }
  if (m.type === 'prices') {
    const view = m.view === null ? null : parsePriceView(m.view);
    const check = m.check === null || oneOf(PRICE_CHECKS, m.check) ? m.check : undefined;
    return count(m.id) && exactKeys(m, ['v', 'type', 'id', 'view', 'check']) && view !== undefined && check !== undefined
      ? { v: 1, type: 'prices', id: m.id, view, check } : null;
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

// XAIBO-PROD-568 (P6-T11; design §6.6 Local prices, C30; review R5): the price view Settings shows. Bounds equal the price
// schema's (integrations/models.schema.json: revision 1..64, dates YYYY-MM-DD, 32 fallbacks of 1..64 exact model ids, rates
// 0..100000, 8 cache-write classes), so every table the service accepted gets through.
export const PRICE_ERRORS = ['override_unreadable', 'override_not_regular', 'override_too_large', 'override_json', 'override_schema'] as const;
export type PriceError = (typeof PRICE_ERRORS)[number];
const PRICE_CHECKS = ['absent', 'valid', ...PRICE_ERRORS] as const;
/** Validate's answer: no override file, a valid one (not yet in use), or why it would be refused. */
export type PriceCheck = (typeof PRICE_CHECKS)[number];
const PRICE_OPS = ['get', 'validate', 'reload'] as const;
export type PriceOp = (typeof PRICE_OPS)[number];
export interface PriceRatesView { input: number; output: number; cache_read?: number; cache_write?: Record<string, number> }
export interface PriceFallback { models: string[]; agent: string | null; rates: PriceRatesView }
/** error: the override was refused at the last load; the table shown is then the last valid one. */
export interface PriceView { source: 'bundled' | 'override'; revision: string; pricesAsOf: string; error: PriceError | null; fallbacks: PriceFallback[] }
/** Reveal override file (main, SEC1): what Finder was asked to select. */
export type RevealResult = 'file' | 'missing' | 'folder' | 'failed';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRICE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CACHE_CLASS = /^[0-9]{1,3}[mh]$/;
const rateOk = (x: unknown): x is number => finite(x) && (x as number) >= 0 && (x as number) <= 100_000;

function parseRates(x: unknown): PriceRatesView | undefined {
  if (!isObj(x) || !rateOk(x.input) || !rateOk(x.output) || Object.keys(x).some((k) => !['input', 'output', 'cache_read', 'cache_write'].includes(k))) return undefined;
  if (x.cache_read !== undefined && !rateOk(x.cache_read)) return undefined;
  const cw = x.cache_write;
  if (cw !== undefined && (!isObj(cw) || Object.keys(cw).length > 8 || Object.entries(cw).some(([k, v]) => !CACHE_CLASS.test(k) || !rateOk(v)))) return undefined;
  return { input: x.input, output: x.output, ...(x.cache_read !== undefined ? { cache_read: x.cache_read } : {}),
    ...(cw !== undefined ? { cache_write: { ...(cw as Record<string, number>) } } : {}) };
}

function parsePriceView(x: unknown): PriceView | undefined {
  if (!exactKeys(x, ['source', 'revision', 'pricesAsOf', 'error', 'fallbacks']) || !oneOf(['bundled', 'override'] as const, x.source)) return undefined;
  if (!text(x.revision, 64) || !x.revision || !text(x.pricesAsOf, 10) || !PRICE_DATE.test(x.pricesAsOf)) return undefined;
  if (!(x.error === null || oneOf(PRICE_ERRORS, x.error)) || !Array.isArray(x.fallbacks) || x.fallbacks.length > 32) return undefined;
  const fallbacks: PriceFallback[] = [];
  for (const f of x.fallbacks as unknown[]) {
    if (!exactKeys(f, ['models', 'agent', 'rates']) || !Array.isArray(f.models) || !f.models.length || f.models.length > 64) return undefined;
    if (!f.models.every((m) => typeof m === 'string' && MODEL_ID.test(m)) || !(f.agent === null || agentOk(f.agent))) return undefined;
    const rates = parseRates(f.rates);
    if (!rates) return undefined;
    fallbacks.push({ models: [...(f.models as string[])], agent: f.agent, rates });
  }
  return { source: x.source, revision: x.revision, pricesAsOf: x.pricesAsOf, error: x.error, fallbacks };
}

// XAIBO-PROD-569 (P6-T10 unit 1; design §6.6 Startup): renderer <-> main through the preload, parsed on both sides.
export type StartupRequest = { op: 'read' } | { op: 'save'; enabled: boolean };
/** failed: platform = the OS refused or read back another value (enabled = that value, null when unreadable); invalid = a
 *  malformed request (nothing done). */
export type StartupReply = { status: 'ready'; enabled: boolean } | { status: 'failed'; code: 'platform' | 'invalid'; enabled: boolean | null };
export function parseStartupRequest(x: unknown): StartupRequest | null {
  if (exactKeys(x, ['op']) && x.op === 'read') return { op: 'read' };
  return exactKeys(x, ['op', 'enabled']) && x.op === 'save' && typeof x.enabled === 'boolean' ? { op: 'save', enabled: x.enabled } : null;
}
export function parseStartupReply(x: unknown): StartupReply | null {
  if (exactKeys(x, ['status', 'enabled']) && x.status === 'ready' && typeof x.enabled === 'boolean') return { status: 'ready', enabled: x.enabled };
  return exactKeys(x, ['status', 'code', 'enabled']) && x.status === 'failed' && oneOf(['platform', 'invalid'] as const, x.code)
    && (x.enabled === null || typeof x.enabled === 'boolean') ? { status: 'failed', code: x.code, enabled: x.enabled } : null;
}

// XAIBO-PROD-572 (P6-T01a slice 3; S-38, FR-54; design .handoff/p6-t01a-design.md "Slice 3 wire contract", security
// review 3647): the owner's sign-in declaration. The renderer sends only the profile, the op, a method and the revision it
// saw; the service assigns every time and reads no credential, auth, config or environment.
export const SIGN_IN_METHODS = ['subscription', 'api-key', 'cloud-provider', 'gateway', 'mixed', 'unknown'] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];
const SIGN_IN_KNOWN = SIGN_IN_METHODS.filter((m) => m !== 'unknown');
const SIGN_IN_SOURCES = ['claude-statusline', 'claude-transcript', 'codex-rollout', 'agy-transcript'] as const;
export const SIGN_IN_CODES = ['ok', 'stale', 'profile-not-found', 'limit', 'read-only', 'unavailable', 'failed'] as const;
export type SignInReplyCode = (typeof SIGN_IN_CODES)[number];
export type SignInRequest = { v: 1; type: 'signIn'; id: number; profileId: string } & (
  | { op: 'read' }
  | { op: 'set'; method: SignInMethod; expectedRevision: number }
  | { op: 'clear' | 'account-change'; expectedRevision: number });
export interface SignInView {
  profileId: string; revision: number; method: SignInMethod;
  /** What the method comes from: the owner's declaration, an output signal, or nothing (Unknown). */
  source: 'owner' | (typeof SIGN_IN_SOURCES)[number] | null; at: number | null;
  declaration: { method: SignInMethod; at: number } | null;
  evidence: { method: Exclude<SignInMethod, 'unknown'>; source: (typeof SIGN_IN_SOURCES)[number]; version: string; ruleId: string; observedAt: number; sourceAt: number } | null;
  conflict: boolean; usingDeclaration: boolean; outputStatus: 'unavailable' | 'matched' | 'ambiguous';
  generation: number; boundary: { at: number; reason: 'method' | 'declared-account' } | null;
}

const SIGN_IN_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[A-Za-z0-9.-]{1,48})?$/;
const SIGN_IN_RULE = /^[a-z]+(?:-[a-z]+)*$/;
const time = (x: unknown): x is number => Number.isSafeInteger(x);
const msOrNull = (x: unknown): x is number | null => x === null || time(x);

function parseSignInRequest(m: Msg): SignInRequest | null {
  if (!count(m.id) || !uuid(m.profileId)) return null;
  const base = { v: 1 as const, type: 'signIn' as const, id: m.id, profileId: m.profileId };
  if (m.op === 'read') return exactKeys(m, ['v', 'type', 'id', 'profileId', 'op']) ? { ...base, op: 'read' } : null;
  if (!count(m.expectedRevision)) return null;
  if (m.op === 'set') {
    return exactKeys(m, ['v', 'type', 'id', 'profileId', 'op', 'method', 'expectedRevision']) && oneOf(SIGN_IN_METHODS, m.method)
      ? { ...base, op: 'set', method: m.method, expectedRevision: m.expectedRevision } : null;
  }
  return (m.op === 'clear' || m.op === 'account-change') && exactKeys(m, ['v', 'type', 'id', 'profileId', 'op', 'expectedRevision'])
    ? { ...base, op: m.op, expectedRevision: m.expectedRevision } : null;
}

/** Review L5: the bounds again on the renderer side (the service writes them; a store row is not trusted). */
function parseSignInView(x: unknown): SignInView | undefined {
  if (!exactKeys(x, ['profileId', 'revision', 'method', 'source', 'at', 'declaration', 'evidence', 'conflict', 'usingDeclaration', 'outputStatus', 'generation', 'boundary'])) return undefined;
  if (!uuid(x.profileId) || !count(x.revision) || !oneOf(SIGN_IN_METHODS, x.method) || !msOrNull(x.at) || !count(x.generation)) return undefined;
  if (!(x.source === null || x.source === 'owner' || oneOf(SIGN_IN_SOURCES, x.source))) return undefined;
  if (typeof x.conflict !== 'boolean' || typeof x.usingDeclaration !== 'boolean' || !oneOf(['unavailable', 'matched', 'ambiguous'] as const, x.outputStatus)) return undefined;
  const d = x.declaration, e = x.evidence, b = x.boundary;
  const declaration = d === null ? null : exactKeys(d, ['method', 'at']) && oneOf(SIGN_IN_METHODS, d.method) && time(d.at) ? { method: d.method, at: d.at } : undefined;
  const evidence = e === null ? null : exactKeys(e, ['method', 'source', 'version', 'ruleId', 'observedAt', 'sourceAt']) && oneOf(SIGN_IN_KNOWN, e.method)
    && oneOf(SIGN_IN_SOURCES, e.source) && text(e.version, 64) && SIGN_IN_VERSION.test(e.version) && text(e.ruleId, 64) && SIGN_IN_RULE.test(e.ruleId)
    && time(e.observedAt) && time(e.sourceAt)
    ? { method: e.method, source: e.source, version: e.version, ruleId: e.ruleId, observedAt: e.observedAt, sourceAt: e.sourceAt } : undefined;
  const boundary = b === null ? null : exactKeys(b, ['at', 'reason']) && time(b.at) && oneOf(['method', 'declared-account'] as const, b.reason) ? { at: b.at, reason: b.reason } : undefined;
  if (declaration === undefined || evidence === undefined || boundary === undefined) return undefined;
  return { profileId: x.profileId, revision: x.revision, method: x.method, source: x.source, at: x.at, declaration, evidence, conflict: x.conflict,
    usingDeclaration: x.usingDeclaration, outputStatus: x.outputStatus, generation: x.generation, boundary };
}

// XAIBO-PROD-574 (P6-T10 unit 2a; FR-06, D-P6-11; design .handoff/p6-t10-design.md sections 1-2, review R2/R3/R7): the
// Agent Map Agents list, one row per agent and profile, read only. Reasons and gaps are fixed codes; no path beyond the
// profile label the usage view already shows; a receipt names only its source, event and time.
export const INTEGRATION_STATES = ['detected', 'setup-required', 'awaiting-trust', 'connected', 'partial-coverage', 'unsupported-version', 'not-detected'] as const;
export const INTEGRATION_FACTS = ['no-executable', 'probe-not-granted', 'probe-grant-stale', 'version-unknown', 'version-unqualified', 'no-profile', 'not-connected',
  'evidence-unavailable', 'drifted', 'disconnected-externally', 'pending-recovery', 'unreadable', 'hooks-blocked', 'no-receipt', 'waiting-for-receipt', 'hook-gap',
  'content-unavailable'] as const;
export const CONTENT_MODES = ['native-transcript', 'report-full', 'report-state-only', 'unavailable'] as const;
export const INTEGRATION_REFUSALS = ['starting', 'unavailable', 'stale-cursor', 'too-large', 'failed'] as const;
export const INTEGRATION_PAGE_MAX = 10;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];
export type IntegrationFact = (typeof INTEGRATION_FACTS)[number];
export interface IntegrationKey { agent: string; profileId: string | null }
export interface IntegrationRow {
  key: IntegrationKey; name: string; profileLabel: string | null; version: string | null; state: IntegrationState; reasons: IntegrationFact[];
  lifecycleGaps: (typeof GAP_REASONS)[number][]; receipt: { source: 'hook' | 'report'; event: string; receivedAt: number } | null;
  content: { mode: (typeof CONTENT_MODES)[number]; assurance: 'verified' | 'declared' | 'unavailable'; evidence: string | null; gaps: string[] };
}
export type IntegrationPageResult =
  | { status: 'ready'; observedAt: number; value: { rows: IntegrationRow[]; previous: IntegrationKey | null; next: IntegrationKey | null } }
  | { status: 'refused'; code: (typeof INTEGRATION_REFUSALS)[number] };

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9.]{0,63}$/;
const SHORT_CODE = /^[a-z][a-z0-9-]{0,31}$/;
function parseIntegrationKey(x: unknown): IntegrationKey | undefined {
  return exactKeys(x, ['agent', 'profileId']) && typeof x.agent === 'string' && AGENT_ID.test(x.agent) && (x.profileId === null || uuid(x.profileId))
    ? { agent: x.agent, profileId: x.profileId } : undefined;
}
const codeList = <T extends string>(x: unknown, allowed: readonly T[]): x is T[] => Array.isArray(x) && x.length <= 16 && x.every((c) => oneOf(allowed, c));
function parseIntegrationRow(x: unknown): IntegrationRow | undefined {
  if (!exactKeys(x, ['key', 'name', 'profileLabel', 'version', 'state', 'reasons', 'lifecycleGaps', 'receipt', 'content'])) return undefined;
  const key = parseIntegrationKey(x.key), r = x.receipt, c = x.content;
  if (!key || !text(x.name, 200) || !(x.profileLabel === null || text(x.profileLabel, 512)) || !(x.version === null || text(x.version, 64))) return undefined;
  if (!oneOf(INTEGRATION_STATES, x.state) || !codeList(x.reasons, INTEGRATION_FACTS) || !codeList(x.lifecycleGaps, GAP_REASONS)) return undefined;
  const receipt = r === null ? null : exactKeys(r, ['source', 'event', 'receivedAt']) && (r.source === 'hook' || r.source === 'report') && typeof r.event === 'string'
    && EVENT_NAME.test(r.event) && count(r.receivedAt) ? { source: r.source as 'hook' | 'report', event: r.event, receivedAt: r.receivedAt } : undefined;
  const content = exactKeys(c, ['mode', 'assurance', 'evidence', 'gaps']) && oneOf(CONTENT_MODES, c.mode) && oneOf(['verified', 'declared', 'unavailable'] as const, c.assurance)
    && (c.evidence === null || text(c.evidence, 64)) && Array.isArray(c.gaps) && c.gaps.length <= 16 && c.gaps.every((g) => typeof g === 'string' && SHORT_CODE.test(g))
    ? { mode: c.mode, assurance: c.assurance, evidence: c.evidence, gaps: [...c.gaps] as string[] } : undefined;
  if (receipt === undefined || content === undefined) return undefined;
  return { key, name: x.name, profileLabel: x.profileLabel, version: x.version, state: x.state, reasons: [...x.reasons], lifecycleGaps: [...x.lifecycleGaps], receipt, content };
}
// XAIBO-PROD-577 (P6-T10 unit 4a; design section 2, review R7/R8): the panel's read. The list row, that agent's profiles,
// that profile's reconcile entries (ids and enums), Codex trust steps while awaiting trust, the install boundary.
export const DETAIL_REFUSALS = ['starting', 'unavailable', 'not-found', 'failed'] as const;
export interface IntegrationDetail {
  row: IntegrationRow; profiles: { id: string; label: string }[];
  entries: { entry: string; route: ConnectRoute; state: (typeof RECONCILE_STATES)[number]; reason: string | null }[];
  trustSteps: string[]; boundary: number | null;
}
export type IntegrationDetailResult = { status: 'ready'; observedAt: number; value: IntegrationDetail } | { status: 'refused'; code: (typeof DETAIL_REFUSALS)[number] };
function parseIntegrationDetail(x: unknown): IntegrationDetailResult | undefined {
  if (exactKeys(x, ['status', 'code']) && x.status === 'refused') return oneOf(DETAIL_REFUSALS, x.code) ? { status: 'refused', code: x.code } : undefined;
  if (!exactKeys(x, ['status', 'observedAt', 'value']) || x.status !== 'ready' || !count(x.observedAt)) return undefined;
  const v = x.value;
  if (!exactKeys(v, ['row', 'profiles', 'entries', 'trustSteps', 'boundary'])) return undefined;
  const row = parseIntegrationRow(v.row);
  const ok = row && bounded(v.profiles, REMOVAL_LIMIT) && v.profiles.every((p) => exactKeys(p, ['id', 'label']) && uuid(p.id) && text(p.label, 512))
    && bounded(v.entries, REMOVAL_LIMIT) && v.entries.every((e) => exactKeys(e, ['entry', 'route', 'state', 'reason']) && uuid(e.entry) && route(e.route)
      && oneOf(RECONCILE_STATES, e.state) && (e.reason === null || connectCode(e.reason)))
    && bounded(v.trustSteps, CONNECT_LIMITS.trust) && v.trustSteps.every(longText) && (v.boundary === null || count(v.boundary));
  if (!ok) return undefined;
  // code review L3: the fields agree: trust steps only while awaiting trust; a profile-less row has no entries or boundary; the
  // row's own profile is listed
  const pid = row.key.profileId, d = v as unknown as IntegrationDetail;
  if ((d.trustSteps.length && row.state !== 'awaiting-trust') || (pid === null && (d.entries.length || d.boundary !== null))
    || (pid !== null && !d.profiles.some((p) => p.id === pid))) return undefined;
  return { status: 'ready', observedAt: x.observedAt, value: { row, profiles: d.profiles.map((p) => ({ ...p })), entries: d.entries.map((e) => ({ ...e })), trustSteps: [...d.trustSteps], boundary: d.boundary } };
}
function parseIntegrationPage(x: unknown): IntegrationPageResult | undefined {
  if (exactKeys(x, ['status', 'code']) && x.status === 'refused') return oneOf(INTEGRATION_REFUSALS, x.code) ? { status: 'refused', code: x.code } : undefined;
  if (!exactKeys(x, ['status', 'observedAt', 'value']) || x.status !== 'ready' || !count(x.observedAt)) return undefined;
  const v = x.value;
  if (!exactKeys(v, ['rows', 'previous', 'next']) || !Array.isArray(v.rows) || v.rows.length > INTEGRATION_PAGE_MAX) return undefined;
  const rows = v.rows.map(parseIntegrationRow);
  const previous = v.previous === null ? null : parseIntegrationKey(v.previous), next = v.next === null ? null : parseIntegrationKey(v.next);
  if (rows.some((r) => r === undefined) || previous === undefined || next === undefined) return undefined;
  return { status: 'ready', observedAt: x.observedAt, value: { rows: rows as IntegrationRow[], previous, next } };
}
