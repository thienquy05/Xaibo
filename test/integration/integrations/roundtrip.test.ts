// XAIBO-PROD-557 (P6-T03 part 1a; FR-30..FR-34, FR-45, EC-48, EC-73; design .handoff/p6-t03-design.md, owner D-P6-06): the
// service Connect/Disconnect/Uninstall core over the FR-32 engine routes, on synthetic disposable profiles only. Connect (all
// offers plus the tee) then Disconnect gives every file back byte for byte; an owner change to a Xaibo-owned value is a
// conflict and nothing is overwritten; a foreign change survives while Xaibo's entries go; an unreadable file is refused before
// any write; previews are single-use, expire and are replaced; a later step that no longer matches its preview undoes the
// Connect and asks again; real or denied roots are refused; Gemini is not offered; Uninstall covers every recorded entry.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnect, type ConnectContext } from '../../../src/service/integrations/connect.ts';
import { apply, ConfigError, plan, readManifest, recordEntry, type ManifestEntry } from '../../../src/service/config/transaction.ts';
import { acquireLock } from '../../../src/service/config/lock.ts';
import { connectContext } from '../../../src/service/integrations-ipc.ts';
import { claudeContext, writeFakeClaude } from '../../helpers/fake-claude.ts';
import { readdirSync, unlinkSync } from 'node:fs';
import type { Profile } from '../../../src/service/catalog/detect.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
// AGENTS.md / review L6: nothing here may resolve a real agent home or data dir
const iso = mkdtempSync(join(tmpdir(), 'xconnect-env-'));
dirs.push(iso);
for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR']) process.env[k] = join(iso, k.toLowerCase());
const sha = (f: string) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'absent');
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;

const CLAUDE_SETTINGS = `${JSON.stringify({
  theme: 'dark',
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /opt/agent-flow/hook.js pre', async: true }] }] },
  statusLine: { type: 'command', command: '/opt/custom/statusline.sh', padding: 1 },
}, null, 2)}\n`;
const CODEX_HOOKS = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/opt/other/notify-stop' }] }] } }, null, 2)}\n`;
const CODEX_TOML = 'model = "m-x"\nnotify = ["/opt/other/notify", "--json"]\n';
const AGY_HOOKS = `${JSON.stringify({ other: { Stop: [{ type: 'command', command: '/opt/other/agy-stop', timeout: 5 }] } }, null, 2)}\n`;
const GEMINI_SETTINGS = `${JSON.stringify({ general: { sessionRetention: { enabled: true, maxAge: '30d' } }, hooks: {} }, null, 2)}\n`;

/** A disposable base (the only allowed root), one profile HOME with Claude, Codex, agy and Gemini files, a managed-policy
 *  dir, synthetic helper binaries and a data dir; `clock.t` is the injected clock. */
async function world(o: { claude?: string | null | undefined; route?: 'plugin' | 'fallback'; version?: string | null; manual?: boolean } = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xconnect-')));
  dirs.push(base);
  const home = join(base, 'home'), managed = join(base, 'managed'), helpers = join(base, 'helpers'), dataDir = join(base, 'data');
  const claudeDir = join(home, '.claude'), codexDir = join(home, '.codex'), agyRoot = join(home, '.gemini', 'antigravity-cli');
  for (const d of [claudeDir, codexDir, agyRoot, join(home, '.gemini', 'config'), managed, helpers, dataDir]) mkdirSync(d, { recursive: true, mode: 0o755 }); // any umask
  const files = {
    claude: join(claudeDir, 'settings.json'), codex: join(codexDir, 'hooks.json'), toml: join(codexDir, 'config.toml'),
    agy: join(home, '.gemini', 'config', 'hooks.json'), gemini: join(home, '.gemini', 'settings.json'),
  };
  if (o.claude !== null) writeFileSync(files.claude, o.claude ?? CLAUDE_SETTINGS);
  writeFileSync(files.codex, CODEX_HOOKS);
  writeFileSync(files.toml, CODEX_TOML);
  writeFileSync(files.agy, AGY_HOOKS);
  writeFileSync(files.gemini, GEMINI_SETTINGS);
  for (const h of ['xaibo-hook', 'xaibo-report', 'xaibo-forwarder', 'xaibo-statusline']) writeFileSync(join(helpers, h), '#!/bin/sh\nexit 0\n');
  const clock = { t: 1_000 };
  const fake = join(base, 'fake-claude');
  writeFakeClaude(fake);
  const ctx: ConnectContext = { ...await claudeContext({ ...(o.route ? { route: o.route } : {}), ...(o.version !== undefined ? { version: o.version } : {}), ...(o.manual ? { manual: true } : {}), exe: fake }),
    dataDir, denied: [join(base, 'real')], allowed: [base], claudeManagedDir: managed, now: () => clock.t,
    helpers: { hook: join(helpers, 'xaibo-hook'), forwarder: join(helpers, 'xaibo-forwarder'), statusline: join(helpers, 'xaibo-statusline') },
  };
  const profiles: Record<'claude' | 'codex' | 'agy' | 'gemini', Profile> = {
    claude: { id: 'claude-1', agent: 'claude', root: claudeDir, origin: 'default' },
    codex: { id: 'codex-1', agent: 'codex', root: codexDir, origin: 'default' },
    agy: { id: 'agy-1', agent: 'agy', root: agyRoot, origin: 'default' },
    gemini: { id: 'gemini-1', agent: 'gemini', root: join(home, '.gemini'), origin: 'default' },
  };
  const side = (f: string) => join(home, `fake-claude.${f}`); // the fake writes beside the config dir
  const log = () => (existsSync(side('log')) ? readFileSync(side('log'), 'utf8').trimEnd().split('\n').map((l) => (JSON.parse(l) as { argv: string[] }).argv.slice(0, 3).join(' ')) : []);
  const setMode = (m: string) => writeFileSync(side('mode'), m);
  return { base, home, managed, dataDir, files, ctx, clock, profiles, fake, log, setMode, c: createConnect(ctx) };
}
type W = Awaited<ReturnType<typeof world>>;
const hashes = (w: W) => Object.fromEntries(Object.entries(w.files).map(([k, f]) => [k, sha(f)]));
async function connect(w: W, p: Profile, sel = { retention: true, tee: true }) {
  const pv = w.c.previewConnect(p, sel);
  assert.equal(pv.status, 'preview', JSON.stringify(pv));
  const r = await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
  assert.equal(r.status, 'applied', JSON.stringify(r));
  return { pv, r };
}

