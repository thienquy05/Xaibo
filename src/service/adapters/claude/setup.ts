// Claude hooks-only plugin route (P3-T05; FR-30, S4, D-2, EC-09). The plugin is the S4 marketplace layout (repo
// integrations/claude-plugin/) plus a hooks.json generated per profile: every §5.2 event runs the stable shim as
// `'<shim>' hook claude <profile_key>`, async except Stop (S3), nothing else (no skills, MCP or output). Install copies
// it to <dataDir>/integrations/claude-plugin/<profile_key>/ and runs the S4 sequence through the sanctioned spawn
// module (argv, no shell) with CLAUDE_CONFIG_DIR = the disposable profile; the settings.json hashes before and after go
// to the FR-32 manifest under route claude-plugin (pending first, so a crash still leaves an entry to uninstall).
// The CLI writes under the config dir (settings.json, .claude.json, plugins/), so a symlink there or anything resolving
// outside the bounds is refused before any call (Codex review). Recovery evidence (pending entry, plugin copy) is
// dropped only once no Xaibo trace is left in the profile; an uninstall that leaves residue keeps its entry, so
// exclusivity still holds and it can be retried. Removal (part 2c, below) proves ownership first and gives the pre-install
// bytes back where nothing else changed. Bounds come from the caller (dev CLI: disposable profiles only, real roots denied).
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync, chmodSync, closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileId, type FileId } from '../../catalog/detect.ts';
import { real } from '../../config/bounds.ts';
import { isObj } from '../../../shared/ipc.ts';
import { isProfileKey } from '../../../shared/hook-protocol.ts';
import type { Logger } from '../../../shared/log.ts';
import { STATUSLINE_BIN, teeCommand } from '../../../forwarder/statusline-tee.ts';
import {
  apply, assertExclusive, ConfigError, dropEntry, plan, privateDirs, readFile, readManifest, recordEntry, resolveTarget, restoreFile, within,
  type Bounds, type ManifestEntry, type Op, type Plan,
} from '../../config/transaction.ts';
import { run, succeeded } from '../../spawn.ts';
import { CLAUDE_HOOK_EVENTS } from './hooks.ts';

export const MARKETPLACE = 'xaibo';
export const PLUGIN = 'xaibo-hooks';
export const PLUGIN_REF = `${PLUGIN}@${MARKETPLACE}`;
const TEMPLATE = new URL('../../../../integrations/claude-plugin/', import.meta.url); // same depth under src/ and out/
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
const CLI_MS = 60_000;
const CLI_BYTES = 1 << 20;

export interface PluginOptions {
  dataDir: string; profileKey: string;
  /** The profile's Claude config dir (CLAUDE_CONFIG_DIR), inside `bounds`. */
  configDir: string;
  /** The claude executable. */
  claude: string;
  bounds: Bounds;
  /** The login-shell PATH: the CLI's only inherited value, and where a `#!/usr/bin/env <name>` interpreter is resolved (part 2b). */
  path: string;
  /** The detected executable's identity (detect.ts): a different file is unverified (part 2b review H1). The dev CLI has none. */
  expect?: FileId;
  timeoutMs?: number; log?: Logger;
}

const fail = (code: ConfigError['code']): never => { throw new ConfigError(code); };
const uid = process.getuid?.();
const ownRegular = (p: string) => { try { const st = lstatSync(p); return st.isFile() && (uid === undefined || st.uid === uid); } catch { return false; } };
const hashOf = (f: string) => { try { return createHash('sha256').update(readFileSync(f)).digest('hex'); } catch { return null; } };
const key = (k: string) => (isProfileKey(k) ? k : fail('ops'));

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
    // P6-T03 part 1b review M4: an APFS clone (instant) where possible, else a copy. ponytail: other volumes copy the SEA
    // binaries (~145 MB each) in full on every Connect; skip a deployed file that already matches if that shows up as slow
    copyFileSync(src, tmp, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
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

/** Any decoded key or string value equal to `name`, at any depth (the registry layouts are Claude's, not a contract);
 *  an explicit stack, so deeply nested JSON cannot overflow the call stack. */
function mentions(root: unknown, name: string): boolean { return some(root, (x) => x === name); }
/** Any decoded key or string value matching, at any depth (part 2c generalises `mentions`). */
function some(root: unknown, match: (s: string) => boolean): boolean {
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string' && match(v)) return true;
    if (Array.isArray(v)) for (const x of v) stack.push(x); // no spread: a wide array would exceed the argument limit
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) { if (match(k)) return true; stack.push(x); }
  }
  return false;
}
/** The values under every decoded key equal to `name`, at any depth. */
function under(root: unknown, name: string): unknown[] {
  const out: unknown[] = [];
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) for (const x of v) stack.push(x);
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) { if (k === name) out.push(x); stack.push(x); }
  }
  return out;
}

