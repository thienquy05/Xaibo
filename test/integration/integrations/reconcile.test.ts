// XAIBO-PROD-562 (P6-T04 part 1; EC-26; design .handoff/p6-t04-design.md: Codex, fresh security review adopted; owner D-P6-08):
// a read-only reconcile of the FR-32 manifest against each disposable profile's config, run by a fresh createConnect over the
// same data dir (a service restart keeps nothing in memory). The plugin removed behind Xaibo's back is `disconnected-externally`
// with only manifest-owned leftovers offered; hook groups are found by deep equality (foreign rewrites are not drift, EC-72);
// retention and tee are judged at their own pointer; an owner's `false` is drift, never a removal; pending entries are
// reported, never repaired; a held or stale lock blocks the scan. Nothing is written, nothing spawned, no path on the report.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnect, type ConnectContext } from '../../../src/service/integrations/connect.ts';
import { readManifest, recordEntry, type ManifestEntry } from '../../../src/service/config/transaction.ts';
import { acquireLock } from '../../../src/service/config/lock.ts';
import { claudeContext, writeFakeClaude } from '../../helpers/fake-claude.ts';
import type { Profile } from '../../../src/service/catalog/detect.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const iso = mkdtempSync(join(tmpdir(), 'xreconcile-env-'));
dirs.push(iso);
for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR']) process.env[k] = join(iso, k.toLowerCase());
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
const put = (f: string, v: unknown) => writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);

const CLAUDE_SETTINGS = {
  theme: 'dark',
  enabledPlugins: { 'other@elsewhere': true },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /opt/agent-flow/hook.js pre', async: true }] }] },
  statusLine: { type: 'command', command: '/opt/custom/statusline.sh', padding: 1 },
};
const CODEX_HOOKS = { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/opt/other/notify-stop' }] }] } };
const AGY_HOOKS = { other: { Stop: [{ type: 'command', command: '/opt/other/agy-stop', timeout: 5 }] } };

async function world(o: { route?: 'plugin' | 'fallback' } = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xreconcile-')));
  dirs.push(base);
  const home = join(base, 'home'), managed = join(base, 'managed'), helpers = join(base, 'helpers'), dataDir = join(base, 'data');
  const claudeDir = join(home, '.claude'), codexDir = join(home, '.codex'), agyRoot = join(home, '.gemini', 'antigravity-cli');
  for (const d of [claudeDir, codexDir, agyRoot, join(home, '.gemini', 'config'), managed, helpers, dataDir]) mkdirSync(d, { recursive: true, mode: 0o755 });
  const files = { claude: join(claudeDir, 'settings.json'), codex: join(codexDir, 'hooks.json'), agy: join(home, '.gemini', 'config', 'hooks.json') };
  put(files.claude, CLAUDE_SETTINGS);
  put(files.codex, CODEX_HOOKS);
  put(files.agy, AGY_HOOKS);
  for (const h of ['xaibo-hook', 'xaibo-report', 'xaibo-forwarder', 'xaibo-statusline']) writeFileSync(join(helpers, h), '#!/bin/sh\nexit 0\n');
  const fake = join(base, 'fake-claude');
  writeFakeClaude(fake);
  const ctx: ConnectContext = { ...await claudeContext({ ...(o.route ? { route: o.route } : {}), exe: fake }),
    dataDir, denied: [join(base, 'real')], allowed: [base], claudeManagedDir: managed,
    helpers: { hook: join(helpers, 'xaibo-hook'), forwarder: join(helpers, 'xaibo-forwarder'), statusline: join(helpers, 'xaibo-statusline') },
  };
  const profiles: Record<'claude' | 'codex' | 'agy', Profile> = {
    claude: { id: 'claude-1', agent: 'claude', root: claudeDir, origin: 'default' },
    codex: { id: 'codex-1', agent: 'codex', root: codexDir, origin: 'default' },
    agy: { id: 'agy-1', agent: 'agy', root: agyRoot, origin: 'default' },
  };
  const logFile = join(home, 'fake-claude.log');
  const spawns = () => { try { return readFileSync(logFile, 'utf8').trimEnd().split('\n').length; } catch { return 0; } };
  /** The plugin removed behind Xaibo's back: the CLI run directly, as the owner would. */
  const external = (...args: string[]) => execFileSync(fake, args, { env: { CLAUDE_CONFIG_DIR: claudeDir, PATH: '/usr/bin:/bin' } });
  /** A restarted service: a fresh createConnect over the same data dir, reconciling every current profile. */
  const restart = (c: Partial<ConnectContext> = {}, ps: Profile[] = Object.values(profiles)) => createConnect({ ...ctx, ...c }).reconcile(ps);
  return { base, home, dataDir, files, ctx, profiles, spawns, external, restart, c: createConnect(ctx) };
}
type W = Awaited<ReturnType<typeof world>>;
async function connect(w: W, p: Profile, sel = { retention: false, tee: false }) {
  const pv = w.c.previewConnect(p, sel);
  assert.equal(pv.status, 'preview', JSON.stringify(pv));
  const r = await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
  assert.equal(r.status, 'applied', JSON.stringify(r));
}
/** sha256 and mode of every regular file under the base (profiles, data dir, lock): "nothing written" covers foreign entries. */
function tree(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isDirectory()) tree(p, out);
    else if (st?.isFile()) out[p] = `${createHash('sha256').update(readFileSync(p)).digest('hex')}:${st.mode}`;
  }
  return out;
}
type Report = ReturnType<W['restart']>;
const states = (r: Report) => (r.status === 'ready' ? r.entries.map((e) => [e.route, e.state]) : r);
const xaibo = (g: unknown) => JSON.stringify(g).includes('xaibo-hook');

