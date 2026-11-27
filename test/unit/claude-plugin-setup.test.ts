// XAIBO-PROD-305 (P3-T05, FR-30, S4, EC-09 route exclusivity moved here by D-P3-05): the hooks-only plugin subscribes to
// every §5.2 event through the stable shim (async except Stop, nothing else in the plugin); install and uninstall run
// the S4 `claude plugin` sequence as argv arrays with CLAUDE_CONFIG_DIR = the disposable profile, recorded in the FR-32
// manifest; a duplicate install is refused; plugin and settings fallback exclude each other; nothing runs outside the
// profile bounds. A fake `claude` records its argv and plays the S4 settings changes (state files beside the profile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_HOOK_EVENTS } from '../../src/service/adapters/claude/hooks.ts';
import { deployShim, installPlugin, pluginHooks, PLUGIN_REF, previewPlugin, uninstallPlugin, writePlugin, type PluginOptions } from '../../src/service/adapters/claude/setup.ts';
import { writeFakeClaude } from '../helpers/fake-claude.ts';
import { lintHooks } from '../../src/service/config/hook-lint.ts';
import { apply, ConfigError, plan, readManifest, type Bounds } from '../../src/service/config/transaction.ts';

const REPO = join(import.meta.dirname, '..', '..');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function sandbox(settings: object | null = { model: 'claude-fixture', hooks: { Stop: [{ hooks: [{ type: 'command', command: '/tmp/xaibo-fixture/tools/flow-hook.sh stop' }] }] } }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'xcp-')));
  const profile = join(base, 'profile');
  const configDir = join(profile, '.claude');
  const dataDir = join(base, 'data');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir);
  if (settings) writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings, null, 2));
  const claude = join(base, 'fake-claude');
  writeFakeClaude(claude);
  const fwd = join(base, 'forwarder-build');
  writeFileSync(fwd, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const shim = deployShim(dataDir, { hook: join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder: fwd });
  const bounds: Bounds = { root: profile, denied: [join(base, 'denied')] };
  const o: PluginOptions = { dataDir, profileKey: 'p1', configDir, claude, bounds, path: '/usr/bin:/bin' };
  writeFileSync(join(profile, 'fake-claude.data'), dataDir); // the CLI env is explicit: the snapshot mode finds the data dir here
  const log = () => (existsSync(join(profile, 'fake-claude.log'))
    ? readFileSync(join(profile, 'fake-claude.log'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as { argv: string[]; dir: string }) : []);
  const setMode = (m: string) => writeFileSync(join(profile, 'fake-claude.mode'), m);
  const envs = () => (existsSync(join(profile, 'fake-claude.env'))
    ? readFileSync(join(profile, 'fake-claude.env'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as { keys: string[]; env: Record<string, string>; cwd: string }) : []);
  return { base, profile, configDir, dataDir, claude, shim, fwd, bounds, o, log, envs, setMode, settings: join(configDir, 'settings.json') };
}
/** Part 2b: the one confirmation is the preview; install takes it back. */
const install = async (o: PluginOptions) => installPlugin(o, previewPlugin(o));
const codeOf = async (p: Promise<unknown> | (() => unknown)) => {
  try { await (typeof p === 'function' ? p() : p); } catch (e) { return e instanceof ConfigError ? e.code : String(e); }
  return 'no error';
};

test('pluginHooks: every §5.2 event, one command hook through the shim, async except Stop; passes the hook lint', () => {
  const shim = '/tmp/xaibo-fixture/app/integrations/bin/xaibo-hook';
  const h = pluginHooks(shim, 'p1') as { hooks: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]> };
  assert.deepEqual(Object.keys(h.hooks), [...CLAUDE_HOOK_EVENTS]);
  assert.deepEqual(lintHooks(h, { shim, asyncRequired: true }), []);
  for (const [ev, groups] of Object.entries(h.hooks)) {
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]!.hooks, [{ type: 'command', command: `'${shim}' hook claude p1`, ...(ev === 'Stop' ? {} : { async: true }) }]);
  }
  for (const ev of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']) assert.equal(h.hooks[ev]![0]!.matcher, '*');
  assert.throws(() => pluginHooks("/tmp/it's", 'p1'));
  assert.throws(() => pluginHooks(shim, 'bad key'));
});

