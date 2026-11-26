// XAIBO-PROD-599 (P6-T12 slice 1; D-P6-21; design .handoff/p6-t12-design.md and its fresh security review H1-H4, M6, M7, L8):
// the real-profile target policy behind REAL_PROFILE_ENABLED. Synthetic "real" roots only: a temp HOME whose agent folders
// are on the injected denylist, exactly as deniedRootsFrom lists the owner's. Flag off (the literal, the default): every
// non-disposable target is refused before any read. Flag on (the test-only override): a native target of a default/env
// profile whose own root is a known real root previews, applies and reverts; manual origin, overlapping denied roots, a
// linked or shared folder and the Claude plugin route refuse; reversal never follows a manifest entry alone.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnect, type ConnectContext } from '../../../src/service/integrations/connect.ts';
import { connectContext } from '../../../src/service/integrations-ipc.ts';
import { deniedRootsFrom, REAL_PROFILE_ENABLED } from '../../../src/service/config/bounds.ts';
import { claudeContext } from '../../helpers/fake-claude.ts';
import type { Profile } from '../../../src/service/catalog/detect.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { chmodSync(d, 0o700); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });
const iso = mkdtempSync(join(tmpdir(), 'xreal-env-'));
dirs.push(iso);
for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR']) process.env[k] = join(iso, k.toLowerCase());

const sha = (f: string) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'absent');
const CLAUDE = `${JSON.stringify({ cleanupPeriodDays: 10, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-stop' }] }] } }, null, 2)}\n`;
const CODEX = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-notify' }] }] } }, null, 2)}\n`;
const AGY = `${JSON.stringify({ other: { Stop: [{ type: 'command', command: 'other-agy', timeout: 5 }] } }, null, 2)}\n`;

/** A temp HOME standing in for the owner's: its agent folders are the denylist (no disposable root is allowed at all). */
async function world(o: { real?: boolean; route?: 'plugin' | 'fallback'; denied?: (home: string) => string[]; linkAgyConfig?: boolean } = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xreal-')));
  dirs.push(base);
  const home = join(base, 'home'), managed = join(base, 'managed'), helpers = join(base, 'helpers'), dataDir = join(base, 'data');
  const claudeDir = join(home, '.claude'), codexDir = join(home, '.codex'), agyRoot = join(home, '.gemini', 'antigravity-cli');
  for (const d of [claudeDir, codexDir, agyRoot, managed, helpers, dataDir]) mkdirSync(d, { recursive: true, mode: 0o755 });
  if (o.linkAgyConfig) { mkdirSync(join(base, 'elsewhere'), { mode: 0o755 }); symlinkSync(join(base, 'elsewhere'), join(home, '.gemini', 'config')); }
  else mkdirSync(join(home, '.gemini', 'config'), { mode: 0o755 });
  const files = {
    claude: join(claudeDir, 'settings.json'), claudeJson: join(home, '.claude.json'), codex: join(codexDir, 'hooks.json'),
    toml: join(codexDir, 'config.toml'), agy: join(home, '.gemini', 'config', 'hooks.json'), gemini: join(home, '.gemini', 'settings.json'),
  };
  writeFileSync(files.claude, CLAUDE);
  writeFileSync(files.claudeJson, '{"numStartups": 1}\n');
  writeFileSync(files.codex, CODEX);
  writeFileSync(files.toml, 'model = "x"\n');
  writeFileSync(files.agy, AGY);
  writeFileSync(files.gemini, '{}\n');
  for (const h of ['xaibo-hook', 'xaibo-report', 'xaibo-forwarder', 'xaibo-statusline']) writeFileSync(join(helpers, h), '#!/bin/sh\nexit 0\n');
  const denied = o.denied ? o.denied(home) : ['.claude', '.codex', '.gemini', '.claude.json'].map((n) => join(home, n));
  const ctx: ConnectContext = { ...await claudeContext(o.route ? { route: o.route } : {}), dataDir, denied, allowed: [], claudeManagedDir: managed,
    helpers: { hook: join(helpers, 'xaibo-hook'), forwarder: join(helpers, 'xaibo-forwarder'), statusline: join(helpers, 'xaibo-statusline') },
    // code review M1: each agent's own real roots (bounds.ts agentRootsFrom), so one agent's profile never owns another's root
    realRoots: { claude: [claudeDir], codex: [codexDir], gemini: [join(home, '.gemini')], agy: [join(home, '.gemini')] },
    ...(o.real === undefined ? {} : { realProfiles: o.real }) };
  const profiles: Record<'claude' | 'codex' | 'agy', Profile> = {
    claude: { id: 'claude-1', agent: 'claude', root: claudeDir, origin: 'default' },
    codex: { id: 'codex-1', agent: 'codex', root: codexDir, origin: 'default' },
    agy: { id: 'agy-1', agent: 'agy', root: agyRoot, origin: 'default' },
  };
  return { base, home, dataDir, files, ctx, profiles, c: createConnect(ctx) };
}
type W = Awaited<ReturnType<typeof world>>;
const hashes = (w: W) => Object.fromEntries(Object.entries(w.files).map(([k, f]) => [k, sha(f)]));
const SEL = { retention: true, tee: true };

