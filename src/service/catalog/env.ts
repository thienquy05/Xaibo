// Login-shell environment (P1-T08, OQ-P1-03; EC-38/39): GUI apps get a minimal PATH and none of the user's agent
// home overrides, so read them once from `$SHELL -l -c '/usr/bin/env -0'`: fixed argv, no interpolation, stdin
// closed, 3 s, bounded output. Only four keys are kept; nothing else is stored or logged.
import path from 'node:path';
import type { Logger } from '../../shared/log.ts';
import { run, succeeded } from '../spawn.ts';

export const LOGIN_ENV_KEYS = ['PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME'] as const;
export type LoginEnv = Partial<Record<(typeof LOGIN_ENV_KEYS)[number], string>>;
export interface LoginEnvOptions { shell?: string | undefined; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number; log?: Logger }

const ARGV = ['-l', '-c', '/usr/bin/env -0'];
const isKey = (k: string): k is keyof LoginEnv => (LOGIN_ENV_KEYS as readonly string[]).includes(k);

/** NUL-separated `env -0` output; rc-file noise before the first entry and after the last NUL is dropped. */
export function parseEnv0(out: Buffer): LoginEnv {
  const env: LoginEnv = {};
  const entries = out.toString('utf8').split('\0');
  entries.pop();
  entries.forEach((e, i) => {
    const entry = i === 0 ? e.slice(e.lastIndexOf('\n') + 1) : e;
    const eq = entry.indexOf('=');
    const k = entry.slice(0, eq);
    const v = entry.slice(eq + 1);
    if (eq > 0 && isKey(k) && v) env[k] = v;
  });
  return env;
}

export async function readLoginEnv(o: LoginEnvOptions): Promise<LoginEnv> {
  const { shell, timeoutMs = 3_000, maxBytes = 256 * 1024 } = o;
  if (!shell || !path.isAbsolute(shell)) {
    o.log?.log('login_env', { ok: false });
    return {};
  }
  const r = await run(shell, ARGV, { timeoutMs, maxBytes, ...(o.env ? { env: o.env } : {}) });
  const env = succeeded(r) ? parseEnv0(r.stdout) : {};
  o.log?.log('login_env', { ok: succeeded(r), timedOut: r.timedOut, overflow: r.overflow, keys: Object.keys(env).length });
  return env;
}