test('Connect all offers plus the tee, then Disconnect: every file byte-identical; config.toml, trust and Gemini untouched', async () => {
  const w = await world();
  const before = hashes(w);
  const { pv } = await connect(w, w.profiles.claude);
  assert.deepEqual(pv.status === 'preview' && pv.steps.map((s) => s.route), ['claude-settings-fallback', 'claude-retention', 'claude-tee']);
  assert.ok(pv.status === 'preview' && pv.ttlMs === 300_000 && !('expiresAt' in pv), 'review LOW: a time-to-live, never a monotonic clock value');
  const s = json(w.files.claude);
  assert.equal(s['cleanupPeriodDays'], 45);
  assert.match(JSON.stringify(s['hooks']), /xaibo-hook' hook claude claude-1/);
  assert.match(JSON.stringify(s['statusLine']), /xaibo-statusline/);
  assert.equal(s['theme'], 'dark');
  const codex = await connect(w, w.profiles.codex);
  assert.ok(codex.r.status === 'applied' && codex.r.trustSteps.length > 0, 'Codex: guided trust steps, never a trust write');
  await connect(w, w.profiles.agy);
  assert.equal(sha(w.files.toml), before['toml']);
  assert.equal(sha(w.files.gemini), before['gemini']);
  for (const p of [w.profiles.agy, w.profiles.codex, w.profiles.claude]) {
    const d = await w.c.disconnect(p);
    assert.equal(d.status, 'disconnected', JSON.stringify(d));
    assert.deepEqual(d.conflicts, []);
  }
  assert.deepEqual(hashes(w), before);
  assert.deepEqual(readManifest(w.dataDir), []);
});

test('no settings.json: Connect creates it, Disconnect (newest first) leaves no file', async () => {
  const w = await world({ claude: null });
  await connect(w, w.profiles.claude, { retention: true, tee: false });
  assert.equal(json(w.files.claude)['cleanupPeriodDays'], 45);
  assert.equal((await w.c.disconnect(w.profiles.claude)).status, 'disconnected');
  assert.equal(existsSync(w.files.claude), false);
});

test('an owner change to a Xaibo-owned value: a conflict, the file is not overwritten, older entries on that file stay', async () => {
  const w = await world();
  await connect(w, w.profiles.claude, { retention: true, tee: false });
  writeFileSync(w.files.claude, JSON.stringify({ ...json(w.files.claude), cleanupPeriodDays: 60 }, null, 2));
  const changed = sha(w.files.claude);
  const d = await w.c.disconnect(w.profiles.claude);
  assert.equal(d.status, 'partial');
  assert.deepEqual(d.conflicts.map((c) => [c.route, c.pointer]), [['claude-retention', '/cleanupPeriodDays']]);
  assert.deepEqual(d.remaining.map((r) => [r.route, r.reason]), [['claude-settings-fallback', 'blocked']]);
  assert.equal(sha(w.files.claude), changed, 'not overwritten');
});

test('a foreign change survives; Xaibo entries are removed and replaced values come back', async () => {
  const w = await world();
  await connect(w, w.profiles.claude);
  writeFileSync(w.files.claude, JSON.stringify({ ...json(w.files.claude), theme: 'light' }, null, 2));
  assert.equal((await w.c.disconnect(w.profiles.claude)).status, 'disconnected');
  const s = json(w.files.claude);
  assert.equal(s['theme'], 'light');
  assert.equal(Object.hasOwn(s, 'cleanupPeriodDays'), false);
  assert.doesNotMatch(JSON.stringify(s), /xaibo/);
  assert.deepEqual(s['statusLine'], { type: 'command', command: '/opt/custom/statusline.sh', padding: 1 });
  assert.deepEqual(s['hooks'], (JSON.parse(CLAUDE_SETTINGS) as Record<string, unknown>)['hooks']);
});

test('an unreadable file is refused at preview: nothing written, no helper deployed, no manifest', async () => {
  const w = await world({ claude: '{ not json' });
  const before = hashes(w);
  assert.deepEqual(w.c.previewConnect(w.profiles.claude, { retention: true, tee: true }), { status: 'refused', code: 'invalid-json' });
  assert.deepEqual(hashes(w), before);
  assert.equal(existsSync(join(w.dataDir, 'integrations')), false);
});

test('previews: single use, replaced by a newer one for the profile, expire after five minutes', async () => {
  const w = await world();
  const a = w.c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  const b = w.c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  assert.ok(a.status === 'preview' && b.status === 'preview');
  assert.deepEqual(await w.c.applyConnect(a.previewId), { status: 'refused', code: 'preview-invalid' }, 'replaced');
  w.clock.t += 5 * 60_000 + 1;
  assert.deepEqual(await w.c.applyConnect(b.previewId), { status: 'refused', code: 'preview-expired' });
  assert.deepEqual(await w.c.applyConnect(b.previewId), { status: 'refused', code: 'preview-invalid' }, 'consumed on first lookup');
  const c = w.c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  assert.equal(c.status === 'preview' && (await w.c.applyConnect(c.previewId)).status, 'applied');
  assert.deepEqual(c.status === 'preview' && await w.c.applyConnect(c.previewId), { status: 'refused', code: 'preview-invalid' }, 'replay');
});

test('the file changed after the preview: nothing written or deployed, a new preview', async () => {
  const w = await world();
  const pv = w.c.previewConnect(w.profiles.claude, { retention: true, tee: true });
  writeFileSync(w.files.claude, CLAUDE_SETTINGS.replace('dark', 'light'));
  const edited = sha(w.files.claude);
  const r = await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
  assert.equal(r.status, 'needs-preview');
  assert.equal(sha(w.files.claude), edited);
  assert.equal(existsSync(join(w.dataDir, 'integrations', 'bin')), false);
  assert.deepEqual(readManifest(w.dataDir), []);
});

test('a later step no longer matching its preview (managed policy appeared) undoes the Connect and shows a new preview', async () => {
  const w = await world();
  const before = sha(w.files.claude);
  const pv = w.c.previewConnect(w.profiles.claude, { retention: true, tee: false });
  writeFileSync(join(w.managed, 'managed-settings.json'), '{"cleanupPeriodDays":20}');
  const r = await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
  assert.equal(r.status, 'needs-preview');
  assert.ok(r.status === 'needs-preview' && r.preview.status === 'preview' && !r.preview.steps.some((s) => s.route === 'claude-retention'), 'the new preview has no retention step');
  assert.equal(sha(w.files.claude), before, 'the fallback step was undone');
  assert.deepEqual(readManifest(w.dataDir), []);
});

test('already connected: a second preview is refused (one entry per file and route, also in the engine)', async () => {
  const w = await world();
  await connect(w, w.profiles.claude, { retention: false, tee: false });
  assert.deepEqual(w.c.previewConnect(w.profiles.claude, { retention: false, tee: false }), { status: 'refused', code: 'duplicate' });
  const bounds = { root: w.profiles.claude.root, denied: [] };
  const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return e instanceof ConfigError ? e.code : String(e); } };
  assert.equal(code(() => apply(plan(w.files.claude, 'claude-settings-fallback', [{ op: 'set', pointer: '/x', value: 1 }], bounds), { dataDir: w.dataDir, bounds })), 'duplicate');
});