/** Xaibo traces the CLI may leave: enabledPlugins keys, the marketplace and plugin registries; unreadable counts. */
function leftovers(configDir: string): string[] {
  const out: string[] = [];
  const text = (f: string) => { try { const c = readFile(path.join(configDir, f)); return c ? c.bytes.toString('utf8') : null; } catch { return undefined; } }; // review R2 (run 197)
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

// --- P6-T03 part 2b (XAIBO-PROD-560; design .handoff/p6-t03-design.md part 2b slice and review) ------------------------
// The one Connect confirmation binds the plugin step: previewPlugin records settings.json's identity (absent, or hash, device,
// inode and mode), the executable's and its interpreter's stat identity and the exact argv; installPlugin takes that preview
// back and refuses `changed` before writing anything, and rechecks the executable before every spawn (compensation included).
// The CLI gets an explicit environment and a private cwd, nothing inherited. Before the first spawn a private backup of
// settings.json and a pending entry (phase, executable) are recorded; after install the effect is verified.
// ponytail: stat identity, not a content hash, keeps the preview synchronous (same-uid edits change ctime); the interpreter's
// own libraries are not covered. The macOS Keychain lookup ignores HOME: a disposable CLAUDE_CONFIG_DIR keeps it off the real
// item; P6-T12 re-examines it for real roots. The three traffic switches are not S4-verified for the plugin verbs.

interface Bound { path: string; id: FileId }
type SettingsId = { hash: string; dev: number; ino: number; mode: number } | null;
export interface PluginPreview {
  target: string; settings: SettingsId; exe: Bound; interp: Bound | null;
  /** marketplace add, install, and the compensation (marketplace remove); the real plugin dir, never on the wire. */
  argv: string[][];
}

const idOf = (f: string) => { try { return fileId(lstatSync(f)); } catch { return null; } };
function bind(file: string): Bound {
  try {
    const real = realpathSync(file);
    const st = lstatSync(real);
    if (!st.isFile()) return fail('unverified');
    accessSync(real, constants.X_OK);
    return { path: real, id: fileId(st) };
  } catch (e) { if (e instanceof ConfigError) throw e; return fail('unverified'); }
}
/** The `#!` interpreter (review M2): an absolute one, or `#!/usr/bin/env <name>` on the login PATH; none for a native binary. */
function interpreter(exe: string, PATH: string): Bound | null {
  const buf = Buffer.alloc(256);
  let n = 0;
  try { const fd = openSync(exe, 'r'); try { n = readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); } } catch { return fail('unverified'); }
  const head = buf.subarray(0, n).toString('utf8');
  if (!head.startsWith('#!')) return null;
  const nl = head.indexOf('\n');
  const [cmd, ...args] = (nl < 0 ? '' : head.slice(2, nl)).trim().split(/\s+/);
  if (!cmd || !path.isAbsolute(cmd)) return fail('unverified');
  if (path.basename(cmd) !== 'env') return bind(cmd);
  const name = args[0];
  if (args.length !== 1 || !name || name.startsWith('-') || name.includes('/')) return fail('unverified');
  for (const d of absPath(PATH).split(':').filter(Boolean)) {
    try { return bind(path.join(d, name)); } catch { /* next PATH entry */ }
  }
  return fail('unverified');
}
const settingsId = (cur: ReturnType<typeof readFile>): SettingsId =>
  (cur ? { hash: createHash('sha256').update(cur.bytes).digest('hex'), dev: cur.dev, ino: cur.ino, mode: cur.mode } : null);
/** The executable unchanged, and its interpreter resolved again as the spawn's `env` will (code review M2: a new one earlier on
 *  the PATH is a change) and unchanged too. */
