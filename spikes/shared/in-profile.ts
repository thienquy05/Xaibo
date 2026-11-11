// P0-T05 isolated temp-profile runner, logic half. in-profile.sh calls `prepare`, which validates the targets,
// creates the profile, writes the read/write-deny Seatbelt profile, self-checks it with a canary, and prints
// NUL-separated records: cwd, agent-for-version ('' if the command is not the agent), token, pids file,
// prefix length, prefix (env -i … sandbox-exec -f …), command. Other commands: block-start|block-end <spike>
// (backstop for escaped processes), cleanup <agent> <slot> (signal recorded supervisors only).
// Refusal messages name the check, never a path.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRootEnv, type EnvKey } from './guard.ts';

export const AGENTS = ['claude', 'codex', 'gemini'] as const;
export type Agent = (typeof AGENTS)[number];
export type GeminiLayout = 'default' | 'unset' | 'custom';
export interface Root { path: string; file: boolean }
export interface Layout {
  repo: string; P: string; profile: string; home: string; data: string; tmp: string;
  geminiCliHome?: string; raw?: string; projects?: string;
}
interface Target { name: string; path: string; allowed: string[] }

const SLOTS = ['a', 'b'];
const SENTINEL = '.xaibo-temp-profile';
// Outside the repo (owner decision D-P0-15): the harness-os VM mounts the repo; temp credentials must not be visible there.
export const DEFAULT_PROFILE_ROOT = path.join(os.homedir(), '.xaibo-spike-profiles');
// Version freeze and Codex sandbox off (OQ-X16 owner choice: its tool sandbox cannot nest in our wrapper). Keys confirmed
// in the installed binaries/bundle; written once when a profile is created, never over an existing file.
const FREEZE_FILES: Record<Agent, (l: Layout) => [string, string][]> = {
  claude: () => [],
  codex: (l) => [[path.join(l.home, '.codex', 'config.toml'), 'check_for_update_on_startup = false\ncli_auth_credentials_store = "file"\nsandbox_mode = "danger-full-access"\n']],
  gemini: (l) => [[path.join(l.geminiCliHome ?? l.home, '.gemini', 'settings.json'), '{"general": {"enableAutoUpdate": false, "enableAutoUpdateNotification": false}}\n']],
};
const PASS_THROUGH = ['PATH', 'TERM', 'LANG', 'USER', 'LOGNAME', 'SHELL'] as const;
const DEFAULTS: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'dumb', LANG: 'en_US.UTF-8' };
// UNVERIFIED names until confirmed from the installed version's docs (P0-T05 version freeze, P0-T06 step 1).
const CLAUDE_FREEZE = { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
// Gemini 0.46.0 keeps OAuth tokens in one fixed-name keychain item shared by every profile unless this is set;
// with it, tokens go to <GEMINI_CLI_HOME>/.gemini/gemini-credentials.json inside the profile (P0-T06 step 1).
const ISOLATION_FIXED = { GEMINI_FORCE_FILE_STORAGE: 'true' };

// realpath of the nearest existing ancestor plus the rest, so not-yet-created paths resolve like created ones.
export function resolveReal(p: string): string {
  let head = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(head)) { rest.unshift(path.basename(head)); head = path.dirname(head); }
  return path.join(realpathSync.native(head), ...rest); // native: on-disk letter case (Seatbelt matches it byte for byte)
}

const under = (p: string, root: string) => p === root || p.startsWith(root === '/' ? root : `${root}/`);

export function realRoots(home: string, env: Partial<Record<EnvKey, string[]>>): Root[] {
  const dirs = [
    path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.gemini'),
    path.join(home, 'Library/Application Support/Xaibo'), path.join(home, 'Library/Application Support/XaiboSpike'),
    ...(env.CLAUDE_CONFIG_DIR ?? []), ...(env.CODEX_HOME ?? []),
    ...(env.GEMINI_CLI_HOME ?? []).map((g) => path.join(g, '.gemini')), // GEMINI_CLI_HOME is the store's parent, never a root
  ];
  return [...dirs.map((p) => ({ path: p, file: false })), { path: path.join(home, '.claude.json'), file: true }];
}

export function layoutFor(repo: string, agent: Agent, slot: string, gemini: GeminiLayout, spike?: string, P = DEFAULT_PROFILE_ROOT): Layout {
  const profile = path.join(P, `${agent}-${slot}`);
  const home = path.join(profile, 'home');
  return {
    repo, P, profile, home,
    data: path.join(profile, 'xaibo-data'),
    tmp: path.join(profile, 'tmp'),
    geminiCliHome: gemini === 'unset' ? undefined : gemini === 'custom' ? path.join(profile, 'cli-home') : home,
    raw: spike ? path.join(repo, '.cache', 'spike-results', spike, 'raw') : undefined,
    projects: spike ? path.join(repo, '.cache', 'spike-projects', spike) : undefined,
  };
}

