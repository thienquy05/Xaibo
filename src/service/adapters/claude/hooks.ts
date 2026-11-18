// Claude Code hooks (P3-T05; PRD §5.2, EC-49): the subscribed event set and the effective hook policy from managed and
// user settings. Payloads are mapped to evidence by status-map.ts.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isObj } from '../../../shared/ipc.ts';

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
  'Notification', 'Elicitation', 'ElicitationResult', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'PreCompact',
  'PostCompact', 'CwdChanged', 'SessionEnd',
] as const;

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
  try { const v: unknown = JSON.parse(readFileSync(file, 'utf8')); return isObj(v) ? v : 'bad'; } catch { return 'bad'; }
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