test('EC-26 plan case: the plugin uninstalled outside Xaibo -> disconnected-externally, owned leftovers only; nothing written, nothing spawned', async () => {
  const w = await world({ route: 'plugin' });
  await connect(w, w.profiles.claude);
  const [entry] = readManifest(w.dataDir);
  assert.equal(entry?.route, 'claude-plugin');
  w.external('plugin', 'uninstall', 'xaibo-hooks@xaibo', '-s', 'user'); // the marketplace registration stays behind
  const before = tree(w.base), spawned = w.spawns();
  const c = createConnect(w.ctx);
  const r = c.reconcile(Object.values(w.profiles));
  assert.deepEqual(r, { status: 'ready', entries: [{
    entry: entry!.id, route: 'claude-plugin', profileId: 'claude-1', state: 'disconnected-externally',
    cleanup: ['manifest-entry', 'backup'], manual: ['plugin-copy', 'marketplace'],
  }] });
  assert.deepEqual(c.reconciled(), r, 'the latest report is kept');
  assert.deepEqual(tree(w.base), before, 'every profile, foreign and data-dir file byte-identical');
  assert.equal(w.spawns(), spawned, 'D-P6-08: no Claude process');
  assert.ok(!JSON.stringify(r).includes(w.base), 'no path on the report');
  w.external('plugin', 'marketplace', 'remove', 'xaibo');
  const r2 = w.restart();
  assert.deepEqual(r2.status === 'ready' && r2.entries.map((e) => [e.state, e.cleanup, e.manual]), [['disconnected-externally', ['manifest-entry', 'backup'], ['plugin-copy']]]);
});