export function buildEnv(l: Layout, agent: Agent, inherited: NodeJS.ProcessEnv, token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH) { const v = inherited[k] ?? DEFAULTS[k]; if (v) env[k] = v; }
  Object.assign(env, {
    HOME: l.home,
    CLAUDE_CONFIG_DIR: path.join(l.home, '.claude'),
    CODEX_HOME: path.join(l.home, '.codex'),
    XAIBO_DATA_DIR: l.data,
    TMPDIR: l.tmp,
    XAIBO_RUN_TOKEN: token,
    ...ISOLATION_FIXED,
  });
  if (l.geminiCliHome) env.GEMINI_CLI_HOME = l.geminiCliHome;
  if (l.raw) env.XAIBO_SPIKE_RAW = l.raw;
  if (agent === 'claude') Object.assign(env, CLAUDE_FREEZE);
  return env;
}

export function targetsFor(l: Layout, cwd: string): Target[] {
  const inProfile = (name: string, p: string): Target => ({ name, path: p, allowed: [l.profile] });
  return [
    inProfile('HOME', l.home),
    inProfile('CLAUDE_CONFIG_DIR', path.join(l.home, '.claude')),
    inProfile('CODEX_HOME', path.join(l.home, '.codex')),
    ...(l.geminiCliHome ? [inProfile('GEMINI_CLI_HOME', l.geminiCliHome)] : []),
    inProfile('XAIBO_DATA_DIR', l.data),
    inProfile('TMPDIR', l.tmp),
    ...(l.raw ? [{ name: 'XAIBO_SPIKE_RAW', path: l.raw, allowed: [l.raw] }] : []),
    { name: 'cwd', path: cwd, allowed: [l.profile, l.raw, l.projects].filter((x): x is string => !!x) },
  ];
}

export function checkTargets(targets: Target[], roots: Root[]): string[] {
  const realRootPaths = roots.map((r) => resolveReal(r.path));
  const errors: string[] = [];
  for (const t of targets) {
    const rp = resolveReal(t.path);
    if (!t.allowed.some((a) => under(rp, resolveReal(a)))) errors.push(`${t.name} outside its allowed root`);
    if (realRootPaths.some((rr) => under(rp, rr) || under(rr, rp))) errors.push(`${t.name} overlaps a real root`);
  }
  return errors;
}

