// XAIBO-PROD-596 (P6-T08a slice A; D-P6-20, SEC5, FR-01; design .handoff/p6-t08a-design.md with the fresh review): grant
// offers carry the exact dialog fields and a stateless binding; a confirm writes only while the binding still matches (else
// stale, the store untouched); each grant implies no other; revoke (a root also drops the probe and setup grants under it);
// grant state for the integration detail carries no paths. Synthetic data in temp dirs only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmGrant, grantOffer, grantState, importCatalog, loadImports, revokeGrant, type GrantRequest, type RootPolicy } from '../../../src/service/catalog/import.ts';
import { loadCatalog, type Catalog } from '../../../src/service/catalog/validate.ts';
import { deniedRootsFrom } from '../../../src/service/config/bounds.ts';

const FIX = join(import.meta.dirname, '..', '..', 'fixtures', 'synthetic', 'catalog');
const SYNTH = JSON.parse(readFileSync(join(FIX, 'valid', 'synthagent.json'), 'utf8')) as Catalog;
const entry = (f: (c: Catalog) => void = () => {}) => { const c = structuredClone(SYNTH); f(c); return Buffer.from(JSON.stringify(c)); };
const WITH_SETUP = entry((c) => {
  (c.agents[0] as unknown as Record<string, unknown>)['reportSetup'] = { root: 'user', file: 'config.json', ops: [
    { op: 'set', pointer: '/xaibo/helper', value: { xaibo: 'report-helper' } }, { op: 'set', pointer: '/xaibo/on', value: { literal: true } }] };
});
const bundled: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((a) => ({ ...a, detection: { ...a.detection, locations: ['~/.local/bin'] } })) };
const KEY = randomBytes(32);
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const denied = deniedRootsFrom({ PATH: '/nonexistent-xaibo' })!;

function world(bytes = WITH_SETUP) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xgrants-')));
  dirs.push(tmp);
  const home = join(tmp, 'home'), dataDir = join(tmp, 'data');
  mkdirSync(home);
  mkdirSync(dataDir, { mode: 0o700 });
  assert.equal(importCatalog(dataDir, bytes, bundled).status, 'imported');
  const root = join(home, '.synthagent');
  mkdirSync(root, { mode: 0o755 });
  mkdirSync(join(root, 'bin'), { mode: 0o755 });
  const exe = join(root, 'bin', 'synthagent');
  writeFileSync(exe, '#!/bin/sh\necho 1.2.3\n', { mode: 0o755 });
  const store = join(dataDir, 'catalog', 'imports.json');
  const o: RootPolicy = { home, allowed: [tmp], denied };
  const offer = (r: GrantRequest, policy = o) => grantOffer(dataDir, bundled, r, policy, KEY);
  /** Offer, then confirm with the offered binding. */
  const grant = (r: GrantRequest, policy = o) => {
    const x = offer(r, policy);
    assert.equal(x.status, 'offer', JSON.stringify(x));
    return confirmGrant(dataDir, bundled, r, x.status === 'offer' ? x.offer.binding : '', policy, KEY);
  };
  const loaded = (policy = o) => loadImports(dataDir, bundled, policy);
  const snap = () => (existsSync(store) ? readFileSync(store).toString('hex') : null);
  return { tmp, home, dataDir, root, exe, store, o, offer, grant, loaded, snap };
}
const ROOT: GrantRequest = { action: 'root', agent: 'synthagent', root: 'user' };
const SETUP: GrantRequest = { action: 'setup', agent: 'synthagent' };
const probe = (file: string): GrantRequest => ({ action: 'probe', agent: 'synthagent', binary: 'main', file });

