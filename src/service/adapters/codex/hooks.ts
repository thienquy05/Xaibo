// Codex hooks (P3-T06; FR-31, S5, FR-51). The 0.160.0 event set Xaibo subscribes to (no model-request events exist
// there, S5 2.6; EC-53 leaves them to the catalog's capability detection), the events S5 saw accept `async: true` (SessionEnd runs synchronously, so it stays sync), and
// the payload -> evidence mapping: the fields S5 recorded, a bounded tool_input preview, everything else raw in
// `extra`, never interpreted. Codex hook payloads carry no effort (FR-51: unavailable). Paths are evidence strings only.
import { TOOL_INPUT_PREVIEW } from '../claude/hooks.ts';

export const CODEX_HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact',
  'PostCompact', 'UserPromptSubmit', 'Stop', 'Interrupt',
] as const;
export const CODEX_ASYNC_EVENTS: readonly string[] = ['SessionStart', 'PostToolUse'];

export interface CodexHookEvidence {
  event: string; sessionId: string | null; turnId: string | null; transcriptPath: string | null; cwd: string | null;
  model: string | null; effort: null; permissionMode: string | null; source: string | null; toolName: string | null;
  toolUseId: string | null; toolInputPreview: string | null;
  /** Payload fields this mapping does not use, as received. */
  extra: Record<string, unknown>;
}

const USED = new Set(['session_id', 'turn_id', 'transcript_path', 'cwd', 'hook_event_name', 'model', 'permission_mode', 'source',
  'tool_name', 'tool_use_id', 'tool_input']);

/** `payload` is null for a malformed or truncated delivery; `event` is the envelope's event name. */
export function mapCodexHook(payload: Record<string, unknown> | null, event: string): CodexHookEvidence {
  const p = payload ?? {};
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null);
  return {
    event: s('hook_event_name') ?? event, sessionId: s('session_id'), turnId: s('turn_id'), transcriptPath: s('transcript_path'),
    cwd: s('cwd'), model: s('model'), effort: null, permissionMode: s('permission_mode'), source: s('source'), toolName: s('tool_name'),
    toolUseId: s('tool_use_id'),
    toolInputPreview: p['tool_input'] === undefined ? null : [...(JSON.stringify(p['tool_input']) ?? '')].slice(0, TOOL_INPUT_PREVIEW).join(''),
    extra: Object.fromEntries(Object.entries(p).filter(([k]) => !USED.has(k))),
  };
}