test('writePlugin: the S4 marketplace layout, nothing else (no skills, MCP or output); private dirs', () => {
  const s = sandbox();
  const dir = writePlugin(s.dataDir, 'p1', s.shim);
  assert.equal(dir, join(s.dataDir, 'integrations', 'claude-plugin', 'p1'));
  const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile()).sort();
  assert.deepEqual(files, ['.claude-plugin/marketplace.json', 'xaibo-hooks/.claude-plugin/plugin.json', 'xaibo-hooks/hooks/hooks.json']);
  const tpl = join(REPO, 'integrations', 'claude-plugin');
  for (const f of ['.claude-plugin/marketplace.json', 'xaibo-hooks/.claude-plugin/plugin.json']) assert.deepEqual(JSON.parse(readFileSync(join(dir, f), 'utf8')), JSON.parse(readFileSync(join(tpl, f), 'utf8')));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'xaibo-hooks', 'hooks', 'hooks.json'), 'utf8')), pluginHooks(s.shim, 'p1'));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('install: the S4 argv sequence with CLAUDE_CONFIG_DIR = the profile; manifest entry with pre/post hashes; duplicate refused', async () => {
  const s = sandbox();
  const pre = readFileSync(s.settings);
  const entry = await install(s.o);
  const dir = join(s.dataDir, 'integrations', 'claude-plugin', 'p1');
  assert.deepEqual(s.log(), [
    { argv: ['plugin', 'marketplace', 'add', dir], dir: s.configDir },
    { argv: ['plugin', 'install', PLUGIN_REF, '-s', 'user'], dir: s.configDir },
  ]);
  assert.equal(entry.route, 'claude-plugin');
  assert.equal(entry.target, s.settings);
  assert.equal(entry.preHash, sha(pre));
  assert.equal(entry.postHash, sha(readFileSync(s.settings)));
  assert.deepEqual(readManifest(s.dataDir).map((e) => e.id), [entry.id]);
  assert.equal(await codeOf(install(s.o)), 'duplicate');
  assert.equal(s.log().length, 2, 'no CLI call for a refused install');
});

test('EC-09: plugin and settings fallback exclude each other in both directions', async () => {
  const s = sandbox();
  await install(s.o);
  const ops = [{ op: 'append' as const, pointer: '/hooks/SessionStart', value: { hooks: [{ type: 'command', command: `'${s.shim}' hook claude p1`, async: true }] } }];
  assert.equal(await codeOf(() => apply(plan(s.settings, 'claude-settings-fallback', ops, s.bounds), { dataDir: s.dataDir, bounds: s.bounds })), 'exclusive');

  const t = sandbox();
  apply(plan(t.settings, 'claude-settings-fallback', ops, t.bounds), { dataDir: t.dataDir, bounds: t.bounds });
  assert.equal(await codeOf(install(t.o)), 'exclusive');
  assert.deepEqual(t.log(), []);
});

test('uninstall: the S4 sequence; manifest entry and plugin copy removed; pre-hash restored, or the residue reported', async () => {
  const s = sandbox();
  const pre = readFileSync(s.settings);
  await install(s.o);
  assert.deepEqual(await uninstallPlugin(s.o), { result: 'restored', preHashRestored: true, residue: [], conflicts: [] });
  assert.deepEqual(s.log().slice(2), [
    { argv: ['plugin', 'uninstall', PLUGIN_REF, '-s', 'user'], dir: s.configDir },
    { argv: ['plugin', 'marketplace', 'remove', 'xaibo'], dir: s.configDir },
  ]);
  assert.deepEqual(readFileSync(s.settings), pre);
  assert.deepEqual(readManifest(s.dataDir), []);
  assert.ok(!existsSync(join(s.dataDir, 'integrations', 'claude-plugin', 'p1')));
  assert.equal(await codeOf(uninstallPlugin(s.o)), 'not-installed');

  const t = sandbox(); // part 2c: residue keeps the entry and restores nothing yet
  await install(t.o);
  t.setMode('residue');
  assert.deepEqual(await uninstallPlugin(t.o), { result: 'unchanged', preHashRestored: false, residue: [PLUGIN_REF, `installed:${PLUGIN_REF}`], conflicts: [] });
  assert.equal(readManifest(t.dataDir).length, 1);
});

test('a failed install rolls back: marketplace removed, no manifest entry, settings untouched', async () => {
  const s = sandbox();
  s.setMode('fail-install');
  const pre = readFileSync(s.settings);
  assert.equal(await codeOf(install(s.o)), 'cli');
  assert.deepEqual(s.log().map((l) => l.argv.slice(0, 3).join(' ')), ['plugin marketplace add', 'plugin install xaibo-hooks@xaibo', 'plugin marketplace remove']);
  assert.deepEqual(readManifest(s.dataDir), []);
  assert.deepEqual(readFileSync(s.settings), pre);
  assert.deepEqual(readdirSync(join(s.dataDir, 'integrations', 'backups')), [], 'part 2b: the backup goes with the dropped entry');
});

