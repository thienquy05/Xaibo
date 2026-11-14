// Claude hooks-only plugin route (P3-T05; FR-30, S4, D-2, EC-09). The plugin is the S4 marketplace layout (repo
// integrations/claude-plugin/) plus a hooks.json generated per profile: every §5.2 event runs the stable shim as
// `'<shim>' hook claude <profile_key>`, async except Stop (S3), nothing else (no skills, MCP or output). Install copies
// it to <dataDir>/integrations/claude-plugin/<profile_key>/ and runs the S4 sequence through the sanctioned spawn
// module (argv, no shell) with CLAUDE_CONFIG_DIR = the disposable profile; the settings.json hashes before and after go
// to the FR-32 manifest under route claude-plugin (pending first, so a crash still leaves an entry to uninstall).
// The CLI writes under the config dir (settings.json, .claude.json, plugins/), so a symlink there or anything resolving
// outside the bounds is refused before any call (Codex review). Recovery evidence (pending entry, plugin copy) is
// dropped only once no Xaibo trace is left in the profile; an uninstall that leaves residue keeps its entry, so
// exclusivity still holds and it can be retried. Uninstall reports whether the pre-install bytes came back (S4-C6:
// Claude may leave its own edits). Bounds come from the caller (dev CLI: disposable profiles only, real roots denied).
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../../shared/log.ts';
import { STATUSLINE_BIN, teeCommand } from '../../../forwarder/statusline-tee.ts';
import {
  apply, assertExclusive, ConfigError, dropEntry, plan, privateDirs, readFile, readManifest, recordEntry, resolveTarget, within,
  type Bounds, type ManifestEntry, type Op, type Plan,
} from '../../config/transaction.ts';
import { run, succeeded } from '../../spawn.ts';
import { CLAUDE_HOOK_EVENTS } from './hooks.ts';

export const MARKETPLACE = 'xaibo';
export const PLUGIN = 'xaibo-hooks';
export const PLUGIN_REF = `${PLUGIN}@${MARKETPLACE}`;
const TEMPLATE = new URL('../../../../integrations/claude-plugin/', import.meta.url); // same depth under src/ and out/
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
const PROFILE_KEY = /^[A-Za-z0-9._-]{1,128}$/; // as the hook protocol's profile_key
const CLI_MS = 60_000;
const CLI_BYTES = 1 << 20;

export interface PluginOptions {
  dataDir: string; profileKey: string;
  /** The profile's Claude config dir (CLAUDE_CONFIG_DIR), inside `bounds`. */
  configDir: string;
  /** The claude executable. */
  claude: string;
  bounds: Bounds;
  /** The CLI's environment (PATH, HOME of the disposable profile); CLAUDE_CONFIG_DIR is added. */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number; log?: Logger;
}

const fail = (code: ConfigError['code']): never => { throw new ConfigError(code); };
const uid = process.getuid?.();
const ownRegular = (p: string) => { try { const st = lstatSync(p); return st.isFile() && (uid === undefined || st.uid === uid); } catch { return false; } };
const hashOf = (f: string) => { try { return createHash('sha256').update(readFileSync(f)).digest('hex'); } catch { return null; } };
const key = (k: string) => (PROFILE_KEY.test(k) && k !== '.' && k !== '..' ? k : fail('ops'));

export function pluginHooks(shim: string, profileKey: string): { hooks: Record<string, unknown[]> } {
  if (shim.includes("'")) throw new Error('plugin hooks: the shim path must not contain a single quote');
  const command = `'${shim}' hook claude ${key(profileKey)}`;
  return {
    hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((ev) => [ev, [{
      ...(TOOL_EVENTS.has(ev) ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command, ...(ev === 'Stop' ? {} : { async: true }) }], // S3: Stop synchronous
    }]])),
  };
}

function privateDir(d: string) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  const st = lstatSync(d);
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) fail('private-dir');
  chmodSync(d, 0o700);
}

/** Writes the plugin for one profile (replacing an earlier copy); returns the marketplace dir. */
export function writePlugin(dataDir: string, profileKey: string, shim: string): string {
  privateDirs(dataDir);
  const root = path.join(dataDir, 'integrations', 'claude-plugin');
  privateDir(root);
  const dir = path.join(root, key(profileKey));
  rmSync(dir, { recursive: true, force: true });
  const files: [string, string][] = [
    ['.claude-plugin/marketplace.json', readFileSync(new URL('.claude-plugin/marketplace.json', TEMPLATE), 'utf8')],
    [`${PLUGIN}/.claude-plugin/plugin.json`, readFileSync(new URL(`${PLUGIN}/.claude-plugin/plugin.json`, TEMPLATE), 'utf8')],
    [`${PLUGIN}/hooks/hooks.json`, `${JSON.stringify(pluginHooks(shim, profileKey), null, 2)}\n`],
  ];
  for (const [rel, body] of files) {
    privateDir(path.dirname(path.join(dir, rel)));
    writeFileSync(path.join(dir, rel), body, { mode: 0o600, flag: 'wx' });
  }
  return dir;
}

