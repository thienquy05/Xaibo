// Report event contract v1 (P3-T13a; PRD §5.10, OQ-X6): hand-written strict parser shared by the service intake and the
// status map. The version is checked first and nothing else is read for any other version. Event names outside the v1
// list are kept (the caller warns about coverage); unknown fields and malformed values are rejected with fixed codes
// that name a field, never a value. Identity (agent, profile) is not here: the approved registration binds it.
export const REPORT_EVENTS = ['session.start', 'session.end', 'turn.start', 'turn.end', 'turn.error', 'permission.request', 'permission.resolve',
  'input.request', 'input.resolve', 'tool.start', 'tool.end', 'content.upsert', 'usage.snapshot'] as const;

export interface ReportEvent {
  v: 1; delivery_id: string; session_id: string; producer_id: string; producer_seq: number; event: string; source_ts: string;
  payload: Record<string, unknown>;
  turn_id?: string; item_id?: string; parent_id?: string; request_id?: string; cwd?: string;
  model?: { id: string; display_name?: string }; effort?: string;
}
export type ReportParse = { ok: true; event: ReportEvent } | { ok: false; code: string };

const ID = 128;
const OPTIONAL: Record<string, number> = { turn_id: 256, item_id: 256, parent_id: 256, request_id: 256, cwd: 4096, effort: 64 };
const REQUIRED = ['v', 'delivery_id', 'session_id', 'producer_id', 'producer_seq', 'event', 'source_ts', 'payload'];
const KEYS = new Set([...REQUIRED, ...Object.keys(OPTIONAL), 'model']);
const EVENT = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_]{0,31}){0,3}$/;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
// Well-formed only (P3-T13b, security review 872): JSON can carry lone surrogates, which would collide once stored as UTF-8.
const str = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max && x.isWellFormed();
const count = (x: unknown, min = 0) => Number.isSafeInteger(x) && (x as number) >= min;

export function parseReport(x: unknown): ReportParse {
  if (!isObj(x)) return { ok: false, code: 'malformed' };
  if (x.v !== 1) return { ok: false, code: 'unsupported-version' };
  const bad = (field: string): ReportParse => ({ ok: false, code: `invalid-${field}` });
  for (const k of Object.keys(x)) if (!KEYS.has(k)) return bad('field');
  for (const k of ['delivery_id', 'session_id', 'producer_id'] as const) if (!str(x[k], k === 'session_id' ? 256 : ID)) return bad(k);
  if (!count(x.producer_seq)) return bad('producer_seq');
  if (typeof x.event !== 'string' || !EVENT.test(x.event)) return bad('event');
  if (!str(x.source_ts, 64)) return bad('source_ts');
  if (!isObj(x.payload)) return bad('payload');
  for (const [k, max] of Object.entries(OPTIONAL)) if (k in x && !str(x[k], max)) return bad(k);
  if ('model' in x) {
    const m = x.model;
    if (!isObj(m) || !str(m.id, 256) || Object.keys(m).some((k) => k !== 'id' && k !== 'display_name') || ('display_name' in m && !str(m.display_name, 256))) return bad('model');
  }
  if (x.event === 'content.upsert') {
    if (!('item_id' in x)) return bad('item_id');
    const p = x.payload;
    if (!count(p.revision, 1) || !str(p.role, 64) || !str(p.kind, 64) || typeof p.content !== 'string' || !p.content.isWellFormed() || !count(p.chunk_index) || typeof p.final !== 'boolean') return bad('content');
  }
  return { ok: true, event: x as unknown as ReportEvent };
}
