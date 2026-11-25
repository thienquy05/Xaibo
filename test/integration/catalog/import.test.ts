// XAIBO-PROD-566 (P6-T07 part 2; EC-78, SEC5, FR-01; design .handoff/p6-t07-design.md part 2 slice, review P2-1..P2-9):
// the private import store (one agent per import, 0700/0600, never overwritten when corrupt), shadowing between bundled
// and imported entries and between imports, root approval for disposable roots only, and boot wiring: an imported entry
// is merged, never probed, gets only approved roots, and setPath refuses it. Synthetic data in temp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../../../src/service/boot.ts';
import { profileRoots } from '../../../src/service/catalog/detect.ts';
import { approveRoot, importCatalog, loadImports } from '../../../src/service/catalog/import.ts';
import { loadCatalog, type Catalog } from '../../../src/service/catalog/validate.ts';
import { deniedRootsFrom } from '../../../src/service/config/bounds.ts';
import { openStore } from '../../../src/service/store/db.ts';

const FIX = join(import.meta.dirname, '..', '..', 'fixtures', 'synthetic', 'catalog');
const bytes = (rel: string) => readFileSync(join(FIX, rel));
const SYNTH = JSON.parse(bytes('valid/synthagent.json').toString('utf8')) as Catalog;
const variant = (f: (c: Catalog) => void) => { const c = structuredClone(SYNTH); f(c); return Buffer.from(JSON.stringify(c)); };
// Known locations limited to the temp home (as in service-boot.test.ts), so no agent installed on this machine is probed.
const bundled: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((a) => ({ ...a, detection: { ...a.detection, locations: ['~/.local/bin'] } })) };
const denied = deniedRootsFrom({ PATH: '/nonexistent-xaibo' })!;

function setup() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ximport-')));
  const home = join(tmp, 'home'), dataDir = join(tmp, 'data');
  mkdirSync(home);
  mkdirSync(dataDir, { mode: 0o700 });
  const store = join(dataDir, 'catalog', 'imports.json');
  return { tmp, home, dataDir, store, o: { home, allowed: [tmp], denied } };
}
const snapshot = (file: string) => (existsSync(file) ? readFileSync(file).toString('hex') : null);

test('a valid import is stored privately and merged at load; a second import of the same agent is shadow', () => {
  const s = setup();
  assert.deepEqual(importCatalog(s.dataDir, bytes('valid/synthagent.json'), bundled), { status: 'imported', agent: 'synthagent' });
  assert.equal(statSync(join(s.dataDir, 'catalog')).mode & 0o777, 0o700);
  assert.equal(statSync(s.store).mode & 0o777, 0o600);
  const l = loadImports(s.dataDir, bundled, s.o);
  assert.deepEqual(l.issues, []);
  assert.deepEqual(l.catalog.agents.map((a) => a.id), [...bundled.agents.map((a) => a.id), 'synthagent']);
  assert.deepEqual([...l.imported.keys()], ['synthagent']);
  assert.deepEqual(l.imported.get('synthagent'), {});

  const before = snapshot(s.store);
  for (const [b, at] of [
    [bytes('valid/synthagent.json'), '/agents/0/id'],
    [variant((c) => { c.agents[0]!.id = 'other'; c.agents[0]!.profileRoots[0]!.relative = '.other'; }), '/agents/0/detection/binaries/0/names/0'],
    [variant((c) => { c.agents[0]!.id = 'other'; c.agents[0]!.detection.binaries[0]!.names = ['other']; c.agents[0]!.profileRoots[0]!.relative = '.synthagent/sub'; }), '/agents/0/profileRoots/0/relative'],
  ] as const) {
    const r = importCatalog(s.dataDir, b, bundled);
    assert.equal(r.status, 'rejected');
    assert.ok(r.status === 'rejected' && r.issues.some((i) => i.code === 'shadow' && i.at === at), at);
  }
  assert.equal(snapshot(s.store), before, 'store unchanged');
});

