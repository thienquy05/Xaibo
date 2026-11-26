// XAIBO-PROD-577 (P6-T10 unit 4a; design .handoff/p6-t10-design.md section 2 IntegrationDetail, review R7/R8; design
// §6.5.2): the integration panel's read. One agent/profile: the same FR-06 row as the Agents list, that agent's profiles,
// that profile's reconcile entries, Codex trust steps only while awaiting trust, and the install boundary a Test receipt
// compares against. Strict request/reply contract. Synthetic profiles and deliveries only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/service/store/db.ts';
import { loadCatalog } from '../../src/service/catalog/validate.ts';
import { compatibility } from '../../src/service/catalog/capabilities.ts';
import { parsePortMessage, parsePortRequest } from '../../src/shared/ipc.ts';
import { answerIntegrationDetail, answerIntegrationPage, type PageDeps } from '../../src/service/integrations/state.ts';

const C1 = '00000000-0000-4000-8000-0000000c7701', C2 = '00000000-0000-4000-8000-0000000c7702', X1 = '00000000-0000-4000-8000-0000000c7703', K2 = '00000000-0000-4000-8000-0000000c7704';
const E1 = '00000000-0000-4000-8000-0000000c77e1', E2 = '00000000-0000-4000-8000-0000000c77e2', S = '00000000-0000-4000-8000-0000000c77f1';
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
async function deps(o: Partial<PageDeps> = {}): Promise<PageDeps> {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'xid-')));
  dirs.push(d);
  const db = (await openStore({ file: join(d, 'xaibo.db'), backupDir: join(d, 'b') })).db;
  return {
    db, catalog: loadCatalog(), home: '/tmp/xaibo-fixture/home', now: 10_000,
    detections: [{ agent: 'claude', state: 'detected', path: '/x/claude', version: '2.1.332', id: { dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 }, manual: false },
      { agent: 'codex', state: 'detected', path: '/x/codex', version: '0.160.0', id: { dev: 1, ino: 2, size: 1, mtimeMs: 1, ctimeMs: 1 }, manual: false },
      { agent: 'agy', state: 'not-detected' }],
    profiles: [{ id: C1, agent: 'claude', root: '/tmp/xaibo-fixture/home/.claude', origin: 'default' }, { id: K2, agent: 'claude', root: '/tmp/xaibo-fixture/other/.claude', origin: 'manual' },
      { id: C2, agent: 'codex', root: '/tmp/xaibo-fixture/home/.codex', origin: 'default' }, { id: X1, agent: 'codex', root: '/tmp/xaibo-fixture/other/.codex', origin: 'manual' }],
    reconcile: () => ({ status: 'ready', entries: [{ entry: E1, route: 'claude-settings-fallback', profileId: C1, state: 'connected', cleanup: [], manual: [] },
      { entry: E2, route: 'codex-hooks', profileId: C2, state: 'connected', cleanup: [], manual: [] }] }),
    installedAt: (p) => (p.id === C1 || p.id === C2 ? 1_000 : null),
    trust: (p) => (p.id === C2 ? 'awaiting-trust' : null),
    trustSteps: (p) => (p.id === C2 ? ['Open Codex once in a terminal for this profile.', 'Approve the listed hooks there.'] : ['never shown']),
    policy: () => null,
    ...o,
  };
}
const hook = (d: PageDeps, profile: string, at: number) => d.db.prepare('INSERT INTO hook_delivery (delivery_id, agent, profile_key, native_session_id, event, received_ts, committed_ts, unattributed) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
  .run('d' + at + profile.slice(-2), 'claude', profile, S, 'Stop', at, at);
const ask = (d: PageDeps, key: unknown) => answerIntegrationDetail(d, (parsePortRequest({ v: 1, type: 'integrationDetail', id: 1, key }) as unknown as { key: never }).key);

test('requests: an agent/profile key only, exact keys', () => {
  assert.deepEqual(parsePortRequest({ v: 1, type: 'integrationDetail', id: 4, key: { agent: 'claude', profileId: C1 } }), { v: 1, type: 'integrationDetail', id: 4, key: { agent: 'claude', profileId: C1 } });
  assert.ok(parsePortRequest({ v: 1, type: 'integrationDetail', id: 4, key: { agent: 'agy', profileId: null } }));
  for (const bad of [{ key: { agent: 'claude' } }, { key: { agent: 'Claude!', profileId: C1 } }, { key: { agent: 'claude', profileId: '/tmp/x' } },
    { key: { agent: 'claude', profileId: C1, root: '/tmp/x' } }, { key: { agent: 'claude', profileId: C1 }, path: '/tmp/x' }, {}]) {
    assert.equal(parsePortRequest({ v: 1, type: 'integrationDetail', id: 4, ...bad }), null, JSON.stringify(bad));
  }
});

test('the detail: the list row, that agent\'s profiles, that profile\'s entries, the boundary; nothing of another profile', async () => {
  const d = await deps();
  hook(d, C1, 5_000);
  hook(d, K2, 6_000); // another Claude profile's delivery never shows here
  const r = ask(d, { agent: 'claude', profileId: C1 });
  assert.equal(r.status, 'ready');
  if (r.status !== 'ready') return;
  const page = answerIntegrationPage(d, { cursor: null, direction: 'next', limit: 10 });
  assert.deepEqual(r.value.row, page.status === 'ready' ? page.value.rows.find((x) => x.key.profileId === C1) : null, 'the same row as the list');
  assert.deepEqual(r.value.row.receipt, { source: 'hook', event: 'Stop', receivedAt: 5_000 });
  assert.deepEqual(r.value.profiles, [{ id: C1, label: 'Default profile' }, { id: K2, label: '/tmp/xaibo-fixture/other/.claude' }]);
  assert.deepEqual(r.value.entries, [{ entry: E1, route: 'claude-settings-fallback', state: 'connected', reason: null }]);
  assert.deepEqual(r.value.trustSteps, [], 'not awaiting trust: no steps');
  assert.equal(r.value.boundary, 1_000);
  assert.equal(r.observedAt, 10_000);
  assert.ok(parsePortMessage({ v: 1, type: 'integrationDetail', id: 1, result: r }), 'the reply passes the renderer parser');
  const other = ask(d, { agent: 'claude', profileId: K2 });
  assert.deepEqual(other.status === 'ready' ? [other.value.row.state, other.value.entries, other.value.boundary] : null, ['detected', [], null]);
});

test('Codex awaiting trust carries its trust steps; a profile-less agent has a detail with no profiles', async () => {
  const d = await deps();
  const r = ask(d, { agent: 'codex', profileId: C2 });
  assert.deepEqual(r.status === 'ready' ? [r.value.row.state, r.value.trustSteps] : null, ['awaiting-trust', ['Open Codex once in a terminal for this profile.', 'Approve the listed hooks there.']]);
  const agy = ask(d, { agent: 'agy', profileId: null });
  assert.deepEqual(agy.status === 'ready' ? [agy.value.row.state, agy.value.profiles, agy.value.entries, agy.value.boundary] : null, ['not-detected', [], [], null]);
});

// found by the unit 4b E2E: Codex's change boundary carries a file's fractional mtime; the reply still parses, rounded up so a
// receipt from before the true boundary never counts
test('a fractional install boundary is rounded up and the reply parses', async () => {
  const d = await deps({ installedAt: (p) => (p.id === C1 ? 1_000.4 : null) });
  const r = ask(d, { agent: 'claude', profileId: C1 });
  assert.equal(r.status === 'ready' ? r.value.boundary : null, 1_001);
  assert.ok(M(r), 'the renderer parser accepts it');
});

test('refusals: unknown key, a null profile for an agent with profiles, starting, no catalog, a throw', async () => {
  assert.deepEqual(ask(await deps(), { agent: 'claude', profileId: '00000000-0000-4000-8000-0000000c77ff' }), { status: 'refused', code: 'not-found' });
  assert.deepEqual(ask(await deps(), { agent: 'claude', profileId: null }), { status: 'refused', code: 'not-found' }, 'never an invented profile');
  assert.deepEqual(ask(await deps({ profiles: null }), { agent: 'claude', profileId: C1 }), { status: 'refused', code: 'starting' });
  assert.deepEqual(ask(await deps({ catalog: null }), { agent: 'claude', profileId: C1 }), { status: 'refused', code: 'unavailable' });
  assert.deepEqual(ask(await deps({ reconcile: () => { throw new Error('boom /tmp/x'); } }), { agent: 'claude', profileId: C1 }), { status: 'refused', code: 'failed' });
  const blocked = ask(await deps({ reconcile: () => ({ status: 'blocked', code: 'busy' }) }), { agent: 'claude', profileId: C1 });
  assert.deepEqual(blocked.status === 'ready' ? [blocked.value.row.reasons, blocked.value.entries] : null, [['evidence-unavailable'], []]);
});

const M = (result: unknown) => parsePortMessage({ v: 1, type: 'integrationDetail', id: 1, result });
test('replies: bounded and exact; fixed refusal codes', async () => {
  const d = await deps();
  const ok = ask(d, { agent: 'claude', profileId: C1 });
  assert.ok(M(ok));
  if (ok.status !== 'ready') return;
  const v = ok.value;
  for (const bad of [{ ...v, extra: 1 }, { ...v, trustSteps: Array(9).fill('x') }, { ...v, profiles: Array(257).fill(v.profiles[0]) },
    { ...v, entries: Array(257).fill(v.entries[0]) }, { ...v, entries: [{ ...v.entries[0], state: 'guess' }] }, { ...v, entries: [{ ...v.entries[0], target: '/tmp/x' }] },
    { ...v, profiles: [{ id: 'x', label: 'y' }] }, { ...v, boundary: -1 }]) {
    assert.equal(M({ ...ok, value: bad }), null, JSON.stringify(bad).slice(0, 120));
  }
  // code review L3: the fields agree with each other
  assert.equal(M({ ...ok, value: { ...v, trustSteps: ['Approve them in Codex.'] } }), null, 'trust steps only while awaiting trust');
  assert.equal(M({ ...ok, value: { ...v, profiles: [] } }), null, "the row's own profile is listed");
  const agy = ask(d, { agent: 'agy', profileId: null });
  if (agy.status === 'ready') {
    assert.equal(M({ ...agy, value: { ...agy.value, boundary: 5 } }), null, 'no boundary without a profile');
    assert.equal(M({ ...agy, value: { ...agy.value, entries: v.entries } }), null, 'no entries without a profile');
  }
  assert.ok(M({ status: 'refused', code: 'not-found' }));
  assert.equal(M({ status: 'refused', code: 'boom: /tmp/x' }), null);
});

// XAIBO-PROD-591 (P6-T08 slice B; EC-79, US-8): the detail carries that agent's compatibility labels for its detected version
// (catalog/capabilities.ts), bounded on the wire; unverified is never shown as supported.
test('P6-T08: the detail carries the compatibility labels for the detected version; the reply is bounded', async () => {
  const d = await deps();
  const r = ask(d, { agent: 'codex', profileId: C2 });
  assert.ok(r.status === 'ready');
  assert.deepEqual(r.value.compatibility, compatibility(d.catalog, 'codex', '0.160.0'));
  assert.ok(r.value.compatibility.includes('VS Code extension: unverified for 0.160.0 (not tested)'));
  assert.ok(parsePortMessage({ v: 1, type: 'integrationDetail', id: 1, result: r }));
  const agy = ask(d, { agent: 'agy', profileId: null });
  assert.deepEqual(agy.status === 'ready' ? agy.value.compatibility : null, [], 'no rows, no labels');
  const cl = ask(d, { agent: 'claude', profileId: C1 }); // code review L4: every bundled agent's labels cross the wire
  assert.ok(cl.status === 'ready' && cl.value.compatibility.length > 0 && parsePortMessage({ v: 1, type: 'integrationDetail', id: 1, result: cl }));
  const over = (compat: unknown) => parsePortMessage({ v: 1, type: 'integrationDetail', id: 1, result: { ...r, value: { ...r.value, compatibility: compat } } });
  assert.equal(over(Array.from({ length: 17 }, () => 'x')), null, 'at most 16 lines');
  assert.equal(over(['x'.repeat(257)]), null, 'at most 256 characters a line');
  assert.equal(over([1]), null);
});