test('nothing runs outside the profile bounds, under a denied root, or without a deployed shim', async () => {
  const s = sandbox();
  const outside = join(s.base, 'elsewhere', '.claude');
  mkdirSync(outside, { recursive: true });
  assert.equal(await codeOf(install({ ...s.o, configDir: outside })), 'outside-root');
  assert.equal(await codeOf(install({ ...s.o, bounds: { root: s.profile, denied: [s.configDir] } })), 'denied-root');
  const t = sandbox();
  spawnSync('/bin/rm', [join(t.dataDir, 'integrations', 'bin', 'xaibo-hook')]);
  assert.equal(await codeOf(install(t.o)), 'shim-missing');
  assert.deepEqual([...s.log(), ...t.log()], []);
});

test('deployShim: shim and forwarder in a private bin dir, not group/other writable; a redeploy replaces them by rename', () => {
  const s = sandbox();
  const bin = join(s.dataDir, 'integrations', 'bin');
  assert.equal(s.shim, join(bin, 'xaibo-hook'));
  assert.equal(statSync(bin).mode & 0o777, 0o700);
  for (const f of ['xaibo-hook', 'xaibo-forwarder']) assert.equal(statSync(join(bin, f)).mode & 0o777, 0o755);
  const ino = statSync(join(bin, 'xaibo-forwarder')).ino;
  writeFileSync(s.fwd, '#!/bin/sh\nexit 0 # v2\n');
  deployShim(s.dataDir, { hook: join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder: s.fwd });
  assert.notEqual(statSync(join(bin, 'xaibo-forwarder')).ino, ino);
  assert.match(readFileSync(join(bin, 'xaibo-forwarder'), 'utf8'), /v2/);
  assert.deepEqual(readdirSync(bin).sort(), ['xaibo-forwarder', 'xaibo-hook', 'xaibo-report'], 'no temp files left (the report shim ships beside the hook shim, P3-T13c)');
});

test('dev CLI: claude-plugin apply deploys the shim and installs; status lists it; revert uninstalls', () => {
  const s = sandbox();
  const home = join(s.base, 'home');
  mkdirSync(home);
  const sh = join(s.base, 'fake-shell');
  writeFileSync(sh, "#!/bin/sh\nprintf 'PATH=/usr/bin:/bin\\000'\n");
  chmodSync(sh, 0o700);
  const env = { PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), HOME: home, XAIBO_DATA_DIR: s.dataDir, SHELL: sh };
  const cli = (args: string[]) => spawnSync(process.execPath, [join(REPO, 'src', 'service', 'config', 'dev-cli.ts'), ...args], { encoding: 'utf8', env, input: '' });
  const common = ['--target', 'claude-plugin', '--profile', s.profile, '--yes'];
  const a = cli(['apply', ...common, '--claude', s.claude, '--profile-key', 'p1', '--forwarder', s.fwd]);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /installed/);
  assert.equal(s.log().length, 2);
  const st = cli(['status', '--target', 'claude-plugin', '--profile', s.profile]);
  assert.match(st.stdout, /claude-plugin applied/);
  const r = cli(['revert', ...common, '--claude', s.claude, '--profile-key', 'p1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pre-install settings restored/);
  assert.deepEqual(readManifest(s.dataDir), []);
});

// Codex review of P3-T05 (findings 1, 2, 4).
test('R1: a symlinked config dir, plugins/ or plugins entry is refused before any CLI call', async () => {
  for (const which of ['plugins', 'plugins/cache', 'config']) {
    const s = sandbox();
    const outside = join(s.base, 'outside');
    mkdirSync(outside);
    if (which === 'config') {
      const cfg = join(s.profile, '.claude-real');
      spawnSync('/bin/mv', [s.configDir, cfg]);
      symlinkSync(cfg, s.configDir);
    } else {
      if (which === 'plugins/cache') mkdirSync(join(s.configDir, 'plugins'));
      symlinkSync(outside, join(s.configDir, which));
    }
    assert.equal(await codeOf(install(s.o)), 'symlink', which);
    assert.deepEqual(s.log(), []);
  }
});

test('R2: a failed install that changed the profile keeps its pending entry and copy; uninstall then cleans it', async () => {
  const s = sandbox();
  s.setMode('fail-dirty');
  assert.equal(await codeOf(install(s.o)), 'cli');
  const [e] = readManifest(s.dataDir);
  assert.equal(e?.route, 'claude-plugin');
  assert.equal(e?.state, 'pending');
  assert.ok(existsSync(join(s.dataDir, 'integrations', 'claude-plugin', 'p1')));
  s.setMode('');
  assert.deepEqual(await uninstallPlugin(s.o), { result: 'restored', preHashRestored: true, residue: [], conflicts: [] }, 'part 2c: a pending entry whose profile differs only by Xaibo\'s key is restored');
  assert.deepEqual(readManifest(s.dataDir), []);
});