test('plugin evidence: intact -> connected; owner false -> drifted (never removed); key gone but still installed -> drifted; symlinked registry -> unreadable', async () => {
  const w = await world({ route: 'plugin' });
  await connect(w, w.profiles.claude);
  assert.deepEqual(states(w.restart()), [['claude-plugin', 'connected']]);
  const s = json(w.files.claude);
  put(w.files.claude, { ...s, enabledPlugins: { ...(s['enabledPlugins'] as object), 'xaibo-hooks@xaibo': false } });
  assert.deepEqual(states(w.restart()), [['claude-plugin', 'drifted']], 'review R4: false is how an owner pauses a plugin');
  put(w.files.claude, { ...s, enabledPlugins: { 'other@elsewhere': true } });
  assert.deepEqual(states(w.restart()), [['claude-plugin', 'drifted']], 'still installed');
  put(w.files.claude, s);
  const reg = join(w.home, '.claude', 'plugins', 'installed_plugins.json'), moved = join(w.base, 'elsewhere.json');
  writeFileSync(moved, readFileSync(reg));
  unlinkSync(reg);
  symlinkSync(moved, reg);
  const r = w.restart();
  assert.deepEqual(r.status === 'ready' && r.entries.map((e) => [e.state, e.reason, e.cleanup]), [['unreadable', 'symlink', []]], 'review R2');
});

test('fallback, retention, tee: foreign rewrites and unrelated edits are not drift (EC-72); each route judged at its own values', async () => {
  const w = await world();
  await connect(w, w.profiles.claude, { retention: true, tee: true });
  assert.deepEqual(states(w.restart()), [['claude-settings-fallback', 'connected'], ['claude-retention', 'connected'], ['claude-tee', 'connected']]);
  const s = json(w.files.claude) as { hooks: Record<string, unknown[]>; [k: string]: unknown };
  // the foreign agent-flow group goes (Xaibo's PreToolUse group shifts to index 0), the theme changes, a key is added
  put(w.files.claude, { ...s, theme: 'light', added: 1, hooks: { ...s.hooks, PreToolUse: s.hooks['PreToolUse']!.filter(xaibo) } });
  assert.deepEqual(states(w.restart()), [['claude-settings-fallback', 'connected'], ['claude-retention', 'connected'], ['claude-tee', 'connected']]);
  const hooks = Object.fromEntries(Object.entries(s.hooks).map(([ev, gs]) => [ev, gs.filter((g) => !xaibo(g))]));
  put(w.files.claude, { ...s, hooks, cleanupPeriodDays: 30, statusLine: CLAUDE_SETTINGS.statusLine });
  assert.deepEqual(states(w.restart()), [['claude-settings-fallback', 'disconnected-externally'], ['claude-retention', 'drifted'], ['claude-tee', 'disconnected-externally']],
    'all groups gone; another retention value; the tee replaced by the value it had replaced');
  const r = w.restart();
  assert.deepEqual(r.status === 'ready' && r.entries.map((e) => e.cleanup), [['manifest-entry', 'backup'], [], ['manifest-entry', 'backup']], 'cleanup offered only for removed entries');
});

test('fallback partly removed or a Xaibo group edited -> drifted', async () => {
  const w = await world();
  await connect(w, w.profiles.claude);
  const s = json(w.files.claude) as { hooks: Record<string, unknown[]> };
  put(w.files.claude, { ...s, hooks: { ...s.hooks, SessionStart: [] } });
  assert.deepEqual(states(w.restart()), [['claude-settings-fallback', 'drifted']], 'one event\'s group gone');
  const edited = structuredClone(s.hooks['SessionStart']!) as Array<{ hooks: Array<Record<string, unknown>> }>;
  edited[0]!.hooks[0]!['timeout'] = 99;
  put(w.files.claude, { ...s, hooks: { ...s.hooks, SessionStart: edited } });
  assert.deepEqual(states(w.restart()), [['claude-settings-fallback', 'drifted']], 'a Xaibo group changed is a conflict, not a removal');
});

