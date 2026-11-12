// Codex rollout parser (P2-T02): one raw JSONL line + file context -> normalized record, or a malformed outcome for
// quarantine. Pure and tolerant, like the Claude parser. Record types and shapes: S9 facts for Codex 0.160.0
// (spikes/s9/evidence/facts.json, re-extracted 2026-11-11); payload types never observed there are kept raw only.
import { createHash } from 'node:crypto';

export const KNOWN_TYPES = new Set(['compacted', 'event_msg', 'response_item', 'session_meta', 'token_usage_record', 'turn_context', 'world_state']);
// event_msg item_completed User/AgentMessage items mirror a response_item message of the same role and text (S9
// messageMirroring); the response_item is the message, the item never adds one.
const MIRROR_ITEMS = new Set(['UserMessage', 'AgentMessage']);
const ROLLOUT_ID = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/;

export interface ParseContext { offset: number; fileIdentity: string; fileMtime: number; receivedTs: number }
export interface CodexRecord {
  type: string;
  payloadType?: string;
  kind: string; // session | turn_context | turn_start | turn_end | turn_aborted | message | mirror | tool_call | tool_result
  //               | token_count | token_usage | settings | compaction | item | world_state | other | unknown
  nativeId: string; // `${fileIdentity}:${offset}` (OQ-P2-02: archive moves and copies keep both parts)
  sessionId?: string; // session_meta only
  turnId?: string;
  sourceSeq: number;
  sourceTs?: number;
  fileMtime: number;
  receivedTs: number;
  cwd?: string;
  cliVersion?: string;
  source?: string;
  originator?: string;
  model?: string;
  effort?: string | null; // undefined: not exposed; null: exposed and unset
  approvalPolicy?: string;
  sandboxPolicy?: string;
  role?: string;
  callId?: string;
  toolName?: string;
  content?: string;
  tokenInfo?: Record<string, unknown>; // token_count payload.info, raw (normalized in T06)
  rateLimits?: Record<string, unknown>; // token_count payload.rate_limits, raw; absent stays absent (EC-93)
  usage?: Record<string, unknown>; // token_usage_record payload, raw
  injected: boolean;
  raw: string;
}
export type ParseResult = { ok: true; record: CodexRecord } | { ok: false; reason: 'malformed' };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const joined = (parts: (string | undefined)[]) => parts.filter((p) => p).join('\n') || undefined;
const texts = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? joined(v.map((c) => (isObj(c) ? str(c.text) : undefined))) : undefined);

/** File identity: hash of the first line (session_meta), stable while the file grows and across archive moves. */
export const fileIdentity = (firstLine: Buffer) => createHash('sha256').update(firstLine).digest('hex').slice(0, 16);

/** Session id in a rollout filename, for the coverage warning when it differs from session_meta. */
export const filenameSessionId = (name: string) => ROLLOUT_ID.exec(name)?.[1];

// collaboration_mode.settings.reasoning_effort (S9: the FR-51 path; observed only as null on 0.160.0).
function effortOf(p: Obj): string | null | undefined {
  const settings = isObj(p.collaboration_mode) && isObj(p.collaboration_mode.settings) ? p.collaboration_mode.settings : undefined;
  if (!settings || !('reasoning_effort' in settings)) return undefined;
  return str(settings.reasoning_effort) ?? null;
}

function fromPayload(type: string, p: Obj): Partial<CodexRecord> & { kind: string } {
  const pt = str(p.type);
  switch (type) {
    case 'session_meta':
      return { kind: 'session', sessionId: str(p.id), cwd: str(p.cwd), cliVersion: str(p.cli_version), source: str(p.source), originator: str(p.originator) };
    case 'turn_context':
      return {
        kind: 'turn_context', turnId: str(p.turn_id), cwd: str(p.cwd), model: str(p.model), effort: effortOf(p), approvalPolicy: str(p.approval_policy),
        sandboxPolicy: isObj(p.sandbox_policy) ? str(p.sandbox_policy.type) : undefined,
      };
    case 'compacted':
      return { kind: 'compaction', content: str(p.message) }; // replacement_history replays earlier messages: not indexed again
    case 'token_usage_record':
      return { kind: 'token_usage', turnId: str(p.turn_id), usage: p };
    case 'world_state':
      return { kind: 'world_state' };
    case 'response_item': {
      const meta = isObj(p.internal_chat_message_metadata_passthrough) ? str(p.internal_chat_message_metadata_passthrough.turn_id) : undefined;
      if (pt === 'message') return { kind: 'message', role: str(p.role), content: texts(p.content), turnId: meta, injected: p.role === 'developer' };
      if (pt === 'custom_tool_call') {
        const name = str(p.name);
        const input = str(p.input);
        return { kind: 'tool_call', callId: str(p.call_id), toolName: name, content: [name, input].filter((x) => x).join(' ') || undefined };
      }
      if (pt === 'custom_tool_call_output') return { kind: 'tool_result', callId: str(p.call_id), content: texts(p.output) };
      return { kind: 'other' }; // function_call, web_search_call, reasoning, …: never observed on 0.160.0 (S9), kept raw
    }
    case 'event_msg': {
      const turnId = str(p.turn_id);
      switch (pt) {
        case 'task_started': return { kind: 'turn_start', turnId };
        case 'task_complete': return { kind: 'turn_end', turnId };
        case 'turn_aborted': return { kind: 'turn_aborted', turnId };
        case 'token_count':
          return { kind: 'token_count', turnId, tokenInfo: isObj(p.info) ? p.info : undefined, rateLimits: isObj(p.rate_limits) ? p.rate_limits : undefined };
        case 'thread_settings_applied': {
          const s = isObj(p.thread_settings) ? p.thread_settings : {};
          return { kind: 'settings', model: str(s.model), effort: effortOf(s), approvalPolicy: str(s.approval_policy) };
        }
        case 'item_completed': {
          const item = isObj(p.item) ? p.item : {};
          return { kind: MIRROR_ITEMS.has(str(item.type) ?? '') ? 'mirror' : 'item', turnId };
        }
        default: return { kind: 'other', turnId };
      }
    }
    default:
      return { kind: 'unknown' };
  }
}

const ACCOUNT_KEYS = ['creator_account_id', 'creator_user_id'];

export function parseLine(bytes: Buffer, ctx: ParseContext): ParseResult | null {
  const raw = bytes.toString('utf8');
  if (raw.trim() === '') return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, reason: 'malformed' }; }
  if (!isObj(value)) return { ok: false, reason: 'malformed' };
  const type = str(value.type) ?? '';
  const payload = isObj(value.payload) ? value.payload : {};
  const ts = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
  const fields = KNOWN_TYPES.has(type) ? fromPayload(type, payload) : { kind: 'unknown' };
  // G2-1: account identifiers in session_meta are never stored (PRD §5.11, EC-92, D-P0-27).
  const stored = type === 'session_meta' && ACCOUNT_KEYS.some((k) => k in payload)
    ? JSON.stringify({ ...value, payload: Object.fromEntries(Object.entries(payload).filter(([k]) => !ACCOUNT_KEYS.includes(k))) }) : raw;
  return {
    ok: true,
    record: {
      type,
      payloadType: str(payload.type),
      nativeId: `${ctx.fileIdentity}:${ctx.offset}`,
      sourceSeq: ctx.offset,
      sourceTs: Number.isNaN(ts) ? undefined : ts,
      fileMtime: ctx.fileMtime,
      receivedTs: ctx.receivedTs,
      injected: false,
      raw: stored,
      ...fields,
    },
  };
}