const sameExe = (p: Pick<PluginPreview, 'exe' | 'interp'>, PATH: string) => {
  if (!isDeepStrictEqual(idOf(p.exe.path), p.exe.id)) return false;
  try { return isDeepStrictEqual(interpreter(p.exe.path, PATH), p.interp); } catch { return false; }
};
/** Absolute entries only: an empty or relative one would resolve against the cwd (code review M2). */
const absPath = (PATH: string) => PATH.split(':').filter((x) => path.isAbsolute(x)).join(':');

/** One plugin entry per profile, never next to the fallback, and no Xaibo marketplace or plugin left in the profile (a
 *  collision is never taken over); an unreadable registry is refused. */
function free(o: PluginOptions, target: string) {
  const mine = readManifest(o.dataDir).filter((e) => e.target === target);
  if (mine.some((e) => e.route === 'claude-plugin')) fail('duplicate');
  assertExclusive(mine, target, 'claude-plugin');
  const left = leftovers(o.configDir);
  if (left.some((l) => l.startsWith('unreadable:'))) fail('unreadable');
  if (left.length) fail('duplicate');
}

/** Nothing runs and nothing is written; refusals are ConfigErrors. */
export function previewPlugin(o: PluginOptions): PluginPreview {
  confine(o);
  const target = resolveTarget(path.join(o.configDir, 'settings.json'), o.bounds);
  free(o, target);
  const exe = bind(o.claude);
  if (o.expect && !isDeepStrictEqual(exe.id, o.expect)) fail('unverified');
  const dir = path.join(o.dataDir, 'integrations', 'claude-plugin', key(o.profileKey));
  return {
    target, settings: settingsId(readFile(target)), exe, interp: interpreter(exe.path, o.path),
    argv: [['plugin', 'marketplace', 'add', dir], ['plugin', 'install', PLUGIN_REF, '-s', 'user'], ['plugin', 'marketplace', 'remove', MARKETPLACE]],
  };
}

/** <dataDir>/integrations/cli-home (0700) with tmp/: the CLI's HOME, TMPDIR and cwd. */
function cliHome(dataDir: string) {
  privateDirs(dataDir);
  const home = path.join(dataDir, 'integrations', 'cli-home');
  privateDir(home);
  privateDir(path.join(home, 'tmp'));
  return home;
}
const cli = (o: PluginOptions, exe: string, args: string[]) => {
  const home = cliHome(o.dataDir);
  const env = {
    PATH: absPath(o.path), HOME: home, TMPDIR: path.join(home, 'tmp'), CLAUDE_CONFIG_DIR: o.configDir,
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  return run(exe, args, { timeoutMs: o.timeoutMs ?? CLI_MS, maxBytes: CLI_BYTES, env, cwd: home, ...(o.log ? { log: o.log } : {}) });
};

/** The plugin is enabled in settings.json and both registries name it; the tree is re-confined first (review M6). */
function installedEffect(o: PluginOptions): boolean {
  try {
    confine(o);
    const left = leftovers(o.configDir);
    const cur = readFile(path.join(o.configDir, 'settings.json'));
    const doc: unknown = cur ? JSON.parse(cur.bytes.toString('utf8')) : null;
    const enabled = isObj(doc) && isObj(doc['enabledPlugins']) && doc['enabledPlugins'][PLUGIN_REF] === true;
    return enabled && left.includes(`marketplace:${MARKETPLACE}`) && left.includes(`installed:${PLUGIN_REF}`);
  } catch { return false; }
}

export async function installPlugin(o: PluginOptions, confirmed: PluginPreview): Promise<ManifestEntry> {
  confine(o);
  const target = resolveTarget(path.join(o.configDir, 'settings.json'), o.bounds);
  if (target !== confirmed.target) fail('changed');
  free(o, target);
  const shim = path.join(o.dataDir, 'integrations', 'bin', 'xaibo-hook');
  if (!ownRegular(shim)) fail('shim-missing');
  const cur = readFile(target); // review M4a: one read gives the identity, the hash and the backup bytes
  if (!isDeepStrictEqual(settingsId(cur), confirmed.settings) || !sameExe(confirmed, o.path)) fail('changed');
  const backup = cur ? `${randomUUID()}.bak` : null;
  let dir = '', backupFile: string | null = null;
  const entry: ManifestEntry = {
    id: randomUUID(), target, route: 'claude-plugin', state: 'pending', existed: !!cur, preHash: confirmed.settings?.hash ?? null, postHash: '',
    owned: [], created: [], backup, at: new Date().toISOString(), phase: 'marketplace', exe: { path: confirmed.exe.path, id: confirmed.exe.id },
    profileKey: key(o.profileKey), ...(cur ? { preMode: cur.mode } : {}), // part 2c: removal evidence
  };
  try { // code review M1: until the pending entry is recorded nothing names these files, so a failure removes them
    dir = writePlugin(o.dataDir, o.profileKey, shim);
    if (dir !== confirmed.argv[0]![3]) fail('changed'); // code review L4: the folder the confirmed argv names
    backupFile = backup ? path.join(privateDirs(o.dataDir).backups, backup) : null;
    if (cur && backupFile) writeFileSync(backupFile, cur.bytes, { mode: 0o600, flag: 'wx' });
    recordEntry(o.dataDir, entry);
  } catch (e) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (backupFile) rmSync(backupFile, { force: true });
    throw e;
  }
  let changed = false;
  /** Every spawn, the compensation included, first rechecks the executable (review M7); a changed one runs nothing more. */
  const step = async (args: string[]) => {
    if (changed || !sameExe(confirmed, o.path)) { changed = true; return false; }
    return succeeded(await cli(o, confirmed.exe.path, args));
  };
  let ok = await step(confirmed.argv[0]!);
  if (ok) { recordEntry(o.dataDir, { ...entry, phase: 'install' }); ok = await step(confirmed.argv[1]!) && installedEffect(o); }
  if (!ok) {
    await step(confirmed.argv[2]!); // a failed step may still have changed the profile; never a fallback after this
    let clean = false;
    try { confine(o); clean = !leftovers(o.configDir).length; } catch { /* kept: unconfined or unreadable */ }
    if (clean) { // else the pending entry, backup and copy stay (phase is a lower bound for 2c / P6-T04)
      rmSync(dir, { recursive: true, force: true });
      if (backupFile) rmSync(backupFile, { force: true });
      dropEntry(o.dataDir, entry.id);
    }
    fail(changed ? 'changed' : 'cli');
  }
  const applied: ManifestEntry = { ...entry, state: 'applied', phase: 'install', postHash: hashOf(target) ?? 'absent' };
  recordEntry(o.dataDir, applied);
  return applied;
}