test('R4: an uninstall that leaves residue keeps the entry, so exclusivity still holds and it can be retried', async () => {
  const s = sandbox();
  await install(s.o);
  s.setMode('residue');
  assert.deepEqual(await uninstallPlugin(s.o), { result: 'unchanged', preHashRestored: false, residue: [PLUGIN_REF, `installed:${PLUGIN_REF}`], conflicts: [] });
  assert.equal(readManifest(s.dataDir).length, 1);
  assert.ok(existsSync(join(s.dataDir, 'integrations', 'claude-plugin', 'p1')));
  const ops = [{ op: 'append' as const, pointer: '/hooks/SessionStart', value: { hooks: [{ type: 'command', command: `'${s.shim}' hook claude p1`, async: true }] } }];
  assert.equal(await codeOf(() => apply(plan(s.settings, 'claude-settings-fallback', ops, s.bounds), { dataDir: s.dataDir, bounds: s.bounds })), 'exclusive');
});

// Codex re-review of P3-T05 (round 2).
test('R1b: a symlink nested anywhere under plugins/ is refused before any CLI call', async () => {
  const s = sandbox();
  const outside = join(s.base, 'outside');
  mkdirSync(outside);
  mkdirSync(join(s.configDir, 'plugins', 'marketplaces'), { recursive: true });
  symlinkSync(outside, join(s.configDir, 'plugins', 'marketplaces', 'xaibo'));
  assert.equal(await codeOf(install(s.o)), 'symlink');
  assert.deepEqual(s.log(), []);
});

test('R2b: registry entries are matched on decoded JSON keys, so escaped names still count as residue', async () => {
  const s = sandbox();
  await install(s.o);
  mkdirSync(join(s.configDir, 'plugins'), { recursive: true });
  writeFileSync(join(s.configDir, 'plugins', 'installed_plugins.json'), '{"version":2,"plugins":{"xaibo-hooks@xa\\u0069bo":[{"scope":"user"}]}}');
  writeFileSync(join(s.configDir, 'plugins', 'known_marketplaces.json'), '{"xa\\u0069bo":{"source":{"source":"directory"}}}');
  s.setMode('keep-registries');
  const r = await uninstallPlugin(s.o); // part 2c: the escaped marketplace names no plugin dir: not ours, so no CLI call
  assert.deepEqual(r.residue, [PLUGIN_REF, `marketplace:xaibo`, `installed:${PLUGIN_REF}`]);
  assert.deepEqual(r.conflicts, [{ pointer: 'marketplace:xaibo' }]);
  assert.equal(readManifest(s.dataDir).length, 1, 'kept while registered');
  writeFileSync(join(s.configDir, 'plugins', 'known_marketplaces.json'), '{not json');
  writeFileSync(join(s.configDir, 'plugins', 'installed_plugins.json'), '{}');
  assert.deepEqual((await uninstallPlugin(s.o)).residue, [PLUGIN_REF, 'unreadable:plugins/known_marketplaces.json']);
  assert.equal(readManifest(s.dataDir).length, 1);
});

test('R5: deeply nested registry JSON is searched without overflowing the stack', async () => {
  const s = sandbox();
  await install(s.o);
  mkdirSync(join(s.configDir, 'plugins'), { recursive: true });
  writeFileSync(join(s.configDir, 'plugins', 'installed_plugins.json'), `${'['.repeat(10_000)}"${PLUGIN_REF}"${']'.repeat(10_000)}`);
  s.setMode('keep-registries'); // part 2b: the fake also registers the marketplace, kept in this mode
  assert.deepEqual((await uninstallPlugin(s.o)).residue, [`marketplace:xaibo`, `installed:${PLUGIN_REF}`]);
});

test('R5b: a very wide registry array is searched without exceeding the argument limit', async () => {
  const s = sandbox();
  await install(s.o);
  mkdirSync(join(s.configDir, 'plugins'), { recursive: true });
  writeFileSync(join(s.configDir, 'plugins', 'installed_plugins.json'), JSON.stringify([...Array(300_000).fill('x'), PLUGIN_REF]));
  s.setMode('keep-registries'); // part 2b: the fake also registers the marketplace, kept in this mode
  assert.deepEqual((await uninstallPlugin(s.o)).residue, [`marketplace:xaibo`, `installed:${PLUGIN_REF}`]);
});