test('real or denied profile roots and Gemini are refused before anything is read or written', async () => {
  const w = await world();
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'xreal-')));
  dirs.push(outside);
  mkdirSync(join(outside, '.claude'));
  assert.deepEqual(w.c.previewConnect({ ...w.profiles.claude, root: join(outside, '.claude') }, { retention: true, tee: false }), { status: 'refused', code: 'unsafe-profile' });
  mkdirSync(join(w.base, 'real', '.claude'), { recursive: true });
  assert.deepEqual(w.c.previewConnect({ ...w.profiles.claude, root: join(w.base, 'real', '.claude') }, { retention: true, tee: false }), { status: 'refused', code: 'unsafe-profile' });
  assert.deepEqual(w.c.previewConnect(w.profiles.gemini, { retention: true, tee: false }), { status: 'refused', code: 'unverified' });
  assert.equal(existsSync(join(w.dataDir, 'integrations')), false);
});

test('Disconnect touches only its own profile; Uninstall reverts every entry and refuses targets outside the allowed roots', async () => {
  const w = await world();
  const before = hashes(w);
  await connect(w, w.profiles.claude);
  await connect(w, w.profiles.codex);
  const codexConnected = sha(w.files.codex);
  assert.equal((await w.c.disconnect(w.profiles.claude)).status, 'disconnected');
  assert.equal(sha(w.files.codex), codexConnected, 'the other profile is untouched');
  await connect(w, w.profiles.claude, { retention: true, tee: false });
  const locked = await createConnect({ ...w.ctx, allowed: [] }).uninstall([]);
  assert.equal(locked.status, 'partial');
  assert.ok(locked.remaining.length >= 2 && locked.remaining.every((r) => r.reason === 'refused'));
  assert.equal(readManifest(w.dataDir).length, 3);
  const u = await w.c.uninstall([]);
  assert.equal(u.status, 'disconnected', JSON.stringify(u));
  assert.deepEqual(hashes(w), before);
  assert.deepEqual(readManifest(w.dataDir), []);
});