const UNSAFE = /["\\\x00-\x1f\x7f]/;

// One deny rule per root; each covers the literal and the resolved path (Seatbelt matches resolved vnode paths).
export function denyProfile(roots: Root[]): string {
  const rules = roots.map((r) => {
    if (!path.isAbsolute(r.path)) throw new Error('deny root not absolute');
    const forms = [...new Set([path.resolve(r.path), resolveReal(r.path)])];
    if (forms.some((f) => UNSAFE.test(f))) throw new Error('deny root has characters that cannot be quoted safely');
    const filters = forms.map((f) => `(${r.file ? 'literal' : 'subpath'} "${f}")`).join(' ');
    return `(deny file-read* file-write* ${filters})`;
  });
  return ['(version 1)', '(allow default)', ...rules, ''].join('\n');
}

function refuse(reason: string): never {
  process.stderr.write(`in-profile: refused: ${reason}\n`);
  process.exit(3);
}

const sandboxed = (sb: string, argv: string[]) => spawnSync('/usr/bin/sandbox-exec', ['-f', sb, ...argv], { stdio: 'ignore' }).status === 0;

// Canary: a read and a write of the deny-listed canary must fail, a write into the profile tmp must succeed.
export function canaryOk(sb: string, canaryDir: string, okDir: string): boolean {
  const okFile = path.join(okDir, '.wrapper-ok');
  return !sandboxed(sb, ['/bin/cat', path.join(canaryDir, 'canary.txt')])
    && !sandboxed(sb, ['/usr/bin/touch', path.join(canaryDir, 'written')])
    && sandboxed(sb, ['/usr/bin/touch', okFile]);
}

function prepare(argv: string[]) {
  const args = [...argv];
  let spike: string | undefined;
  let gemini: GeminiLayout = 'default';
  while (args[0]?.startsWith('--') && args[0] !== '--') {
    const flag = args.shift();
    if (flag === '--spike') spike = args.shift();
    else if (flag === '--gemini-layout') gemini = args.shift() as GeminiLayout;
    else refuse('unknown flag');
  }
  const [agent, slot, sep, ...cmd] = args;
  if (!AGENTS.includes(agent as Agent) || !SLOTS.includes(slot) || sep !== '--' || cmd.length === 0) refuse('usage: in-profile.sh [--spike <id>] [--gemini-layout unset|custom] <agent> <slot> -- <cmd…>');
  if (spike !== undefined && !/^[a-z0-9-]+$/.test(spike)) refuse('bad spike id');
  if (!['default', 'unset', 'custom'].includes(gemini)) refuse('bad gemini layout');
  if (gemini !== 'default' && agent !== 'gemini') refuse('gemini layout only applies to gemini');

  const repo = realpathSync(path.join(import.meta.dirname, '..', '..'));
  const l = layoutFor(repo, agent as Agent, slot, gemini, spike);
  const roots = realRoots(os.homedir(), readRootEnv());
  const canaryDir = path.join(l.P, '.deny-canary');

  const sentinel = path.join(l.profile, SENTINEL);
  if (existsSync(l.profile) && !existsSync(sentinel)) refuse('profile dir exists without the temp-profile sentinel');
  const preErrors = checkTargets(targetsFor(l, l.home), roots);
  if (preErrors.length) refuse(preErrors.join('; '));
  for (const d of [l.profile, l.home, l.data, l.tmp, l.geminiCliHome, l.raw, canaryDir]) if (d) mkdirSync(d, { recursive: true, mode: 0o700 });
  if (!existsSync(sentinel)) {
    mkdirSync(l.P, { recursive: true, mode: 0o700 });
    for (const [f, body] of FREEZE_FILES[agent as Agent](l)) {
      mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      if (!existsSync(f)) writeFileSync(f, body, { mode: 0o600 });
    }
    writeFileSync(sentinel, '', { mode: 0o600 });
  }
  writeFileSync(path.join(canaryDir, 'canary.txt'), 'canary\n', { mode: 0o600 });

  const here = process.cwd();
  const cwd = checkTargets(targetsFor(l, here), roots).length === 0 ? here : l.home;
  const errors = checkTargets(targetsFor(l, cwd), roots);
  if (errors.length) refuse(errors.join('; '));

  const allRoots = [...roots, { path: canaryDir, file: false }];
  let sbText: string;
  try { sbText = denyProfile(allRoots); } catch { refuse('deny profile generation failed'); }
  if ((sbText.match(/^\(deny /gm) ?? []).length !== allRoots.length) refuse('deny profile rule count mismatch');
  const sb = path.join(l.profile, 'sandbox.sb');
  writeFileSync(sb, sbText, { mode: 0o600 });
  if (!canaryOk(sb, canaryDir, l.tmp)) refuse('sandbox-exec wrapper could not be established (canary)');

  const token = randomBytes(16).toString('hex');
  const env = buildEnv(l, agent as Agent, process.env, token);
  const prefix = ['/usr/bin/env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), '/usr/bin/sandbox-exec', '-f', sb];
  const versionAgent = path.basename(cmd[0]) === agent ? agent : '';
  const out = [cwd, versionAgent, token, path.join(l.profile, 'pids'), String(prefix.length), ...prefix, ...cmd];
  process.stdout.write(`${out.join('\0')}\0`);
}

// Own-user processes except this one and its ps child; key = pid + lstart (fields: pid ppid lstart×5 comm).
const ownProcesses = () => execFileSync('/bin/ps', ['-U', String(process.getuid!()), '-o', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8' })
  .split('\n').map((l) => l.trim()).filter(Boolean)
  .filter((l) => { const [pid, ppid] = l.split(/\s+/).map(Number); return pid !== process.pid && ppid !== process.pid; });
const procKey = (line: string) => { const f = line.split(/\s+/); return [f[0], ...f.slice(2, 7)].join(' '); };

function block(cmd: string, spike: string) {
  if (!/^[a-z0-9-]+$/.test(spike ?? '')) refuse('bad spike id');
  const dir = path.join(import.meta.dirname, '..', '..', '.cache', 'spike-results', spike);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'block-pre.json');
  if (cmd === 'block-start') { writeFileSync(file, JSON.stringify(ownProcesses().map(procKey)), { mode: 0o600 }); console.log('block-start ok'); return 0; }
  const pre = new Set(JSON.parse(readFileSync(file, 'utf8')) as string[]);
  const fresh = ownProcesses().filter((l) => !pre.has(procKey(l)));
  writeFileSync(path.join(dir, 'block-new.txt'), `${fresh.join('\n')}\n`, { mode: 0o600 }); // local only: PIDs and names
  console.log(`new-processes ${fresh.length}`);
  return fresh.length ? 1 : 0;
}

// P0-T09: signal only supervisors whose recorded start time and argv still match.
function cleanup(agent: string, slot: string) {
  if (!AGENTS.includes(agent as Agent) || !SLOTS.includes(slot)) refuse('usage: cleanup <agent> <slot>');
  const pids = path.join(DEFAULT_PROFILE_ROOT, `${agent}-${slot}`, 'pids');
  let n = 0;
  for (const line of existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean) : []) {
    const [pid, lstart] = line.split('\t');
    const now = spawnSync('/bin/ps', ['-o', 'lstart=,command=', '-p', pid], { encoding: 'utf8' }).stdout.trim();
    if (now.startsWith(lstart) && now.includes('supervise.pl')) { process.kill(Number(pid), 'SIGTERM'); n++; }
  }
  console.log(`signalled ${n}`);
  return 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'prepare') prepare(rest);
  else if (cmd === 'block-start' || cmd === 'block-end') process.exitCode = block(cmd, rest[0]);
  else if (cmd === 'cleanup') process.exitCode = cleanup(rest[0], rest[1]);
  else refuse('usage: in-profile.ts prepare|block-start|block-end|cleanup …');
}