// XAIBO-PROD-560 (P6-T03 part 2b; design .handoff/p6-t03-design.md part 2b slice and its review): the confirmed preview binds
// the settings file and the executable (and its interpreter); the CLI runs with an explicit environment in a private cwd; a
// pending entry with a backup of the pre-install bytes exists before the first spawn; the installed effect is verified.
const ids = (f: string) => { const st = statSync(f); return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs }; };

test('2b previewPlugin: settings and executable identity, the exact argv; nothing runs, nothing is written', () => {
  const s = sandbox();
  const pv = previewPlugin(s.o);
  const dir = join(s.dataDir, 'integrations', 'claude-plugin', 'p1');
  assert.equal(pv.target, s.settings);
  assert.deepEqual(pv.argv, [['plugin', 'marketplace', 'add', dir], ['plugin', 'install', PLUGIN_REF, '-s', 'user'], ['plugin', 'marketplace', 'remove', 'xaibo']]);
  assert.equal(pv.settings?.hash, sha(readFileSync(s.settings)));
  assert.equal(pv.exe.path, realpathSync(s.claude));
  assert.deepEqual(pv.exe.id, ids(s.claude));
  assert.equal(pv.interp?.path, realpathSync(process.execPath), 'the fake runs under #!<node>: its interpreter is bound too (review M2)');
  assert.deepEqual(s.log(), []);
  assert.deepEqual(readManifest(s.dataDir), []);
  assert.ok(!existsSync(dir));
  const t = sandbox(null);
  assert.equal(previewPlugin(t.o).settings, null, 'no settings.json yet: absent');
});

test('2b install: env exactly PATH, HOME, TMPDIR, CLAUDE_CONFIG_DIR and the three traffic switches; cwd = the private CLI home', async () => {
  const s = sandbox();
  process.env['ANTHROPIC_API_KEY'] = 'fixture-not-a-key'; // never inherited
  try { await install(s.o); } finally { delete process.env['ANTHROPIC_API_KEY']; }
  const home = join(s.dataDir, 'integrations', 'cli-home');
  assert.equal(s.envs().length, 2);
  for (const e of s.envs()) {
    // macOS adds __CF_USER_TEXT_ENCODING to every process it starts; it is not inherited from Xaibo's environment
    const keys = e.keys.filter((k) => k !== '__CF_USER_TEXT_ENCODING');
    delete e.env['__CF_USER_TEXT_ENCODING'];
    assert.deepEqual(keys, ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'HOME', 'PATH', 'TMPDIR']);
    assert.deepEqual(e.env, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: s.configDir, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', HOME: home, PATH: '/usr/bin:/bin', TMPDIR: join(home, 'tmp') });
    assert.equal(realpathSync(e.cwd), realpathSync(home));
  }
  assert.equal(statSync(home).mode & 0o777, 0o700);
});

test('2b journal: before the first spawn a pending entry (phase marketplace) with a backup of the pre-install bytes; applied after', async () => {
  const s = sandbox();
  const pre = readFileSync(s.settings);
  s.setMode('snapshot');
  const entry = await install(s.o);
  const snap = JSON.parse(readFileSync(join(s.profile, 'fake-claude.manifest'), 'utf8')) as { entries: { id: string; state: string; phase?: string; backup: string | null; exe?: unknown }[] };
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0]!.state, 'pending');
  assert.equal(snap.entries[0]!.phase, 'marketplace');
  assert.ok(snap.entries[0]!.exe, 'the executable identity is journaled');
  assert.deepEqual(readFileSync(join(s.dataDir, 'integrations', 'backups', snap.entries[0]!.backup!)), pre);
  assert.equal(entry.state, 'applied');
  assert.equal(entry.backup, snap.entries[0]!.backup);
  assert.equal(entry.preHash, sha(pre));
});

