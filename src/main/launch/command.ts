// XAIBO-PROD-614 (P7-T02, EC-76; design .handoff/p7-designs.md, Claude from the plan, D-P7-02): launch argument safety. The
// external-terminal command (a private .command file, OQ-P7-1) is assembled only from validated whole-argument tokens, each
// POSIX single-quoted: the agent's own executable (absolute, realpath-resolved, a regular file with the execute bit; never a
// shell, interpreter or package runner, by the given name or the resolved one), the template's tokens (a placeholder only as
// a whole token: {id}, {cwd}), the native id (claude, codex, agy: lowercase UUID; others only by a catalog-declared pattern
// that matches the whole id; never a leading dash) and the cwd (an existing directory, entered with cd --). Typed fields only:
// no transcript, catalog or user shell string is ever a token source. No ownership input: stale ownership is never control
// (P7-T06 owns badges). Pure: no Electron, no child process; P7-T04 wires it, P7-T03 gates it with grants.
// Security review (MEDIUM): the trust boundary is where the executable and template come from (detection plus the P7-T03 grant,
// which binds the executable's bytes and the template; templates are the bundled catalog's or an imported entry's, shown in
// that grant), not these name checks: the given name must be one of the catalog's names for the agent, and an interpreter,
// package runner or command wrapper (any case, given or resolved name) is refused as a second layer. ponytail: a renamed copy
// of a shell under an agent's name passes here; the grant's hash is what binds it.
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export interface LaunchCommand {
  agent: string;
  executable: string;
  /** The argument template: whole tokens; '{id}' and '{cwd}' only as an entire token. */
  args: readonly string[];
  nativeId?: string;
  cwd: string;
  /** The catalog's executable names for this agent; the given path's basename must be one of them. */
  names: readonly string[];
  /** XAIBO-PROD-615: the granted environment key names (beside BASE_ENV); the script passes nothing else. */
  envKeys: readonly string[];
  /** A catalog-declared native-id pattern (matched against the whole id), for agents other than claude, codex and agy. */
  idPattern?: RegExp;
}
export type Refusal = 'executable' | 'interpreter' | 'name' | 'cwd' | 'id' | 'placeholder' | 'text' | 'env';
/** argv: the resolved executable and its arguments (for a no-shell spawn); script: the .command text. */
export type Built = { ok: true; argv: string[]; script: string } | { ok: false; reason: Refusal };

/** XAIBO-PROD-615: what every launched agent gets; anything else only by a granted key name. */
export const BASE_ENV = ['PATH', 'HOME', 'LANG', 'TERM', 'USER', 'SHELL', 'TMPDIR'] as const;
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_AGENTS = new Set(['claude', 'codex', 'agy']);
/** Shells, interpreters, package runners and command wrappers (deno and bun outright: neither is an agent CLI). */
const INTERPRETER = /^(?:sh|bash|zsh|fish|dash|ksh|csh|tcsh|pwsh|env|node|nodejs|tsx|ts-node|python[\d.]*|ruby[\d.]*|irb|perl[\d.]*|php[\d.]*|lua[\d.]*|tclsh[\d.]*|expect|awk|gawk|swift|osascript|npx|npm|pnpm|pnpx|bun|bunx|yarn|uv|uvx|pipx|deno|nice|nohup|arch|time|timeout|xargs|caffeinate|script|sudo|doas|xcrun|sandbox-exec|open)$/i;
const PLACEHOLDER = /\{[^}]*\}/;
/** A NUL or a lone surrogate (written as U+FFFD, so the script and argv would differ). */
const badText = (s: string) => s.includes('\0') || !s.isWellFormed();

/** POSIX single quotes: the token as one word, nothing inside evaluated. */
export const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function resolved(p: string, dir: boolean): string | null {
  if (!path.isAbsolute(p) || p.includes('\0')) return null;
  try {
    const r = realpathSync.native(p), st = statSync(r);
    if (dir ? !st.isDirectory() : !st.isFile()) return null;
    if (!dir) accessSync(r, constants.X_OK);
    return r;
  } catch { return null; }
}

function idOk(agent: string, id: string, declared: RegExp | undefined): boolean {
  if (UUID_AGENTS.has(agent)) return UUID.test(id);
  if (!declared || id === '' || id.startsWith('-') || badText(id)) return false;
  return new RegExp(`^(?:${declared.source})$`, declared.flags.replace(/[gmy]/g, '')).test(id); // the whole id, never a part of it
}

export function buildCommand(c: LaunchCommand): Built {
  const no = (reason: Refusal): Built => ({ ok: false, reason });
  const exe = resolved(c.executable, false);
  if (!exe) return no('executable');
  if ([c.executable, exe].some((p) => INTERPRETER.test(path.basename(p)))) return no('interpreter');
  if (!c.names.includes(path.basename(c.executable))) return no('name');
  const cwd = resolved(c.cwd, true);
  if (!cwd) return no('cwd');
  if (c.nativeId !== undefined && !idOk(c.agent, c.nativeId, c.idPattern)) return no('id');
  if (!c.envKeys.every((k) => ENV_KEY.test(k))) return no('env');
  const argv = [exe];
  for (const t of c.args) {
    if (badText(t)) return no('text');
    if (t === '{id}') { if (c.nativeId === undefined) return no('id'); argv.push(c.nativeId); continue; }
    if (t === '{cwd}') { argv.push(cwd); continue; }
    if (PLACEHOLDER.test(t)) return no('placeholder');
    argv.push(t);
  }
  // XAIBO-PROD-615 reviews (MEDIUM): Terminal runs the file with its own environment (launchd's, the login shell's exports), so
  // the agent starts under env -i with the fixed set plus the granted names only; ${K+"K=$K"} passes a set variable's value as
  // one word, read in the terminal at launch, never written here. /usr/bin/env is Xaibo's wrapper, not the agent's executable.
  const env = [...new Set([...BASE_ENV, ...c.envKeys])].map((k) => `\${${k}+"${k}=$${k}"}`).join(' ');
  return { ok: true, argv, script: `#!/bin/sh\ncd -- ${quote(cwd)} || exit 1\nexec /usr/bin/env -i ${env} ${argv.map(quote).join(' ')}\n` };
}