test('every shadow and invalid fixture, oversized, undecodable and multi-agent input is rejected; the store never changes', () => {
  const s = setup();
  for (const dir of ['shadow', 'invalid']) {
    for (const f of readdirSync(join(FIX, dir))) {
      const r = importCatalog(s.dataDir, bytes(`${dir}/${f}`), bundled);
      assert.equal(r.status, 'rejected', f);
    }
  }
  const reject = (b: Uint8Array) => { const r = importCatalog(s.dataDir, b, bundled); return r.status === 'rejected' ? r.issues : null; };
  assert.deepEqual(reject(Buffer.alloc(256 * 1024 + 1, 0x20)), [{ code: 'too-large', at: '/' }]);
  assert.deepEqual(reject(Buffer.from([0xff, 0xfe])), [{ code: 'invalid-json', at: '/' }]);
  assert.deepEqual(reject(Buffer.from('{')), [{ code: 'invalid-json', at: '/' }]);
  assert.deepEqual(reject(variant((c) => { c.agents.push({ ...structuredClone(c.agents[0]!), id: 'second' }); })), [{ code: 'schema-invalid', at: '/agents' }]);
  // an imported session kind naming a bundled agent cannot attach to it (P2-6)
  assert.ok(reject(variant((c) => { c.sessionKinds = [{ agent: 'claude', id: 'cli', match: { entrypoint: 'cli' }, evidence: 'synthetic', resumeDisabled: 'synthetic' }]; }))
    ?.some((i) => i.code === 'unknown-reference' && i.at === '/sessionKinds/0/agent'));
  assert.equal(existsSync(s.store), false, 'nothing stored');
});

test('a corrupt or unsafe store refuses imports, is never rewritten, and leaves the bundled catalog intact', () => {
  const s = setup();
  mkdirSync(join(s.dataDir, 'catalog'), { mode: 0o700 });
  for (const [content, mode] of [['not json', 0o600], [JSON.stringify({ version: 2, entries: [] }), 0o600], [JSON.stringify({ version: 1, entries: [], x: 1 }), 0o600],
    [JSON.stringify({ version: 1, entries: [] }), 0o644]] as const) {
    writeFileSync(s.store, content, { mode });
    chmodSync(s.store, mode);
    const before = snapshot(s.store);
    const r = importCatalog(s.dataDir, bytes('valid/synthagent.json'), bundled);
    assert.deepEqual(r, { status: 'rejected', issues: [{ code: 'store-corrupt', at: '/' }] }, content);
    assert.equal(snapshot(s.store), before);
    const l = loadImports(s.dataDir, bundled, s.o);
    assert.deepEqual(l.catalog, bundled);
    assert.deepEqual(l.issues, [{ code: 'store-corrupt', at: '/' }]);
  }
  // a linked or group-readable catalog directory fails closed too
  const t = setup();
  mkdirSync(join(t.tmp, 'elsewhere'), { mode: 0o700 });
  symlinkSync(join(t.tmp, 'elsewhere'), join(t.dataDir, 'catalog'));
  assert.equal(importCatalog(t.dataDir, bytes('valid/synthagent.json'), bundled).status, 'rejected');
  assert.deepEqual(readdirSync(join(t.tmp, 'elsewhere')), []);
  const u = setup();
  mkdirSync(join(u.dataDir, 'catalog'), { mode: 0o755 });
  chmodSync(join(u.dataDir, 'catalog'), 0o755);
  assert.equal(importCatalog(u.dataDir, bytes('valid/synthagent.json'), bundled).status, 'rejected');
  assert.equal(existsSync(u.store), false);
});

