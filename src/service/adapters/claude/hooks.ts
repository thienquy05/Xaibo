// Claude Code hooks (P3-T05; PRD §5.2, FR-51, EC-49). The subscribed event set, the payload -> evidence mapping (the
// fields §5.2 uses, a bounded tool_input preview, model/effort only in their reported shapes; everything else kept raw
// in `extra`, never interpreted), and the effective hook policy from managed and user settings. Paths in payloads are
// evidence strings only, never dereferenced.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
  'Notification', 'Elicitation', 'ElicitationResult', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'PreCompact',
  'PostCompact', 'CwdChanged', 'SessionEnd',
] as const;
/** Code points of JSON.stringify(tool_input) kept as the preview; the full payload stays in the event's raw envelope. */
export const TOOL_INPUT_PREVIEW = 200;

export interface HookEvidence {
  event: string; sessionId: string | null; transcriptPath: string | null; cwd: string | null; promptId: string | null;
  permissionMode: string | null; agentId: string | null; agentType: string | null; toolName: string | null; toolUseId: string | null;
  toolInputPreview: string | null; notificationType: string | null; model: string | null; effort: string | null;
  /** Payload fields this mapping does not use, as received. */
  extra: Record<string, unknown>;
}

const USED = new Set(['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'prompt_id', 'permission_mode', 'agent_id', 'agent_type',
  'tool_name', 'tool_use_id', 'tool_input', 'notification_type', 'model', 'effort']);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `payload` is null for a malformed or truncated delivery; `event` is the envelope's event name. */
export function mapClaudeHook(payload: Record<string, unknown> | null, event: string): HookEvidence {
  const p = payload ?? {};
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null);
  const m = p['model'];
  const e = p['effort'];
  return {
    event: s('hook_event_name') ?? event, sessionId: s('session_id'), transcriptPath: s('transcript_path'), cwd: s('cwd'),
    promptId: s('prompt_id'), permissionMode: s('permission_mode'), agentId: s('agent_id'), agentType: s('agent_type'),
    toolName: s('tool_name'), toolUseId: s('tool_use_id'),
    toolInputPreview: p['tool_input'] === undefined ? null : [...(JSON.stringify(p['tool_input']) ?? '')].slice(0, TOOL_INPUT_PREVIEW).join(''),
    notificationType: s('notification_type'),
    model: typeof m === 'string' ? m : isObject(m) && typeof m['id'] === 'string' ? m['id'] : null,
    effort: typeof e === 'string' ? e : isObject(e) && typeof e['level'] === 'string' ? e['level'] : null,
    extra: Object.fromEntries(Object.entries(p).filter(([k]) => !USED.has(k))),
  };
}

/** macOS system managed-settings location (managed-settings.json plus managed-settings.d/*.json). */
export const CLAUDE_MANAGED_DIR = '/Library/Application Support/ClaudeCode';
export type PolicyReason = 'disable-all-hooks-managed' | 'disable-all-hooks-user' | 'managed-hooks-only' | 'marketplaces-restricted' | 'policy-unreadable';
export interface HookPolicy {
  state: 'ok' | 'blocked' | 'unknown'; reasons: PolicyReason[]; notes: 'http-hook-allowlist'[];
  coverage: { label: 'hooks blocked by policy' | 'hook policy unknown'; mode: 'files-only' } | null;
}

const MAX_SETTINGS = 1 << 20;
const absent = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '');
/** null when absent; 'bad' when unreadable (permission denied included), oversized, not JSON or not an object. */
function settings(file: string): Record<string, unknown> | null | 'bad' {
  let st;
  try { st = lstatSync(file); } catch (e) { return absent(e) ? null : 'bad'; }
  if (!st.isFile() || st.size > MAX_SETTINGS) return 'bad';
  try { const v: unknown = JSON.parse(readFileSync(file, 'utf8')); return isObject(v) ? v : 'bad'; } catch { return 'bad'; }
}

/** EC-49: what blocks the plugin route's command hooks. Project settings are per project and not read here. */
export function claudeHookPolicy(o: { managedDir?: string; configDir: string }): HookPolicy {
  const dir = o.managedDir ?? CLAUDE_MANAGED_DIR;
  let dropIns: string[] = [];
  let listing: 'bad' | null = null;
  try { dropIns = readdirSync(path.join(dir, 'managed-settings.d')).filter((n) => n.endsWith('.json')).sort(); } catch (e) { if (!absent(e)) listing = 'bad'; }
  const managed = [listing, ...[path.join(dir, 'managed-settings.json'), ...dropIns.map((n) => path.join(dir, 'managed-settings.d', n))].map(settings)];
  const user = settings(path.join(o.configDir, 'settings.json'));
  if ([...managed, user].includes('bad')) {
    return { state: 'unknown', reasons: ['policy-unreadable'], notes: [], coverage: { label: 'hook policy unknown', mode: 'files-only' } };
  }
  const m = managed.filter((x): x is Record<string, unknown> => x !== null);
  const u = user as Record<string, unknown> | null;
  const reasons: PolicyReason[] = [];
  if (m.some((x) => x['disableAllHooks'] === true)) reasons.push('disable-all-hooks-managed');
  if (u?.['disableAllHooks'] === true) reasons.push('disable-all-hooks-user');
  if (m.some((x) => x['allowManagedHooksOnly'] === true)) reasons.push('managed-hooks-only');
  if (m.some((x) => Array.isArray(x['strictKnownMarketplaces']))) reasons.push('marketplaces-restricted'); // ours is a local dir
  const notes: HookPolicy['notes'] = [...m, ...(u ? [u] : [])].some((x) => x['allowedHttpHookUrls'] !== undefined) ? ['http-hook-allowlist'] : [];
  return reasons.length
    ? { state: 'blocked', reasons, notes, coverage: { label: 'hooks blocked by policy', mode: 'files-only' } }
    : { state: 'ok', reasons, notes, coverage: null };
}
