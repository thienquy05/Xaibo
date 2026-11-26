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
import { pageEvidence } from '../../../src/service/integrations/state.ts';

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

// XAIBO-PROD-563 (P6-T04 part 2; design .handoff/p6-t04-design.md part 2 slice, review C1-C8): one preview and one
// confirmation drop the manifest record and the backup of entries a fresh reconcile still reports removed; nothing in the
// agent profile is written, no CLI runs; reconnect is the ordinary Connect afterwards.
const A = {}, B = {};
/** Every Xaibo hook group removed from settings.json behind Xaibo's back (the fallback entry becomes removed). */
function stripXaibo(w: W) {
  const s = json(w.files.claude) as { hooks: Record<string, unknown[]>; [k: string]: unknown };
  put(w.files.claude, { ...s, hooks: Object.fromEntries(Object.entries(s.hooks).map(([ev, gs]) => [ev, gs.filter((g) => !xaibo(g))])) });
  return s;
}
const backups = (w: W) => readdirSync(join(w.dataDir, 'integrations', 'backups'));

test('part 2 plan case: the plugin removed outside Xaibo is cleaned up (record, backup); profile untouched, no CLI; reconnect after the marketplace goes', async () => {
  const w = await world({ route: 'plugin' });
  await connect(w, w.profiles.claude);
  const [e] = readManifest(w.dataDir);
  w.external('plugin', 'uninstall', 'xaibo-hooks@xaibo', '-s', 'user');
  const ps = Object.values(w.profiles);
  const pv = w.c.previewCleanup(ps, [e!.id], A);
  assert.equal(pv.status, 'preview', JSON.stringify(pv));
  if (pv.status !== 'preview') return;
  assert.deepEqual({ ...pv, previewId: '' }, { status: 'preview', previewId: '', ttlMs: 300_000, items: [{ entry: e!.id, cleanup: ['manifest-entry', 'backup'] }] });
  assert.equal(backups(w).length, 1);
  const profile = tree(w.home), spawned = w.spawns();
  assert.deepEqual(await w.c.applyCleanup(pv.previewId, A), { status: 'cleaned', removed: [e!.id], left: [] });
  assert.deepEqual(readManifest(w.dataDir), []);
  assert.deepEqual(backups(w), []);
  assert.deepEqual(tree(w.home), profile, 'no agent profile file written');
  assert.equal(w.spawns(), spawned, 'no CLI');
  assert.deepEqual(w.c.reconciled(), { status: 'ready', entries: [] }, 'the kept report is refreshed');
  assert.deepEqual(w.c.previewConnect(w.profiles.claude, { retention: false, tee: false }), { status: 'refused', code: 'duplicate' }, 'the marketplace is a manual leftover');
  w.external('plugin', 'marketplace', 'remove', 'xaibo');
  await connect(w, w.profiles.claude);
  assert.deepEqual(states(w.restart()), [['claude-plugin', 'connected']]);
});

test('part 2: fallback cleaned then reconnected; only removed entries can be cleaned; empty or duplicate ids refused', async () => {
  const w = await world();
  await connect(w, w.profiles.claude, { retention: false, tee: true });
  const [fb, tee] = readManifest(w.dataDir);
  const ps = Object.values(w.profiles);
  stripXaibo(w);
  assert.deepEqual(w.c.previewCleanup(ps, [tee!.id], A), { status: 'refused', code: 'not-removed' }, 'the tee is still connected');
  assert.deepEqual(w.c.previewCleanup(ps, [fb!.id, tee!.id], A), { status: 'refused', code: 'not-removed' }, 'no silent partial selection');
  assert.deepEqual(w.c.previewCleanup(ps, ['00000000-0000-4000-8000-00000000dead'], A), { status: 'refused', code: 'not-removed' });
  assert.deepEqual(w.c.previewCleanup(ps, [], A), { status: 'refused', code: 'ops' });
  assert.deepEqual(w.c.previewCleanup(ps, [fb!.id, fb!.id], A), { status: 'refused', code: 'ops' });
  recordEntry(w.dataDir, { ...tee!, backup: fb!.backup }); // code review 3: a hand-edited manifest sharing a backup
  const pv = w.c.previewCleanup(ps, [fb!.id], A);
  assert.equal(pv.status, 'preview');
  assert.deepEqual(await w.c.applyCleanup(pv.status === 'preview' ? pv.previewId : '', A), { status: 'cleaned', removed: [fb!.id], left: [] });
  assert.deepEqual(readManifest(w.dataDir).map((x) => x.id), [tee!.id]);
  assert.ok(backups(w).includes(fb!.backup!), 'the backup an entry that stays names is kept');
  recordEntry(w.dataDir, tee!);
  const pc = w.c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  assert.equal(pc.status, 'preview', 'reconnect: the ordinary Connect preview');
  assert.deepEqual(await w.c.applyConnect(pc.status === 'preview' ? pc.previewId : ''), { status: 'applied', entries: [readManifest(w.dataDir).at(-1)!.id], trustSteps: [] });
});

