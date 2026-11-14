// Codex status map (P3-T08, PRD §6.3, S5/S9 for 0.160.0): hook payloads and rollout lines -> normalized status evidence.
// Hook and rollout rows only (notify rows v1-B, app-server v1-A, Q3-13). Turn ids join hook and rollout turns; tool calls
// join on call_id = tool_use_id; token_count totals are cumulative, so they go under one key (latest wins, never summed).
// Content is never copied.
import type { Ev, Observation } from '../../status/engine.ts';
import { sigField } from '../../status/rules.ts';

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
/** A string field of at most 256 characters (ids, names); anything longer is dropped, not truncated. */
const str = (p: Record<string, unknown>, k: string) => (typeof p[k] === 'string' && (p[k] as string).length <= 256 ? p[k] as string : null);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

function hook(p: Record<string, unknown>, envelopeEvent: string): Ev[] {
  const id = str(p, 'tool_use_id'), turn = str(p, 'turn_id'), agent = str(p, 'agent_id'), tool = str(p, 'tool_name');
  switch (str(p, 'hook_event_name') ?? envelopeEvent) {
    case 'SessionStart': return [{ k: 'session.start' }];
    case 'SessionEnd': return [{ k: 'session.end' }];
    case 'UserPromptSubmit': return [{ k: 'turn.start', typed: typeof p['prompt'] === 'string' && p['prompt'] !== '', ...(turn ? { turn } : {}) }];
    case 'PreToolUse': return id ? [{ k: 'tool.start', id, ...(tool ? { tool } : {}), ...sigField(p['tool_input'], tool) }] : [{ k: 'activity' }];
    // No error flag: R3 is not applied to Codex until a verified tool-error field exists (D-P3-08 e).
    case 'PostToolUse': return id ? [{ k: 'tool.end', id, ...sigField(p['tool_response']) }] : [];
    case 'PermissionRequest': return [{ k: 'request', kind: 'permission', id }]; // unverified on 0.160.0 (D-P3-08)
    case 'Stop': return [{ k: 'turn.end' }];
    case 'Interrupt': return [{ k: 'interrupt' }];
    case 'SubagentStart': return agent ? [{ k: 'child.start', id: agent }] : [];
    case 'SubagentStop': return agent ? [{ k: 'child.end', id: agent }] : [];
    default: return [];
  }
}

const USAGE: Record<string, string> = { input_tokens: 'input', cached_input_tokens: 'cacheRead', output_tokens: 'output', reasoning_output_tokens: 'reasoning' };

function line(raw: string): Ev[] {
  let r: Record<string, unknown>;
  try { r = obj(JSON.parse(raw)); } catch { return []; }
  const p = obj(r['payload']);
  const type = str(p, 'type') ?? '';
  if (r['type'] === 'event_msg') {
    const turn = str(p, 'turn_id');
    if (type === 'task_started') return [{ k: 'turn.start', typed: true, ...(turn ? { turn } : {}) }];
    if (type === 'task_complete') return [{ k: 'turn.end' }];
    if (type === 'token_count') {
      const u = obj(obj(p['info'])['total_token_usage']);
      const usage = Object.fromEntries(Object.entries(USAGE).filter(([k]) => count(u[k])).map(([k, n]) => [n, u[k] as number]));
      return Object.keys(usage).length ? [{ k: 'usage', key: 'total', usage }] : [];
    }
    return [];
  }
  if (r['type'] !== 'response_item') return [];
  const id = str(p, 'call_id'), name = str(p, 'name');
  if (id && type.endsWith('_call_output')) return [{ k: 'tool.end', id, ...sigField(p['output']) }];
  if (id && type.endsWith('_call')) return [{ k: 'tool.start', id, ...(name ? { tool: name } : {}), ...sigField(p['input'] ?? p['arguments'] ?? p['action'], name) }];
  return type === 'message' ? [{ k: 'activity' }] : [];
}

export function codexEvidence(o: Observation): Ev[] {
  if (o.source === 'file') return line(o.line);
  if (o.source === 'otel') return [];
  return hook(o.envelope.payload ?? {}, o.envelope.event);
}
