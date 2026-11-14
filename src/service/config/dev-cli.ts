// FR-32 dev CLI (P3-T01): the only agent-config writer until Gate 6, and only into disposable profiles.
//   XAIBO_DATA_DIR=<abs> node src/service/config/dev-cli.ts plan|apply|revert|status --target <t> --profile <dir>
//     [--change <ops.json>] [--yes]
//   claude-plugin (P3-T05): apply|revert also take --claude <exe> --profile-key <key> [--forwarder <file>]; apply deploys
//   the shim and forwarder into <dataDir>/integrations/bin, then installs through `claude plugin` with CLAUDE_CONFIG_DIR =
//   <dir>/.claude and HOME = <dir>
//   codex-hooks (P3-T06): plan|apply with --profile-key <key> [--forwarder <file>] instead of --change append the Xaibo
//   hook groups to <dir>/.codex/hooks.json and print the guided trust steps; revert is the generic one
// <dir> is a profile HOME. Real agent roots (~/.claude, ~/.codex, ~/.gemini, ~/.claude.json under both $HOME and the
// passwd home, plus CLAUDE_CONFIG_DIR/CODEX_HOME/GEMINI_CLI_HOME from the login shell and this process) are refused,
// with no override; a login environment that cannot be read refuses too. Writes need a typed `yes` on a TTY; `--yes`
// is accepted only for profiles strictly below the temp dir or <repo>/.cache/profiles/. The printed diff shows Xaibo
// values only (replaced foreign values as type + hash). No renderer Connect IPC until Phase 6.
//   agy-hooks (P3-T13d): plan|apply with --profile-key <key> [--project <dir>] [--forwarder <file>] instead of --change
//   add the Xaibo group to <dir>/.gemini/config/hooks.json; the project's .agents/hooks.json is only inspected (a Xaibo
//   hook there refuses); revert is the generic one
//   claude-tee (P3-T14): plan|apply with --profile-key <key> [--forwarder <file>] [--statusline <file>] instead of --change
//   point <dir>/.claude/settings.json's statusLine at the xaibo-statusline tee (only its command; the original stays in
//   the manifest); revert is the generic one
//   P3-T13b report registrations: register --agent <id> --profile-key <key> [--yes] | revoke --id <uuid> [--yes]
//   register prints the registration id and its token once (only the token's hash is stored, <dataDir>/registrations.json);
//   --yes is accepted only for a data dir strictly below the temp dir. Revoking cuts the producer's open connections.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { deployShim, installPlugin, installTee, MARKETPLACE, PLUGIN_REF, teePlan, uninstallPlugin } from '../adapters/claude/setup.ts';
import { checkAgyInstall, installAgyHooks } from '../adapters/agy/setup.ts';
import { codexHookOps, codexTrustSteps, installCodexHooks, shimPath } from '../adapters/codex/setup.ts';
import { readLoginEnv } from '../catalog/env.ts';
import { addRegistration, RegistrationError, removeRegistration } from '../receivers/registrations.ts';
import {
  apply, ConfigError, plan, readManifest, resolveTarget, revert, validateOps, within, type Bounds, type Plan, type Route,
} from './transaction.ts';

const TARGETS: Record<string, { file: string; route: Route | null }> = {
  'claude-plugin': { file: '.claude/settings.json', route: null },
  'claude-settings-fallback': { file: '.claude/settings.json', route: 'claude-settings-fallback' },
  'claude-tee': { file: '.claude/settings.json', route: 'claude-tee' },
  'codex-hooks': { file: '.codex/hooks.json', route: 'codex-hooks' },
  'agy-hooks': { file: '.gemini/config/hooks.json', route: 'agy-hooks' },
};
const COMMANDS = new Set(['plan', 'apply', 'revert', 'status']);
const ROOT_NAMES = ['.claude', '.codex', '.gemini', '.claude.json'];
const ENV_ROOTS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME'] as const;
const MAX_OPS_BYTES = 1 << 20;
const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

class UsageError extends Error {}
const refuse = (msg: string): never => { throw new UsageError(msg); };
const real = (p: string) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };

