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
import { approveRoot, boundedOutcome, grantProbe, grantSetup, importCatalog, importCatalogFile, loadImports } from '../../../src/service/catalog/import.ts';
import { parsePortMessage, parseServiceCommand } from '../../../src/shared/ipc.ts';
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

// XAIBO-PROD-588 (P6-T09a slice A; D-P6-18, SEC5): a setup grant is the owner's authorization for an imported entry's declared
// reportSetup writes. Only grantSetup stores it (trusted callers), bound to the entry digest and needing the declared root
// approved; loadImports keeps it only while both still hold. Import, root approval and probe grants never imply it, and it
// never implies a probe.
const SETUP_ENTRY = variant((c) => {
  (c.agents[0] as unknown as Record<string, unknown>)['reportSetup'] = { root: 'user', file: 'config.json', ops: [{ op: 'set', pointer: '/xaibo/helper', value: { xaibo: 'report-helper' } }] };
});
function granted() {
  const s = setup();
  assert.equal(importCatalog(s.dataDir, SETUP_ENTRY, bundled).status, 'imported');
  const root = join(s.home, '.synthagent');
  mkdirSync(root, { mode: 0o755 });
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), true);
  return { ...s, root, setupOf: (o = s.o) => [...loadImports(s.dataDir, bundled, o).setup] };
}

test('P6-T09a setup grant: only grantSetup grants it, for an imported entry with reportSetup and an approved root', () => {
  const s = setup();
  assert.equal(importCatalog(s.dataDir, SETUP_ENTRY, bundled).status, 'imported');
  const setupOf = (o = s.o) => [...loadImports(s.dataDir, bundled, o).setup];
  assert.deepEqual(setupOf(), [], 'import alone grants nothing');
  assert.equal(grantSetup(s.dataDir, bundled, 'synthagent', s.o), false, 'root not approved');
  const root = join(s.home, '.synthagent');
  mkdirSync(root, { mode: 0o755 });
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', s.o), true);
  assert.deepEqual(setupOf(), [], 'root approval alone grants nothing');
  mkdirSync(join(root, 'bin'), { mode: 0o755 });
  const exe = join(root, 'bin', 'synthagent');
  writeFileSync(exe, '#!/bin/sh\necho 1.2.3\n', { mode: 0o755 });
  assert.equal(grantProbe(s.dataDir, bundled, 'synthagent', 'main', exe, s.o), true);
  assert.deepEqual(setupOf(), [], 'a probe grant is not a setup grant');
  assert.equal(grantSetup(s.dataDir, bundled, 'claude', s.o), false, 'bundled agent');
  assert.equal(grantSetup(s.dataDir, bundled, 'nope', s.o), false, 'unknown agent');
  assert.equal(grantSetup(s.dataDir, bundled, 'synthagent', { ...s.o, allowed: [] }), false, 'production: nothing allowed');
  assert.equal(grantSetup(s.dataDir, bundled, 'synthagent', { ...s.o, denied: null }), false, 'no denylist');
  assert.equal(grantSetup(s.dataDir, bundled, 'synthagent', s.o), true);
  const l = loadImports(s.dataDir, bundled, s.o);
  assert.deepEqual([...l.setup], ['synthagent']);
  assert.equal(l.grants.get('synthagent')?.length, 1, 'the probe grant is untouched');
  assert.deepEqual(setupOf({ ...s.o, allowed: [] }), [], 'root approval rechecked at every load');
});

test('P6-T09a: a setup grant never authorizes a probe; an entry without reportSetup cannot get one', () => {
  const s = granted();
  assert.equal(grantSetup(s.dataDir, bundled, 'synthagent', s.o), true);
  assert.deepEqual(loadImports(s.dataDir, bundled, s.o).grants.get('synthagent'), [], 'no probe grant');
  const plain = variant((c) => { c.agents[0]!.id = 'plain'; c.agents[0]!.detection.binaries[0]!.names = ['plain']; c.agents[0]!.profileRoots[0]!.relative = '.plain'; });
  assert.equal(importCatalog(s.dataDir, plain, bundled).status, 'imported');
  mkdirSync(join(s.home, '.plain'));
  assert.equal(approveRoot(s.dataDir, bundled, 'plain', 'user', s.o), true);
  const before = snapshot(s.store);
  assert.equal(grantSetup(s.dataDir, bundled, 'plain', s.o), false, 'nothing declared to grant');
  assert.equal(snapshot(s.store), before, 'store unchanged on refusal');
  assert.deepEqual(s.setupOf(), ['synthagent']);
});

