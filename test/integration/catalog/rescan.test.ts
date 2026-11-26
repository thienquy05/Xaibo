// XAIBO-PROD-590 (P6-T08 slice A; EC-79, FR-01, D-P6-19; design .handoff/p6-t08-design.md with the fresh review): rescan
// without restart. One scan at a time (callers join it), a cooldown, refused while starting or stopped; grants and approved
// roots reloaded, catalog and login environment kept from startup; detections replaced in place, profiles re-synced with
// stable ids, an adapter started only for a profile that had none; an imported entry is probed only through its grant. The
// IPC request carries no argument. Synthetic temp homes, login shells and executables only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../../../src/service/boot.ts';
import { approveRoot, importCatalog } from '../../../src/service/catalog/import.ts';
import { loadCatalog, type Catalog } from '../../../src/service/catalog/validate.ts';
import { deniedRootsFrom } from '../../../src/service/config/bounds.ts';
import { parsePortMessage, parsePortRequest } from '../../../src/shared/ipc.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const iso = mkdtempSync(join(tmpdir(), 'xrescan-env-'));
dirs.push(iso);
for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR']) process.env[k] = join(iso, k.toLowerCase());
// known locations limited to the temp home, so no agent installed on this machine is probed
const bundled: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((a) => ({ ...a, detection: { ...a.detection, locations: ['~/.local/bin'] } })) };
const SYNTH = readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'synthetic', 'catalog', 'valid', 'synthagent.json'));

function world() {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'xrescan-')));
  dirs.push(tmp);
  const home = join(tmp, 'home'), dataDir = join(tmp, 'data'), bin = join(tmp, 'bin');
  mkdirSync(home);
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(bin);
  const shell = join(tmp, 'login-shell');
  writeFileSync(shell, `#!/bin/sh\nprintf 'PATH=${bin}\\0'\n`, { mode: 0o755 });
  const probes = join(tmp, 'probes');
  /** A fake executable that records each probe and prints its version. */
  const install = (dir: string, name: string, version: string) => writeFileSync(join(dir, name), `#!/bin/sh\necho ${name} >> '${probes}'\necho "${name} ${version}"\n`, { mode: 0o755 });
  const probed = (name: string) => (existsSync(probes) ? readFileSync(probes, 'utf8').split('\n').filter((l) => l === name).length : 0);
  const start = (o: { cooldown?: number } = {}) => boot({ dataDir, home, shell, catalog: bundled, intervalMs: 60_000, allowedRoots: [tmp], ...(o.cooldown !== undefined ? { rescanCooldownMs: o.cooldown } : {}) });
  return { tmp, home, dataDir, bin, install, probed, start };
}
const state = (svc: Awaited<ReturnType<ReturnType<typeof world>['start']>>, agent: string) => svc.agents()?.find((a) => a.agent === agent);

test('an executable installed after startup is detected by rescan, without a restart; the shared detections list is updated in place', async () => {
  const w = world();
  const svc = await w.start({ cooldown: 0 });
  try {
    await svc.done;
    assert.equal(state(svc, 'codex')?.state, 'not-detected');
    const list = svc.detections;
    w.install(w.bin, 'codex', '0.160.0');
    assert.deepEqual(await svc.rescan(), { status: 'ready' });
    assert.deepEqual(state(svc, 'codex'), { agent: 'codex', name: 'Codex', state: 'detected', version: '0.160.0' });
    assert.equal(svc.detections, list, 'the same array (index.ts and Connect read it live)');
    assert.equal(list.find((d) => d.agent === 'codex')?.state, 'detected');
  } finally { svc.stop(); }
});

test('a profile folder created after startup gets a profile and one adapter; repeated rescans add no duplicates', async () => {
  const w = world();
  w.install(w.bin, 'codex', '0.160.0');
  const svc = await w.start({ cooldown: 0 });
  try {
    await svc.done;
    const before = svc.profiles()!.length, adapters = svc.adapters.length;
    mkdirSync(join(w.home, '.codex'));
    assert.deepEqual(await svc.rescan(), { status: 'ready' });
    const codex = svc.profiles()!.filter((p) => p.agent === 'codex');
    assert.deepEqual(codex.map((p) => p.root), [join(w.home, '.codex')]);
    assert.equal(svc.profiles()!.length, before + 1);
    assert.equal(svc.adapters.length, adapters + 1, 'an adapter for the new profile');
    const id = codex[0]!.id;
    assert.deepEqual(await svc.rescan(), { status: 'ready' });
    assert.deepEqual(svc.profiles()!.filter((p) => p.agent === 'codex').map((p) => p.id), [id], 'stable id, no duplicate');
    assert.equal(svc.adapters.length, adapters + 1, 'no second adapter');
  } finally { svc.stop(); }
});