test('design review M2: recordEntry replaces an entry in place, so manifest order stays creation order', async () => {
  const w = await world();
  await connect(w, w.profiles.claude, { retention: true, tee: false });
  const [a, b] = readManifest(w.dataDir) as [ManifestEntry, ManifestEntry];
  recordEntry(w.dataDir, { ...a, seen: { hash: 'h', since: 1 } });
  assert.deepEqual(readManifest(w.dataDir).map((e) => e.id), [a.id, b.id]);
});

// code review (run 191) M-c: no denylist (login environment unreadable) refuses everything, never fails open
test('unavailable bounds: every call is refused', async () => {
  const w = await world();
  for (const denied of [null, []]) {
    const c = createConnect({ ...w.ctx, denied });
    assert.deepEqual(c.previewConnect(w.profiles.claude, { retention: true, tee: false }), { status: 'refused', code: 'bounds-unavailable' });
    assert.deepEqual(await c.disconnect(w.profiles.claude), { status: 'refused', code: 'bounds-unavailable' });
    assert.deepEqual(await c.uninstall([]), { status: 'refused', code: 'bounds-unavailable' });
  }
  assert.equal(existsSync(join(w.dataDir, 'integrations')), false);
});

// M-b: an allowed root that holds the home is not disposable; M-d and writable(): every folder up to the allowed root private
test('refused: an allowed root holding the home, group-writable folders, a symlinked root into a denied root', async () => {
  const w = await world();
  const home = process.env['HOME'];
  process.env['HOME'] = join(w.base, 'someone');
  try { assert.deepEqual(w.c.previewConnect(w.profiles.claude, { retention: false, tee: false }), { status: 'refused', code: 'unsafe-profile' }); } finally { process.env['HOME'] = home; }
  chmodSync(join(w.home, '.gemini', 'config'), 0o775);
  assert.deepEqual(w.c.previewConnect(w.profiles.agy, { retention: false, tee: false }), { status: 'refused', code: 'unsafe-profile' }, 'the agy hooks folder itself');
  chmodSync(w.profiles.claude.root, 0o775);
  assert.deepEqual(w.c.previewConnect(w.profiles.claude, { retention: false, tee: false }), { status: 'refused', code: 'unsafe-profile' });
  mkdirSync(join(w.base, 'real', '.claude'), { recursive: true, mode: 0o755 });
  symlinkSync(join(w.base, 'real', '.claude'), join(w.home, 'linked'));
  assert.deepEqual(w.c.previewConnect({ ...w.profiles.claude, root: join(w.home, 'linked') }, { retention: false, tee: false }), { status: 'refused', code: 'unsafe-profile' });
  assert.equal(existsSync(join(w.dataDir, 'integrations')), false);
});

// review LOW (L2): same bytes but another mode or file since the preview is a new preview, before any helper is deployed
test('a mode change after the preview: nothing deployed, a new preview', async () => {
  const w = await world();
  chmodSync(w.files.claude, 0o644); // a known mode under any umask (re-review LOW)
  const pv = w.c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  chmodSync(w.files.claude, 0o600);
  assert.equal((await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '')).status, 'needs-preview');
  assert.equal(existsSync(join(w.dataDir, 'integrations', 'bin')), false);
});