test('a root offer names the entry, id and exact folder; only a matching confirm approves it, and approves nothing else', () => {
  const w = world();
  const x = w.offer(ROOT);
  assert.equal(x.status, 'offer');
  if (x.status !== 'offer') return;
  assert.equal(x.offer.name, 'Synthetic Agent');
  assert.equal(x.offer.agent, 'synthagent');
  assert.equal(x.offer.id, 'user');
  assert.equal(x.offer.path, w.root);
  assert.equal(x.offer.root, w.root);
  assert.deepEqual([x.offer.argv, x.offer.ops], [null, null]);
  assert.match(x.offer.binding, /^[0-9a-f]{64}$/);
  assert.deepEqual(w.loaded().imported.get('synthagent'), {}, 'an offer writes nothing');
  const before = w.snap();
  assert.deepEqual(confirmGrant(w.dataDir, bundled, ROOT, '0'.repeat(64), w.o, KEY), { status: 'refused', code: 'stale' });
  assert.deepEqual(confirmGrant(w.dataDir, bundled, { ...ROOT, root: 'other' }, x.offer.binding, w.o, KEY), { status: 'refused', code: 'stale' }, 'binding is per request');
  assert.equal(w.snap(), before, 'a refused confirm leaves the store byte-identical');
  assert.deepEqual(confirmGrant(w.dataDir, bundled, ROOT, x.offer.binding, w.o, randomBytes(32)), { status: 'refused', code: 'stale' }, 'another service instance (restart)');
  assert.deepEqual(confirmGrant(w.dataDir, bundled, ROOT, x.offer.binding, w.o, KEY, Date.now() + 11 * 60_000), { status: 'refused', code: 'stale' }, 'expired');
  assert.equal(w.snap(), before);
  assert.deepEqual(confirmGrant(w.dataDir, bundled, ROOT, x.offer.binding, w.o, KEY), { status: 'granted' });
  const l = w.loaded();
  assert.deepEqual(l.imported.get('synthagent'), { user: w.root });
  assert.deepEqual(l.grants.get('synthagent'), [], 'no probe grant');
  assert.deepEqual([...l.setup], [], 'no setup grant');
});

test('offers refuse what cannot be granted: production roots, unknown or bundled ids, missing roots, a corrupt store', () => {
  const w = world();
  assert.deepEqual(w.offer(ROOT, { ...w.o, allowed: [] }), { status: 'refused', code: 'root-unavailable' }, 'production: nothing allowed');
  assert.deepEqual(w.offer(ROOT, { ...w.o, denied: null }), { status: 'refused', code: 'root-unavailable' }, 'no denylist');
  assert.deepEqual(w.offer({ ...ROOT, root: 'nope' }), { status: 'refused', code: 'not-found' });
  assert.deepEqual(w.offer({ ...ROOT, agent: 'claude' }), { status: 'refused', code: 'not-found' }, 'bundled agent');
  assert.deepEqual(w.offer({ ...ROOT, agent: 'nope' }), { status: 'refused', code: 'not-found' });
  assert.deepEqual(w.offer(SETUP), { status: 'refused', code: 'root-not-approved' }, 'setup needs its root approved');
  assert.deepEqual(w.offer(probe(w.exe)), { status: 'refused', code: 'root-not-approved' }, 'probe needs an approved root');
  assert.deepEqual(w.offer({ action: 'probe', agent: 'synthagent', binary: 'nope', file: w.exe }), { status: 'refused', code: 'not-found' });
  const plain = world(entry());
  assert.equal(plain.grant(ROOT).status, 'granted');
  assert.deepEqual(plain.offer(SETUP), { status: 'refused', code: 'not-found' }, 'no reportSetup declared');
  chmodSync(w.store, 0o644);
  const before = w.snap();
  assert.deepEqual(w.offer(ROOT), { status: 'refused', code: 'unavailable' }, 'store-corrupt');
  assert.equal(w.snap(), before);
});