// --- P6-T03 part 2c (XAIBO-PROD-561; design .handoff/p6-t03-design.md part 2c slice and review) -------------------------
// Removal only where Xaibo's ownership is proven by the profile (never by the journal's phase): the enabled key still true,
// the `xaibo` marketplace naming Xaibo's plugin dir, no foreign plugin on that marketplace; otherwise a conflict and no CLI
// call. After the CLI (the profile, not its exit codes, decides), residue keeps everything. Then settings.json: when nothing
// but Xaibo's key changed since before install (an applied entry: exactly the post-install bytes, tee and retention reverted
// first; a pending one: the same document but for that key) the pre-install bytes and mode come back, or the file goes when
// it did not exist; otherwise the CLI's removal stands (owner edits are never overwritten) and a foreign value the CLI
// dropped or added is a conflict kept as partial evidence. Entry, backup and copy go last, in that order.

export interface PluginRemoval {
  result: 'restored' | 'removed' | 'structural' | 'unchanged'; preHashRestored: boolean; residue: string[]; conflicts: { pointer: string }[];
}
const ENABLED = `/enabledPlugins/${PLUGIN_REF}`;
const OWNERSHIP = `marketplace:${MARKETPLACE}`;
/** settings without Xaibo's enabled key, and without an enabledPlugins left empty by its removal. */
function strip(doc: Record<string, unknown>): Record<string, unknown> {
  const c = structuredClone(doc);
  const ep = c['enabledPlugins'];
  if (isObj(ep)) { delete ep[PLUGIN_REF]; if (!Object.keys(ep).length) delete c['enabledPlugins']; }
  return c;
}
const parsed = (f: ReturnType<typeof readFile>): Record<string, unknown> | null => {
  if (!f) return {};
  try { const v: unknown = JSON.parse(f.bytes.toString('utf8')); return isObj(v) ? v : null; } catch { return null; }
};
/** Review M7: a registry string naming the plugin dir, compared after realpath (macOS temp dirs resolve through a symlink) or
 *  below it. */
