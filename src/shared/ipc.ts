// Versioned IPC messages (P1-T06, §7.1) with hand-written validation: every receiver parses what arrives and drops
// (and counts) anything malformed, of an unknown version or of an unknown type. Parsers return fresh objects holding
// only the known fields. Main <-> service over the parent port; main -> renderer health; renderer <-> service over the
// brokered port (P1-T12).
export const IPC_VERSION = 1;

export type ReadOnlyReason = 'migration-failed' | 'insufficient-space';
export const READ_ONLY_BANNER: Record<ReadOnlyReason, string> = {
  'migration-failed': 'Database migration failed: read-only',
  'insufficient-space': 'Not enough disk space to migrate the database: read-only',
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
const READ_ONLY = ['migration-failed', 'insufficient-space'] as const;
const readOnlyOk = (x: unknown): x is ReadOnlyReason | null => x === null || oneOf(READ_ONLY, x);

export const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_TEXT = 64 * 1024; // any single transcript-derived string in a list row
const text = (x: unknown, max = MAX_TEXT): x is string => typeof x === 'string' && x.length <= max;
const textOrNull = (x: unknown): x is string | null => x === null || text(x);
const boolOrNull = (x: unknown): x is boolean | null => x === null || typeof x === 'boolean';
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
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
export interface SessionDetail { row: SessionRow; coverage: CoverageCode[]; context: ContextReading | null }

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
export type PortRequest = { v: 1; type: 'listSessions'; id: number; cursor: Cursor | null; limit: number }
  /** P4-T02: the window is visible (live session deltas wanted) or hidden (paused; the renderer resyncs by cursor). */
  | { v: 1; type: 'live'; on: boolean }
  /** P4-T04a: the live-session set (tracked, non-ended, active within 24 h), capped; deltas keep it current. */
  | { v: 1; type: 'liveSet'; id: number }
  /** P4-T04b1: usage scopes; one scope+stream's observations with measured time in [from, to), by keyset cursor. */
  | { v: 1; type: 'usage'; id: number }
  | { v: 1; type: 'usageHistory'; id: number; scope: number; stream: string; from: number; to: number; cursor: HistoryCursor | null; limit: number }
  | { v: 1; type: 'session'; id: number; session: number }
  | { v: 1; type: 'transcript'; id: number; session: number; at: TranscriptAt; limit: number }
  | { v: 1; type: 'slice'; id: number; session: number; event: number; part: 'text' | 'reasoning'; offset: number }
  | IdPage<'tools'> | IdPage<'subagents'> | IdPage<'files'>
  | { v: 1; type: 'markers'; id: number; session: number; cursor: MCursor | null; limit: number }
  | { v: 1; type: 'cost'; id: number; session: number };
export type PortMessage =
  | { v: 1; type: 'cost'; id: number; cost: CostDetail | null }
  | { v: 1; type: 'session'; id: number; detail: SessionDetail | null }
  | { v: 1; type: 'transcript'; id: number; items: TranscriptItem[]; prev: TCursor | null; next: TCursor | null }
  | { v: 1; type: 'slice'; id: number; text: string; next: number | null }
  | { v: 1; type: 'tools'; id: number; calls: ToolItem[]; next: number | null }
  | { v: 1; type: 'subagents'; id: number; subagents: SubagentItem[]; next: number | null }
  | { v: 1; type: 'files'; id: number; touches: FileItem[]; next: number | null }
  | { v: 1; type: 'markers'; id: number; markers: ModelMarker[]; next: MCursor | null }
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
  if (typeof x !== 'object' || Array.isArray(x)) return undefined;
  const c = x as Msg;
  return count(c.id) && timeOrNull(c.lastActivity) ? { lastActivity: c.lastActivity, id: c.id } : undefined;
}

function parseRow(x: unknown): SessionRow | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const r = x as Msg;
  if (!count(r.id) || !text(r.agent, 64) || !textOrNull(r.entrypoint) || !textOrNull(r.cwd) || !textOrNull(r.title)) return null;
  if (!(r.origin === null || text(r.origin, 64)) || !boolOrNull(r.interactive) || !text(r.model)) return null;
  if (!timeOrNull(r.lastActivity) || typeof r.drift !== 'boolean' || typeof r.compressed !== 'boolean' || !count(r.quarantined)) return null;
  const live = r.live === null ? null : parseLive(r.live);
  if (live === undefined || !(r.contextPct === null || (Number.isFinite(r.contextPct) && (r.contextPct as number) >= 0 && (r.contextPct as number) <= 100))) return null;
  if (!(r.costUsd === null || (Number.isFinite(r.costUsd) && (r.costUsd as number) >= 0)) || !oneOf(COSTS, r.costCoverage)) return null;
  if (!(r.tokens === null || count(r.tokens)) || typeof r.tokensComplete !== 'boolean') return null;
  return { id: r.id, agent: r.agent, entrypoint: r.entrypoint, origin: r.origin, interactive: r.interactive, model: r.model, cwd: r.cwd, title: r.title, lastActivity: r.lastActivity, drift: r.drift, compressed: r.compressed, quarantined: r.quarantined,
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
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const a = x as Msg;
  if (!text(a.agent) || !AGENT_ID.test(a.agent) || !text(a.name, 128) || !oneOf(['detected', 'not-detected'] as const, a.state)) return null;
  return a.version === null || text(a.version, 64) ? { agent: a.agent, name: a.name, state: a.state, version: a.version } : null;
}