test('codex and agy: a foreign removal is not drift; Xaibo\'s removed -> disconnected-externally; agy group extended -> drifted', async () => {
  const w = await world();
  await connect(w, w.profiles.codex);
  await connect(w, w.profiles.agy);
  assert.deepEqual(states(w.restart()), [['codex-hooks', 'connected'], ['agy-hooks', 'connected']]);
  const c = json(w.files.codex) as { hooks: Record<string, unknown[]> };
  put(w.files.codex, { hooks: { ...c.hooks, Stop: c.hooks['Stop']!.filter(xaibo) } });
  const a = json(w.files.agy) as Record<string, Record<string, unknown[]>>;
  const key = Object.keys(a).find((k) => k !== 'other')!;
  put(w.files.agy, { ...a, [key]: { ...a[key], Extra: [{ type: 'command', command: '/opt/other/x' }] } });
  assert.deepEqual(states(w.restart()), [['codex-hooks', 'connected'], ['agy-hooks', 'drifted']]);
  put(w.files.codex, CODEX_HOOKS);
  unlinkSync(w.files.agy);
  assert.deepEqual(states(w.restart()), [['codex-hooks', 'disconnected-externally'], ['agy-hooks', 'disconnected-externally']]);
});

test('pending -> pending-recovery and partial -> drifted: reported, never repaired', async () => {
  const w = await world();
  await connect(w, w.profiles.claude);
  const [e] = readManifest(w.dataDir);
  recordEntry(w.dataDir, { ...e!, state: 'pending' });
  const before = tree(w.base);
  assert.deepEqual(states(w.restart()), [['claude-settings-fallback', 'pending-recovery']]);
  assert.deepEqual(tree(w.base), before);
  recordEntry(w.dataDir, { ...e!, partial: true });
  assert.deepEqual(states(w.restart()), [['claude-settings-fallback', 'drifted']]);
});

test('lock held or stale -> blocked, nothing read or changed; no denylist; corrupt manifest; outside the roots or no profile -> unreadable', async () => {
  const w = await world();
  await connect(w, w.profiles.claude);
  const lock = acquireLock(w.dataDir);
  const lockFile = join(w.dataDir, 'integrations', 'operation.lock');
  const held = readFileSync(lockFile);
  assert.deepEqual(w.restart(), { status: 'blocked', code: 'busy' });
  assert.deepEqual(readFileSync(lockFile), held, 'lock bytes unchanged');
  lock.release();
  writeFileSync(lockFile, JSON.stringify({ pid: 2_147_483_646, token: 'crashed', at: 1 }), { mode: 0o600 });
  assert.deepEqual(w.restart(), { status: 'blocked', code: 'stale-lock' });
  unlinkSync(lockFile);
  assert.deepEqual(w.restart({ denied: null }), { status: 'blocked', code: 'bounds-unavailable' });
  const r = w.restart({ allowed: [] });
  assert.deepEqual(r.status === 'ready' && r.entries.map((e) => [e.state, e.reason]), [['unreadable', 'refused']], 'a real (non-disposable) root is never read');
  const r2 = w.restart({}, []);
  assert.deepEqual(r2.status === 'ready' && r2.entries.map((e) => [e.state, e.reason, e.profileId]), [['unreadable', 'profile-unavailable', null]]);
  const m = join(w.dataDir, 'integrations', 'manifest.json');
  writeFileSync(m, '{not json');
  assert.deepEqual(w.restart(), { status: 'blocked', code: 'manifest' });
});

// code review (run 197): a linked plugins/ folder would be read through; a legacy plugin entry has no plugin folder to compare
test('review 1/2: a symlinked plugins/ folder -> unreadable symlink; a legacy plugin entry (no profile key) -> unreadable legacy', async () => {
  const w = await world({ route: 'plugin' });
  await connect(w, w.profiles.claude);
  const plugins = join(w.home, '.claude', 'plugins'), moved = join(w.base, 'moved-plugins');
  renameSync(plugins, moved);
  symlinkSync(moved, plugins);
  const r = w.restart();
  assert.deepEqual(r.status === 'ready' && r.entries.map((e) => [e.state, e.reason]), [['unreadable', 'symlink']]);
  unlinkSync(plugins);
  renameSync(moved, plugins);
  const legacy: ManifestEntry = { ...readManifest(w.dataDir)[0]! };
  delete legacy.profileKey;
  recordEntry(w.dataDir, legacy);
  const r2 = w.restart();
  assert.deepEqual(r2.status === 'ready' && r2.entries.map((e) => [e.state, e.reason, e.manual]), [['unreadable', 'legacy', []]]);
});

