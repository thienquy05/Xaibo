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
  await install(s.o);
  const pre = readFileSync(join(s.profile, 'fake-claude.orig'));
  assert.deepEqual(await uninstallPlugin(s.o), { preHashRestored: true, residue: [] });
  assert.deepEqual(s.log().slice(2), [
    { argv: ['plugin', 'uninstall', PLUGIN_REF, '-s', 'user'], dir: s.configDir },
    { argv: ['plugin', 'marketplace', 'remove', 'xaibo'], dir: s.configDir },
  ]);
  assert.deepEqual(readFileSync(s.settings), pre);
  assert.deepEqual(readManifest(s.dataDir), []);
  assert.ok(!existsSync(join(s.dataDir, 'integrations', 'claude-plugin', 'p1')));
  assert.equal(await codeOf(uninstallPlugin(s.o)), 'not-installed');

  for (const [mode, want] of [['residue', { preHashRestored: false, residue: [PLUGIN_REF, `installed:${PLUGIN_REF}`] }], ['empty-left', { preHashRestored: false, residue: [] }]] as const) {
    const t = sandbox();
    await install(t.o);
    t.setMode(mode);
    assert.deepEqual(await uninstallPlugin(t.o), want);
  }
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
  assert.deepEqual(await uninstallPlugin(s.o), { preHashRestored: true, residue: [] });
  assert.deepEqual(readManifest(s.dataDir), []);
});

test('R4: an uninstall that leaves residue keeps the entry, so exclusivity still holds and it can be retried', async () => {
  const s = sandbox();
  await install(s.o);
  s.setMode('residue');
  assert.deepEqual(await uninstallPlugin(s.o), { preHashRestored: false, residue: [PLUGIN_REF, `installed:${PLUGIN_REF}`] });
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
  const r = await uninstallPlugin(s.o);
  assert.deepEqual(r.residue, [`marketplace:xaibo`, `installed:${PLUGIN_REF}`]);
  assert.equal(readManifest(s.dataDir).length, 1, 'kept while registered');
  writeFileSync(join(s.configDir, 'plugins', 'known_marketplaces.json'), '{not json');
  writeFileSync(join(s.configDir, 'plugins', 'installed_plugins.json'), '{}');
  assert.deepEqual((await uninstallPlugin(s.o)).residue, ['unreadable:plugins/known_marketplaces.json']);
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
