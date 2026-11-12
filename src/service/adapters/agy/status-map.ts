// agy status map, native transcript side (P3-T13a; P2-T00 schema for agy 1.5.6, D-P2-02): transcript_full.jsonl records
// -> inferred status evidence. USER_INPUT opens a turn (turn boundaries come from here, never from PreInvocation); a
// planner response with tool calls and inline tool output are progress; a planner response without tool calls is the
// end of the turn (idle, inferred); per-request usage is kept per step. Transcript tool calls carry no id, so none is
// invented and no tool call is counted from here. Hooks (catalog mappings) outrank all of this once a session has any.
import type { Ev } from '../../status/engine.ts';

const USAGE: Record<string, string> = { input_tokens: 'input', cache_read_tokens: 'cacheRead', output_tokens: 'output' };
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

export function agyFileEvidence(raw: string): Ev[] {
  let r: unknown;
  try { r = JSON.parse(raw); } catch { return []; }
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return [];
  const o = r as Record<string, unknown>;
  switch (o['type']) {
    case 'USER_INPUT': return [{ k: 'turn.start', typed: true }];
    case 'GENERIC': return [{ k: 'activity' }];
    case 'PLANNER_RESPONSE': {
      const usage = Object.fromEntries(Object.entries(USAGE).filter(([k]) => count(o[k])).map(([k, n]) => [n, o[k] as number]));
      const step = count(o['step_index']) ? `step:${String(o['step_index'])}` : null;
      const u: Ev[] = step && Object.keys(usage).length ? [{ k: 'usage', key: step, usage }] : [];
      return [Array.isArray(o['tool_calls']) && o['tool_calls'].length ? { k: 'activity' } : { k: 'turn.idle' }, ...u];
    }
    default: return [];
  }
}