test('L8: the shipped flag is the literal false and no production caller can set the override', async () => {
  assert.equal(REAL_PROFILE_ENABLED, false);
  const ctx = connectContext({ dataDir: iso, login: { PATH: '/usr/bin:/bin' }, bin: '', catalog: null, detection: () => undefined });
  assert.ok(!('realProfiles' in ctx), 'connectContext never sets it');
  // code review: every source file, not a list: only connect.ts names the override
  const names = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? names(join(dir, e.name)) : /\.(ts|tsx|cts|mts)$/.test(e.name) && readFileSync(join(dir, e.name), 'utf8').includes('realProfiles') ? [join(dir, e.name)] : []));
  assert.deepEqual(names('src'), [join('src', 'service', 'integrations', 'connect.ts')]);
});

test('flag off (default): real Claude, Codex and agy profiles are refused real-profile before any read; nothing written', async () => {
  const w = await world();
  const before = hashes(w);
  for (const p of Object.values(w.profiles)) {
    assert.deepEqual(w.c.previewConnect(p, SEL), { status: 'refused', code: 'real-profile' }, p.agent);
    assert.deepEqual(w.c.previewRemoval(Object.values(w.profiles), p), { status: 'refused', code: 'real-profile' }, p.agent);
  }
  assert.deepEqual(hashes(w), before);
  assert.ok(!existsSync(join(w.dataDir, 'integrations', 'manifest.json')));
});

test('flag on: Claude uses the settings fallback even where the plugin qualifies (decision A); apply, then Disconnect restores the bytes', async () => {
  const w = await world({ real: true, route: 'plugin' });
  const before = hashes(w);
  const pv = w.c.previewConnect(w.profiles.claude, SEL);
  assert.equal(pv.status, 'preview', JSON.stringify(pv));
  const routes = (pv as { steps: { route: string; target: string }[] }).steps.map((s) => s.route);
  assert.equal(routes[0], 'claude-settings-fallback');
  assert.ok(!routes.includes('claude-plugin'));
  assert.ok((pv as { steps: { target: string }[] }).steps.every((s) => s.target === w.files.claude), 'settings.json only');
  const r = await w.c.applyConnect((pv as { previewId: string }).previewId);
  assert.equal(r.status, 'applied', JSON.stringify(r));
  assert.notEqual(sha(w.files.claude), before['claude']);
  assert.deepEqual({ ...hashes(w), claude: before['claude'] }, before, 'only settings.json changed (never ~/.claude.json)');
  const d = await w.c.disconnect(w.profiles.claude);
  assert.equal(d.status, 'disconnected', JSON.stringify(d));
  assert.deepEqual(hashes(w), before, 'byte-identical after Disconnect');
});

