// XAIBO-PROD-567 (P6-T07 part 3; EC-78, SEC5, FR-01; design .handoff/p6-t07-design.md part 3 slice, review P3-1..P3-8):
// the probe grant. An imported entry runs its declared version probe only through a grant that binds the entry digest, the
// binary id, one exact executable inside an approved disposable root and its file identity; every change after the grant
// (content, rename, mode, link, FIFO, root, digest) runs nothing. Never a shell, PATH search, process.env or manual path.
// Synthetic data in temp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../../../src/service/boot.ts';
import { detectAgent } from '../../../src/service/catalog/detect.ts';
import { approveRoot, grantProbe, importCatalog, loadImports } from '../../../src/service/catalog/import.ts';
import { loadCatalog, type Catalog } from '../../../src/service/catalog/validate.ts';
import { deniedRootsFrom } from '../../../src/service/config/bounds.ts';
import type { run } from '../../../src/service/spawn.ts';

const FIX = join(import.meta.dirname, '..', '..', 'fixtures', 'synthetic', 'catalog');
const SYNTH = readFileSync(join(FIX, 'valid', 'synthagent.json'));
// Known locations limited to the temp home, so no agent installed on this machine is probed.
const bundled: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((a) => ({ ...a, detection: { ...a.detection, locations: ['~/.local/bin'] } })) };
const denied = deniedRootsFrom({ PATH: '/nonexistent-xaibo' })!;

/** An imported synthagent and a fake executable in <root>/bin that logs each call (argv, env, cwd). */
function setup() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xprobe-')));
  const home = join(tmp, 'home'), dataDir = join(tmp, 'data'), root = join(home, '.synthagent'), bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(dataDir, { mode: 0o700 });
  const calls = join(tmp, 'calls'), envFile = join(tmp, 'env'), cwdFile = join(tmp, 'cwd');
  const exe = join(bin, 'synthagent');
  const script = (version: string) => `#!/bin/sh\necho "$@" >> '${calls}'\n/usr/bin/env > '${envFile}'\npwd > '${cwdFile}'\necho ${version}\n`;
  writeFileSync(exe, script('1.2.3'), { mode: 0o755 });
  const o = { home, allowed: [tmp], denied };
  const store = join(dataDir, 'catalog', 'imports.json');
  assert.deepEqual(importCatalog(dataDir, SYNTH, bundled), { status: 'imported', agent: 'synthagent' });
  return { tmp, home, dataDir, root, bin, exe, calls, envFile, cwdFile, script, o, store };
}
type S = ReturnType<typeof setup>;
const snapshot = (f: string) => (existsSync(f) ? readFileSync(f).toString('hex') : null);
const callCount = (s: S) => (existsSync(s.calls) ? readFileSync(s.calls, 'utf8').split('\n').filter(Boolean).length : 0);

/** detectAgent for synthagent with a recording fake runner; grants from a fresh load unless given. */
async function detect(s: S, grants?: unknown) {
  const l = loadImports(s.dataDir, bundled, s.o);
  const entry = l.catalog.agents.find((a) => a.id === 'synthagent')!;
  const seen: { file: string; args: readonly string[]; o: Parameters<typeof run>[2] }[] = [];
  const fake: typeof run = async (file, args, o) => {
    seen.push({ file, args, o });
    return { code: 0, signal: null, stdout: Buffer.from('synthagent 1.2.3\n'), timedOut: false, overflow: false, error: false };
  };
  const d = await detectAgent(entry, { env: { PATH: s.bin }, home: s.home, manualPath: s.exe, run: fake,
    access: { origin: 'imported', grants: (grants ?? l.grants.get('synthagent') ?? []) as never } });
  return { d, seen, grants: l.grants.get('synthagent') ?? [] };
}

const shellFor = (tmp: string) => {
  const shell = join(tmp, 'login-shell');
  writeFileSync(shell, "#!/bin/sh\nprintf 'PATH=/nonexistent-xaibo\\0'\n", { mode: 0o755 });
  return shell;
};

