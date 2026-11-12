// Hook config lint (P3-T03, EC-64): every hook template and engine-generated entry must be a command hook that runs
// exactly `'<shim>' hook <agent> <profile_key>` (the agent runs it through a shell, so nothing else may follow), never a
// prompt or agent hook (they add tokens), and async wherever the agent supports it (Stop stays synchronous, S3).
// Entries are found by shape: any object with a `type` is a hook; its event is the nearest array-valued key that is
// not `hooks` (Claude/Codex `{hooks: {Event: [{hooks: [...]}]}}`, agy `{group: {Event: [... ]}}`).
export type HookLintCode = 'forbidden-type' | 'not-command' | 'not-shim' | 'async-required' | 'empty';
export interface HookLintOptions { shim: string; asyncRequired: boolean; syncEvents?: readonly string[] }

const FORBIDDEN_TYPES = new Set(['prompt', 'agent']);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function lintHooks(value: unknown, o: HookLintOptions): HookLintCode[] {
  if (o.shim.includes("'")) throw new Error('hook lint: the shim path must not contain a single quote');
  const command = new RegExp(`^'${escape(o.shim)}' hook [a-z0-9][a-z0-9-]{0,31} [A-Za-z0-9._-]{1,128}$`);
  const sync = new Set(o.syncEvents ?? ['Stop']);
  const found = new Set<HookLintCode>();
  let entries = 0;
  const check = (h: Record<string, unknown>, event: string) => {
    entries++;
    if (FORBIDDEN_TYPES.has(h['type'] as string)) { found.add('forbidden-type'); return; }
    if (h['type'] !== 'command') { found.add('not-command'); return; }
    if (typeof h['command'] !== 'string' || !command.test(h['command'])) found.add('not-shim');
    if (o.asyncRequired && !sync.has(event) && h['async'] !== true) found.add('async-required');
  };
  const walk = (v: unknown, event: string) => {
    if (Array.isArray(v)) { v.forEach((x) => walk(x, event)); return; }
    if (!isObject(v)) return;
    if ('type' in v) { check(v, event); return; }
    for (const [k, x] of Object.entries(v)) walk(x, Array.isArray(x) && k !== 'hooks' ? k : event);
  };
  walk(value, '');
  if (!entries) found.add('empty');
  return [...found];
}