// review LOW: Codex hooks that already run a Xaibo shim (manifest lost) are not appended again
test('Codex hooks already running a Xaibo shim: refused as a duplicate', async () => {
  const w = await world();
  writeFileSync(w.files.codex, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: "'/x/integrations/bin/xaibo-hook' hook codex codex-1" }] }] } }));
  assert.deepEqual(w.c.previewConnect(w.profiles.codex, { retention: false, tee: false }), { status: 'refused', code: 'duplicate' });
});

// P6-T03 part 2a (design review M3, L3, L4): the operation lock; failures injected after a step's rename
test('busy keeps the preview: apply while another writer holds the lock, then again once it is released; previews refuse while locked', async () => {
  const w = await world();
  const pv = w.c.previewConnect(w.profiles.claude, { retention: true, tee: false });
  const held = acquireLock(w.dataDir);
  assert.deepEqual(await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : ''), { status: 'refused', code: 'busy' });
  assert.deepEqual(w.c.previewConnect(w.profiles.codex, { retention: false, tee: false }), { status: 'refused', code: 'busy' });
  assert.deepEqual(await w.c.disconnect(w.profiles.claude), { status: 'refused', code: 'busy' });
  held.release();
  assert.equal((await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '')).status, 'applied', 'the same preview, kept');
});

// XAIBO-PROD-612 review (MEDIUM, LOW 1): Disconnect always holds the lock as external (the plugin uninstall may run, and the
// manifest it reverts is read only under the lock); a Removal of a plugin entry too
test('a plugin Disconnect and a plugin Removal hold the lock as the external writer', async () => {
  const w = await world({ route: 'plugin' });
  const lockWriter = () => json(join(w.dataDir, 'integrations', 'operation.lock'))['writer'];
  const pv = w.c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  assert.equal((await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '')).status, 'applied');
  w.setMode('slow');
  const pending = w.c.disconnect(w.profiles.claude);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(lockWriter(), 'external', 'Disconnect');
  await pending;
  w.setMode('');
  const pv2 = w.c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  assert.equal((await w.c.applyConnect(pv2.status === 'preview' ? pv2.previewId : '')).status, 'applied');
  const rp = w.c.previewRemoval(Object.values(w.profiles), w.profiles.claude);
  assert.equal(rp.status, 'preview', JSON.stringify(rp));
  w.setMode('slow');
  const removing = w.c.applyRemoval(rp.status === 'preview' ? rp.previewId : '', undefined, Object.values(w.profiles));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(lockWriter(), 'external', 'Removal');
  await removing;
});

// XAIBO-PROD-612: an in-process settings write holds the lock as the service writer
test('a settings-route Connect holds the lock as the service writer', async () => {
  const w = await world();
  const seen: unknown[] = [];
  const c = createConnect({ ...w.ctx, afterRename: () => { seen.push(json(join(w.dataDir, 'integrations', 'operation.lock'))['writer']); } });
  const pv = c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  assert.equal((await c.applyConnect(pv.status === 'preview' ? pv.previewId : '')).status, 'applied');
  assert.ok(seen.length > 0 && seen.every((x) => x === 'service'), JSON.stringify(seen));
});

test('a step that throws after its rename: its pending entry is undone first, then step 1; the file comes back byte for byte', async () => {
  const w = await world();
  const before = sha(w.files.claude);
  let n = 0;
  const c = createConnect({ ...w.ctx, afterRename: () => { if (++n === 2) throw new Error('injected'); } });
  const pv = c.previewConnect(w.profiles.claude, { retention: true, tee: false });
  assert.deepEqual(await c.applyConnect(pv.status === 'preview' ? pv.previewId : ''), { status: 'refused', code: 'failed' });
  assert.equal(sha(w.files.claude), before);
  assert.deepEqual(readManifest(w.dataDir), []);
});

test('an undo that fails during compensation: partial, the older entry on that file blocked', async () => {
  const w = await world();
  let n = 0;
  const c = createConnect({ ...w.ctx, afterRename: () => {
    if (++n !== 2) return;
    const pending = readManifest(w.dataDir).at(-1)!; // step 2's entry, recorded before its rename
    unlinkSync(join(w.dataDir, 'integrations', 'backups', pending.backup!));
    throw new Error('injected');
  } });
  const pv = c.previewConnect(w.profiles.claude, { retention: true, tee: false });
  const r = await c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
  assert.equal(r.status, 'partial');
  assert.ok(r.status === 'partial' && r.code === 'failed');
  assert.deepEqual(r.status === 'partial' && r.remaining.map((x) => [x.route, x.reason]), [['claude-retention', 'backup'], ['claude-settings-fallback', 'blocked']]);
  assert.equal(readdirSync(join(w.dataDir, 'integrations', 'backups')).length, 1, 'the older entry keeps its backup');
});

