// P6-T03 (FR-32; design review H3, M4): where Xaibo may write agent config. Real agent roots (~/.claude, ~/.codex, ~/.gemini,
// ~/.claude.json under both $HOME and the passwd home, plus CLAUDE_CONFIG_DIR/CODEX_HOME/GEMINI_CLI_HOME from the login shell
// and this process) are denied, with no override; a login environment that could not be read gives no list (callers refuse).
// Disposable profiles: strictly below an allowed root, every directory from the profile up to that root owned by this user
// and not group/world-writable (a shared /tmp fallback is refused), and never a root that holds the home (P6-T03 code review
// M-b). XAIBO-PROD-599 (P6-T12 slice 1, D-P6-21): real profiles only while REAL_PROFILE_ENABLED, a literal flipped in the
// Gate 6 merge; never an env var, an IPC field or a setting (connect.ts realBounds). GEMINI_CLI_HOME holds a .gemini
// folder, so that folder is denied, not GEMINI_CLI_HOME itself (review M7).
// ponytail: owner and the 022 mode bits only; macOS ACLs granting others write are not read.
import { lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LoginEnv } from '../catalog/env.ts';
import { within } from './transaction.ts';

/** XAIBO-PROD-599: off on the branch until the Gate 6 merge (FR-32, D-P6-21); tests override it through createConnect only. */
export const REAL_PROFILE_ENABLED = false;
const ENV_ROOTS = { CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', GEMINI_CLI_HOME: '.gemini' } as const;
export const real = (p: string) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };

/** XAIBO-PROD-599 (code review M1): each agent's own real roots by agent id (agy shares the home's .gemini, never
 *  GEMINI_CLI_HOME); a real profile writes only under its own agent's. null when the login environment could not be read. */
export function agentRootsFrom(login: LoginEnv, env: NodeJS.ProcessEnv = process.env): Record<string, string[]> | null {
  if (!login.PATH) return null;
  const homes = [...new Set([os.homedir(), os.userInfo().homedir])];
  const at = (n: string) => homes.map((h) => path.join(h, n));
  const envs = (k: keyof typeof ENV_ROOTS) => [login[k], env[k]].filter((v): v is string => !!v).map((v) => path.join(v, ENV_ROOTS[k]));
  const roots = { claude: [...at('.claude'), ...envs('CLAUDE_CONFIG_DIR')], codex: [...at('.codex'), ...envs('CODEX_HOME')], gemini: [...at('.gemini'), ...envs('GEMINI_CLI_HOME')], agy: at('.gemini') };
  return Object.fromEntries(Object.entries(roots).map(([k, v]) => [k, v.map(real)]));
}

/** The real-root denylist from the login environment (every agent's roots plus ~/.claude.json); null when it could not be
 *  read (no PATH). */
export function deniedRootsFrom(login: LoginEnv, env: NodeJS.ProcessEnv = process.env): string[] | null {
  const a = agentRootsFrom(login, env);
  if (!a) return null;
  const homes = [...new Set([os.homedir(), os.userInfo().homedir])];
  return [...Object.values(a).flat(), ...homes.map((h) => real(path.join(h, '.claude.json')))];
}

const uid = process.getuid?.();
export const privateDir = (d: string) => {
  try { const st = lstatSync(d); return st.isDirectory() && (uid === undefined || st.uid === uid) && (st.mode & 0o022) === 0; } catch { return false; }
};
/** `dir` (an existing directory) is strictly below one of `allowed`, outside every `denied` root, and every directory from it
 *  up to and including that allowed root is private to this user. */
export function writable(dir: string, allowed: string[], denied: string[]): boolean {
  let d: string;
  try { d = realpathSync.native(dir); } catch { return false; }
  if (denied.some((x) => within(d, x))) return false;
  const homes = [os.homedir(), os.userInfo().homedir].map(real);
  return allowed.map(real).some((a) => {
    if (d === a || !within(d, a) || homes.some((h) => within(h, a))) return false;
    for (let cur = d; ; cur = path.dirname(cur)) {
      if (!privateDir(cur)) return false;
      if (cur === a) return true;
    }
  });
}
