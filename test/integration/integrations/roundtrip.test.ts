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
function world(o: { claude?: string | null } = {}) {
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
  const ctx: ConnectContext = {
    dataDir, denied: [join(base, 'real')], allowed: [base], claudeManagedDir: managed, now: () => clock.t,
    helpers: { hook: join(helpers, 'xaibo-hook'), forwarder: join(helpers, 'xaibo-forwarder'), statusline: join(helpers, 'xaibo-statusline') },
  };
  const profiles: Record<'claude' | 'codex' | 'agy' | 'gemini', Profile> = {
    claude: { id: 'claude-1', agent: 'claude', root: claudeDir, origin: 'default' },
    codex: { id: 'codex-1', agent: 'codex', root: codexDir, origin: 'default' },
    agy: { id: 'agy-1', agent: 'agy', root: agyRoot, origin: 'default' },
    gemini: { id: 'gemini-1', agent: 'gemini', root: join(home, '.gemini'), origin: 'default' },
  };
  return { base, home, managed, dataDir, files, ctx, clock, profiles, c: createConnect(ctx) };
}
type W = ReturnType<typeof world>;
const hashes = (w: W) => Object.fromEntries(Object.entries(w.files).map(([k, f]) => [k, sha(f)]));
function connect(w: W, p: Profile, sel = { retention: true, tee: true }) {
  const pv = w.c.previewConnect(p, sel);
  assert.equal(pv.status, 'preview', JSON.stringify(pv));
  const r = w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
  assert.equal(r.status, 'applied', JSON.stringify(r));
  return { pv, r };
}