test('code review 6: a symlinked store, non-string or __proto__ roots; approveRoot never writes a corrupt store', () => {
  const s = setup();
  importCatalog(s.dataDir, bytes('valid/synthagent.json'), bundled);
  mkdirSync(join(s.home, '.synthagent'));
  const doc = JSON.parse(readFileSync(s.store, 'utf8')) as { entries: { roots: unknown }[] };
  doc.entries[0]!.roots = { user: 1 };
  writeFileSync(s.store, JSON.stringify(doc));
  const before = snapshot(s.store);
  assert.deepEqual(loadImports(s.dataDir, bundled, s.o).issues, [{ code: 'store-corrupt', at: '/' }]);
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), false);
  assert.equal(snapshot(s.store), before, 'never rewritten');

  writeFileSync(s.store, JSON.stringify(doc).replace('{"user":1}', '{"__proto__":"x"}'));
  const l = loadImports(s.dataDir, bundled, s.o);
  assert.deepEqual(l.issues, []);
  assert.deepEqual(l.imported.get('synthagent'), {}, 'an inert __proto__ key approves nothing');
  assert.equal(({} as Record<string, unknown>)['user'], undefined, 'no prototype pollution');

  renameSync(s.store, join(s.tmp, 'real.json'));
  symlinkSync(join(s.tmp, 'real.json'), s.store);
  assert.deepEqual(loadImports(s.dataDir, bundled, s.o).issues, [{ code: 'store-corrupt', at: '/' }]);
  assert.equal(importCatalog(s.dataDir, variant((c) => { c.agents[0]!.id = 'other'; c.agents[0]!.detection.binaries[0]!.names = ['other']; c.agents[0]!.profileRoots[0]!.relative = '.other'; }), bundled).status, 'rejected');
});

test('a later stored entry that shadows an earlier one is dropped at load; loading creates nothing', () => {
  const s = setup();
  assert.equal(existsSync(join(s.dataDir, 'catalog')), false);
  assert.deepEqual(loadImports(s.dataDir, bundled, s.o).issues, []);
  assert.equal(existsSync(join(s.dataDir, 'catalog')), false, 'read-only load: no catalog dir');
  importCatalog(s.dataDir, bytes('valid/synthagent.json'), bundled);
  const doc = JSON.parse(readFileSync(s.store, 'utf8')) as { entries: unknown[] };
  doc.entries.push(structuredClone(doc.entries[0])); // hand-edited duplicate
  writeFileSync(s.store, JSON.stringify(doc));
  const l = loadImports(s.dataDir, bundled, s.o);
  assert.equal(l.catalog.agents.filter((a) => a.id === 'synthagent').length, 1);
  assert.ok(l.issues.some((i) => i.code === 'shadow' && i.at.startsWith('/entries/1/')));
});

test('root approval: a declared real directory inside the allowed disposable roots only; rechecked at every load', () => {
  const s = setup();
  importCatalog(s.dataDir, bytes('valid/synthagent.json'), bundled);
  const root = join(s.home, '.synthagent');
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), false, 'missing directory');
  writeFileSync(root, 'file');
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), false, 'not a directory');
  renameSync(root, join(s.tmp, 'was-file'));
  mkdirSync(join(s.tmp, 'target'));
  symlinkSync(join(s.tmp, 'target'), root);
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), false, 'symlinked root');
  renameSync(root, join(s.tmp, 'was-link'));
  mkdirSync(root);
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', { ...s.o, allowed: [join(s.tmp, 'target')] }), false, 'outside allowed');
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', { ...s.o, denied: null }), false, 'no denylist');
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', { ...s.o, allowed: [] }), false, 'production: nothing allowed');
  assert.equal(approveRoot(s.dataDir, bundled, 'claude', 'user', s.o), false, 'bundled agent');
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'nope', s.o), false, 'undeclared root');
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), true);
  assert.deepEqual(loadImports(s.dataDir, bundled, s.o).imported.get('synthagent'), { user: root });
  assert.deepEqual(loadImports(s.dataDir, bundled, { ...s.o, allowed: [] }).imported.get('synthagent'), {}, 'writable() again at load');

  // profiles: an imported agent gets only its approved roots, never manual ones
  const l = loadImports(s.dataDir, bundled, s.o);
  const manualDir = join(s.tmp, 'manual');
  mkdirSync(manualDir);
  assert.deepEqual(profileRoots(l.catalog, {}, s.home, { synthagent: [manualDir] }, l.imported).filter((r) => r.agent === 'synthagent'),
    [{ agent: 'synthagent', root, origin: 'default' }]);

  // swapped to a symlink after approval: dropped at the next load
  renameSync(root, join(s.tmp, 'moved'));
  symlinkSync(join(s.tmp, 'moved'), root);
  assert.deepEqual(loadImports(s.dataDir, bundled, s.o).imported.get('synthagent'), {});

  // a hand-edited absolute or undeclared root is dropped
  const doc = JSON.parse(readFileSync(s.store, 'utf8')) as { entries: { roots: Record<string, string> }[] };
  doc.entries[0]!.roots = { user: join(s.tmp, 'target'), extra: join(s.tmp, 'target') };
  writeFileSync(s.store, JSON.stringify(doc));
  assert.deepEqual(loadImports(s.dataDir, bundled, s.o).imported.get('synthagent'), {});
});

