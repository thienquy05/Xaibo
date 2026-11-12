// agy 1.5.6 transcript_full.jsonl records (P2-T11; T00 schema spikes/p2-agy/schemas/agy-1.5.6.transcript.schema.json):
// USER_INPUT, SYSTEM_MESSAGE (injected context), PLANNER_RESPONSE (reply, tool calls without ids, per-request usage),
// GENERIC (inline tool output). Identity = step_index + line hash: a rewritten step gets a new id (revised in source
// order by the writer, D-P2-02 (2)); a line without a step index takes no part in revisions. Unknown types stay raw.
import { createHash } from 'node:crypto';
import type { LineResult, TailRecord } from '../tail-adapter.ts';

export interface AgyRecord extends TailRecord {
  kind: 'user' | 'system' | 'assistant' | 'tool_output' | 'unknown';
  role: string | undefined;
  step: number | null;
  nativeId: string;
  sourceSeq: number; // step_index, or -1 without one
  sourceTs?: number;
  fileMtime: number;
  receivedTs: number;
  injected: boolean;
  toolNames: string[];
  usage?: Record<string, number>;
}

const KINDS: Record<string, [AgyRecord['kind'], string]> = {
  USER_INPUT: ['user', 'user'], SYSTEM_MESSAGE: ['system', 'system'], PLANNER_RESPONSE: ['assistant', 'assistant'], GENERIC: ['tool_output', 'tool'],
};
const USAGE_KEYS = ['input_tokens', 'cache_read_tokens', 'output_tokens'];

export function parseLine(bytes: Buffer, c: { offset: number; fileMtime: number; receivedTs: number }): LineResult<AgyRecord> {
  const raw = bytes.toString('utf8');
  if (!raw.trim()) return null;
  let r: unknown;
  try { r = JSON.parse(raw); } catch { return { ok: false, reason: 'malformed' }; }
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return { ok: false, reason: 'malformed' };
  const o = r as Record<string, unknown>;
  const step = Number.isSafeInteger(o.step_index) && (o.step_index as number) >= 0 ? o.step_index as number : null;
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const [kind, role] = KINDS[typeof o.type === 'string' ? o.type : ''] ?? ['unknown', undefined];
  const ts = typeof o.created_at === 'string' ? Date.parse(o.created_at) : NaN;
  const usage = kind === 'assistant'
    ? Object.fromEntries(USAGE_KEYS.filter((k) => typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) >= 0).map((k) => [k, o[k] as number]))
    : undefined;
  const toolNames = Array.isArray(o.tool_calls)
    ? o.tool_calls.flatMap((t) => (typeof t === 'object' && t !== null && typeof (t as { name?: unknown }).name === 'string' ? [(t as { name: string }).name] : []))
    : [];
  return {
    ok: true,
    record: {
      kind, role, step, nativeId: step === null ? `line:${c.offset}:${hash}` : `step:${step}:${hash}`, sourceSeq: step ?? -1,
      ...(Number.isFinite(ts) ? { sourceTs: ts } : {}), fileMtime: c.fileMtime, receivedTs: c.receivedTs, injected: kind === 'system',
      ...(typeof o.content === 'string' ? { content: o.content } : {}), raw, toolNames, ...(usage ? { usage } : {}),
    },
  };
}