// ponytail (code review L4): any string in the `xaibo` subtree naming the dir proves it; Claude repeats the source path in
// its fields. Require every absolute path there to name it if a registry layout ever mixes sources.
const namesDir = (t: unknown, dir: string) => { const d = real(dir); return some(t, (x) => path.isAbsolute(x) && (real(x) === d || real(x).startsWith(`${d}/`))); };

/** What of the plugin is Xaibo's in this profile, read before any CLI call; conflicts mean nothing may run. */
function ownership(configDir: string, doc: Record<string, unknown>, dir: string) {
  const conflicts = new Set<string>();
  const ep = isObj(doc['enabledPlugins']) ? doc['enabledPlugins'] : null;
  const enabled = !!ep && Object.hasOwn(ep, PLUGIN_REF);
  if (enabled && ep![PLUGIN_REF] !== true) conflicts.add(ENABLED); // FR-34: the owner changed it (incl. false)
  const foreign = (x: string) => x !== PLUGIN_REF && x.endsWith(`@${MARKETPLACE}`);
  if (ep && Object.keys(ep).some(foreign)) conflicts.add(OWNERSHIP);
  const read = (f: string): unknown => { // null absent, undefined unreadable
    const t = (() => { try { const c = readFile(path.join(configDir, f)); return c ? c.bytes.toString('utf8') : null; } catch { return undefined; } })(); // review R2 (run 197)
    if (t === null || t === undefined) return t;
    try { return JSON.parse(t) as unknown; } catch { return undefined; }
  };
  const known = read('plugins/known_marketplaces.json'), installed = read('plugins/installed_plugins.json');
  if (known === undefined || installed === undefined) conflicts.add(OWNERSHIP);
  const ours = known ? under(known, MARKETPLACE) : [];
  if (ours.some((t) => !namesDir(t, dir))) conflicts.add(OWNERSHIP);
  if (installed && some(installed, foreign)) conflicts.add(OWNERSHIP);
  return { enabled, marketplace: ours.length > 0, registered: !!installed && mentions(installed, PLUGIN_REF), conflicts: [...conflicts] };
}

/** XAIBO-PROD-562 (P6-T04 part 1; owner D-P6-08): the plugin's state from the three files, never the CLI: the exact
 *  enabledPlugins value (undefined = no key), whether the plugin registry names it, and whether the `xaibo` marketplace
 *  names `dir` (ours), something else (foreign) or is absent. Unreadable, linked, oversized or invalid JSON throws ConfigError. */
export function pluginEvidence(configDir: string, dir: string): { enabled: unknown; installed: boolean; marketplace: 'ours' | 'foreign' | 'absent' } {
  // code review (run 197) 1: readFile refuses only a linked final component, so a linked plugins/ folder is refused here
  // (configDir itself is a realpath). ponytail: namesDir still stats the paths the marketplace registry names (no content).
  try { if (lstatSync(path.join(configDir, 'plugins')).isSymbolicLink()) fail('symlink'); } catch (e) { if (e instanceof ConfigError) throw e; }
  const json = (f: string): unknown => {
    const c = readFile(path.join(configDir, f));
    if (!c) return null;
    try { return JSON.parse(c.bytes.toString('utf8')) as unknown; } catch { return fail('invalid-json'); }
  };
  const doc = json('settings.json'), known = json('plugins/known_marketplaces.json'), installed = json('plugins/installed_plugins.json');
  const ep = isObj(doc) && isObj(doc['enabledPlugins']) ? doc['enabledPlugins'] : null;
  const ours = known ? under(known, MARKETPLACE) : [];
  return {
    enabled: ep && Object.hasOwn(ep, PLUGIN_REF) ? ep[PLUGIN_REF] : undefined,
    installed: !!installed && mentions(installed, PLUGIN_REF),
    marketplace: !ours.length ? 'absent' : ours.every((t) => namesDir(t, dir)) ? 'ours' : 'foreign',
  };
}