test('review 3/4: refused before any read (an unreadable file, a denied root); tee edited -> drifted; a bad backup name is never offered', async () => {
  const w = await world();
  await connect(w, w.profiles.claude, { retention: false, tee: true });
  chmodSync(w.files.claude, 0o000);
  const reasons = (r: Report) => (r.status === 'ready' ? r.entries.map((e) => [e.state, e.reason]) : r);
  assert.deepEqual(reasons(w.restart()), [['unreadable', 'unreadable'], ['unreadable', 'unreadable']], 'readable roots: the file is read');
  assert.deepEqual(reasons(w.restart({ allowed: [] })), [['unreadable', 'refused'], ['unreadable', 'refused']], 'decided before reading');
  assert.deepEqual(reasons(w.restart({ denied: [w.home] })), [['unreadable', 'refused'], ['unreadable', 'refused']], 'a denied root');
  chmodSync(w.files.claude, 0o644);
  const s = json(w.files.claude) as { hooks: Record<string, unknown[]>; [k: string]: unknown };
  put(w.files.claude, { ...s, statusLine: { type: 'command', command: '/opt/other/line.sh' } });
  assert.deepEqual(states(w.restart()), [['claude-settings-fallback', 'connected'], ['claude-tee', 'drifted']], 'neither Xaibo\'s nor the old value');
  const hooks = Object.fromEntries(Object.entries(s.hooks).map(([ev, gs]) => [ev, gs.filter((g) => !xaibo(g))]));
  put(w.files.claude, { ...s, hooks });
  const [fb] = readManifest(w.dataDir);
  recordEntry(w.dataDir, { ...fb!, backup: '../../outside.bak' });
  const r = w.restart();
  assert.deepEqual(r.status === 'ready' && r.entries.map((e) => [e.route, e.state, e.cleanup]), [['claude-settings-fallback', 'disconnected-externally', ['manifest-entry']], ['claude-tee', 'connected', []]]);
});

test('review 4: a foreign marketplace -> drifted; an oversized registry -> unreadable; Disconnect then runs no CLI (registry readers through readFile)', async () => {
  const w = await world({ route: 'plugin' });
  await connect(w, w.profiles.claude);
  const known = join(w.home, '.claude', 'plugins', 'known_marketplaces.json'), reg = join(w.home, '.claude', 'plugins', 'installed_plugins.json');
  const k = json(known);
  put(known, { ...k, xaibo: { source: { source: 'directory', path: join(w.base, 'elsewhere') } } });
  assert.deepEqual(states(w.restart()), [['claude-plugin', 'drifted']]);
  put(known, k);
  put(reg, { ...json(reg), pad: 'x'.repeat(5 << 20) });
  const r = w.restart();
  assert.deepEqual(r.status === 'ready' && r.entries.map((e) => [e.state, e.reason]), [['unreadable', 'too-large']]);
  const spawned = w.spawns();
  const d = await w.c.disconnect(w.profiles.claude);
  assert.equal(d.status, 'partial', JSON.stringify(d));
  assert.equal(w.spawns(), spawned, 'an unreadable registry is an ownership conflict: no `claude plugin` call');
});

test('no entries -> an empty ready report', async () => {
  const w = await world();
  assert.deepEqual(w.restart(), { status: 'ready', entries: [] });
  assert.equal(w.c.reconciled(), null, 'nothing kept before the first reconcile');
});