test('boot: an imported agent is merged, never probed, gets only approved roots; kv roots and setPath are refused', async () => {
  const s = setup();
  const shell = join(s.tmp, 'login-shell');
  writeFileSync(shell, "#!/bin/sh\nprintf 'PATH=/nonexistent-xaibo\\0'\n", { mode: 0o755 });
  const marker = join(s.tmp, 'probed');
  mkdirSync(join(s.home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(s.home, '.local', 'bin', 'synthagent'), `#!/bin/sh\ntouch '${marker}'\necho 1.0.0\n`, { mode: 0o755 });
  const root = join(s.home, '.synthagent');
  mkdirSync(root);
  const kvRoot = join(s.tmp, 'kv-root');
  mkdirSync(kvRoot);
  const pre = await openStore({ file: join(s.dataDir, 'xaibo.db'), backupDir: join(s.dataDir, 'backups') });
  pre.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('agent.synthagent.roots', JSON.stringify([kvRoot]));
  pre.db.close();
  importCatalog(s.dataDir, bytes('valid/synthagent.json'), bundled);
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), true);

  const svc = await boot({ dataDir: s.dataDir, home: s.home, shell, catalog: bundled, allowedRoots: [s.tmp], intervalMs: 60_000 });
  try {
    await svc.done;
    assert.deepEqual(svc.agents()?.find((a) => a.agent === 'synthagent'), { agent: 'synthagent', name: 'Synthetic Agent', state: 'not-detected', version: null });
    assert.equal(existsSync(marker), false, 'no probe ran');
    assert.ok(svc.catalog()?.agents.some((a) => a.id === 'synthagent'));
    const roots = svc.store.db.prepare("SELECT root FROM profiles WHERE agent = 'synthagent'").all().map((r) => (r as { root: string }).root);
    assert.deepEqual(roots, [root], 'approved root only, never the kv root');
    assert.equal(await svc.setPath('synthagent', join(s.home, '.local', 'bin', 'synthagent')), false);
    assert.equal(existsSync(marker), false);
  } finally {
    svc.stop();
  }

  // no store: the same catalog and agents as before imports existed
  const t = setup();
  const plain = await boot({ dataDir: t.dataDir, home: t.home, shell, catalog: bundled, allowedRoots: [t.tmp], intervalMs: 60_000 });
  try {
    await plain.done;
    assert.deepEqual(plain.catalog(), bundled);
    assert.deepEqual(plain.agents()?.map((a) => a.agent), bundled.agents.map((a) => a.id));
    assert.equal(existsSync(join(t.dataDir, 'catalog')), false);
  } finally {
    plain.stop();
  }
});