test('the service context never sets the test-only afterRename hook', () => {
  const ctx = connectContext({ dataDir: '/d', login: { PATH: '/bin' }, bin: '', catalog: null, detection: () => undefined });
  assert.equal(ctx.afterRename, undefined);
});

// code review (run 193) L-c: a preview says stale-lock (not busy) when the lock's holder is gone
test('a stale lock: the preview says stale-lock, apply too; nothing is touched', async () => {
  const w = await world();
  mkdirSync(join(w.dataDir, 'integrations'), { recursive: true, mode: 0o700 });
  writeFileSync(join(w.dataDir, 'integrations', 'operation.lock'), JSON.stringify({ pid: 2_147_483_646, token: 'crashed', at: 1 }), { mode: 0o600 });
  assert.deepEqual(w.c.previewConnect(w.profiles.claude, { retention: false, tee: false }), { status: 'refused', code: 'stale-lock' });
  assert.deepEqual(await w.c.disconnect(w.profiles.claude), { status: 'refused', code: 'stale-lock' });
});

// XAIBO-PROD-560 (P6-T03 part 2b; owner D-P6-06, D-P6-07; design .handoff/p6-t03-design.md part 2b slice and review): Claude's
// route comes from the catalog and the detected version; the plugin step is previewed (bounded cli view, a placeholder for
// the plugin folder) and installed through the fake `claude` under the operation lock; retention and tee after it apply only
// when equal to the preview, else the Connect is undone (plugin entries stay remaining until part 2c: partial).
test('2b route at preview: 2.1.319 and later -> plugin step with a bounded cli view, no data dir on the wire, nothing run', async () => {
  for (const version of ['2.1.319', '2.1.322']) {
    const w = await world({ route: 'plugin', version });
    const pv = w.c.previewConnect(w.profiles.claude, { retention: true, tee: true });
    assert.equal(pv.status, 'preview', JSON.stringify(pv));
    if (pv.status !== 'preview') return;
    assert.deepEqual(pv.steps.map((s) => s.route), ['claude-plugin', 'claude-retention', 'claude-tee']);
    const p = pv.steps[0]!;
    assert.deepEqual(p.diff, [{ pointer: '/enabledPlugins/xaibo-hooks@xaibo', new: true }]);
    assert.deepEqual(p.cli, {
      version, argv: [['plugin', 'marketplace', 'add', '<plugin-dir>'], ['plugin', 'install', 'xaibo-hooks@xaibo', '-s', 'user']],
      writes: ['settings.json', '.claude.json', 'plugins/known_marketplaces.json', 'plugins/installed_plugins.json', 'plugins/cache/'],
    });
    assert.ok(!JSON.stringify(p).includes(w.dataDir), 'review H2: the plugin step carries no data dir (plugin folder)'); // tee/hook diffs carry the helper they write
    assert.ok(!JSON.stringify(pv).includes(w.fake), 'never the executable path');
    assert.deepEqual(w.log(), []);
  }
});

test('2b unverified: below 2.1.319, a prerelease, no version, not detected, an executable replaced since detection; no login PATH', async () => {
  for (const version of ['2.1.318', '2.1.319-beta.1', null]) {
    const w = await world({ route: 'plugin', version });
    assert.deepEqual(w.c.previewConnect(w.profiles.claude, { retention: true, tee: true }), { status: 'refused', code: 'unverified' }, String(version));
  }
  const w = await world({ route: 'plugin' });
  assert.deepEqual(createConnect({ ...w.ctx, detection: () => ({ agent: 'claude', state: 'not-detected' }) }).previewConnect(w.profiles.claude, { retention: false, tee: false }), { status: 'refused', code: 'unverified' });
  assert.deepEqual(createConnect({ ...w.ctx, catalog: null }).previewConnect(w.profiles.claude, { retention: false, tee: false }), { status: 'refused', code: 'unverified' });
  assert.deepEqual(createConnect({ ...w.ctx, cliPath: null }).previewConnect(w.profiles.claude, { retention: false, tee: false }), { status: 'refused', code: 'bounds-unavailable' });
  writeFileSync(w.fake, `${readFileSync(w.fake, 'utf8')}// replaced after detection\n`);
  assert.deepEqual(w.c.previewConnect(w.profiles.claude, { retention: false, tee: false }), { status: 'refused', code: 'unverified' }, 'review H1');
  assert.deepEqual(w.log(), []);
});