test('no grant: nothing runs, even with the executable on PATH, as the manual path and in the approved root', async () => {
  const s = setup();
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), true);
  const { d, seen } = await detect(s);
  assert.deepEqual(d, { agent: 'synthagent', state: 'not-detected', reason: 'probe-not-granted' });
  assert.equal(seen.length, 0);
  // code review 2: a store written before grants existed (no grants key) loads cleanly
  assert.equal('grants' in (JSON.parse(readFileSync(s.store, 'utf8')) as { entries: object[] }).entries[0]!, false);
  const l = loadImports(s.dataDir, bundled, s.o);
  assert.deepEqual([l.issues, l.grants.get('synthagent')], [[], []]);
});

test('grantProbe refuses anything but one exact private executable inside an approved root; the store never changes', () => {
  const s = setup();
  const grant = (file: string, agent = 'synthagent', binary = 'main') => grantProbe(s.dataDir, bundled, agent, binary, file, s.o);
  assert.equal(grant(s.exe), false, 'root not approved yet');
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), true);
  const before = snapshot(s.store);

  const outside = join(s.tmp, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'synthagent'), s.script('9.9.9'), { mode: 0o755 });
  const mk = (rel: string, mode = 0o755) => {
    const p = join(s.root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, s.script('1.2.3'));
    chmodSync(p, mode);
    return p;
  };
  mkdirSync(join(s.root, 'alt'));
  symlinkSync(s.exe, join(s.root, 'alt', 'synthagent'));
  mkdirSync(join(s.root, 'out'));
  symlinkSync(join(outside, 'synthagent'), join(s.root, 'out', 'synthagent'));
  symlinkSync(s.bin, join(s.root, 'lnk'));
  mkdirSync(join(s.root, 'fifo'));
  execFileSync('mkfifo', [join(s.root, 'fifo', 'synthagent')]);
  mkdirSync(join(s.root, 'dir', 'synthagent'), { recursive: true });
  mkdirSync(join(s.home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(s.home, '.local', 'bin', 'synthagent'), s.script('1.2.3'), { mode: 0o755 });

  for (const [why, ok] of [
    ['unknown agent', grant(s.exe, 'nope')],
    ['unknown binary', grant(s.exe, 'synthagent', 'other')],
    ['relative path', grant('bin/synthagent')],
    ['symlinked file', grant(join(s.root, 'alt', 'synthagent'))],
    ['symlink pointing outside', grant(join(s.root, 'out', 'synthagent'))],
    ['symlinked parent', grant(join(s.root, 'lnk', 'synthagent'))],
    ['undeclared name', grant(mk('bin/other'))],
    ['outside every approved root', grant(join(outside, 'synthagent'))],
    ['known location outside the root', grant(join(s.home, '.local', 'bin', 'synthagent'))],
    ['the root itself', grant(s.root)],
    ['group-writable', grant(mk('gw/synthagent', 0o775))],
    ['group-writable parent below the root (code review 1)', (() => { const p = mk('gwd/sub/synthagent'); chmodSync(join(s.root, 'gwd'), 0o777); return grant(p); })()],
    ['not executable', grant(mk('nx/synthagent', 0o644))],
    ['setuid', grant(mk('su/synthagent', 0o4755))],
    ['FIFO', grant(join(s.root, 'fifo', 'synthagent'))],
    ['directory', grant(join(s.root, 'dir', 'synthagent'))],
  ] as const) assert.equal(ok, false, why);
  assert.equal(snapshot(s.store), before, 'store unchanged');
  assert.deepEqual(loadImports(s.dataDir, bundled, s.o).grants.get('synthagent') ?? [], []);
});