test('a probe offer shows the exact executable, its approved root and argv; a changed file between offer and confirm is stale', () => {
  const w = world();
  assert.equal(w.grant(ROOT).status, 'granted');
  const outside = join(w.tmp, 'synthagent');
  writeFileSync(outside, '#!/bin/sh\necho 1\n', { mode: 0o755 });
  assert.deepEqual(w.offer(probe(outside)), { status: 'refused', code: 'executable-invalid' }, 'outside the approved root');
  const misnamed = join(w.root, 'bin', 'other');
  writeFileSync(misnamed, '#!/bin/sh\necho 1\n', { mode: 0o755 });
  assert.deepEqual(w.offer(probe(misnamed)), { status: 'refused', code: 'executable-invalid' }, 'not a declared name');
  const x = w.offer(probe(w.exe));
  assert.equal(x.status, 'offer');
  if (x.status !== 'offer') return;
  assert.equal(x.offer.id, 'main');
  assert.equal(x.offer.path, w.exe);
  assert.equal(x.offer.root, w.root);
  assert.deepEqual(x.offer.argv, [w.exe, '--version']);
  writeFileSync(w.exe, '#!/bin/sh\necho 9.9.9 changed\n', { mode: 0o755 }); // a new FileId
  const before = w.snap();
  assert.deepEqual(confirmGrant(w.dataDir, bundled, probe(w.exe), x.offer.binding, w.o, KEY), { status: 'refused', code: 'stale' });
  assert.equal(w.snap(), before);
  assert.equal(w.grant(probe(w.exe)).status, 'granted');
  const l = w.loaded();
  assert.equal(l.grants.get('synthagent')?.length, 1);
  assert.deepEqual([...l.setup], [], 'a probe grant is not a setup grant');
});

test('a setup offer lists the exact target file and every declared op; it grants setup only', () => {
  const w = world();
  assert.equal(w.grant(ROOT).status, 'granted');
  const x = w.offer(SETUP);
  assert.equal(x.status, 'offer');
  if (x.status !== 'offer') return;
  assert.equal(x.offer.path, join(w.root, 'config.json'));
  assert.equal(x.offer.root, w.root);
  assert.deepEqual(x.offer.ops, [{ pointer: '/xaibo/helper', value: '<report-helper>' }, { pointer: '/xaibo/on', value: 'true' }]);
  assert.equal(confirmGrant(w.dataDir, bundled, SETUP, x.offer.binding, w.o, KEY).status, 'granted');
  const l = w.loaded();
  assert.deepEqual([...l.setup], ['synthagent']);
  assert.deepEqual(l.grants.get('synthagent'), [], 'a setup grant is not a probe grant');
});

test('a changed entry or a moved root between offer and confirm is stale; the store stays byte-identical', () => {
  const w = world();
  const x = w.offer(ROOT);
  assert.equal(x.status, 'offer');
  if (x.status !== 'offer') return;
  const doc = JSON.parse(readFileSync(w.store, 'utf8')) as { entries: { catalog: Catalog }[] };
  doc.entries[0]!.catalog.agents[0]!.displayName = 'Renamed Agent'; // a new entry digest
  writeFileSync(w.store, JSON.stringify(doc));
  const before = w.snap();
  assert.deepEqual(confirmGrant(w.dataDir, bundled, ROOT, x.offer.binding, w.o, KEY), { status: 'refused', code: 'stale' });
  assert.equal(w.snap(), before);

  const v = world();
  const y = v.offer(ROOT);
  assert.equal(y.status, 'offer');
  if (y.status !== 'offer') return;
  renameSync(v.root, join(v.tmp, 'gone'));
  const was = v.snap();
  assert.deepEqual(confirmGrant(v.dataDir, bundled, ROOT, y.offer.binding, v.o, KEY), { status: 'refused', code: 'stale' });
  assert.equal(v.snap(), was);
});