test('an imported entry without a probe grant is never probed by rescan, even with its binary on PATH', async () => {
  const w = world();
  const policy = { home: w.home, allowed: [w.tmp], denied: deniedRootsFrom({ PATH: '/nonexistent-xaibo' })! };
  assert.equal(importCatalog(w.dataDir, SYNTH, bundled).status, 'imported');
  mkdirSync(join(w.home, '.synthagent'));
  assert.equal(approveRoot(w.dataDir, bundled, 'synthagent', 'user', policy), true);
  w.install(w.bin, 'synthagent', '1.0.0');
  w.install(join(w.home, '.synthagent'), 'synthagent', '1.0.0');
  const svc = await w.start({ cooldown: 0 });
  try {
    await svc.done;
    assert.deepEqual(await svc.rescan(), { status: 'ready' });
    assert.equal(state(svc, 'synthagent')?.state, 'not-detected');
    assert.equal(w.probed('synthagent'), 0, 'no probe without a grant');
    assert.deepEqual(svc.profiles()!.filter((p) => p.agent === 'synthagent').map((p) => p.root), [join(w.home, '.synthagent')], 'the approved root only');
  } finally { svc.stop(); }
});

test('concurrent rescans join one scan; another within the cooldown is rate-limited; starting and stopped are refused', async () => {
  const w = world();
  w.install(w.bin, 'codex', '0.160.0');
  const svc = await w.start();
  try {
    assert.deepEqual(await svc.rescan(), { status: 'refused', code: 'starting' }, 'before startup settles');
    await svc.done;
    const startup = w.probed('codex');
    const [a, b] = await Promise.all([svc.rescan(), svc.rescan()]);
    assert.deepEqual([a, b], [{ status: 'ready' }, { status: 'ready' }]);
    assert.equal(w.probed('codex'), startup + 1, 'one scan, one probe');
    const r = await svc.rescan();
    assert.equal(r.status, 'refused');
    assert.ok(r.status === 'refused' && r.code === 'rate-limited' && r.retryAfterMs! > 0 && r.retryAfterMs! <= 5_000, JSON.stringify(r));
    assert.equal(w.probed('codex'), startup + 1, 'no probe when rate-limited');
  } finally { svc.stop(); }
  assert.deepEqual(await svc.rescan(), { status: 'refused', code: 'unavailable' });
});

test('code review H1: an import store that reads as corrupt at rescan never turns an imported entry into a bundled one', async () => {
  const w = world();
  const policy = { home: w.home, allowed: [w.tmp], denied: deniedRootsFrom({ PATH: '/nonexistent-xaibo' })! };
  assert.equal(importCatalog(w.dataDir, SYNTH, bundled).status, 'imported');
  mkdirSync(join(w.home, '.synthagent'));
  assert.equal(approveRoot(w.dataDir, bundled, 'synthagent', 'user', policy), true);
  w.install(w.bin, 'synthagent', '1.0.0'); // on the login PATH: a bundled-style search would find and run it
  const svc = await w.start({ cooldown: 0 });
  try {
    await svc.done;
    chmodSync(join(w.dataDir, 'catalog', 'imports.json'), 0o644); // now store-corrupt (mode)
    assert.deepEqual(await svc.rescan(), { status: 'ready' });
    assert.equal(w.probed('synthagent'), 0, 'never probed without a grant');
    assert.equal(state(svc, 'synthagent')?.state, 'not-detected');
    assert.deepEqual(svc.profiles()!.filter((p) => p.agent === 'synthagent').map((p) => p.root), [], 'no unapproved default root');
    assert.equal(await svc.setPath('synthagent', join(w.bin, 'synthagent')), false, 'no manual path for an imported id');
    assert.equal(w.probed('synthagent'), 0);
  } finally { svc.stop(); }
});