test('P6-T09a: a setup grant dies with a changed entry or a moved root; a malformed one never corrupts the store; old stores load', () => {
  const s = granted();
  assert.equal(grantSetup(s.dataDir, bundled, 'synthagent', s.o), true);
  const good = readFileSync(s.store, 'utf8');
  const doc = () => JSON.parse(good) as { entries: Record<string, unknown>[] };
  assert.deepEqual(s.setupOf(), ['synthagent']);

  const old = doc();
  delete old.entries[0]!['setup'];
  writeFileSync(s.store, JSON.stringify(old));
  let l = loadImports(s.dataDir, bundled, s.o);
  assert.deepEqual([l.issues, [...l.setup], l.imported.get('synthagent')], [[], [], { user: s.root }], 'a store without setup grants');

  for (const bad of [1, null, {}, ['x'], 'not-a-digest']) {
    const d = doc();
    d.entries[0]!['setup'] = bad;
    writeFileSync(s.store, JSON.stringify(d));
    l = loadImports(s.dataDir, bundled, s.o);
    assert.deepEqual([l.issues, [...l.setup]], [[], []], JSON.stringify(bad));
  }

  const changed = doc();
  (changed.entries[0]!['catalog'] as Catalog).agents[0]!.displayName = 'Changed';
  writeFileSync(s.store, JSON.stringify(changed));
  l = loadImports(s.dataDir, bundled, s.o);
  assert.deepEqual([l.issues, [...l.setup]], [[], []], 'a changed entry voids it');

  writeFileSync(s.store, good);
  assert.deepEqual(s.setupOf(), ['synthagent']);
  renameSync(s.root, join(s.tmp, 'moved'));
  assert.deepEqual(s.setupOf(), [], 'a moved root voids it');
});

test('P6-T09a code review 1: a setup grant is bound to the root it was given for, not to whichever root is approved later', () => {
  const s = granted();
  assert.equal(grantSetup(s.dataDir, bundled, 'synthagent', s.o), true);
  const homeB = join(s.tmp, 'homeB');
  mkdirSync(join(homeB, '.synthagent'), { recursive: true });
  const oB = { ...s.o, home: homeB };
  assert.equal(approveRoot(s.dataDir, bundled, 'synthagent', 'user', oB), true);
  assert.deepEqual(loadImports(s.dataDir, bundled, oB).imported.get('synthagent'), { user: join(homeB, '.synthagent') });
  assert.deepEqual(s.setupOf(oB), [], 'a root approved later needs its own setup grant');
  assert.equal(grantSetup(s.dataDir, bundled, 'synthagent', oB), true);
  assert.deepEqual(s.setupOf(oB), ['synthagent']);
});

test('P6-T09a code review: grantSetup refuses a stored entry the validator rejects (a string literal written into the store)', () => {
  const s = granted();
  const doc = JSON.parse(readFileSync(s.store, 'utf8')) as { entries: { catalog: Catalog }[] };
  (doc.entries[0]!.catalog.agents[0] as unknown as { reportSetup: { ops: { value: unknown }[] } }).reportSetup.ops[0]!.value = { literal: 'sh -c x' };
  writeFileSync(s.store, JSON.stringify(doc));
  const before = snapshot(s.store);
  assert.equal(grantSetup(s.dataDir, bundled, 'synthagent', s.o), false);
  assert.equal(snapshot(s.store), before);
  const l = loadImports(s.dataDir, bundled, s.o);
  assert.deepEqual([...l.setup], []);
  assert.ok(l.issues.some((i) => i.code === 'schema-invalid'));
});

// XAIBO-PROD-595 (P6-T08 slice E part 2; D-P6-19 1a, EC-78): import through the native picker. main forwards only the path the
// owner picked; the service reads it bounded (no link, regular file, 256 KiB) and runs importCatalog; the result carries an
// agent id or fixed codes and pointers only. Importing grants nothing.
test('P6-T08: importCatalogFile reads one bounded regular file and imports it; links, folders and oversize are refused', () => {
  const s = setup();
  const file = join(s.tmp, 'entry.json');
  writeFileSync(file, bytes('valid/synthagent.json'));
  assert.deepEqual(importCatalogFile(s.dataDir, bundled, file), { status: 'imported', agent: 'synthagent' });
  assert.deepEqual(loadImports(s.dataDir, bundled, s.o).grants.get('synthagent'), [], 'no grant from an import');
  assert.deepEqual([...loadImports(s.dataDir, bundled, s.o).setup], []);
  const before = snapshot(s.store);
  const link = join(s.tmp, 'link.json');
  symlinkSync(file, link);
  assert.deepEqual(importCatalogFile(s.dataDir, bundled, link), { status: 'rejected', issues: [{ code: 'unreadable', at: '/' }] });
  assert.deepEqual(importCatalogFile(s.dataDir, bundled, s.tmp), { status: 'rejected', issues: [{ code: 'unreadable', at: '/' }] });
  assert.deepEqual(importCatalogFile(s.dataDir, bundled, join(s.tmp, 'missing.json')), { status: 'rejected', issues: [{ code: 'unreadable', at: '/' }] });
  const big = join(s.tmp, 'big.json');
  writeFileSync(big, Buffer.alloc(256 * 1024 + 1, 0x20));
  assert.deepEqual(importCatalogFile(s.dataDir, bundled, big), { status: 'rejected', issues: [{ code: 'too-large', at: '/' }] });
  assert.equal(snapshot(s.store), before, 'refusals never change the store');
});

