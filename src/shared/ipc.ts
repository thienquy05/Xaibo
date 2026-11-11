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

/** main -> service; setPath carries a file the user picked in the native dialog (validated again by the service). */
export type ServiceCommand = { v: 1; type: 'quit' | 'wake' | 'port' } | { v: 1; type: 'setPath'; agent: string; path: string };
/** service -> main */
export type ServiceEvent = { v: 1; type: 'ready'; readOnly: ReadOnlyReason | null };
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
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const timeOrNull = (x: unknown): x is number | null => x === null || Number.isFinite(x);

export function parseServiceCommand(x: unknown): ServiceCommand | null {
  const m = envelope(x);
  if (!m) return null;
  if (oneOf(['quit', 'wake', 'port'] as const, m.type)) return { v: 1, type: m.type };
  if (m.type !== 'setPath' || !text(m.agent) || !AGENT_ID.test(m.agent)) return null;
  if (!text(m.path, 4096) || !m.path.startsWith('/') || m.path.includes('\0')) return null;
  return { v: 1, type: 'setPath', agent: m.agent, path: m.path };
}

export function parseServiceEvent(x: unknown): ServiceEvent | null {
  const m = envelope(x);
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
  lastActivity: number | null; drift: boolean; compressed: boolean; quarantined: number;
}
export interface Page { rows: SessionRow[]; next: Cursor | null }
export interface AgentStatus { agent: string; name: string; state: 'detected' | 'not-detected'; version: string | null }
export type PortRequest = { v: 1; type: 'listSessions'; id: number; cursor: Cursor | null; limit: number };
export type PortMessage =
  | { v: 1; type: 'page'; id: number; rows: SessionRow[]; next: Cursor | null }
  | { v: 1; type: 'sessions'; rows: SessionRow[] } // coalesced deltas: current rows of changed sessions
  | { v: 1; type: 'agents'; agents: AgentStatus[] | null }; // null while detection runs

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
  if (!timeOrNull(r.lastActivity) || typeof r.drift !== 'boolean' || typeof r.compressed !== 'boolean' || !count(r.quarantined)) return null;
  return { id: r.id, agent: r.agent, entrypoint: r.entrypoint, cwd: r.cwd, title: r.title, lastActivity: r.lastActivity, drift: r.drift, compressed: r.compressed, quarantined: r.quarantined };
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
    return rows ? { v: 1, type: 'sessions', rows } : null;
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
