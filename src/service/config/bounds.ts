// P6-T03 (FR-32; design review H3, M4): where Xaibo may write agent config. Real agent roots (~/.claude, ~/.codex, ~/.gemini,
// ~/.claude.json under both $HOME and the passwd home, plus CLAUDE_CONFIG_DIR/CODEX_HOME/GEMINI_CLI_HOME from the login shell
// and this process) are denied, with no override; a login environment that could not be read gives no list (callers refuse).
// Until P6-T12 the service writes only disposable profiles: strictly below an allowed root, every directory from the profile
// up to that root owned by this user and not group/world-writable (a shared /tmp fallback is refused), and never a root that
// holds the home (P6-T03 code review M-b). P6-T12 adds real-profile writes after Gate 6; never an env var or an IPC field.
// ponytail: owner and the 022 mode bits only; macOS ACLs granting others write are not read.
import { lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LoginEnv } from '../catalog/env.ts';
import { within } from './transaction.ts';

const ROOT_NAMES = ['.claude', '.codex', '.gemini', '.claude.json'];
const ENV_ROOTS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME'] as const;
export const real = (p: string) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };

/** The real-root denylist from the login environment; null when it could not be read (no PATH). */
export function deniedRootsFrom(login: LoginEnv, env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (!login.PATH) return null;
  const homes = new Set([os.homedir(), os.userInfo().homedir]);
  return [
    ...[...homes].flatMap((h) => ROOT_NAMES.map((n) => path.join(h, n))),
    ...ENV_ROOTS.flatMap((k) => [login[k], env[k]]).filter((v): v is string => !!v),
  ].map(real);
}

const uid = process.getuid?.();
const privateDir = (d: string) => {
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