function parseArgs(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || !COMMANDS.has(cmd)) refuse('usage: dev-cli.ts plan|apply|revert|status --target <t> --profile <dir> [--change <ops.json>] [--yes]');
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]!;
    if (k === '--yes') flags['yes'] = true;
    else if (['--target', '--profile', '--change', '--claude', '--profile-key', '--forwarder', '--project', '--statusline'].includes(k) && rest[i + 1] !== undefined) flags[k.slice(2)] = rest[++i]!;
    else refuse(`unknown argument: ${k}`);
  }
  const target = flags['target'];
  if (typeof target !== 'string' || !TARGETS[target]) refuse(`--target must be one of ${Object.keys(TARGETS).join(', ')}`);
  if (typeof flags['profile'] !== 'string') refuse('--profile <dir> is required');
  const opt = (k: string) => flags[k] as string | undefined;
  return {
    cmd: cmd!, target: target as string, profile: flags['profile'] as string, change: opt('change'), yes: flags['yes'] === true,
    claude: opt('claude'), profileKey: opt('profile-key'), forwarder: opt('forwarder'), project: opt('project'), statusline: opt('statusline'),
  };
}

async function deniedRoots(): Promise<string[]> {
  const login = await readLoginEnv({ shell: process.env['SHELL'] });
  if (!login.PATH) refuse('refused: the login shell environment could not be read, so agent home overrides are unknown');
  const homes = new Set([os.homedir(), os.userInfo().homedir]);
  return [
    ...[...homes].flatMap((h) => ROOT_NAMES.map((n) => path.join(h, n))),
    ...ENV_ROOTS.flatMap((k) => [login[k], process.env[k]]).filter((v): v is string => !!v),
  ].map(real);
}

/** `--yes` only for a profile strictly below the temp dir (unless that holds the real home) or .cache/profiles/. */
function yesAllowed(profile: string): boolean {
  const tmp = real(os.tmpdir());
  const below = (root: string) => profile !== root && within(profile, root);
  return (below(tmp) && !within(real(os.userInfo().homedir), tmp)) || below(real(path.join(REPO, '.cache', 'profiles')));
}