test('Connect all offers plus the tee, then Disconnect: every file byte-identical; config.toml, trust and Gemini untouched', () => {
  const w = world();
  const before = hashes(w);
  const { pv } = connect(w, w.profiles.claude);
  assert.deepEqual(pv.status === 'preview' && pv.steps.map((s) => s.route), ['claude-settings-fallback', 'claude-retention', 'claude-tee']);
  assert.ok(pv.status === 'preview' && pv.ttlMs === 300_000 && !('expiresAt' in pv), 'review LOW: a time-to-live, never a monotonic clock value');
  const s = json(w.files.claude);
  assert.equal(s['cleanupPeriodDays'], 45);
  assert.match(JSON.stringify(s['hooks']), /xaibo-hook' hook claude claude-1/);
  assert.match(JSON.stringify(s['statusLine']), /xaibo-statusline/);
  assert.equal(s['theme'], 'dark');
  const codex = connect(w, w.profiles.codex);
  assert.ok(codex.r.status === 'applied' && codex.r.trustSteps.length > 0, 'Codex: guided trust steps, never a trust write');
  connect(w, w.profiles.agy);
  assert.equal(sha(w.files.toml), before['toml']);
  assert.equal(sha(w.files.gemini), before['gemini']);
  for (const p of [w.profiles.agy, w.profiles.codex, w.profiles.claude]) {
    const d = w.c.disconnect(p);
    assert.equal(d.status, 'disconnected', JSON.stringify(d));
    assert.deepEqual(d.conflicts, []);
  }
  assert.deepEqual(hashes(w), before);
  assert.deepEqual(readManifest(w.dataDir), []);
});

test('no settings.json: Connect creates it, Disconnect (newest first) leaves no file', () => {
  const w = world({ claude: null });
  connect(w, w.profiles.claude, { retention: true, tee: false });
  assert.equal(json(w.files.claude)['cleanupPeriodDays'], 45);
  assert.equal(w.c.disconnect(w.profiles.claude).status, 'disconnected');
  assert.equal(existsSync(w.files.claude), false);
});

test('an owner change to a Xaibo-owned value: a conflict, the file is not overwritten, older entries on that file stay', () => {
  const w = world();
  connect(w, w.profiles.claude, { retention: true, tee: false });
  writeFileSync(w.files.claude, JSON.stringify({ ...json(w.files.claude), cleanupPeriodDays: 60 }, null, 2));
  const changed = sha(w.files.claude);
  const d = w.c.disconnect(w.profiles.claude);
  assert.equal(d.status, 'partial');
  assert.deepEqual(d.conflicts.map((c) => [c.route, c.pointer]), [['claude-retention', '/cleanupPeriodDays']]);
  assert.deepEqual(d.remaining.map((r) => [r.route, r.reason]), [['claude-settings-fallback', 'blocked']]);
  assert.equal(sha(w.files.claude), changed, 'not overwritten');
});

test('a foreign change survives; Xaibo entries are removed and replaced values come back', () => {
  const w = world();
  connect(w, w.profiles.claude);
  writeFileSync(w.files.claude, JSON.stringify({ ...json(w.files.claude), theme: 'light' }, null, 2));
  assert.equal(w.c.disconnect(w.profiles.claude).status, 'disconnected');
  const s = json(w.files.claude);
  assert.equal(s['theme'], 'light');
  assert.equal(Object.hasOwn(s, 'cleanupPeriodDays'), false);
  assert.doesNotMatch(JSON.stringify(s), /xaibo/);
  assert.deepEqual(s['statusLine'], { type: 'command', command: '/opt/custom/statusline.sh', padding: 1 });
  assert.deepEqual(s['hooks'], (JSON.parse(CLAUDE_SETTINGS) as Record<string, unknown>)['hooks']);
});

test('an unreadable file is refused at preview: nothing written, no helper deployed, no manifest', () => {
  const w = world({ claude: '{ not json' });
  const before = hashes(w);
  assert.deepEqual(w.c.previewConnect(w.profiles.claude, { retention: true, tee: true }), { status: 'refused', code: 'invalid-json' });
  assert.deepEqual(hashes(w), before);
  assert.equal(existsSync(join(w.dataDir, 'integrations')), false);
});

test('previews: single use, replaced by a newer one for the profile, expire after five minutes', () => {
  const w = world();
  const a = w.c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  const b = w.c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  assert.ok(a.status === 'preview' && b.status === 'preview');
  assert.deepEqual(w.c.applyConnect(a.previewId), { status: 'refused', code: 'preview-invalid' }, 'replaced');
  w.clock.t += 5 * 60_000 + 1;
  assert.deepEqual(w.c.applyConnect(b.previewId), { status: 'refused', code: 'preview-expired' });
  assert.deepEqual(w.c.applyConnect(b.previewId), { status: 'refused', code: 'preview-invalid' }, 'consumed on first lookup');
  const c = w.c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  assert.equal(c.status === 'preview' && w.c.applyConnect(c.previewId).status, 'applied');
  assert.deepEqual(c.status === 'preview' && w.c.applyConnect(c.previewId), { status: 'refused', code: 'preview-invalid' }, 'replay');
});

test('the file changed after the preview: nothing written or deployed, a new preview', () => {
  const w = world();
  const pv = w.c.previewConnect(w.profiles.claude, { retention: true, tee: true });
  writeFileSync(w.files.claude, CLAUDE_SETTINGS.replace('dark', 'light'));
  const edited = sha(w.files.claude);
  const r = w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
  assert.equal(r.status, 'needs-preview');
  assert.equal(sha(w.files.claude), edited);
  assert.equal(existsSync(join(w.dataDir, 'integrations', 'bin')), false);
  assert.deepEqual(readManifest(w.dataDir), []);
});

test('a later step no longer matching its preview (managed policy appeared) undoes the Connect and shows a new preview', () => {
  const w = world();
  const before = sha(w.files.claude);
  const pv = w.c.previewConnect(w.profiles.claude, { retention: true, tee: false });
  writeFileSync(join(w.managed, 'managed-settings.json'), '{"cleanupPeriodDays":20}');
  const r = w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
  assert.equal(r.status, 'needs-preview');
  assert.ok(r.status === 'needs-preview' && r.preview.status === 'preview' && !r.preview.steps.some((s) => s.route === 'claude-retention'), 'the new preview has no retention step');
  assert.equal(sha(w.files.claude), before, 'the fallback step was undone');
  assert.deepEqual(readManifest(w.dataDir), []);
});

test('already connected: a second preview is refused (one entry per file and route, also in the engine)', () => {
  const w = world();
  connect(w, w.profiles.claude, { retention: false, tee: false });
  assert.deepEqual(w.c.previewConnect(w.profiles.claude, { retention: false, tee: false }), { status: 'refused', code: 'duplicate' });
  const bounds = { root: w.profiles.claude.root, denied: [] };
  const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return e instanceof ConfigError ? e.code : String(e); } };
  assert.equal(code(() => apply(plan(w.files.claude, 'claude-settings-fallback', [{ op: 'set', pointer: '/x', value: 1 }], bounds), { dataDir: w.dataDir, bounds })), 'duplicate');
});

test('real or denied profile roots and Gemini are refused before anything is read or written', () => {
  const w = world();
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'xreal-')));
  dirs.push(outside);
  mkdirSync(join(outside, '.claude'));
  assert.deepEqual(w.c.previewConnect({ ...w.profiles.claude, root: join(outside, '.claude') }, { retention: true, tee: false }), { status: 'refused', code: 'real-profile' });
  mkdirSync(join(w.base, 'real', '.claude'), { recursive: true });
  assert.deepEqual(w.c.previewConnect({ ...w.profiles.claude, root: join(w.base, 'real', '.claude') }, { retention: true, tee: false }), { status: 'refused', code: 'real-profile' });
  assert.deepEqual(w.c.previewConnect(w.profiles.gemini, { retention: true, tee: false }), { status: 'refused', code: 'unverified' });
  assert.equal(existsSync(join(w.dataDir, 'integrations')), false);
});