const isObj = (x: unknown): x is Msg => typeof x === 'object' && x !== null && !Array.isArray(x);
const finite = (x: unknown): x is number => Number.isFinite(x);
const numOrNull = (x: unknown, ok: (n: number) => boolean) => x === null || (finite(x) && ok(x));
const percentOk = (n: number) => n >= 0 && n <= 10_000; // the service's stored bound (spend above 100 % is kept)
function parseHistoryCursor(x: unknown): HistoryCursor | null | undefined { // undefined = invalid
  if (x === null) return null;
  return isObj(x) && finite(x.measuredAt) && count(x.id) ? { measuredAt: x.measuredAt, id: x.id } : undefined;
}
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
function parseTCursor(x: unknown): TCursor | null | undefined { // undefined = invalid
  if (x === null) return null;
  return isObj(x) && Number.isSafeInteger(x.seq) && positive(x.id) ? { seq: x.seq as number, id: x.id } : undefined;
}
function parseAt(x: unknown): TranscriptAt | null {
  if (x === 'first' || x === 'latest') return x;
  if (!isObj(x) || Object.keys(x).length !== 1) return null;
  const c = parseTCursor('after' in x ? x.after : x.before);
  if (!c) return null;
  return 'after' in x ? { after: c } : 'before' in x ? { before: c } : null;
}
function parseItem(x: unknown): TranscriptItem | null {
  if (!isObj(x) || !positive(x.event) || !Number.isSafeInteger(x.seq) || !timeOrNull(x.ts) || !oneOf(ITEM_KINDS, x.kind)) return null;
  if (!(x.preview === null || text(x.preview, PREVIEW_BYTES)) || !count(x.length) || typeof x.reasoning !== 'boolean') return null;
  if (!(x.callId === null || (text(x.callId, MAX_CALL_ID) && x.callId !== ''))) return null;
  return { event: x.event, seq: x.seq as number, ts: x.ts, kind: x.kind, preview: x.preview, length: x.length, reasoning: x.reasoning, callId: x.callId };
}
function parseDetail(x: unknown): SessionDetail | null | undefined { // undefined = invalid
  if (x === null) return null;
  if (!isObj(x)) return undefined;
  const row = parseRow(x.row);
  const coverage = all(x.coverage, COVERAGE_CODES.length, (c) => (oneOf(COVERAGE_CODES, c) ? c : null));
  const context = x.context === null ? null : parseContext(x.context);
  return row && coverage && context !== undefined ? { row, coverage, context } : undefined;
}
const CONTEXT_KEYS = ['generation', 'used', 'window', 'basis', 'source', 'asOf', 'observedAt'];
export function parseContext(x: unknown): ContextReading | undefined {
  if (!isObj(x) || Object.keys(x).length !== CONTEXT_KEYS.length || !CONTEXT_KEYS.every((k) => k in x)) return undefined;
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
function parseMCursor(x: unknown): MCursor | null | undefined { // undefined = invalid
  if (x === null) return null;
  return isObj(x) && Number.isSafeInteger(x.ts) && positive(x.id) ? { ts: x.ts as number, id: x.id } : undefined;
}
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

export function parsePortRequest(x: unknown): PortRequest | null {
  const m = envelope(x);
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
    return { v: 1, type: 'slice', id: m.id, session: m.session, event: m.event, part: m.part, offset: m.offset };
  }
  if (m?.type === 'live') return typeof m.on === 'boolean' ? { v: 1, type: 'live', on: m.on } : null;
  if (m?.type === 'liveSet') return count(m.id) ? { v: 1, type: 'liveSet', id: m.id } : null;
  if (m?.type === 'usage') return count(m.id) ? { v: 1, type: 'usage', id: m.id } : null;
  if (m?.type === 'usageHistory') {
    const cursor = parseHistoryCursor(m.cursor);
    if (!count(m.id) || !count(m.scope) || !text(m.stream, MAX_STREAM) || !m.stream || !finite(m.from) || !finite(m.to) || m.from > m.to) return null;
    if (cursor === undefined || !Number.isSafeInteger(m.limit) || (m.limit as number) < 1) return null;
    return { v: 1, type: 'usageHistory', id: m.id, scope: m.scope, stream: m.stream, from: m.from, to: m.to, cursor, limit: m.limit as number };
  }
  if (!m || m.type !== 'listSessions' || !count(m.id) || !Number.isSafeInteger(m.limit) || (m.limit as number) < 1) return null;
  const cursor = parseCursor(m.cursor);
  return cursor === undefined ? null : { v: 1, type: 'listSessions', id: m.id, cursor, limit: m.limit as number };
}

export function parsePortMessage(x: unknown): PortMessage | null {
  const m = envelope(x);
  if (!m) return null;
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
    return count(m.id) && markers && next !== undefined ? { v: 1, type: 'markers', id: m.id, markers, next } : null;
  }
  if (m.type === 'page') {
    const rows = parseRows(m.rows);
    const next = parseCursor(m.next);
    return count(m.id) && rows && next !== undefined ? { v: 1, type: 'page', id: m.id, rows, next } : null;
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