/** Copies the shim and forwarder (and the statusLine tee when given, P3-T14) into <dataDir>/integrations/bin (0700), each
 *  by temp file and rename, so a running helper is never half-overwritten (upgrade, EC-46); returns the shim path. */
export function deployShim(dataDir: string, from: { hook: string; forwarder: string; statusline?: string }): string {
  privateDirs(dataDir);
  const bin = path.join(dataDir, 'integrations', 'bin');
  privateDir(bin);
  // the report shim (P3-T13c) ships beside the hook shim
  const report = path.join(path.dirname(from.hook), 'xaibo-report');
  const files: [string, string][] = [['xaibo-forwarder', from.forwarder], ['xaibo-hook', from.hook], ['xaibo-report', report]];
  if (from.statusline) files.push([STATUSLINE_BIN, from.statusline]);
  for (const [name, src] of files) {
    const tmp = path.join(bin, `.${name}.${randomUUID()}.tmp`);
    copyFileSync(src, tmp, constants.COPYFILE_EXCL);
    chmodSync(tmp, 0o755);
    renameSync(tmp, path.join(bin, name));
  }
  return path.join(bin, 'xaibo-hook');
}

const MAX_WALK = 50_000;
/** Every path the CLI writes through: the config dir, its files and the whole existing plugins/ tree (cache,
 *  marketplaces, registries), with no symlink anywhere and nothing resolving outside the bounds. */