test('a valid grant runs exactly the declared probe once: absolute path, exact argv, 3 s, bounded, isolated env, cwd /', async () => {
  const s = setup();
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), true);
  assert.equal(grantProbe(s.dataDir, bundled, 'synthagent', 'main', s.exe, s.o), true);
  assert.equal(grantProbe(s.dataDir, bundled, 'synthagent', 'main', s.exe, s.o), true, 'a second grant replaces the first');
  const doc = JSON.parse(readFileSync(s.store, 'utf8')) as { entries: { grants: unknown[] }[] };
  assert.equal(doc.entries[0]!.grants.length, 1);

  const { d, seen } = await detect(s);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.file, s.exe);
  assert.deepEqual(seen[0]!.args, ['--version']);
  assert.equal(seen[0]!.o.timeoutMs, 3_000);
  assert.equal(seen[0]!.o.maxBytes, 64 * 1024);
  assert.deepEqual(seen[0]!.o.env, { HOME: s.home, PATH: '/usr/bin:/bin' });
  assert.equal(seen[0]!.o.cwd, '/');
  assert.equal(d.state, 'detected');
  assert.ok(d.state === 'detected' && d.path === s.exe && d.version === '1.2.3' && d.manual, 'manual: never run as a plugin CLI (P3-7)');
});

test('boot: no grant, 0 calls; after the grant exactly 1 call per boot, detected, no inherited environment', async () => {
  const s = setup();
  const shell = shellFor(s.tmp);
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), true);
  const once = async () => {
    const svc = await boot({ dataDir: s.dataDir, home: s.home, shell, catalog: bundled, allowedRoots: [s.tmp], intervalMs: 60_000 });
    try { await svc.done; return svc.agents()?.find((a) => a.agent === 'synthagent'); } finally { svc.stop(); }
  };
  assert.equal((await once())?.state, 'not-detected');
  assert.equal(callCount(s), 0);

  assert.equal(grantProbe(s.dataDir, bundled, 'synthagent', 'main', s.exe, s.o), true);
  assert.equal(callCount(s), 0, 'granting runs nothing');
  process.env.XAIBO_P3_CANARY = 'canary-value';
  try {
    assert.deepEqual(await once(), { agent: 'synthagent', name: 'Synthetic Agent', state: 'detected', version: '1.2.3' });
  } finally { delete process.env.XAIBO_P3_CANARY; }
  assert.equal(callCount(s), 1);
  assert.equal(readFileSync(s.calls, 'utf8'), '--version\n');
  const env = readFileSync(s.envFile, 'utf8');
  assert.ok(!env.includes('canary-value'), 'process.env not inherited');
  assert.ok(env.split('\n').includes(`HOME=${s.home}`));
  assert.equal(readFileSync(s.cwdFile, 'utf8').trim(), '/');

  assert.equal((await once())?.state, 'detected', 'restart keeps the grant');
  assert.equal(callCount(s), 2);
});

test('production wiring: no allowed roots means a stored grant never loads and nothing runs', async () => {
  const s = setup();
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), true);
  assert.equal(grantProbe(s.dataDir, bundled, 'synthagent', 'main', s.exe, s.o), true);
  assert.deepEqual(loadImports(s.dataDir, bundled, { ...s.o, allowed: [] }).grants.get('synthagent') ?? [], []);
  const svc = await boot({ dataDir: s.dataDir, home: s.home, shell: shellFor(s.tmp), catalog: bundled, intervalMs: 60_000 });
  try {
    await svc.done;
    assert.equal(svc.agents()?.find((a) => a.agent === 'synthagent')?.state, 'not-detected');
  } finally { svc.stop(); }
  assert.equal(callCount(s), 0);
});