test('2b changed since the preview (bytes, absence, inode, mode, executable, collision): no CLI call, no entry', async () => {
  const cases: [string, (s: ReturnType<typeof sandbox>) => void, string][] = [
    ['bytes', (s) => writeFileSync(s.settings, '{"theme":"light"}'), 'changed'],
    ['absent', (s) => spawnSync('/bin/rm', [s.settings]), 'changed'],
    ['inode', (s) => { const b = readFileSync(s.settings); spawnSync('/bin/rm', [s.settings]); writeFileSync(s.settings, b); }, 'changed'],
    ['mode', (s) => chmodSync(s.settings, 0o640), 'changed'],
    ['executable', (s) => writeFileSync(s.claude, `${readFileSync(s.claude, 'utf8')}// v2\n`), 'changed'],
    ['collision', (s) => { mkdirSync(join(s.configDir, 'plugins')); writeFileSync(join(s.configDir, 'plugins', 'known_marketplaces.json'), '{"xaibo":{}}'); }, 'duplicate'],
  ];
  for (const [name, change, code] of cases) {
    // ponytail (D-P6-25, as D-P6-02): ext4 reuses an inode number at once, so a same-path replace keeps its identity off
    // macOS (APFS, the MVP target, gives a new one); compare birthtime too before S-23 (Linux)
    if (name === 'inode' && process.platform !== 'darwin') continue;
    const s = sandbox();
    const pv = previewPlugin(s.o);
    change(s);
    assert.equal(await codeOf(installPlugin(s.o, pv)), code, name);
    assert.deepEqual(s.log(), [], name);
    assert.deepEqual(readManifest(s.dataDir), [], name);
  }
});