/** `o.expect` is the current detection (Claude may have updated since install, D-P6-07); the dev CLI passes none. */
export async function uninstallPlugin(o: PluginOptions): Promise<PluginRemoval> {
  confine(o);
  const target = resolveTarget(path.join(o.configDir, 'settings.json'), o.bounds);
  const entry = readManifest(o.dataDir).find((e) => e.target === target && e.route === 'claude-plugin');
  if (!entry) return fail('not-installed');
  if (entry.profileKey !== undefined && entry.profileKey !== key(o.profileKey)) fail('ops'); // review M8
  const exe = bind(o.claude);
  if (o.expect && !isDeepStrictEqual(exe.id, o.expect)) fail('unverified');
  const bound = { exe, interp: interpreter(exe.path, o.path) };
  const dir = path.join(o.dataDir, 'integrations', 'claude-plugin', key(o.profileKey));
  const kept = (conflicts: string[]): PluginRemoval =>
    ({ result: 'unchanged', preHashRestored: false, residue: leftovers(o.configDir), conflicts: conflicts.map((pointer) => ({ pointer })) });

  const s0 = readFile(target), doc0 = parsed(s0);
  if (!doc0) return kept(['/']); // review L10: unreadable settings: nothing proven, nothing run
  const own = ownership(o.configDir, doc0, dir);
  if (own.conflicts.length) return kept(own.conflicts);
  const steps: string[][] = [];
  if (own.enabled || own.registered) steps.push(['plugin', 'uninstall', PLUGIN_REF, '-s', 'user']);
  if (own.marketplace) steps.push(['plugin', 'marketplace', 'remove', MARKETPLACE]);
  const ran = [];
  for (const args of steps) {
    if (!sameExe(bound, o.path)) fail('changed'); // every spawn rechecks the executable and interpreter (2b M7)
    ran.push(await cli(o, exe.path, args));
  }
  confine(o); // the CLI may have written anything under plugins/ (2b M6)
  const residue = leftovers(o.configDir);
  if (residue.length) {
    if (!ran.every(succeeded)) fail('cli');
    return { result: 'unchanged', preHashRestored: false, residue, conflicts: [] }; // entry kept: still ours, still exclusive
  }

  const s1 = readFile(target), doc1 = parsed(s1);
  const backupFile = entry.backup ? path.join(privateDirs(o.dataDir).backups, entry.backup) : null;
  const b = backupFile ? readFile(backupFile) : null;
  const drop = (r: PluginRemoval): PluginRemoval => {
    dropEntry(o.dataDir, entry.id);
    if (backupFile) rmSync(backupFile, { force: true });
    rmSync(dir, { recursive: true, force: true });
    return r;
  };
  const hash = (f: typeof s0) => (f ? createHash('sha256').update(f.bytes).digest('hex') : null);
  const backupDoc = entry.existed ? parsed(b) : {};
  // the CLI kept every foreign value, and nothing else changed the file while it ran (code review M1)
  const foreignKept = !!doc1 && isDeepStrictEqual(strip(doc1), strip(doc0));
  const restore = !entry.partial && foreignKept && (entry.state === 'applied'
    ? (hash(s0) ?? 'absent') === entry.postHash // design review M3: exactly what install left (tee and retention reverted first)
    : !!backupDoc && isDeepStrictEqual(strip(doc0), strip(backupDoc)));
  const usable = !entry.existed || (!!b && hash(b) === entry.preHash); // code review M3: else a conflict, never a lasting error
  if (restore && usable) {
    restoreFile(target, entry.existed ? b!.bytes : null, hash(s1), entry.preMode ?? s1?.mode ?? 0o600);
    return drop({ result: entry.existed ? 'restored' : 'removed', preHashRestored: true, residue: [], conflicts: [] });
  }
  // structural: the CLI's removal stands; a foreign change or an unusable backup is partial evidence (design review M6)
  if (entry.partial || !foreignKept || restore) {
    if (!entry.partial) {
      recordEntry(o.dataDir, { ...entry, partial: true });
      return { result: 'structural', preHashRestored: false, residue: [], conflicts: [{ pointer: '/' }] };
    }
    return drop({ result: 'structural', preHashRestored: false, residue: [], conflicts: [{ pointer: '/' }] }); // reported again, never restored
  }
  return drop({ result: 'structural', preHashRestored: hash(s1) === entry.preHash, residue: [], conflicts: [] });
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
  const s = isObj(doc) && Object.hasOwn(doc, 'statusLine') ? doc['statusLine'] : undefined;
  let ops: Op[];
  if (s === undefined) ops = [{ op: 'set', pointer: '/statusLine', value: { type: 'command', command } }];
  else if (isObj(s) && s['type'] === 'command' && typeof s['command'] === 'string') {
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