test('any change after the grant runs nothing and never falls through to another candidate', async () => {
  const cases: [string, (s: S) => void][] = [
    ['content rewritten', (s) => writeFileSync(s.exe, s.script('1.2.4-changed'))],
    ['replaced by rename', (s) => { writeFileSync(join(s.bin, 'new'), s.script('1.2.3'), { mode: 0o755 }); renameSync(join(s.bin, 'new'), s.exe); }],
    ['made group-writable', (s) => chmodSync(s.exe, 0o775)],
    ['made setuid', (s) => chmodSync(s.exe, 0o4755)],
    ['swapped for a symlink', (s) => { renameSync(s.exe, join(s.root, 'copy')); symlinkSync(join(s.root, 'copy'), s.exe); }],
    ['swapped for a FIFO', (s) => { rmSync(s.exe); execFileSync('mkfifo', [s.exe]); }],
    ['parent swapped for a symlink', (s) => { renameSync(s.bin, join(s.root, 'bin2')); symlinkSync(join(s.root, 'bin2'), s.bin); }],
    ['removed', (s) => rmSync(s.exe)],
  ];
  for (const [why, change] of cases) {
    const s = setup();
    assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), true);
    assert.equal(grantProbe(s.dataDir, bundled, 'synthagent', 'main', s.exe, s.o), true, why);
    const held = loadImports(s.dataDir, bundled, s.o).grants.get('synthagent');
    assert.equal(held?.length, 1, why);
    change(s);
    const r = await detect(s, held); // a grant held from before the change
    assert.equal(r.seen.length, 0, why);
    assert.deepEqual(r.d, { agent: 'synthagent', state: 'not-detected', reason: 'probe-grant-stale' }, why);
    const fresh = await detect(s); // a fresh load: stale or dropped, never run
    assert.equal(fresh.seen.length, 0, why);
    assert.equal(fresh.d.state, 'not-detected', why);
  }
});

test('root no longer approved, or the stored entry changed by hand: the grant is dropped at load', async () => {
  const s = setup();
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), true);
  assert.equal(grantProbe(s.dataDir, bundled, 'synthagent', 'main', s.exe, s.o), true);
  const good = readFileSync(s.store);

  const doc = JSON.parse(good.toString('utf8')) as { entries: { catalog: Catalog }[] };
  doc.entries[0]!.catalog.agents[0]!.detection.binaries[0]!.versionArgs = ['--other'];
  writeFileSync(s.store, JSON.stringify(doc));
  const r1 = await detect(s);
  assert.deepEqual([r1.grants, r1.seen.length, r1.d], [[], 0, { agent: 'synthagent', state: 'not-detected', reason: 'probe-not-granted' }]);

  writeFileSync(s.store, good);
  assert.equal((await detect(s)).grants.length, 1);
  chmodSync(s.bin, 0o777); // code review 1: a directory below the root opened to others after the grant
  const r3 = await detect(s);
  assert.deepEqual([r3.grants, r3.seen.length], [[], 0]);
  chmodSync(s.bin, 0o755);
  assert.equal((await detect(s)).grants.length, 1);
  renameSync(s.root, join(s.home, 'moved'));
  symlinkSync(join(s.home, 'moved'), s.root);
  const r2 = await detect(s);
  assert.deepEqual([r2.grants, r2.seen.length], [[], 0]);
});

test('malformed stored grants are dropped silently; the import itself still loads and nothing throws', () => {
  const s = setup();
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), true);
  assert.equal(grantProbe(s.dataDir, bundled, 'synthagent', 'main', s.exe, s.o), true);
  const doc = JSON.parse(readFileSync(s.store, 'utf8')) as { entries: { grants: Record<string, unknown>[] }[] };
  const g = doc.entries[0]!.grants[0]!;
  for (const [why, grants] of [
    ['not an array', 'x'],
    ['not an object', [1]],
    ['binary not a string', [{ ...g, binary: 1 }]],
    ['ino a string', [{ ...g, id: { ...(g['id'] as object), ino: '1' } }]],
    ['undeclared binary', [{ ...g, binary: 'other' }]],
    ['relative path', [{ ...g, path: 'bin/synthagent' }]],
    ['more grants than binaries', [g, g]],
  ] as const) {
    writeFileSync(s.store, JSON.stringify({ ...doc, entries: [{ ...doc.entries[0], grants }] }));
    const l = loadImports(s.dataDir, bundled, s.o);
    assert.deepEqual(l.issues, [], why);
    assert.ok(l.imported.has('synthagent'), why);
    assert.deepEqual(l.grants.get('synthagent') ?? [], [], why);
  }
});