test('part 2: changed since the preview -> needs-preview, nothing written (values back, entry changed, plugin reinstalled)', async () => {
  const w = await world();
  await connect(w, w.profiles.claude);
  const [fb] = readManifest(w.dataDir);
  const ps = Object.values(w.profiles);
  const s = stripXaibo(w);
  let pv = w.c.previewCleanup(ps, [fb!.id], A);
  put(w.files.claude, s); // the owner put Xaibo's groups back
  assert.deepEqual(await w.c.applyCleanup(pv.status === 'preview' ? pv.previewId : '', A), { status: 'needs-preview' });
  assert.deepEqual(readManifest(w.dataDir), [fb]);
  stripXaibo(w);
  pv = w.c.previewCleanup(ps, [fb!.id], A);
  recordEntry(w.dataDir, { ...fb!, at: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(await w.c.applyCleanup(pv.status === 'preview' ? pv.previewId : '', A), { status: 'needs-preview' });
  assert.equal(backups(w).length, 1);

  const p = await world({ route: 'plugin' });
  await connect(p, p.profiles.claude);
  const [pe] = readManifest(p.dataDir);
  p.external('plugin', 'uninstall', 'xaibo-hooks@xaibo', '-s', 'user');
  const ppv = p.c.previewCleanup(Object.values(p.profiles), [pe!.id], A);
  p.external('plugin', 'install', 'xaibo-hooks@xaibo', '-s', 'user'); // review C2: settings.json alone would not show it
  assert.deepEqual(await p.c.applyCleanup(ppv.status === 'preview' ? ppv.previewId : '', A), { status: 'needs-preview' });
  assert.deepEqual(readManifest(p.dataDir), [pe]);
});

test('part 2 preview semantics: lock held (preview refused; at apply busy keeps it), wrong owner, closed port, expiry, no denylist', async () => {
  const w = await world();
  await connect(w, w.profiles.claude);
  const [fb] = readManifest(w.dataDir);
  const ps = Object.values(w.profiles);
  stripXaibo(w);
  const lock = acquireLock(w.dataDir);
  assert.deepEqual(w.c.previewCleanup(ps, [fb!.id], A), { status: 'refused', code: 'busy' });
  lock.release();
  const pv = w.c.previewCleanup(ps, [fb!.id], A);
  const id = pv.status === 'preview' ? pv.previewId : '';
  const other = w.c.previewCleanup(ps, [fb!.id], A);
  const oid = other.status === 'preview' ? other.previewId : '';
  assert.deepEqual(await w.c.applyCleanup(oid, B), { status: 'refused', code: 'preview-invalid' }, 'another port');
  assert.deepEqual(await w.c.applyCleanup(oid, A), { status: 'refused', code: 'preview-invalid' }, 'consumed by the wrong owner');
  for (let i = 0; i < 31; i++) assert.equal(w.c.previewCleanup(ps, [fb!.id], A).status, 'preview');
  assert.deepEqual(w.c.previewCleanup(ps, [fb!.id], A), { status: 'refused', code: 'busy' }, 'at most 32 held previews');
  w.c.dropOwner(A);
  assert.deepEqual(await w.c.applyCleanup(id, A), { status: 'refused', code: 'preview-invalid' }, 'the closed port dropped it too');
  const kept = w.c.previewCleanup(ps, [fb!.id], A);
  const kid = kept.status === 'preview' ? kept.previewId : '';
  const held2 = acquireLock(w.dataDir);
  assert.deepEqual(await w.c.applyCleanup(kid, A), { status: 'refused', code: 'busy' });
  held2.release();
  assert.deepEqual(await w.c.applyCleanup(kid, A), { status: 'cleaned', removed: [fb!.id], left: [] }, 'code review 1: busy kept the preview');
  recordEntry(w.dataDir, fb!); // back for the remaining cases
  const closed = w.c.previewCleanup(ps, [fb!.id], A);
  w.c.dropOwner(A);
  assert.deepEqual(await w.c.applyCleanup(closed.status === 'preview' ? closed.previewId : '', A), { status: 'refused', code: 'preview-invalid' }, 'C7: dropped with its port');
  const clock = { t: 0 };
  const c = createConnect({ ...w.ctx, now: () => clock.t });
  const late = c.previewCleanup(ps, [fb!.id], A);
  clock.t = 300_001;
  assert.deepEqual(await c.applyCleanup(late.status === 'preview' ? late.previewId : '', A), { status: 'refused', code: 'preview-expired' });
  assert.deepEqual(createConnect({ ...w.ctx, denied: null }).previewCleanup(ps, [fb!.id], A), { status: 'refused', code: 'bounds-unavailable' });
  assert.deepEqual(await createConnect({ ...w.ctx, denied: null }).applyCleanup(id, A), { status: 'refused', code: 'bounds-unavailable' });
  assert.deepEqual(readManifest(w.dataDir), [fb], 'nothing cleaned by any of these');
});

test('part 2 C4: a linked backup or backups folder refuses the whole apply before any write', async () => {
  const w = await world();
  await connect(w, w.profiles.claude);
  const [fb] = readManifest(w.dataDir);
  const ps = Object.values(w.profiles);
  stripXaibo(w);
  const dir = join(w.dataDir, 'integrations', 'backups'), file = join(dir, fb!.backup!), outside = join(w.base, 'outside.bak');
  writeFileSync(outside, readFileSync(file));
  unlinkSync(file);
  symlinkSync(outside, file);
  let pv = w.c.previewCleanup(ps, [fb!.id], A);
  assert.deepEqual(await w.c.applyCleanup(pv.status === 'preview' ? pv.previewId : '', A), { status: 'refused', code: 'symlink' });
  assert.deepEqual(readManifest(w.dataDir), [fb]);
  unlinkSync(file);
  renameSync(outside, file);
  const moved = join(w.base, 'moved-backups');
  renameSync(dir, moved);
  symlinkSync(moved, dir);
  pv = w.c.previewCleanup(ps, [fb!.id], A);
  assert.deepEqual(await w.c.applyCleanup(pv.status === 'preview' ? pv.previewId : '', A), { status: 'refused', code: 'private-dir' });
  assert.deepEqual(readManifest(w.dataDir), [fb]);
  assert.equal(readdirSync(moved).length, 1, 'the linked folder\'s file is untouched');
});

test('part 2 code review 2: a non-regular backup or a malformed name refuses; several entries at once; a backup that cannot be removed is reported in left', async () => {
  const w = await world();
  await connect(w, w.profiles.claude, { retention: false, tee: true });
  const [fb, tee] = readManifest(w.dataDir);
  const ps = Object.values(w.profiles);
  stripXaibo(w);
  put(w.files.claude, { ...json(w.files.claude), statusLine: CLAUDE_SETTINGS.statusLine }); // the tee's replaced value is back
  assert.deepEqual(states(w.restart()), [['claude-settings-fallback', 'disconnected-externally'], ['claude-tee', 'disconnected-externally']]);
  const dir = join(w.dataDir, 'integrations', 'backups'), file = join(dir, fb!.backup!), saved = readFileSync(file);
  unlinkSync(file);
  mkdirSync(file);
  let pv = w.c.previewCleanup(ps, [fb!.id, tee!.id], A);
  assert.deepEqual(await w.c.applyCleanup(pv.status === 'preview' ? pv.previewId : '', A), { status: 'refused', code: 'not-regular' });
  rmSync(file, { recursive: true });
  writeFileSync(file, saved, { mode: 0o600 });
  recordEntry(w.dataDir, { ...tee!, backup: 'not-a-uuid.bak' });
  pv = w.c.previewCleanup(ps, [fb!.id, tee!.id], A);
  assert.deepEqual(await w.c.applyCleanup(pv.status === 'preview' ? pv.previewId : '', A), { status: 'refused', code: 'manifest' });
  assert.equal(readManifest(w.dataDir).length, 2, 'nothing dropped');
  recordEntry(w.dataDir, tee!);
  chmodSync(dir, 0o500); // the folder passes the private check (no group/other bits) but its files cannot be unlinked
  pv = w.c.previewCleanup(ps, [fb!.id, tee!.id], A);
  const r = await w.c.applyCleanup(pv.status === 'preview' ? pv.previewId : '', A);
  chmodSync(dir, 0o700);
  assert.deepEqual(r, { status: 'cleaned', removed: [fb!.id, tee!.id], left: [fb!.id, tee!.id] });
  assert.deepEqual(readManifest(w.dataDir), []);
  assert.equal(backups(w).length, 2, 'inert leftovers, reported');
});

test('no entries -> an empty ready report', async () => {
  const w = await world();
  assert.deepEqual(w.restart(), { status: 'ready', entries: [] });
  assert.equal(w.c.reconciled(), null, 'nothing kept before the first reconcile');
});

test('G6A-1 (D-P6-08): an unsupported registry or settings layout is unreadable, never removed, no cleanup; the v2 registry layout is read', async () => {
  const w = await world({ route: 'plugin' });
  await connect(w, w.profiles.claude);
  const s = json(w.files.claude);
  const reg = join(w.home, '.claude', 'plugins', 'installed_plugins.json'), known = join(w.home, '.claude', 'plugins', 'known_marketplaces.json');
  const regBytes = readFileSync(reg), knownBytes = readFileSync(known);
  put(w.files.claude, { ...s, enabledPlugins: {} }); // our key gone: only the registries decide
  for (const [f, v] of [[reg, ['unrelated']], [reg, 'scalar'], [reg, { version: 2, plugins: ['x'] }], [known, ['xaibo']], [known, { xaibo: 'here' }],
    [reg, null], [reg, { version: 2, plugins: null }], [known, null]] as const) { // G6R-1: a JSON null is not a missing file
    writeFileSync(f, JSON.stringify(v));
    const r = w.restart();
    assert.deepEqual(r.status === 'ready' && r.entries.map((e) => [e.state, e.reason, e.cleanup]), [['unreadable', 'layout', []]], JSON.stringify(v));
    writeFileSync(reg, regBytes);
    writeFileSync(known, knownBytes);
  }
  put(w.files.claude, { ...s, enabledPlugins: ['xaibo-hooks@xaibo'] });
  const r = w.restart();
  assert.deepEqual(r.status === 'ready' && r.entries.map((e) => [e.state, e.reason]), [['unreadable', 'layout']], 'enabledPlugins not an object');
  writeFileSync(w.files.claude, 'null');
  const rn = w.restart();
  assert.deepEqual(rn.status === 'ready' && rn.entries.map((e) => [e.state, e.reason, e.cleanup]), [['unreadable', 'layout', []]], 'G6R-1: settings.json null');
  put(w.files.claude, { ...s, enabledPlugins: {} });
  writeFileSync(reg, JSON.stringify({ version: 2, plugins: JSON.parse(regBytes.toString('utf8')) }));
  assert.deepEqual(states(w.restart()), [['claude-plugin', 'drifted']], 'v2: still installed, key gone');
});

test('G6A-2: an applied agy entry counts as installed for the agy profile (the file Connect writes, outside its catalog root)', async () => {
  const w = await world();
  await connect(w, w.profiles.agy);
  const ev = pageEvidence({ db: {} as never, dataDir: w.dataDir });
  assert.notEqual(ev.installedAt(w.profiles.agy), null);
  assert.equal(ev.installedAt(w.profiles.codex), null);
});