test('2b preview refusals: a pre-existing xaibo enabled key; the detected identity differs; an unresolvable interpreter', async () => {
  const s = sandbox({ enabledPlugins: { 'other@xaibo': true } });
  assert.equal(await codeOf(() => previewPlugin(s.o)), 'duplicate');
  const t = sandbox();
  const expect = ids(t.claude);
  writeFileSync(t.claude, `${readFileSync(t.claude, 'utf8')}// swapped after detection\n`);
  assert.equal(await codeOf(() => previewPlugin({ ...t.o, expect })), 'unverified', 'review H1');
  const u = sandbox();
  writeFileSync(u.claude, readFileSync(u.claude, 'utf8').replace(/^#!.*$/m, '#!/usr/bin/env xaibo-fixture-no-such-node'));
  assert.equal(await codeOf(() => previewPlugin(u.o)), 'unverified', 'review M2');
  assert.deepEqual([...s.log(), ...t.log(), ...u.log()], []);
});

test('2b the executable changes between the two CLI steps: no further spawn (not even the compensation); entry kept; changed', async () => {
  const s = sandbox();
  s.setMode('touch-self');
  assert.equal(await codeOf(install(s.o)), 'changed');
  assert.deepEqual(s.log().map((l) => l.argv.slice(0, 3).join(' ')), ['plugin marketplace add']);
  assert.equal(readManifest(s.dataDir)[0]?.state, 'pending', 'the marketplace may be registered: the entry stays for 2c/P6-T04');
});

test('2b the installed effect is verified: a clean exit without the enabled plugin is a dirty failure (cli), compensated', async () => {
  const s = sandbox();
  s.setMode('no-enable');
  assert.equal(await codeOf(install(s.o)), 'cli');
  assert.deepEqual(s.log().map((l) => l.argv.slice(0, 3).join(' ')), ['plugin marketplace add', 'plugin install xaibo-hooks@xaibo', 'plugin marketplace remove']);
  assert.equal(readManifest(s.dataDir)[0]?.state, 'pending', 'the installed registry entry is still there: kept');
});

// Code review (run 195) M2: `#!/usr/bin/env <name>` is resolved again at spawn time, so an interpreter appearing earlier on the
// PATH after the preview is a change: refused before anything is written or run.
test('2b review M2: an interpreter shadowing the previewed one on the PATH is a change; nothing runs', async () => {
  const s = sandbox();
  const [early, late] = [join(s.base, 'early-bin'), join(s.base, 'late-bin')];
  for (const d of [early, late]) mkdirSync(d);
  const wrapper = `#!/bin/sh\nexec '${process.execPath}' "$@"\n`;
  writeFileSync(join(late, 'xaibo-fixture-node'), wrapper, { mode: 0o755 });
  writeFileSync(s.claude, readFileSync(s.claude, 'utf8').replace(/^#!.*$/m, '#!/usr/bin/env xaibo-fixture-node'));
  const o = { ...s.o, path: `${early}:${late}` };
  const pv = previewPlugin(o);
  assert.equal(pv.interp?.path, join(late, 'xaibo-fixture-node'));
  writeFileSync(join(early, 'xaibo-fixture-node'), wrapper, { mode: 0o755 });
  assert.equal(await codeOf(installPlugin(o, pv)), 'changed');
  assert.deepEqual(s.log(), []);
  assert.deepEqual(readManifest(s.dataDir), []);
});

// XAIBO-PROD-561 (P6-T03 part 2c; design .handoff/p6-t03-design.md part 2c slice and review): removal only where Xaibo's
// ownership is proven (enabled key true, the xaibo marketplace naming our plugin dir, no foreign plugin on it), else a
// conflict and no CLI call; the pre-install bytes and mode come back when nothing but Xaibo's key changed; owner edits are
// never overwritten; a CLI that drops a foreign value in that case is a conflict kept as partial evidence.
const cliCalls = (s: ReturnType<typeof sandbox>) => s.log().map((l) => l.argv.slice(0, 3).join(' '));

test('2c restore: the pre-install bytes and mode come back although the CLI rewrote the file at 0600 and compactly', async () => {
  const s = sandbox();
  chmodSync(s.settings, 0o644);
  const pre = readFileSync(s.settings);
  s.setMode('install-0600');
  await install(s.o);
  assert.equal(statSync(s.settings).mode & 0o777, 0o600);
  s.setMode('');
  assert.deepEqual(await uninstallPlugin(s.o), { result: 'restored', preHashRestored: true, residue: [], conflicts: [] });
  assert.deepEqual(readFileSync(s.settings), pre);
  assert.equal(statSync(s.settings).mode & 0o777, 0o644, 'review M4: the pre-install mode');
  assert.deepEqual(readManifest(s.dataDir), []);
  assert.deepEqual(readdirSync(join(s.dataDir, 'integrations', 'backups')), []);
  assert.ok(!existsSync(join(s.dataDir, 'integrations', 'claude-plugin', 'p1')));
});

test('2c no settings.json before install: removed again', async () => {
  const s = sandbox(null);
  await install(s.o);
  assert.ok(existsSync(s.settings));
  assert.equal((await uninstallPlugin(s.o)).result, 'removed');
  assert.ok(!existsSync(s.settings));
  assert.deepEqual(readManifest(s.dataDir), []);
});

test('2c an owner edit since install: structural, the edit survives, no backup written over it', async () => {
  const s = sandbox();
  await install(s.o);
  const doc = JSON.parse(readFileSync(s.settings, 'utf8')) as Record<string, unknown>;
  writeFileSync(s.settings, JSON.stringify({ ...doc, ownerKey: 'kept' }, null, 2));
  const r = await uninstallPlugin(s.o);
  assert.deepEqual(r, { result: 'structural', preHashRestored: false, residue: [], conflicts: [] });
  const after = JSON.parse(readFileSync(s.settings, 'utf8')) as Record<string, unknown>;
  assert.equal(after['ownerKey'], 'kept');
  assert.equal(after['model'], 'claude-fixture');
  assert.ok(!JSON.stringify(after).includes(PLUGIN_REF));
  assert.deepEqual(readManifest(s.dataDir), []);
});

test('2c ownership not proven: an owner-changed enabled key, a foreign xaibo marketplace, a foreign plugin on it -> conflict, no CLI call', async () => {
  const cases: [string, (s: ReturnType<typeof sandbox>) => void, string][] = [
    ['disabled', (s) => { const d = JSON.parse(readFileSync(s.settings, 'utf8')); d.enabledPlugins[PLUGIN_REF] = false; writeFileSync(s.settings, JSON.stringify(d)); }, `/enabledPlugins/${PLUGIN_REF}`],
    ['foreign marketplace', (s) => writeFileSync(join(s.configDir, 'plugins', 'known_marketplaces.json'), '{"xaibo":{"source":{"source":"directory","path":"/opt/other-marketplace"}}}'), 'marketplace:xaibo'],
    ['foreign plugin', (s) => writeFileSync(join(s.configDir, 'plugins', 'installed_plugins.json'), `{"${PLUGIN_REF}":[{}],"other@xaibo":[{}]}`), 'marketplace:xaibo'],
  ];
  for (const [name, change, pointer] of cases) {
    const s = sandbox();
    await install(s.o);
    change(s);
    const before = readFileSync(s.settings);
    const r = await uninstallPlugin(s.o);
    assert.equal(r.result, 'unchanged', name);
    assert.deepEqual(r.conflicts, [{ pointer }], name);
    assert.equal(s.log().length, 2, `${name}: no CLI call after the install`);
    assert.deepEqual(readFileSync(s.settings), before, name);
    assert.equal(readManifest(s.dataDir).length, 1, `${name}: entry kept`);
  }
});

test('2c structural path: a CLI that drops or adds a foreign value is a conflict kept as partial, reported again on retry', async () => {
  for (const mode of ['drop-foreign', 'add-benign']) {
    const s = sandbox({ theme: 'dark', model: 'claude-fixture' });
    await install(s.o);
    const doc = JSON.parse(readFileSync(s.settings, 'utf8')) as Record<string, unknown>;
    writeFileSync(s.settings, JSON.stringify({ ...doc, ownerKey: 1 }, null, 2)); // owner edit: structural path
    s.setMode(mode);
    const r = await uninstallPlugin(s.o);
    assert.equal(r.result, 'structural', mode);
    assert.deepEqual(r.conflicts, [{ pointer: '/' }], mode);
    const [e] = readManifest(s.dataDir);
    assert.equal(e?.partial, true, `${mode}: kept as partial evidence`);
    s.setMode('');
    const again = await uninstallPlugin(s.o);
    assert.deepEqual(again.conflicts, [{ pointer: '/' }], `${mode}: reported again, never restored`);
    assert.deepEqual(readManifest(s.dataDir), []);
  }
});

test('2c pending entries: after a marketplace add only `marketplace remove` runs; with nothing registered no CLI call', async () => {
  const s = sandbox();
  const pre = readFileSync(s.settings);
  s.setMode('touch-self'); // the executable changes after `marketplace add`: the install stops with the entry pending
  assert.equal(await codeOf(install(s.o)), 'changed');
  s.setMode('');
  assert.equal((await uninstallPlugin(s.o)).result, 'restored');
  assert.deepEqual(cliCalls(s), ['plugin marketplace add', 'plugin marketplace remove']);
  assert.deepEqual(readFileSync(s.settings), pre);
  assert.deepEqual(readManifest(s.dataDir), []);

  const t = sandbox();
  t.setMode('touch-self');
  await codeOf(install(t.o));
  writeFileSync(join(t.configDir, 'plugins', 'known_marketplaces.json'), '{}'); // nothing of Xaibo's registered any more
  t.setMode('');
  assert.equal((await uninstallPlugin(t.o)).result, 'restored');
  assert.deepEqual(cliCalls(t), ['plugin marketplace add'], 'no CLI call for the removal');
  assert.deepEqual(readManifest(t.dataDir), []);
});

test('2c review M7: the registry may store the realpath of the plugin dir (data dir reached through a symlink)', async () => {
  const s = sandbox();
  const link = join(s.base, 'data-link');
  symlinkSync(s.dataDir, link);
  const o = { ...s.o, dataDir: link };
  writeFileSync(join(s.profile, 'fake-claude.data'), link);
  s.setMode('realpath-source');
  await install(o);
  assert.equal((await uninstallPlugin(o)).result, 'restored');
  assert.deepEqual(readManifest(s.dataDir), []);
});

test('2c unreadable settings at removal: a conflict, no CLI call, entry kept; the dev CLI key must match the entry', async () => {
  const s = sandbox();
  await install(s.o);
  writeFileSync(s.settings, '{ not json');
  const r = await uninstallPlugin(s.o);
  assert.deepEqual(r.conflicts, [{ pointer: '/' }]);
  assert.equal(s.log().length, 2);
  assert.equal(readManifest(s.dataDir).length, 1);
  const t = sandbox();
  await install(t.o);
  assert.equal(await codeOf(uninstallPlugin({ ...t.o, profileKey: 'p2' })), 'ops', 'review M8: another profile key');
  assert.equal(readManifest(t.dataDir)[0]?.profileKey, 'p1');
});

// Code review (run 196) M1: a settings change made while the CLI ran is never overwritten by the backup; M3: an unusable
// backup is a conflict kept as partial (the CLI's removal stands), never an error that blocks the entry for good.
test('2c review M1/M3: a change during the CLI run, or an unusable backup: no restore, conflict kept as partial, then dropped', async () => {
  const s = sandbox();
  await install(s.o);
  s.setMode('add-benign'); // the file changes while `plugin uninstall` runs
  const r = await uninstallPlugin(s.o);
  assert.deepEqual([r.result, r.conflicts], ['structural', [{ pointer: '/' }]]);
  assert.equal((JSON.parse(readFileSync(s.settings, 'utf8')) as Record<string, unknown>)['cliAdded'], true, 'not overwritten');
  assert.equal(readManifest(s.dataDir)[0]?.partial, true);

  const t = sandbox();
  await install(t.o);
  for (const f of readdirSync(join(t.dataDir, 'integrations', 'backups'))) spawnSync('/bin/rm', [join(t.dataDir, 'integrations', 'backups', f)]);
  const u = await uninstallPlugin(t.o);
  assert.deepEqual([u.result, u.conflicts], ['structural', [{ pointer: '/' }]]);
  assert.equal(readManifest(t.dataDir)[0]?.partial, true);
  assert.deepEqual((await uninstallPlugin(t.o)).conflicts, [{ pointer: '/' }]);
  assert.deepEqual(readManifest(t.dataDir), [], 'dropped on the second pass');
});