function confine(o: PluginOptions) {
  const check = (p: string) => { // true for a directory to descend into
    let st;
    try { st = lstatSync(p); } catch { return false; }
    if (st.isSymbolicLink()) fail('symlink');
    const real = realpathSync(p);
    if (!within(real, o.bounds.root)) fail('outside-root');
    if (o.bounds.denied.some((d) => within(real, d))) fail('denied-root');
    return st.isDirectory();
  };
  for (const p of [o.configDir, path.join(o.configDir, 'settings.json'), path.join(o.configDir, '.claude.json')]) check(p);
  const stack = [path.join(o.configDir, 'plugins')];
  let seen = 0;
  while (stack.length) {
    const d = stack.pop()!;
    if (!check(d)) continue;
    for (const name of readdirSync(d)) {
      if (++seen > MAX_WALK) fail('too-large');
      stack.push(path.join(d, name));
    }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Any decoded key or string value equal to `name`, at any depth (the registry layouts are Claude's, not a contract);
 *  an explicit stack, so deeply nested JSON cannot overflow the call stack. */
function mentions(root: unknown, name: string): boolean {
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (v === name) return true;
    if (Array.isArray(v)) for (const x of v) stack.push(x); // no spread: a wide array would exceed the argument limit
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) { if (k === name) return true; stack.push(x); }
  }
  return false;
}

/** Xaibo traces the CLI may leave: enabledPlugins keys, the marketplace and plugin registries; unreadable counts. */
function leftovers(configDir: string): string[] {
  const out: string[] = [];
  const text = (f: string) => { try { return readFileSync(path.join(configDir, f), 'utf8'); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined; } };
  const s = text('settings.json');
  if (s === undefined) out.push('unreadable:settings.json');
  else if (s !== null) {
    try {
      const enabled = (JSON.parse(s) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {};
      out.push(...Object.keys(enabled).filter((k) => k.endsWith(`@${MARKETPLACE}`)));
    } catch { out.push('unreadable:settings.json'); }
  }
  for (const [f, name, label] of [['plugins/known_marketplaces.json', MARKETPLACE, `marketplace:${MARKETPLACE}`], ['plugins/installed_plugins.json', PLUGIN_REF, `installed:${PLUGIN_REF}`]] as const) {
    const t = text(f);
    if (t === null) continue;
    let v: unknown;
    try { v = t === undefined ? undefined : JSON.parse(t); } catch { v = undefined; }
    if (v === undefined) out.push(`unreadable:${f}`);
    else if (mentions(v, name)) out.push(label);
  }
  return out;
}

const cli = (o: PluginOptions, args: string[]) =>
  run(o.claude, args, { timeoutMs: o.timeoutMs ?? CLI_MS, maxBytes: CLI_BYTES, env: { ...o.env, CLAUDE_CONFIG_DIR: o.configDir }, ...(o.log ? { log: o.log } : {}) });

export async function installPlugin(o: PluginOptions): Promise<ManifestEntry> {
  confine(o);
  const target = resolveTarget(path.join(o.configDir, 'settings.json'), o.bounds);
  const mine = readManifest(o.dataDir).filter((e) => e.target === target);
  if (mine.some((e) => e.route === 'claude-plugin')) fail('duplicate');
  assertExclusive(mine, target, 'claude-plugin');
  const shim = path.join(o.dataDir, 'integrations', 'bin', 'xaibo-hook');
  if (!ownRegular(shim)) fail('shim-missing');
  const dir = writePlugin(o.dataDir, o.profileKey, shim);
  const preHash = hashOf(target);
  const entry: ManifestEntry = {
    id: randomUUID(), target, route: 'claude-plugin', state: 'pending', existed: preHash !== null, preHash, postHash: '',
    owned: [], created: [], backup: null, at: new Date().toISOString(),
  };
  recordEntry(o.dataDir, entry);
  const added = succeeded(await cli(o, ['plugin', 'marketplace', 'add', dir]));
  if (!added || !succeeded(await cli(o, ['plugin', 'install', PLUGIN_REF, '-s', 'user']))) {
    await cli(o, ['plugin', 'marketplace', 'remove', MARKETPLACE]); // a failed step may still have changed the profile
    if (!leftovers(o.configDir).length) { // else the pending entry and copy stay for uninstall
      rmSync(dir, { recursive: true, force: true });
      dropEntry(o.dataDir, entry.id);
    }
    fail('cli');
  }
  const applied: ManifestEntry = { ...entry, state: 'applied', postHash: hashOf(target) ?? 'absent' };
  recordEntry(o.dataDir, applied);
  return applied;
}

export async function uninstallPlugin(o: PluginOptions): Promise<{ preHashRestored: boolean; residue: string[] }> {
  confine(o);
  const target = resolveTarget(path.join(o.configDir, 'settings.json'), o.bounds);
  const entry = readManifest(o.dataDir).find((e) => e.target === target && e.route === 'claude-plugin');
  if (!entry) return fail('not-installed');
  // Both steps run; the profile, not their exit codes, decides (a retry after a partial uninstall may see "not found").
  const steps = [await cli(o, ['plugin', 'uninstall', PLUGIN_REF, '-s', 'user']), await cli(o, ['plugin', 'marketplace', 'remove', MARKETPLACE])];
  const residue = leftovers(o.configDir);
  if (residue.length) {
    if (!steps.every(succeeded)) fail('cli');
    return { preHashRestored: hashOf(target) === entry.preHash, residue }; // entry kept: still ours, still exclusive
  }
  dropEntry(o.dataDir, entry.id);
  rmSync(path.join(o.dataDir, 'integrations', 'claude-plugin', key(o.profileKey)), { recursive: true, force: true });
  return { preHashRestored: hashOf(target) === entry.preHash, residue };
}

// --- statusLine tee (P3-T14; S-31, FR-45, EC-28, Q3-7) -------------------------------------------------------------

export interface TeeOptions {
  dataDir: string; profileKey: string;
  /** The profile's Claude config dir, inside `bounds`. */
  configDir: string;
  bounds: Bounds;
}
// Any Xaibo statusLine tee, whatever its data dir or quoting.
const TEE = /xaibo-statusline['"]?(\s|$)/;

/** The FR-32 plan for the claude-tee route: an existing command statusLine keeps every key but its command (padding,
 *  refreshInterval; the replaced command is the original the tee runs, kept in the manifest), an absent one is added.
 *  A second install, a statusLine already running a tee or one that is not a command statusLine is refused. */
export function teePlan(o: TeeOptions): Plan {
  const target = resolveTarget(path.join(o.configDir, 'settings.json'), o.bounds);
  if (readManifest(o.dataDir).some((e) => e.target === target && e.route === 'claude-tee')) fail('duplicate');
  let command = '';
  try { command = teeCommand(o.dataDir, key(o.profileKey)); } catch (e) { if (e instanceof ConfigError) throw e; fail('ops'); } // review L6
  const cur = readFile(target);
  let doc: unknown = {};
  if (cur) { try { doc = JSON.parse(cur.bytes.toString('utf8')); } catch { fail('invalid-json'); } }
  const s = isObject(doc) && Object.hasOwn(doc, 'statusLine') ? doc['statusLine'] : undefined;
  let ops: Op[];
  if (s === undefined) ops = [{ op: 'set', pointer: '/statusLine', value: { type: 'command', command } }];
  else if (isObject(s) && s['type'] === 'command' && typeof s['command'] === 'string') {
    if (TEE.test(s['command'])) fail('duplicate');
    ops = [{ op: 'set', pointer: '/statusLine/command', value: command }];
  } else return fail('statusline');
  return plan(target, 'claude-tee', ops, o.bounds);
}

/** Installs the tee (deployed first with deployShim); revert is the engine's (byte-identical, or conflicts kept).
 *  `preview`: the exact teePlan the owner confirmed, so an edit since then aborts with `changed` (G3a-2, EC-48). */
export function installTee(o: TeeOptions, preview?: Plan): ManifestEntry {
  if (!ownRegular(path.join(o.dataDir, 'integrations', 'bin', STATUSLINE_BIN))) fail('shim-missing');
  return apply(preview ?? teePlan(o), { dataDir: o.dataDir, bounds: o.bounds });
}