// XAIBO-PROD-596 (P6-T08a slice A; D-P6-20): grants through the service refresh detection and profiles before the reply,
// inside the rescan cooldown; the renderer's own rescan keeps its cooldown; a revoke that changes nothing scans nothing.
const synthRoots = (svc: Awaited<ReturnType<ReturnType<typeof world>['start']>>) => svc.profiles()!.filter((p) => p.agent === 'synthagent').map((p) => p.root);
test('P6-T08a: a confirmed root approval and probe grant take effect before the reply; revoke drops them; a no-op revoke scans nothing', async () => {
  const w = world();
  w.install(w.bin, 'codex', '0.160.0'); // every scan probes it once: a scan counter
  assert.equal(importCatalog(w.dataDir, SYNTH, bundled).status, 'imported');
  const root = join(w.home, '.synthagent');
  mkdirSync(root);
  const ROOT = { action: 'root', agent: 'synthagent', root: 'user' } as const;
  const svc = await w.start(); // the default 5 s cooldown
  try {
    assert.deepEqual(svc.grantOffer(ROOT), { status: 'refused', code: 'unavailable' }, 'refused while starting');
    await svc.done;
    assert.deepEqual(await svc.rescan(), { status: 'ready' }); // the cooldown is now running
    const x = svc.grantOffer(ROOT);
    assert.equal(x.status, 'offer');
    if (x.status !== 'offer') return;
    assert.deepEqual(synthRoots(svc), [], 'an offer changes nothing');
    assert.deepEqual(await svc.grantConfirm(ROOT, x.offer.binding), { status: 'granted' });
    assert.deepEqual(synthRoots(svc), [root], 'the profile exists when the reply arrives');
    assert.equal((await svc.rescan()).status, 'refused', 'the renderer rescan keeps its cooldown');

    w.install(root, 'synthagent', '1.0.0');
    const PROBE = { action: 'probe', agent: 'synthagent', binary: 'main', file: join(root, 'synthagent') } as const;
    const y = svc.grantOffer(PROBE);
    assert.equal(y.status, 'offer');
    if (y.status !== 'offer') return;
    assert.deepEqual(await svc.grantConfirm(PROBE, y.offer.binding), { status: 'granted' });
    assert.equal(state(svc, 'synthagent')?.state, 'detected', 'probed through its new grant before the reply');
    assert.deepEqual(svc.grantState('synthagent'), { roots: [{ id: 'user', state: 'approved' }], probes: [{ binary: 'main', state: 'granted' }], setup: null });

    assert.equal(await svc.revoke('synthagent', { kind: 'root', id: 'user' }), 'revoked');
    assert.deepEqual(synthRoots(svc), [], 'gone when the reply arrives');
    assert.equal(state(svc, 'synthagent')?.state, 'not-detected', 'the probe grant under the root went with it');
    const scans = w.probed('codex');
    assert.equal(await svc.revoke('synthagent', { kind: 'root', id: 'user' }), 'unchanged');
    assert.equal(w.probed('codex'), scans, 'a revoke that changed nothing runs no scan');
    assert.deepEqual(svc.grantState('claude'), null);
  } finally { svc.stop(); }
  assert.deepEqual(svc.grantOffer(ROOT), { status: 'refused', code: 'unavailable' }, 'refused after stop');
  assert.equal(await svc.revoke('synthagent', { kind: 'root', id: 'user' }), 'unavailable');
});

test('code review L1/L4: a binding is single-use (no replay after a revoke); a grant waits for a scan in flight and its reply reflects it', async () => {
  const w = world();
  assert.equal(importCatalog(w.dataDir, SYNTH, bundled).status, 'imported');
  const root = join(w.home, '.synthagent');
  mkdirSync(root);
  const ROOT = { action: 'root', agent: 'synthagent', root: 'user' } as const;
  const svc = await w.start({ cooldown: 0 });
  try {
    await svc.done;
    const x = svc.grantOffer(ROOT);
    assert.equal(x.status, 'offer');
    if (x.status !== 'offer') return;
    const inFlight = svc.rescan();
    assert.deepEqual(await svc.grantConfirm(ROOT, x.offer.binding), { status: 'granted' });
    assert.deepEqual(await inFlight, { status: 'ready' });
    assert.deepEqual(synthRoots(svc), [root], 'the reply came after its own scan, not the earlier one');
    assert.equal(await svc.revoke('synthagent', { kind: 'root', id: 'user' }), 'revoked');
    assert.deepEqual(await svc.grantConfirm(ROOT, x.offer.binding), { status: 'refused', code: 'stale' }, 'no replay');
    assert.deepEqual(synthRoots(svc), []);
  } finally { svc.stop(); }
});

test('IPC: the rescan request carries no argument; replies are bounded', () => {
  assert.deepEqual(parsePortRequest({ v: 1, type: 'agentRescan', id: 7 }), { v: 1, type: 'agentRescan', id: 7 });
  for (const bad of [{ v: 1, type: 'agentRescan', id: 7, agent: 'codex' }, { v: 1, type: 'agentRescan', id: 7, path: '/tmp/x' }, { v: 1, type: 'agentRescan' }]) {
    assert.equal(parsePortRequest(bad), null, JSON.stringify(bad));
  }
  const ok = (result: unknown) => parsePortMessage({ v: 1, type: 'agentRescan', id: 7, result });
  assert.ok(ok({ status: 'ready' }));
  assert.ok(ok({ status: 'refused', code: 'rate-limited', retryAfterMs: 4_000 }));
  assert.ok(ok({ status: 'refused', code: 'starting' }));
  for (const bad of [{ status: 'ready', extra: 1 }, { status: 'refused', code: 'nope' }, { status: 'refused', code: 'rate-limited', retryAfterMs: -1 },
    { status: 'refused', code: 'rate-limited', retryAfterMs: 60_001 }, { status: 'done' }]) assert.equal(ok(bad), null, JSON.stringify(bad));
});