async function confirm(yes: boolean, profile: string, what: string, allowed = yesAllowed(profile)) {
  if (yes) {
    if (!allowed) refuse('refused: --yes is accepted only for disposable locations (temp dir, .cache/profiles/); confirm on a TTY instead');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) refuse('refused: confirmation needs a TTY (type yes) or --yes for a disposable profile');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type yes to ${what}: `);
  rl.close();
  if (answer.trim() !== 'yes') refuse('not confirmed; nothing written');
}

function readOps(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_OPS_BYTES) refuse('--change must be a regular file of at most 1 MiB');
    const buf = Buffer.alloc(st.size);
    for (let n = 0; n < buf.length;) n += readSync(fd, buf, n, buf.length - n, null) || buf.length;
    try { return validateOps(JSON.parse(buf.toString('utf8'))); } catch { return refuse('--change must hold a JSON array of {op, pointer, value}'); }
  } finally {
    closeSync(fd);
  }
}

const show = (v: unknown) => JSON.stringify(v);

/** P3-T13b: approve or revoke a report producer. --yes only for a data dir strictly below the temp dir (tests). */
async function registration(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]!;
    if (k === '--yes') flags['yes'] = true;
    else if (['--agent', '--profile-key', '--id'].includes(k) && rest[i + 1] !== undefined) flags[k.slice(2)] = rest[++i]!;
    else refuse(`unknown argument: ${k}`);
  }
  const dataDir = process.env['XAIBO_DATA_DIR'];
  if (!dataDir || !path.isAbsolute(dataDir)) refuse('XAIBO_DATA_DIR must be an absolute path');
  const tmp = real(os.tmpdir());
  const dir = real(dataDir!);
  const disposable = dir !== tmp && within(dir, tmp) && !within(real(os.userInfo().homedir), tmp);
  const yes = flags['yes'] === true;
  if (cmd === 'revoke') {
    if (typeof flags['id'] !== 'string') refuse('usage: dev-cli.ts revoke --id <registration> [--yes]');
    await confirm(yes, dir, `revoke report registration ${flags['id'] as string}`, disposable);
    if (!removeRegistration(dataDir!, flags['id'] as string)) refuse('no such registration');
    console.log(`revoked ${flags['id'] as string}`);
    return 0;
  }
  const agent = flags['agent'], key = flags['profile-key'];
  if (typeof agent !== 'string' || typeof key !== 'string') refuse('usage: dev-cli.ts register --agent <id> --profile-key <key> [--yes]');
  await confirm(yes, dir, `register a report producer for agent ${agent as string}, profile ${key as string}`, disposable);
  const { registration: r, token } = addRegistration(dataDir!, { agent: agent as string, profileKey: key as string });
  console.log(`registered ${r.id} agent=${r.agent} profile=${r.profile_key}`);
  console.log(`token: ${token}`);
  console.log('The token is shown once; store it in a private (0600) file of the producer, never in argv or env.');
  return 0;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'register' || argv[0] === 'revoke') return registration(argv);
  const a = parseArgs(argv);
  const dataDir = process.env['XAIBO_DATA_DIR'];
  if (!dataDir || !path.isAbsolute(dataDir)) refuse('XAIBO_DATA_DIR must be an absolute path');
  const profile = real(a.profile);
  const bounds: Bounds = { root: profile, denied: await deniedRoots() };
  const spec = TARGETS[a.target]!;
  const target = resolveTarget(path.join(profile, spec.file), bounds);

  if (a.cmd === 'status') {
    const entries = readManifest(dataDir!).filter((e) => e.target === target);
    console.log(entries.length ? '' : `${a.target}: no Xaibo changes recorded`);
    for (const e of entries) console.log(`${a.target} ${e.route} ${e.state} ${e.id} ${e.at} owned=${e.owned.length}`);
    return 0;
  }
  if (a.target === 'claude-plugin') return plugin(a, dataDir!, profile, bounds);
  if (a.target === 'codex-hooks' && a.profileKey && a.cmd !== 'revert') return codex(a, dataDir!, profile, bounds, target);
  if (a.target === 'agy-hooks' && a.profileKey && a.cmd !== 'revert') return agy(a, dataDir!, profile, bounds, target);
  if (a.target === 'claude-tee' && a.profileKey && a.cmd !== 'revert') return tee(a, dataDir!, profile, bounds);

  if (a.cmd === 'revert') {
    const entry = readManifest(dataDir!).filter((e) => e.target === target).at(-1);
    if (!entry) refuse(`${a.target}: no Xaibo change to revert`);
    await confirm(a.yes, profile, `revert Xaibo changes in ${a.target}`);
    const r = revert(entry!, { dataDir: dataDir!, bounds });
    console.log(`${a.target}: ${r.result}`);
    for (const c of r.conflicts) console.log(`conflict (changed since Xaibo wrote it, kept): ${c.pointer}`);
    return r.conflicts.length ? 2 : 0;
  }

  if (!a.change) refuse('--change <ops.json> is required for plan and apply');
  const p = printPlan(a.target, plan(target, spec.route!, readOps(a.change!), bounds));
  if (a.cmd === 'plan') return 0;
  await confirm(a.yes, profile, `write ${a.target}`);
  const entry = apply(p, { dataDir: dataDir!, bounds });
  console.log(`${a.target}: applied ${entry.id}`);
  return 0;
}

function printPlan(name: string, p: Plan): Plan {
  console.log(`${name}: ${p.existed ? 'edit' : 'create'} ${p.target}`);
  for (const d of p.diff) {
    console.log(`+ ${d.pointer} = ${show(d.new)}`);
    if (d.replaced) console.log(`  replaces a ${d.replaced.type} (sha256 ${d.replaced.sha256}…)`);
  }
  return p;
}

/** P3-T06: the Codex hook groups for --profile-key, appended to <dir>/.codex/hooks.json; revert is the generic one.
 *  Codex runs them only after the owner approves them in Codex's own review, so apply prints the guided steps. */
async function codex(a: ReturnType<typeof parseArgs>, dataDir: string, profile: string, bounds: Bounds, target: string): Promise<number> {
  const p = printPlan(a.target, plan(target, 'codex-hooks', codexHookOps(shimPath(dataDir), a.profileKey!), bounds));
  if (a.cmd === 'plan') return 0;
  await confirm(a.yes, profile, 'write codex-hooks');
  deployShim(dataDir, { hook: path.join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder: real(a.forwarder ?? path.join(REPO, '.cache', 'sea', 'xaibo-forwarder')) });
  const codexHome = path.join(profile, '.codex');
  const entry = installCodexHooks({ dataDir, codexHome, profileKey: a.profileKey!, bounds }, p); // the plan shown (G3a-2)
  console.log(`codex-hooks: applied ${entry.id}; installed, awaiting trust`);
  codexTrustSteps(codexHome, shimPath(dataDir), a.profileKey!).forEach((s, i) => console.log(`${i + 1}. ${s}`));
  return 0;
}

/** P3-T13d: the Xaibo group for --profile-key in <dir>/.gemini/config/hooks.json; revert is the generic one. */
async function agy(a: ReturnType<typeof parseArgs>, dataDir: string, profile: string, bounds: Bounds, target: string): Promise<number> {
  const o = { dataDir, profileKey: a.profileKey!, profileHome: profile, bounds, ...(a.project ? { project: a.project } : {}) };
  const { file, ops } = checkAgyInstall(o); // plan refuses whatever apply would (review M2)
  const p = printPlan(a.target, plan(file, 'agy-hooks', ops, bounds));
  if (a.cmd === 'plan') return 0;
  await confirm(a.yes, profile, 'write agy-hooks');
  deployShim(dataDir, { hook: path.join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder: real(a.forwarder ?? path.join(REPO, '.cache', 'sea', 'xaibo-forwarder')) });
  const entry = installAgyHooks(o, p); // the plan shown (G3a-2)
  console.log(`agy-hooks: applied ${entry.id}`);
  return 0;
}

/** P3-T14: the statusLine tee for --profile-key in <dir>/.claude/settings.json (the original command stays in the
 *  manifest); apply deploys xaibo-statusline beside the shim; revert is the generic one. */
async function tee(a: ReturnType<typeof parseArgs>, dataDir: string, profile: string, bounds: Bounds): Promise<number> {
  const o = { dataDir, profileKey: a.profileKey!, configDir: path.join(profile, '.claude'), bounds };
  const p = printPlan(a.target, teePlan(o));
  if (a.cmd === 'plan') return 0;
  await confirm(a.yes, profile, 'write claude-tee');
  deployShim(dataDir, { hook: path.join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder: real(a.forwarder ?? path.join(REPO, '.cache', 'sea', 'xaibo-forwarder')),
    statusline: real(a.statusline ?? path.join(REPO, '.cache', 'sea', 'xaibo-statusline')) });
  const entry = installTee(o, p); // the plan shown (G3a-2)
  console.log(`claude-tee: applied ${entry.id}`);
  return 0;
}

/** P3-T05: the hooks-only plugin, through `claude plugin` in the disposable profile only. */
async function plugin(a: ReturnType<typeof parseArgs>, dataDir: string, profile: string, bounds: Bounds): Promise<number> {
  if (!a.claude || !a.profileKey) refuse('claude-plugin needs --claude <exe> and --profile-key <key>');
  const o = { dataDir, profileKey: a.profileKey!, configDir: path.join(profile, '.claude'), claude: real(a.claude!), bounds, env: { PATH: process.env['PATH'] ?? '', HOME: profile } };
  if (a.cmd === 'plan') {
    console.log(`claude-plugin: CLAUDE_CONFIG_DIR=${o.configDir}`);
    for (const argv of [['plugin', 'marketplace', 'add', '<appdata>/integrations/claude-plugin/' + a.profileKey], ['plugin', 'install', PLUGIN_REF, '-s', 'user']]) console.log(`+ claude ${argv.join(' ')}`);
    return 0;
  }
  if (a.cmd === 'revert') {
    await confirm(a.yes, profile, `uninstall ${PLUGIN_REF} and remove marketplace ${MARKETPLACE}`);
    const r = await uninstallPlugin(o);
    console.log(`claude-plugin: uninstalled; ${r.preHashRestored ? 'pre-install settings restored' : 'settings differ from before install (Claude-owned edits)'}`);
    for (const k of r.residue) console.log(`residue: enabledPlugins ${k}`);
    return r.residue.length ? 2 : 0;
  }
  await confirm(a.yes, profile, `install ${PLUGIN_REF} into ${o.configDir}`);
  deployShim(dataDir, { hook: path.join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder: real(a.forwarder ?? path.join(REPO, '.cache', 'sea', 'xaibo-forwarder')) });
  const entry = await installPlugin(o);
  console.log(`claude-plugin: installed ${entry.id}`);
  return 0;
}

const MESSAGES: Partial<Record<ConfigError['code'], string>> = {
  'denied-root': 'refused: the target is under a real agent root',
  'outside-root': 'refused: the target resolves outside the profile',
  'parent-missing': 'refused: the config directory does not exist in this profile',
  changed: 'aborted: the file changed since it was read; nothing written',
  duplicate: 'refused: Xaibo hooks are already installed in this profile (or its selected project)',
  exclusive: 'refused: this profile already has the other Claude hook route (plugin and settings fallback are exclusive)',
  'not-installed': 'nothing to uninstall: no Xaibo plugin recorded for this profile',
  cli: 'failed: a `claude plugin` step did not succeed; rolled back',
  'shim-missing': 'refused: the hook shim is not deployed',
  statusline: 'refused: the existing statusLine is not a command statusLine, so it cannot be teed',
  route: 'refused: the claude-plugin route installs and uninstalls through `claude plugin` only',
};

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => {
    if (e instanceof UsageError) console.error(e.message);
    else if (e instanceof ConfigError) console.error(MESSAGES[e.code] ?? e.message);
    else if (e instanceof RegistrationError) console.error(`refused: ${e.code} registration (agent ids are lowercase, profile keys [A-Za-z0-9._-])`);
    else console.error('failed:', (e as NodeJS.ErrnoException).code ?? 'error');
    process.exitCode = 1;
  });
}