test('flag on: Codex and agy round-trip; config.toml and Gemini settings untouched', async () => {
  const w = await world({ real: true });
  const before = hashes(w);
  for (const p of [w.profiles.codex, w.profiles.agy]) {
    const pv = w.c.previewConnect(p, SEL);
    assert.equal(pv.status, 'preview', `${p.agent} ${JSON.stringify(pv)}`);
    assert.equal((await w.c.applyConnect((pv as { previewId: string }).previewId)).status, 'applied', p.agent);
  }
  assert.notEqual(sha(w.files.codex), before['codex']);
  assert.notEqual(sha(w.files.agy), before['agy']);
  assert.deepEqual([sha(w.files.toml), sha(w.files.gemini), sha(w.files.claude)], [before['toml'], before['gemini'], before['claude']]);
  for (const p of [w.profiles.codex, w.profiles.agy]) assert.equal((await w.c.disconnect(p)).status, 'disconnected', p.agent);
  assert.deepEqual(hashes(w), before);
});

test('flag on: the removal preview and reconcile read real targets through the same policy', async () => {
  const w = await world({ real: true });
  const pv = w.c.previewConnect(w.profiles.codex, SEL);
  await w.c.applyConnect((pv as { previewId: string }).previewId);
  const rec = w.c.reconcile(Object.values(w.profiles));
  assert.equal(rec.status, 'ready');
  assert.deepEqual((rec as { entries: { state: string }[] }).entries.map((e) => e.state), ['connected']);
  const rp = w.c.previewRemoval(Object.values(w.profiles), w.profiles.codex, w);
  assert.equal(rp.status, 'preview', JSON.stringify(rp));
  assert.ok((rp as { items: { state: string }[] }).items.every((x) => x.state === 'connected'));
  const r = await w.c.applyRemoval((rp as { previewId: string }).previewId, w, Object.values(w.profiles));
  assert.equal(r.status, 'disconnected', JSON.stringify(r));
  assert.equal(readFileSync(w.files.codex, 'utf8'), CODEX);
});

test('flag on: manual origin, an env root not on the denylist, overlapping denied roots, a linked or shared folder refuse unsafe-profile', async () => {
  const w = await world({ real: true });
  const before = hashes(w);
  const other = join(w.base, 'other', '.claude');
  mkdirSync(other, { recursive: true, mode: 0o755 });
  writeFileSync(join(other, 'settings.json'), CLAUDE);
  const refusedFor = (c: ReturnType<typeof createConnect>, p: Profile) => assert.deepEqual(c.previewConnect(p, SEL), { status: 'refused', code: 'unsafe-profile' }, JSON.stringify(p));
  refusedFor(w.c, { id: 'm-1', agent: 'claude', root: other, origin: 'manual' }); // H1: a renderer-chosen folder
  refusedFor(w.c, { id: 'm-2', agent: 'claude', root: w.profiles.claude.root, origin: 'manual' }); // even on a real root
  refusedFor(w.c, { id: 'e-1', agent: 'claude', root: other, origin: 'env' }); // not a known real root
  // code review M1: another agent's real root (CLAUDE_CONFIG_DIR=~/.codex; a Codex profile on ~/.claude) is not this agent's
  refusedFor(w.c, { id: 'e-2', agent: 'claude', root: w.profiles.codex.root, origin: 'env' });
  refusedFor(w.c, { id: 'd-1', agent: 'codex', root: w.profiles.claude.root, origin: 'default' });
  assert.ok(!existsSync(join(w.profiles.claude.root, 'hooks.json')) && !existsSync(join(w.profiles.codex.root, 'settings.json')));
  assert.deepEqual(w.c.previewConnect({ id: 'g-1', agent: 'gemini', root: join(w.home, '.gemini'), origin: 'default' }, SEL), { status: 'refused', code: 'unverified' });
  const overlap = await world({ real: true, denied: (h) => [h, join(h, '.claude'), join(h, '.codex'), join(h, '.gemini')] }); // e.g. CODEX_HOME=HOME
  refusedFor(overlap.c, overlap.profiles.claude);
  const linked = await world({ real: true, linkAgyConfig: true });
  refusedFor(linked.c, linked.profiles.agy);
  chmodSync(w.profiles.codex.root, 0o775); // group-writable
  refusedFor(w.c, w.profiles.codex);
  chmodSync(w.profiles.codex.root, 0o755);
  assert.deepEqual(hashes(w), before);
});

