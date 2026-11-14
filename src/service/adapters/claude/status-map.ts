// Claude Code status map (P3-T08, PRD §6.2, S7 on 2.1.322): hook payloads and transcript lines -> normalized status
// evidence. Reads event names, native ids and usage numbers only; content is never copied. PermissionRequest carries no
// tool_use_id (joined by order in the engine); idle_prompt and elicitation notifications are not input requests; a
// transcript tool_result with the rejection text is its own evidence (denial or interrupt, S7); a subagent's tool calls
// never restart the parent turn.
import type { Ev, Observation } from '../../status/engine.ts';
import { sigField } from '../../status/rules.ts';

// The S7 rejection text starts the result; a marker anywhere else is ordinary tool output (security review).
const REJECTED = /^The user doesn't want to proceed with this tool use/;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
/** A string field of at most 256 characters (ids, names); anything longer is dropped, not truncated. */
const str = (p: Record<string, unknown>, k: string) => (typeof p[k] === 'string' && (p[k] as string).length <= 256 ? p[k] as string : null);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const head = (c: unknown): string => {
  const t = typeof c === 'string' ? c : Array.isArray(c) ? obj(c[0])['text'] : '';
  return typeof t === 'string' ? t.slice(0, 200) : '';
};
const OUTCOME: Record<string, string | null> = { accept: null, decline: 'declined', cancel: 'cancelled' };

function hook(p: Record<string, unknown>, envelopeEvent: string): Ev[] {
  const id = str(p, 'tool_use_id');
  switch (str(p, 'hook_event_name') ?? envelopeEvent) {
    case 'SessionStart': return [{ k: 'session.start' }];
    case 'SessionEnd': return [{ k: 'session.end' }];
    case 'UserPromptSubmit': return [{ k: 'turn.start', typed: typeof p['prompt'] === 'string' && p['prompt'] !== '' }];
    case 'PreToolUse': {
      if (!id) return [{ k: 'activity' }];
      const tool = str(p, 'tool_name');
      return [{ k: 'tool.start', id, ...(tool ? { tool } : {}), ...(obj(p['tool_input'])['run_in_background'] === true ? { background: true as const } : {}),
        ...(str(p, 'agent_id') ? { child: true as const } : {}), ...sigField(p['tool_input'], tool) }];
    }
    case 'PostToolUse': return id ? [{ k: 'tool.end', id, ...sigField(p['tool_response']) }] : [];
    case 'PostToolUseFailure': return id ? [{ k: 'tool.end', id, ...sigField(p['error']), err: true }] : [];
    case 'PermissionRequest': return [{ k: 'request', kind: 'permission', id: null }];
    case 'PermissionDenied': return id ? [{ k: 'resolve', id, outcome: 'denied' }] : []; // §6.2: untested
    case 'Notification': return str(p, 'notification_type') === 'permission_prompt' ? [{ k: 'request', kind: 'permission', id: null }] : [];
    case 'Elicitation': { const s = str(p, 'mcp_server_name'); return s ? [{ k: 'request', kind: 'input', id: `elicit:${s}` }] : []; }
    case 'ElicitationResult': {
      const s = str(p, 'mcp_server_name');
      const a = str(p, 'action') ?? '';
      return s ? [{ k: 'resolve', id: `elicit:${s}`, outcome: Object.hasOwn(OUTCOME, a) ? OUTCOME[a]! : null }] : [];
    }
    case 'SubagentStart': { const a = str(p, 'agent_id'); return a ? [{ k: 'child.start', id: a }] : []; }
    case 'SubagentStop': { const a = str(p, 'agent_id'); return a ? [{ k: 'child.end', id: a }] : []; }
    case 'Stop': return [{ k: 'turn.end' }];
    case 'StopFailure': return [{ k: 'turn.error' }];
    default: return [];
  }
}

const USAGE: Record<string, string> = { input_tokens: 'input', cache_creation_input_tokens: 'cacheWrite', cache_read_input_tokens: 'cacheRead', output_tokens: 'output' };

function line(raw: string): Ev[] {
  let r: Record<string, unknown>;
  try { r = obj(JSON.parse(raw)); } catch { return []; }
  if (r['isMeta'] === true) return [];
  const m = obj(r['message']);
  const blocks = Array.isArray(m['content']) ? (m['content'] as unknown[]).map(obj) : [];
  if (r['type'] === 'user') {
    if (typeof m['content'] === 'string') return [{ k: 'turn.start', typed: true }];
    return blocks.flatMap((b): Ev[] => {
      const id = str(b, 'tool_use_id');
      if (b['type'] !== 'tool_result' || !id) return [];
      if (b['is_error'] === true && REJECTED.test(head(b['content']))) return [{ k: 'tool.rejected', id }];
      return [{ k: 'tool.end', id, ...sigField(b['content']), ...(b['is_error'] === true ? { err: true as const } : {}) }];
    });
  }
  if (r['type'] !== 'assistant') return [];
  const out: Ev[] = [{ k: 'activity' }];
  for (const b of blocks) {
    const id = str(b, 'id');
    if (b['type'] !== 'tool_use' || !id) continue;
    const tool = str(b, 'name');
    out.push({ k: 'tool.start', id, ...(tool ? { tool } : {}), ...(obj(b['input'])['run_in_background'] === true ? { background: true as const } : {}),
      ...sigField(b['input'], tool) });
  }
  const u = obj(m['usage']), mid = str(m, 'id');
  const usage = Object.fromEntries(Object.entries(USAGE).filter(([k]) => count(u[k])).map(([k, n]) => [n, u[k] as number]));
  if (mid && Object.keys(usage).length) out.push({ k: 'usage', key: mid, usage });
  if (m['stop_reason'] === 'end_turn') out.push({ k: 'turn.idle' });
  return out;
}

export function claudeEvidence(o: Observation): Ev[] {
  if (o.source === 'file') return line(o.line);
  if (o.source === 'otel') return [];
  return hook(o.envelope.payload ?? {}, o.envelope.event);
}