test('revoke: each grant is gone at the next load, idempotently; a root revoke drops the probe and setup grants under it', () => {
  const w = world();
  assert.equal(w.grant(ROOT).status, 'granted');
  assert.equal(w.grant(probe(w.exe)).status, 'granted');
  assert.equal(w.grant(SETUP).status, 'granted');
  assert.equal(revokeGrant(w.dataDir, bundled, 'synthagent', { kind: 'probe', id: 'main' }), 'revoked');
  assert.deepEqual(w.loaded().grants.get('synthagent'), []);
  assert.deepEqual([...w.loaded().setup], ['synthagent'], 'revoking the probe leaves setup');
  assert.equal(revokeGrant(w.dataDir, bundled, 'synthagent', { kind: 'probe', id: 'main' }), 'unchanged');
  assert.equal(revokeGrant(w.dataDir, bundled, 'synthagent', { kind: 'setup' }), 'revoked');
  assert.deepEqual([...w.loaded().setup], []);
  assert.equal(revokeGrant(w.dataDir, bundled, 'synthagent', { kind: 'setup' }), 'unchanged');

  assert.equal(w.grant(probe(w.exe)).status, 'granted');
  assert.equal(w.grant(SETUP).status, 'granted');
  assert.equal(revokeGrant(w.dataDir, bundled, 'synthagent', { kind: 'root', id: 'user' }), 'revoked');
  assert.deepEqual(w.loaded().imported.get('synthagent'), {});
  assert.equal(revokeGrant(w.dataDir, bundled, 'synthagent', { kind: 'root', id: 'user' }), 'unchanged');
  assert.equal(w.grant(ROOT).status, 'granted', 'approved again');
  const l = w.loaded();
  assert.deepEqual(l.grants.get('synthagent'), [], 'no probe grant comes back');
  assert.deepEqual([...l.setup], [], 'no setup grant comes back');
  const doc = JSON.parse(readFileSync(w.store, 'utf8')) as { entries: Record<string, unknown>[] };
  assert.deepEqual(doc.entries[0]!['grants'] ?? [], [], 'removed from the store, not only from the load');
  assert.equal(doc.entries[0]!['setup'], undefined);
});

test('revoke by the stored root path: a root moved away still loses its grants; unknown ids and a corrupt store', () => {
  const w = world();
  assert.equal(w.grant(ROOT).status, 'granted');
  assert.equal(w.grant(probe(w.exe)).status, 'granted');
  assert.equal(w.grant(SETUP).status, 'granted');
  renameSync(w.root, join(w.tmp, 'moved'));
  assert.equal(revokeGrant(w.dataDir, bundled, 'synthagent', { kind: 'root', id: 'user' }), 'revoked');
  const doc = JSON.parse(readFileSync(w.store, 'utf8')) as { entries: Record<string, unknown>[] };
  assert.deepEqual(doc.entries[0]!['roots'], {});
  assert.deepEqual(doc.entries[0]!['grants'] ?? [], []);
  assert.equal(doc.entries[0]!['setup'], undefined);
  assert.equal(revokeGrant(w.dataDir, bundled, 'nope', { kind: 'setup' }), 'not-found');
  assert.equal(revokeGrant(w.dataDir, bundled, 'claude', { kind: 'setup' }), 'not-found', 'bundled agent');
  chmodSync(w.store, 0o644);
  const before = w.snap();
  assert.equal(revokeGrant(w.dataDir, bundled, 'synthagent', { kind: 'setup' }), 'unavailable');
  assert.equal(w.snap(), before, 'a corrupt store is never rewritten');
});

test('grant state per item, without paths: none, approved, granted, stale and unavailable', () => {
  const w = world();
  assert.equal(grantState(w.dataDir, bundled, 'claude', w.o), null, 'bundled agent');
  assert.equal(grantState(w.dataDir, bundled, 'nope', w.o), null);
  const s0 = grantState(w.dataDir, bundled, 'synthagent', w.o);
  assert.deepEqual(s0, { roots: [{ id: 'user', state: 'none' }], probes: [{ binary: 'main', state: 'none' }], setup: { root: 'user', state: 'none' } });
  assert.deepEqual(grantState(w.dataDir, bundled, 'synthagent', { ...w.o, allowed: [] }),
    { roots: [{ id: 'user', state: 'unavailable' }], probes: [{ binary: 'main', state: 'none' }], setup: { root: 'user', state: 'none' } }, 'production');
  assert.equal(w.grant(ROOT).status, 'granted');
  assert.equal(w.grant(probe(w.exe)).status, 'granted');
  assert.equal(w.grant(SETUP).status, 'granted');
  assert.deepEqual(grantState(w.dataDir, bundled, 'synthagent', w.o),
    { roots: [{ id: 'user', state: 'approved' }], probes: [{ binary: 'main', state: 'granted' }], setup: { root: 'user', state: 'granted' } });
  writeFileSync(w.exe, '#!/bin/sh\necho changed 2.0.0\n', { mode: 0o755 });
  assert.deepEqual(grantState(w.dataDir, bundled, 'synthagent', w.o)?.valueOf(),
    { roots: [{ id: 'user', state: 'approved' }], probes: [{ binary: 'main', state: 'stale' }], setup: { root: 'user', state: 'granted' } }, 'executable changed');
  assert.deepEqual(grantState(w.dataDir, bundled, 'synthagent', { ...w.o, allowed: [] }),
    { roots: [{ id: 'user', state: 'stale' }], probes: [{ binary: 'main', state: 'stale' }], setup: { root: 'user', state: 'stale' } }, 'stored, no longer binding');
  assert.ok(!JSON.stringify(grantState(w.dataDir, bundled, 'synthagent', w.o)).includes(w.tmp), 'no paths');
  const plain = world(entry());
  assert.equal((grantState(plain.dataDir, bundled, 'synthagent', plain.o) as { setup: unknown }).setup, null, 'no reportSetup declared');
  chmodSync(w.store, 0o644);
  assert.equal(grantState(w.dataDir, bundled, 'synthagent', w.o), 'unavailable');
});