test('2b plugin Connect: plugin, then retention and tee equal to the preview; entries in creation order', async () => {
  for (const claude of [undefined, null]) { // review L1: also with no settings.json before Connect (the CLI creates it)
    const w = await world({ route: 'plugin', claude });
    const { r } = await connect(w, w.profiles.claude);
    assert.equal(r.status, 'applied');
    assert.deepEqual(w.log(), ['plugin marketplace add', 'plugin install xaibo-hooks@xaibo']);
    const m = readManifest(w.dataDir);
    assert.deepEqual(m.map((e) => [e.route, e.state]), [['claude-plugin', 'applied'], ['claude-retention', 'applied'], ['claude-tee', 'applied']]);
    const s = json(w.files.claude);
    assert.deepEqual(s['enabledPlugins'], { 'xaibo-hooks@xaibo': true });
    assert.equal(s['cleanupPeriodDays'], 45);
    assert.match(JSON.stringify(s['statusLine']), /xaibo-statusline/);
    assert.ok(!JSON.stringify(s['hooks'] ?? {}).includes('xaibo-hook'), 'no settings-fallback hooks next to the plugin (EC-09)');
  }
});

test('2b/2c verified chain: the CLI changed the retention value -> the plugin is undone byte for byte, then a fresh preview', async () => {
  const w = await world({ route: 'plugin' });
  const before = sha(w.files.claude);
  w.setMode('bump-retention');
  const pv = w.c.previewConnect(w.profiles.claude, { retention: true, tee: true });
  assert.equal(pv.status, 'preview');
  const r = await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
  assert.equal(r.status, 'needs-preview', JSON.stringify(r));
  assert.deepEqual(readManifest(w.dataDir), []);
  assert.equal(sha(w.files.claude), before, 'the install (and the CLI\'s own edit) undone: the pre-install bytes');
  assert.deepEqual(w.log(), ['plugin marketplace add', 'plugin install xaibo-hooks@xaibo', 'plugin uninstall xaibo-hooks@xaibo', 'plugin marketplace remove']);
});

test('2b/2c a dirty plugin failure never falls back: the pending entry is removed through the CLI, refused cli, profile unchanged', async () => {
  const w = await world({ route: 'plugin' });
  const before = sha(w.files.claude);
  w.setMode('fail-dirty');
  const pv = w.c.previewConnect(w.profiles.claude, { retention: true, tee: false });
  const r = await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
  assert.deepEqual(r, { status: 'refused', code: 'cli' });
  assert.deepEqual(readManifest(w.dataDir), []);
  assert.equal(sha(w.files.claude), before);
  assert.ok(!JSON.stringify(json(w.files.claude)['hooks'] ?? {}).includes('xaibo-hook'));
  assert.deepEqual(w.log(), ['plugin marketplace add', 'plugin install xaibo-hooks@xaibo', 'plugin marketplace remove', 'plugin uninstall xaibo-hooks@xaibo']);
});

test('2b a clean plugin failure: refused cli, nothing recorded, settings unchanged', async () => {
  const w = await world({ route: 'plugin' });
  const before = sha(w.files.claude);
  w.setMode('fail-install');
  const pv = w.c.previewConnect(w.profiles.claude, { retention: true, tee: true });
  assert.deepEqual(await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : ''), { status: 'refused', code: 'cli' });
  assert.deepEqual(readManifest(w.dataDir), []);
  assert.equal(sha(w.files.claude), before);
});

test('2b settings changed between preview and apply: a fresh preview, no CLI call, no helper deployed', async () => {
  const w = await world({ route: 'plugin' });
  const pv = w.c.previewConnect(w.profiles.claude, { retention: true, tee: true });
  writeFileSync(w.files.claude, '{"theme":"light"}\n');
  const r = await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
  assert.equal(r.status, 'needs-preview', JSON.stringify(r));
  assert.deepEqual(w.log(), []);
  assert.ok(!existsSync(join(w.dataDir, 'integrations', 'bin')));
});

test('2b the operation lock is held across the awaited CLI steps', async () => {
  const w = await world({ route: 'plugin' });
  w.setMode('slow');
  const pv = w.c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  const pending = w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
  await new Promise((r) => setTimeout(r, 100)); // the install is running
  assert.throws(() => acquireLock(w.dataDir), (e) => e instanceof ConfigError && e.code === 'busy');
  // XAIBO-PROD-612: an operation that runs `claude plugin` holds the lock as an external writer (never clearable in-app)
  assert.equal(json(join(w.dataDir, 'integrations', 'operation.lock'))['writer'], 'external');
  assert.equal((await pending).status, 'applied');
  acquireLock(w.dataDir).release(); // released after the operation
});