test('Disconnect touches only its own profile; Uninstall reverts every entry and refuses targets outside the allowed roots', () => {
  const w = world();
  const before = hashes(w);
  connect(w, w.profiles.claude);
  connect(w, w.profiles.codex);
  const codexConnected = sha(w.files.codex);
  assert.equal(w.c.disconnect(w.profiles.claude).status, 'disconnected');
  assert.equal(sha(w.files.codex), codexConnected, 'the other profile is untouched');
  connect(w, w.profiles.claude, { retention: true, tee: false });
  const locked = createConnect({ ...w.ctx, allowed: [] }).uninstall();
  assert.equal(locked.status, 'partial');
  assert.ok(locked.remaining.length >= 2 && locked.remaining.every((r) => r.reason === 'refused'));
  assert.equal(readManifest(w.dataDir).length, 3);
  const u = w.c.uninstall();
  assert.equal(u.status, 'disconnected', JSON.stringify(u));
  assert.deepEqual(hashes(w), before);
  assert.deepEqual(readManifest(w.dataDir), []);
});

test('design review M2: recordEntry replaces an entry in place, so manifest order stays creation order', () => {
  const w = world();
  connect(w, w.profiles.claude, { retention: true, tee: false });
  const [a, b] = readManifest(w.dataDir) as [ManifestEntry, ManifestEntry];
  recordEntry(w.dataDir, { ...a, seen: { hash: 'h', since: 1 } });
  assert.deepEqual(readManifest(w.dataDir).map((e) => e.id), [a.id, b.id]);
});

// code review (run 191) M-c: no denylist (login environment unreadable) refuses everything, never fails open
test('unavailable bounds: every call is refused', () => {
  const w = world();
  for (const denied of [null, []]) {
    const c = createConnect({ ...w.ctx, denied });
    assert.deepEqual(c.previewConnect(w.profiles.claude, { retention: true, tee: false }), { status: 'refused', code: 'bounds-unavailable' });
    assert.deepEqual(c.disconnect(w.profiles.claude), { status: 'refused', code: 'bounds-unavailable' });
    assert.deepEqual(c.uninstall(), { status: 'refused', code: 'bounds-unavailable' });
  }
  assert.equal(existsSync(join(w.dataDir, 'integrations')), false);
});

// M-b: an allowed root that holds the home is not disposable; M-d and writable(): every folder up to the allowed root private
test('refused: an allowed root holding the home, group-writable folders, a symlinked root into a denied root', () => {
  const w = world();
  const home = process.env['HOME'];
  process.env['HOME'] = join(w.base, 'someone');
  try { assert.deepEqual(w.c.previewConnect(w.profiles.claude, { retention: false, tee: false }), { status: 'refused', code: 'real-profile' }); } finally { process.env['HOME'] = home; }
  chmodSync(join(w.home, '.gemini', 'config'), 0o775);
  assert.deepEqual(w.c.previewConnect(w.profiles.agy, { retention: false, tee: false }), { status: 'refused', code: 'real-profile' }, 'the agy hooks folder itself');
  chmodSync(w.profiles.claude.root, 0o775);
  assert.deepEqual(w.c.previewConnect(w.profiles.claude, { retention: false, tee: false }), { status: 'refused', code: 'real-profile' });
  mkdirSync(join(w.base, 'real', '.claude'), { recursive: true, mode: 0o755 });
  symlinkSync(join(w.base, 'real', '.claude'), join(w.home, 'linked'));
  assert.deepEqual(w.c.previewConnect({ ...w.profiles.claude, root: join(w.home, 'linked') }, { retention: false, tee: false }), { status: 'refused', code: 'real-profile' });
  assert.equal(existsSync(join(w.dataDir, 'integrations')), false);
});

// review LOW (L2): same bytes but another mode or file since the preview is a new preview, before any helper is deployed
test('a mode change after the preview: nothing deployed, a new preview', () => {
  const w = world();
  chmodSync(w.files.claude, 0o644); // a known mode under any umask (re-review LOW)
  const pv = w.c.previewConnect(w.profiles.claude, { retention: false, tee: false });
  chmodSync(w.files.claude, 0o600);
  assert.equal(w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '').status, 'needs-preview');
  assert.equal(existsSync(join(w.dataDir, 'integrations', 'bin')), false);
});

// review LOW: Codex hooks that already run a Xaibo shim (manifest lost) are not appended again
test('Codex hooks already running a Xaibo shim: refused as a duplicate', () => {
  const w = world();
  writeFileSync(w.files.codex, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: "'/x/integrations/bin/xaibo-hook' hook codex codex-1" }] }] } }));
  assert.deepEqual(w.c.previewConnect(w.profiles.codex, { retention: false, tee: false }), { status: 'refused', code: 'duplicate' });
});