test('code review L2/nit: an unsearchable folder or a non-string binding refuses, never throws', () => {
  const w = world();
  assert.equal(w.grant(ROOT).status, 'granted');
  assert.equal(w.grant(probe(w.exe)).status, 'granted');
  for (const dir of [join(w.root, 'bin'), w.root]) {
    chmodSync(dir, 0o000);
    try {
      assert.equal(w.offer(probe(w.exe)).status, 'refused', dir);
      assert.doesNotThrow(() => grantState(w.dataDir, bundled, 'synthagent', w.o));
      assert.equal(revokeGrant(w.dataDir, bundled, 'synthagent', { kind: 'probe', id: 'nope' }), 'unchanged');
    } finally { chmodSync(dir, 0o755); }
  }
  assert.deepEqual(confirmGrant(w.dataDir, bundled, ROOT, undefined as unknown as string, w.o, KEY), { status: 'refused', code: 'stale' });
});

test('code review L4: a binding from the previous bucket still confirms (5 to 10 minutes)', () => {
  const w = world();
  const x = w.offer(ROOT);
  assert.equal(x.status, 'offer');
  if (x.status !== 'offer') return;
  assert.deepEqual(confirmGrant(w.dataDir, bundled, ROOT, x.offer.binding, w.o, KEY, Date.now() + 5 * 60_000), { status: 'granted' });
});

test('code review L3: a root revoke drops grants under any earlier stored path of that root, so none revive', () => {
  const w = world();
  assert.equal(w.grant(ROOT).status, 'granted');
  assert.equal(w.grant(probe(w.exe)).status, 'granted');
  const home2 = join(w.tmp, 'home2');
  mkdirSync(join(home2, '.synthagent'), { recursive: true, mode: 0o755 });
  const o2 = { ...w.o, home: home2 };
  assert.equal(w.grant(ROOT, o2).status, 'granted', 'the same root id, now resolving elsewhere');
  assert.equal(revokeGrant(w.dataDir, bundled, 'synthagent', { kind: 'root', id: 'user' }), 'revoked');
  assert.equal(w.grant(ROOT).status, 'granted', 'back at the first home');
  assert.deepEqual(w.loaded().grants.get('synthagent'), [], 'the probe grant under the earlier path is gone');
});

test('code review L4: a root revoke keeps grants under another approved root', () => {
  const two = entry((c) => { c.agents[0]!.profileRoots.push({ id: 'alt', base: 'home', relative: '.synthalt' }); });
  const w = world(two);
  const alt = join(w.home, '.synthalt');
  mkdirSync(join(alt, 'bin'), { recursive: true, mode: 0o755 });
  const exe = join(alt, 'bin', 'synthagent');
  writeFileSync(exe, '#!/bin/sh\necho 1.2.3\n', { mode: 0o755 });
  assert.equal(w.grant(ROOT).status, 'granted');
  assert.equal(w.grant({ action: 'root', agent: 'synthagent', root: 'alt' }).status, 'granted');
  assert.equal(w.grant(probe(exe)).status, 'granted');
  assert.equal(revokeGrant(w.dataDir, bundled, 'synthagent', { kind: 'root', id: 'user' }), 'revoked');
  assert.equal(w.loaded().grants.get('synthagent')?.length, 1, 'the grant under alt stays');
});