test('flag on (H3): a manifest entry is reverted only for a currently resolved target; orphans and forged targets stay', async () => {
  const w = await world({ real: true });
  const pv = w.c.previewConnect(w.profiles.codex, SEL);
  await w.c.applyConnect((pv as { previewId: string }).previewId);
  const connected = sha(w.files.codex);
  const orphan = await w.c.uninstall([]); // no profile held: an orphan on a real root
  assert.equal(orphan.status, 'partial', JSON.stringify(orphan));
  assert.deepEqual((orphan as { remaining: { reason: string }[] }).remaining.map((x) => x.reason), ['refused']);
  assert.equal(sha(w.files.codex), connected, 'never reverted from the manifest alone');
  const mf = join(w.dataDir, 'integrations', 'manifest.json');
  const m = JSON.parse(readFileSync(mf, 'utf8')) as { entries: { target: string }[] };
  m.entries[0]!.target = w.files.toml; // forged: another file under the same real root
  writeFileSync(mf, JSON.stringify(m), { mode: 0o600 });
  const tomlBefore = sha(w.files.toml);
  const forged = await w.c.uninstall(Object.values(w.profiles));
  assert.equal(forged.status, 'partial', JSON.stringify(forged));
  assert.deepEqual((forged as { remaining: { reason: string }[] }).remaining.map((x) => x.reason), ['refused']);
  assert.equal(sha(w.files.toml), tomlBefore);
});

test('M7: GEMINI_CLI_HOME denies its .gemini folder, not the folder itself', () => {
  const g = join(iso, 'gemini-home');
  const d = deniedRootsFrom({ PATH: '/usr/bin', GEMINI_CLI_HOME: g }, {})!;
  assert.ok(d.includes(join(g, '.gemini')));
  assert.ok(!d.includes(g));
});

test('flag on (code review): a folder made unsafe between preview and apply refuses at apply; nothing written', async () => {
  const w = await world({ real: true });
  const before = hashes(w);
  const pv = w.c.previewConnect(w.profiles.codex, SEL);
  assert.equal(pv.status, 'preview');
  chmodSync(w.profiles.codex.root, 0o775);
  try {
    assert.deepEqual(await w.c.applyConnect((pv as { previewId: string }).previewId), { status: 'refused', code: 'unsafe-profile' });
  } finally { chmodSync(w.profiles.codex.root, 0o755); }
  assert.deepEqual(hashes(w), before);
});

test('flag on (code review): Full Uninstall with the live profiles reverts every real entry; a forged plugin entry is never run', async () => {
  const w = await world({ real: true });
  const before = hashes(w);
  for (const p of Object.values(w.profiles)) {
    const pv = w.c.previewConnect(p, SEL);
    assert.equal((await w.c.applyConnect((pv as { previewId: string }).previewId)).status, 'applied', p.agent);
  }
  const u = await w.c.uninstall(Object.values(w.profiles));
  assert.equal(u.status, 'disconnected', JSON.stringify(u));
  assert.deepEqual(hashes(w), before);
  const pv = w.c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  await w.c.applyConnect((pv as { previewId: string }).previewId);
  const connected = sha(w.files.claude);
  const mf = join(w.dataDir, 'integrations', 'manifest.json');
  const m = JSON.parse(readFileSync(mf, 'utf8')) as { entries: { route: string; profileKey?: string; phase?: string }[] };
  Object.assign(m.entries[0]!, { route: 'claude-plugin', profileKey: 'claude-1', phase: 'installed' }); // forged
  writeFileSync(mf, JSON.stringify(m), { mode: 0o600 });
  const f = await w.c.uninstall(Object.values(w.profiles)).catch(() => ({ status: 'threw' }));
  assert.notEqual(f.status, 'disconnected', JSON.stringify(f));
  assert.equal(sha(w.files.claude), connected, 'a plugin entry on a real root is never reverted (decision A)');
});