test('P6-T08: the importCatalog command takes one absolute path; the catalogImport broadcast is bounded', () => {
  assert.deepEqual(parseServiceCommand({ v: 1, type: 'importCatalog', path: '/tmp/xaibo-fixture/entry.json' }), { v: 1, type: 'importCatalog', path: '/tmp/xaibo-fixture/entry.json' });
  for (const bad of [{ path: 'entry.json' }, { path: '/tmp/a' + String.fromCharCode(0) + 'b' }, { path: '/'.padEnd(4097, 'x') }, {}]) {
    assert.equal(parseServiceCommand({ v: 1, type: 'importCatalog', ...bad }), null, JSON.stringify(bad));
  }
  const msg = (result: unknown) => parsePortMessage({ v: 1, type: 'catalogImport', result });
  assert.ok(msg({ status: 'imported', agent: 'synthagent' }));
  assert.ok(msg({ status: 'rejected', issues: [{ code: 'shadow', at: '/agents/0/id' }] }));
  for (const bad of [{ status: 'imported', agent: 'Bad Id' }, { status: 'rejected', issues: Array.from({ length: 33 }, () => ({ code: 'shadow', at: '/' })) },
    { status: 'rejected', issues: [{ code: 'Shadow!', at: '/' }] }, { status: 'rejected', issues: [{ code: 'shadow', at: 'x'.repeat(257) }] }, { status: 'done' }]) {
    assert.equal(msg(bad), null, JSON.stringify(bad));
  }
});

test('P6-T08 import review M1: the broadcast outcome is capped so the window can always read it (32 issues, 256-char pointers)', () => {
  const many = { status: 'rejected' as const, issues: Array.from({ length: 40 }, (_, i) => ({ code: 'schema-invalid' as const, at: i === 0 ? '/'.padEnd(300, 'a') : `/agents/0/x${i}` })) };
  const b = boundedOutcome(many);
  assert.equal(b.status === 'rejected' && b.issues.length, 32);
  assert.ok(b.status === 'rejected' && b.issues.every((i) => i.at.length <= 256));
  assert.ok(parsePortMessage({ v: 1, type: 'catalogImport', result: b }));
  assert.deepEqual(boundedOutcome({ status: 'imported', agent: 'synthagent' }), { status: 'imported', agent: 'synthagent' });
});

test('G6B-1: a store write over the load limit (1 MiB) is refused too-large; the store stays byte-identical and loadable', () => {
  const s = setup();
  const big = (i: number) => variant((c) => {
    const a = c.agents[0]!;
    a.id = `big${i}`; a.detection.binaries[0]!.names = [`big${i}`]; a.profileRoots[0]!.relative = `.big${i}`;
    a.detection.binaries[0]!.versionArgs = Array.from({ length: 4 }, () => 'a'.repeat(55_000));
  });
  let refused = false;
  for (let i = 0; i < 6 && !refused; i++) {
    const before = snapshot(s.store);
    const r = importCatalog(s.dataDir, big(i), bundled);
    if (r.status === 'rejected') {
      assert.deepEqual(r.issues, [{ code: 'too-large', at: '/' }], JSON.stringify(r));
      assert.equal(snapshot(s.store), before, 'store unchanged');
      refused = true;
    }
  }
  assert.ok(refused, 'an import past the store limit is refused');
  assert.ok(statSync(s.store).size <= 1 << 20);
  assert.deepEqual(loadImports(s.dataDir, bundled, s.o).issues, [], 'still loadable');
});

test('G6B-2: an imported agent id naming an Object member (constructor) gets no adapter; boot, rescan and stop work', async () => {
  const s = setup();
  const shell = join(s.tmp, 'login-shell');
  writeFileSync(shell, "#!/bin/sh\nprintf 'PATH=/nonexistent-xaibo\\0'\n", { mode: 0o755 });
  const c = variant((x) => { const a = x.agents[0]!; a.id = 'constructor'; a.detection.binaries[0]!.names = ['constructor']; a.profileRoots[0]!.relative = '.constructor'; });
  assert.equal(importCatalog(s.dataDir, c, bundled).status, 'imported');
  mkdirSync(join(s.home, '.constructor'));
  assert.equal(approveRoot(s.dataDir, bundled, 'constructor', 'user', s.o), true);
  const svc = await boot({ dataDir: s.dataDir, home: s.home, shell, catalog: bundled, allowedRoots: [s.tmp], intervalMs: 60_000 });
  try {
    await svc.done;
    assert.ok(svc.profiles()?.some((p) => p.agent === 'constructor'), 'the profile is listed');
    await svc.rescan();
  } finally {
    svc.stop();
  }
});
