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
export type ServiceCommand = { v: 1; type: 'quit' | 'wake' | 'port' | 'reloadPrices' } | { v: 1; type: 'setPath'; agent: string; path: string };
/** service -> main; notify (P3-T11, EC-59) carries only the agent display name, the approved project label (null until
 *  one exists, FR-10) and the wait state. */
export type NotifyState = 'waiting-for-permission' | 'needs-input';
export type ServiceEvent =
  | { v: 1; type: 'ready'; readOnly: ReadOnlyReason | null }
  | { v: 1; type: 'notify'; agent: string; label: string | null; state: NotifyState };
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
export interface AgentStatus { agent: string; name: string; state: 'detected' | 'not-detected'; version: string | null }
export type PortRequest = { v: 1; type: 'listSessions'; id: number; cursor: Cursor | null; limit: number };
export type PortMessage =
  | { v: 1; type: 'page'; id: number; rows: SessionRow[]; next: Cursor | null }
  // coalesced deltas: current rows of changed sessions; delta only with XAIBO_PERF_TRACE=1 (the renderer acks its paint)
  | { v: 1; type: 'sessions'; rows: SessionRow[]; delta?: number }
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
  return { id: r.id, agent: r.agent, entrypoint: r.entrypoint, origin: r.origin, interactive: r.interactive, model: r.model, cwd: r.cwd, title: r.title, lastActivity: r.lastActivity, drift: r.drift, compressed: r.compressed, quarantined: r.quarantined,
    live, contextPct: r.contextPct as number | null, costUsd: r.costUsd as number | null, costCoverage: r.costCoverage };
}

function parseLive(x: unknown): LiveStatus | undefined { // undefined = invalid
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return undefined;
  const l = x as Msg;
  if (!oneOf(LIFECYCLES, l.lifecycle) || !oneOf(CONFIDENCES, l.confidence) || !oneOf(HEALTHS, l.health)) return undefined;
  if (!(l.reason === null || oneOf(REASONS, l.reason)) || !(l.outcome === null || oneOf(OUTCOMES, l.outcome))) return undefined;
  const f = l.findings;
  if (!Array.isArray(f) || !f.every((r) => oneOf(RULES, r)) || new Set(f).size !== f.length) return undefined;
  return { lifecycle: l.lifecycle, confidence: l.confidence, health: l.health, reason: l.reason, outcome: l.outcome, findings: [...f] as LiveStatus['findings'] };
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

export function parsePortRequest(x: unknown): PortRequest | null {
  const m = envelope(x);
  if (!m || m.type !== 'listSessions' || !count(m.id) || !Number.isSafeInteger(m.limit) || (m.limit as number) < 1) return null;
  const cursor = parseCursor(m.cursor);
  return cursor === undefined ? null : { v: 1, type: 'listSessions', id: m.id, cursor, limit: m.limit as number };
}

export function parsePortMessage(x: unknown): PortMessage | null {
  const m = envelope(x);
  if (!m) return null;
  if (m.type === 'page') {
    const rows = parseRows(m.rows);
    const next = parseCursor(m.next);
    return count(m.id) && rows && next !== undefined ? { v: 1, type: 'page', id: m.id, rows, next } : null;
  }
  if (m.type === 'sessions') {
    const rows = parseRows(m.rows);
    if (!rows) return null;
    if (m.delta === undefined) return { v: 1, type: 'sessions', rows };
    return Number.isSafeInteger(m.delta) && (m.delta as number) > 0 ? { v: 1, type: 'sessions', rows, delta: m.delta as number } : null;
  }
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
