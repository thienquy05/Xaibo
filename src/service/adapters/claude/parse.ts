// Claude Code transcript parser (P1-T09): one raw JSONL line + file context -> normalized record, or a malformed
// outcome for quarantine. Pure and tolerant. Known types, injected prefixes: S9 facts for Claude 2.1.319.
import { createHash } from 'node:crypto';

// S9 2.6: the 2.1.319 observations plus the record type names from the owner's real-store audit. The audit kept
// names only, so field shapes of those types (e.g. ai-title) are unverified and nothing is read from them yet.
export const KNOWN_TYPES = new Set(['api-request', 'api-request-blob', 'api-request-shape', 'assistant', 'atis-latch', 'attachment',
  'cost-state', 'last-prompt', 'mode', 'queue-operation', 'session-owner', 'system', 'tools-used', 'user',
  'agent-color', 'agent-name', 'ai-title', 'artifact-autoreact-ledger', 'artifact-comment-monitor', 'bridge-session', 'custom-title',
  'failed', 'file-history-delta', 'file-history-snapshot', 'frame-link', 'launched', 'permission-mode', 'pr-link', 'relocated',
  'result', 'started']);
export const INJECTED_PREFIXES = ['<command-name>', '<local-command-caveat>', '<local-command-stdout>'];

export interface ParseContext { offset: number; fileMtime: number; receivedTs: number; subagentNativeId?: string }
export interface ClaudeRecord {
  type: string;
  kind: string; // 'message' | 'system' | 'unknown' | another known type
  nativeId: string; // uuid, or `h:<hash>` of the raw line for uuid-less records (stable across offsets)
  parentNativeId?: string;
  sessionId?: string;
  sourceSeq: number;
  sourceTs?: number;
  fileMtime: number;
  receivedTs: number;
  cwd?: string;
  entrypoint?: string;
  version?: string;
  role?: string;
  messageId?: string;
  model?: string;
  usage?: Record<string, unknown>;
  content?: string;
  injected: boolean;
  isSidechain: boolean;
  subagentNativeId?: string;
  raw: string;
  /** Oversized records (oversized.ts): the content key linking a head row to its chunk rows. */
  ingestId?: string;
  /** P2-T05: `tool_use` block ids (args) and `tool_result.tool_use_id` (result); absent when the record has none. */
  toolCalls?: { callId: string; part: 'args' | 'result'; tool?: string }[];
  /** P2-T07: a `system` `compact_boundary` record (S9); postTokens null when not a number. */
  compact?: { postTokens: number | null };
}
export type ParseResult = { ok: true; record: ClaudeRecord } | { ok: false; reason: 'malformed' };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const joined = (parts: (string | undefined)[]) => parts.filter((p) => p).join('\n') || undefined;

function blockText(b: unknown): string | undefined {
  if (typeof b === 'string') return b;
  if (!isObj(b)) return undefined;
  switch (b.type) {
    case 'text': return str(b.text);
    case 'thinking': return str(b.thinking);
    case 'tool_use': return `${str(b.name) ?? 'tool'} ${JSON.stringify(b.input ?? {})}`;
    case 'tool_result': return typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? joined(b.content.map(blockText)) : undefined;
    default: return undefined;
  }
}

function messageText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? joined(content.map(blockText)) : undefined;
}

function firstText(content: unknown): string {
  if (typeof content === 'string') return content;
  const first = Array.isArray(content) ? content.find((b) => isObj(b) && b.type === 'text') : undefined;
  return isObj(first) ? str(first.text) ?? '' : '';
}

function toolCalls(content: unknown): NonNullable<ClaudeRecord['toolCalls']> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((b): NonNullable<ClaudeRecord['toolCalls']> => {
    if (!isObj(b)) return [];
    const name = str(b.name);
    if (b.type === 'tool_use' && str(b.id)) return [{ callId: str(b.id)!, part: 'args' as const, ...(name ? { tool: name } : {}) }];
    if (b.type === 'tool_result' && str(b.tool_use_id)) return [{ callId: str(b.tool_use_id)!, part: 'result' as const }];
    return [];
  });
}

export function parseLine(bytes: Buffer, ctx: ParseContext): ParseResult | null {
  const raw = bytes.toString('utf8');
  if (raw.trim() === '') return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, reason: 'malformed' }; }
  if (!isObj(value)) return { ok: false, reason: 'malformed' };
  const r = value;
  const type = str(r.type) ?? '';
  const msg = isObj(r.message) ? r.message : undefined;
  const role = str(msg?.role);
  const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  const calls = toolCalls(msg?.content);
  return {
    ok: true,
    record: {
      type,
      kind: !KNOWN_TYPES.has(type) ? 'unknown' : type === 'user' || type === 'assistant' ? 'message' : type,
      nativeId: str(r.uuid) ?? `h:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`,
      parentNativeId: str(r.parentUuid),
      sessionId: str(r.sessionId),
      sourceSeq: ctx.offset,
      sourceTs: Number.isNaN(ts) ? undefined : ts,
      fileMtime: ctx.fileMtime,
      receivedTs: ctx.receivedTs,
      cwd: str(r.cwd), // only ever from the record, never from the encoded directory name (EC-16)
      entrypoint: str(r.entrypoint),
      version: str(r.version),
      role,
      messageId: str(msg?.id),
      model: str(msg?.model),
      usage: isObj(msg?.usage) ? msg.usage : undefined,
      content: msg ? messageText(msg.content) : str(r.content),
      injected: role === 'user' && INJECTED_PREFIXES.some((p) => firstText(msg?.content).trimStart().startsWith(p)),
      isSidechain: r.isSidechain === true,
      subagentNativeId: ctx.subagentNativeId,
      raw,
      ...(calls.length ? { toolCalls: calls } : {}),
      ...(type === 'system' && r.subtype === 'compact_boundary'
        ? { compact: { postTokens: isObj(r.compactMetadata) && typeof r.compactMetadata.postTokens === 'number' ? r.compactMetadata.postTokens : null } } : {}),
    },
  };
}

/** Latest line per assistant message.id (partial updates of one message collapse to the latest). */
export function collapseByMessageId(records: ClaudeRecord[]): Map<string, ClaudeRecord> {
  const out = new Map<string, ClaudeRecord>();
  for (const r of records) if (r.type === 'assistant' && r.messageId) out.set(r.messageId, r);
  return out;
}

/** EC-04: drift when the unknown share is above 5% (same rule as the store's drift column). */
export const drift = (total: number, unknown: number) => unknown * 20 > total;

/** Duration between two timestamps from one source; missing or negative -> null (EC-08). */
export function durationMs(start: number | undefined, end: number | undefined): number | null {
  if (start === undefined || end === undefined || end < start) return null;
  return end - start;
}