// XAIBO-PROD-561 (P6-T03 part 2c; design .handoff/p6-t03-design.md part 2c slice and review): Disconnect removes the plugin last
// (after tee and retention) through `claude plugin`, giving settings.json back byte for byte; only an auto-detected Claude is
// run; legacy entries and an undetected Claude stay remaining.
test('2c plugin round trip: Connect (plugin, retention, tee) then Disconnect gives every file back byte for byte', async () => {
  for (const claude of [undefined, null]) {
    const w = await world({ route: 'plugin', claude });
    const before = hashes(w);
    await connect(w, w.profiles.claude);
    const d = await w.c.disconnect(w.profiles.claude);
    assert.equal(d.status, 'disconnected', JSON.stringify(d));
    assert.deepEqual(d.status === 'disconnected' && d.reverted.map((x) => [x.route, x.result]), [['claude-tee', 'restored'], ['claude-retention', 'restored'], ['claude-plugin', claude === null ? 'removed' : 'restored']]);
    assert.deepEqual(hashes(w), before);
    assert.deepEqual(readManifest(w.dataDir), []);
  }
});

test('2c a manually chosen Claude: Connect takes the fallback; a plugin entry is not removed with it (remaining unverified, no spawn)', async () => {
  const m = await world({ route: 'plugin', manual: true });
  const pv = m.c.previewConnect(m.profiles.claude, { retention: false, tee: false });
  assert.deepEqual(pv.status === 'preview' && pv.steps.map((x) => x.route), ['claude-settings-fallback']);
  const w = await world({ route: 'plugin' });
  await connect(w, w.profiles.claude, { retention: false, tee: false });
  const det = w.ctx.detection('claude');
  const manual = createConnect({ ...w.ctx, detection: () => (det?.state === 'detected' ? { ...det, manual: true } : det) });
  const d = await manual.disconnect(w.profiles.claude);
  assert.deepEqual(d.status === 'partial' && d.remaining.map((x) => [x.route, x.reason]), [['claude-plugin', 'unverified']]);
  assert.equal(w.log().length, 2, 'only the install ran');
});

test('2c Uninstall with Claude no longer detected: the plugin entry stays remaining unverified; a legacy entry stays legacy', async () => {
  const w = await world({ route: 'plugin' });
  await connect(w, w.profiles.claude, { retention: false, tee: false });
  const gone = createConnect({ ...w.ctx, detection: () => ({ agent: 'claude', state: 'not-detected' }) });
  const u = await gone.uninstall([]);
  assert.deepEqual(u.status === 'partial' && u.remaining.map((x) => [x.route, x.reason]), [['claude-plugin', 'unverified']]);
  const l = await world({ route: 'plugin' });
  recordEntry(l.dataDir, { id: '00000000-0000-4000-8000-0000000000c1', target: realpathSync(l.files.claude), route: 'claude-plugin', state: 'applied', existed: true, preHash: null, postHash: 'x', owned: [], created: [], backup: null, at: '2026-11-01T00:00:00.000Z' });
  const lu = await l.c.uninstall([]);
  assert.deepEqual(lu.status === 'partial' && lu.remaining.map((x) => [x.route, x.reason]), [['claude-plugin', 'legacy']]);
  assert.deepEqual(l.log(), []);
});

test('2c Claude auto-updated between Connect and Disconnect (D-P6-07): the current detection removes the plugin', async () => {
  const w = await world({ route: 'plugin' });
  const before = hashes(w);
  await connect(w, w.profiles.claude, { retention: false, tee: false });
  writeFileSync(w.fake, `${readFileSync(w.fake, 'utf8')}// 2.1.330\n`); // the executable changed in place
  const fresh = createConnect({ ...w.ctx, ...await claudeContext({ route: 'plugin', version: '2.1.330', exe: w.fake }) });
  assert.equal((await fresh.disconnect(w.profiles.claude)).status, 'disconnected');
  assert.deepEqual(hashes(w), before);
});

// Code review (run 196) M2: a first pass that keeps the plugin entry as partial reports it remaining (not reverted).
test('2c review M2: a kept partial plugin entry is remaining `partial` with its conflict; the next Disconnect drops it', async () => {
  const w = await world({ route: 'plugin' });
  await connect(w, w.profiles.claude, { retention: false, tee: false });
  writeFileSync(w.files.claude, JSON.stringify({ ...json(w.files.claude), ownerKey: 1 }, null, 2)); // owner edit: structural
  w.setMode('drop-foreign'); // and the CLI drops a foreign value
  const d = await w.c.disconnect(w.profiles.claude);
  assert.equal(d.status, 'partial', JSON.stringify(d));
  assert.deepEqual(d.status === 'partial' && [d.reverted, d.remaining.map((x) => [x.route, x.reason]), d.conflicts.map((x) => x.pointer)], [[], [['claude-plugin', 'partial']], ['/']]);
  w.setMode('');
  const again = await w.c.disconnect(w.profiles.claude);
  assert.deepEqual(again.status === 'partial' && again.reverted.map((x) => [x.route, x.result]), [['claude-plugin', 'structural']]);
  assert.deepEqual(readManifest(w.dataDir), []);
});
