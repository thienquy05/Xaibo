// XAIBO-PROD-589 (P6-T09a slice B; D-P6-12, D-P6-18; design .handoff/p6-t09a-design.md with the fresh review): generic setup
// for a report-v1 agent. Connect previews and applies the agent's declared reportSetup through one fixed FR-32 route,
// report-setup, only with its access (an imported entry: approved root and setup grant; checked at preview before any read and
// again at apply before any helper is deployed); Disconnect and Uninstall give the file back byte for byte without needing the
// grant; Xaibo's data dir and a file another route manages are refused; nothing runs. Then the access resolver over the real
// import store, the IPC route list, and the lifecycle receipt from report events. Synthetic disposable profiles only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnect, type ConnectContext } from '../../../src/service/integrations/connect.ts';
import { readManifest, recordEntry } from '../../../src/service/config/transaction.ts';
import { reportOps, setupAccess, type SetupAccess } from '../../../src/service/catalog/setup-plans.ts';
import { approveRoot, grantSetup, importCatalog } from '../../../src/service/catalog/import.ts';
import { loadCatalog, type Catalog, type ReportSetup } from '../../../src/service/catalog/validate.ts';
import { deniedRootsFrom } from '../../../src/service/config/bounds.ts';
import { parseConnectReply, parseRemovalReply } from '../../../src/shared/ipc.ts';
import { openStore } from '../../../src/service/store/db.ts';
import { answerIntegrationPage, type PageDeps } from '../../../src/service/integrations/state.ts';
import type { Profile } from '../../../src/service/catalog/detect.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
// AGENTS.md: nothing here may resolve a real agent home or data dir
const iso = mkdtempSync(join(tmpdir(), 'xreport-env-'));
dirs.push(iso);
for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR']) process.env[k] = join(iso, k.toLowerCase());
const sha = (f: string) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'absent');
const P1 = '00000000-0000-4000-8000-0000000a5e01';

const SETUP: ReportSetup = {
  root: 'user', file: 'config.json', ops: [
    { op: 'set', pointer: '/reporting/xaibo/helper', value: { xaibo: 'report-helper' } },
    { op: 'set', pointer: '/reporting/xaibo/profileKey', value: { xaibo: 'profile-key' } },
    { op: 'set', pointer: '/reporting/xaibo/agentId', value: { xaibo: 'agent-id' } },
    { op: 'set', pointer: '/reporting/enabled', value: { literal: true } },
  ],
};
const ORIGINAL = `${JSON.stringify({ model: 'synthetic', reporting: { enabled: false, interval: 5 } }, null, 4)}\n`;

/** A disposable base (the only allowed root) with the agent's profile root and config, synthetic helpers and a data dir.
 *  access is the resolver's answer, changed by tests; the detection seam throws, so nothing looks up an executable. */
function world(o: { file?: string | null } = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xreport-')));
  dirs.push(base);
  const root = join(base, 'home', '.synthagent'), helpers = join(base, 'helpers'), dataDir = join(base, 'data');
  for (const d of [root, helpers, dataDir]) mkdirSync(d, { recursive: true, mode: 0o755 });
  const file = join(root, 'config.json');
  if (o.file !== null) writeFileSync(file, o.file ?? ORIGINAL, { mode: 0o640 });
  for (const h of ['xaibo-hook', 'xaibo-report', 'xaibo-forwarder', 'xaibo-statusline']) writeFileSync(join(helpers, h), '#!/bin/sh\nexit 0\n');
  const access: { value: SetupAccess | null } = { value: { setup: structuredClone(SETUP), root, granted: true } };
  const ctx: ConnectContext = {
    dataDir, denied: [join(base, 'real')], allowed: [base], claudeManagedDir: join(base, 'managed'), catalog: null, cliPath: null, now: () => 1_000,
    helpers: { hook: join(helpers, 'xaibo-hook'), forwarder: join(helpers, 'xaibo-forwarder'), statusline: join(helpers, 'xaibo-statusline') },
    detection: () => { throw new Error('report setup never looks up an executable'); },
    setupAccess: (agent) => (agent === 'synthagent' ? access.value : null),
  };
  const profile: Profile = { id: P1, agent: 'synthagent', root, origin: 'default' };
  const deployed = () => existsSync(join(dataDir, 'integrations', 'bin', 'xaibo-report'));
  return { base, root, file, dataDir, ctx, access, profile, deployed, c: createConnect(ctx) };
}
type W = ReturnType<typeof world>;
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, any>;
async function connect(w: W) {
  const pv = w.c.previewConnect(w.profile, { retention: true, tee: true });
  assert.equal(pv.status, 'preview', JSON.stringify(pv));
  const r = await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
  return { pv, r };
}

test('reportOps: placeholders become the helper path, profile key and agent id; literals stay as they are', () => {
  assert.deepEqual(reportOps(SETUP, { helper: '/h/xaibo-report', profileKey: P1, agent: 'synthagent' }), [
    { op: 'set', pointer: '/reporting/xaibo/helper', value: '/h/xaibo-report' },
    { op: 'set', pointer: '/reporting/xaibo/profileKey', value: P1 },
    { op: 'set', pointer: '/reporting/xaibo/agentId', value: 'synthagent' },
    { op: 'set', pointer: '/reporting/enabled', value: true },
  ]);
  assert.deepEqual(reportOps({ root: 'user', file: 'c.json', ops: [{ op: 'set', pointer: '/n', value: { literal: null } }, { op: 'set', pointer: '/x', value: { literal: 0 } }] },
    { helper: 'h', profileKey: P1, agent: 'a' }).map((x) => x.value), [null, 0]);
});

test('preview writes nothing; apply writes exactly the declared values; Disconnect gives the file back byte for byte and mode', async () => {
  const w = world();
  const before = sha(w.file), mode = statSync(w.file).mode;
  const pv = w.c.previewConnect(w.profile, { retention: true, tee: true });
  assert.ok(pv.status === 'preview', JSON.stringify(pv));
  assert.deepEqual(pv.steps.map((s) => [s.route, s.target]), [['report-setup', w.file]], 'one step; Claude-only offers ignored');
  assert.deepEqual(pv.steps[0]!.diff.map((d) => d.pointer).sort(), SETUP.ops.map((o) => o.pointer).sort());
  assert.equal(pv.retention, null);
  assert.equal(sha(w.file), before, 'preview wrote nothing');
  assert.equal(w.deployed(), false, 'preview deployed nothing');
  assert.ok(parseConnectReply(pv), 'the IPC accepts a report-setup preview');
  const r = await w.c.applyConnect(pv.previewId);
  assert.equal(r.status, 'applied', JSON.stringify(r));
  assert.ok(parseConnectReply(r));
  const doc = json(w.file);
  assert.deepEqual(doc['reporting'], { enabled: true, interval: 5, xaibo: { helper: join(w.dataDir, 'integrations', 'bin', 'xaibo-report'), profileKey: P1, agentId: 'synthagent' } });
  assert.equal(doc['model'], 'synthetic');
  assert.ok(w.deployed(), 'the report helper is deployed at the path written');
  assert.deepEqual(readManifest(w.dataDir).map((e) => [e.route, e.target]), [['report-setup', w.file]]);
  const rec = w.c.reconcile([w.profile]);
  assert.deepEqual(rec.status === 'ready' && rec.entries.map((e) => [e.route, e.profileId, e.state]), [['report-setup', P1, 'connected']]);

  w.access.value = { ...w.access.value!, granted: false }; // reversal never needs the grant
  const d = await w.c.disconnect(w.profile);
  assert.equal(d.status, 'disconnected', JSON.stringify(d));
  assert.ok(parseConnectReply(d), 'the IPC accepts a report-setup outcome');
  assert.equal(sha(w.file), before);
  assert.equal(statSync(w.file).mode, mode);
  assert.deepEqual(readManifest(w.dataDir), []);
});

test('no config file: apply creates it, Disconnect removes it', async () => {
  const w = world({ file: null });
  const { r } = await connect(w);
  assert.equal(r.status, 'applied', JSON.stringify(r));
  assert.equal(json(w.file)['reporting'].enabled, true);
  assert.equal((await w.c.disconnect(w.profile)).status, 'disconnected');
  assert.equal(existsSync(w.file), false);
});

test('no approved root, another root or no setup grant: refused before the config is read or a helper deployed', () => {
  const w = world();
  chmodSync(w.file, 0o000); // a read would fail as unreadable: these refusals come first
  const cases: [string, SetupAccess | null, string][] = [
    ['root not approved', { setup: structuredClone(SETUP), root: null, granted: true }, 'root-not-approved'],
    ['another root approved', { setup: structuredClone(SETUP), root: join(w.base, 'elsewhere'), granted: true }, 'root-not-approved'],
    ['no setup grant', { setup: structuredClone(SETUP), root: w.root, granted: false }, 'setup-not-granted'],
    ['no reportSetup (not offered)', null, 'unverified'],
  ];
  for (const [why, access, code] of cases) {
    w.access.value = access;
    const pv = w.c.previewConnect(w.profile, { retention: false, tee: false });
    assert.deepEqual(pv, { status: 'refused', code }, why);
    assert.ok(parseConnectReply(pv), `${why}: the IPC accepts the code`);
  }
  chmodSync(w.file, 0o640);
  assert.equal(w.deployed(), false);
  assert.deepEqual(readManifest(w.dataDir), []);
});

test('changed between preview and apply (grant revoked, setup changed, root changed): a fresh preview, nothing deployed or written', async () => {
  for (const [why, change] of [
    ['grant revoked', (w: W) => { w.access.value = { ...w.access.value!, granted: false }; }],
    ['setup changed', (w: W) => { w.access.value = { ...w.access.value!, setup: { ...SETUP, ops: [SETUP.ops[3]!] } }; }],
    ['root approval gone', (w: W) => { w.access.value = { ...w.access.value!, root: null }; }],
  ] as const) {
    const w = world();
    const before = sha(w.file);
    const pv = w.c.previewConnect(w.profile, { retention: false, tee: false });
    assert.equal(pv.status, 'preview');
    change(w);
    const r = await w.c.applyConnect(pv.status === 'preview' ? pv.previewId : '');
    assert.equal(r.status, 'needs-preview', `${why}: ${JSON.stringify(r)}`);
    assert.equal(sha(w.file), before, why);
    assert.equal(w.deployed(), false, `${why}: checked before any helper is deployed`);
    assert.deepEqual(readManifest(w.dataDir), [], why);
  }
});

test("Xaibo's data dir and a file another route manages are refused; a second Connect is a duplicate", async () => {
  const w = world();
  const inData = join(w.dataDir, 'agent');
  mkdirSync(inData, { mode: 0o700 });
  writeFileSync(join(inData, 'config.json'), '{}');
  w.access.value = { ...w.access.value!, root: inData };
  assert.deepEqual(w.c.previewConnect({ ...w.profile, root: inData }, { retention: false, tee: false }), { status: 'refused', code: 'denied-root' });

  w.access.value = { setup: structuredClone(SETUP), root: w.root, granted: true };
  recordEntry(w.dataDir, { id: '00000000-0000-4000-8000-0000000a5ee1', target: w.file, route: 'agy-hooks', state: 'applied', existed: true, preHash: null,
    postHash: sha(w.file), owned: [], created: [], backup: null, at: new Date(0).toISOString() });
  assert.deepEqual(w.c.previewConnect(w.profile, { retention: false, tee: false }), { status: 'refused', code: 'duplicate' });

  const v = world();
  assert.equal((await connect(v)).r.status, 'applied');
  assert.deepEqual(v.c.previewConnect(v.profile, { retention: false, tee: false }), { status: 'refused', code: 'duplicate' });
});

test('code review M1: a native Connect onto a file a report-setup entry manages is refused', async () => {
  const w = world();
  w.access.value = { ...w.access.value!, setup: { ...SETUP, file: 'hooks.json' } };
  assert.equal((await connect(w)).r.status, 'applied');
  const codex: Profile = { id: '00000000-0000-4000-8000-0000000a5e03', agent: 'codex', root: w.root, origin: 'manual' };
  const before = sha(join(w.root, 'hooks.json'));
  assert.deepEqual(w.c.previewConnect(codex, { retention: false, tee: false }), { status: 'refused', code: 'duplicate' });
  assert.equal(sha(join(w.root, 'hooks.json')), before);
});

test('code review M2: a declared file reached through a linked folder is never a target (Disconnect would miss its entry)', () => {
  const w = world();
  mkdirSync(join(w.root, 'sub'));
  symlinkSync(join(w.root, 'sub'), join(w.root, 'link'));
  w.access.value = { ...w.access.value!, setup: { ...SETUP, file: 'link/config.json' } };
  assert.deepEqual(w.c.previewConnect(w.profile, { retention: false, tee: false }), { status: 'refused', code: 'unverified' });
  assert.equal(existsSync(join(w.root, 'sub', 'config.json')), false);
  w.access.value = { ...w.access.value!, setup: { ...SETUP, file: 'sub/config.json' } };
  assert.equal(w.c.previewConnect(w.profile, { retention: false, tee: false }).status, 'preview', 'a real nested folder is fine');
});

test('code review nit: a report preview with the tee selected does not need the status-line helper', () => {
  const w = world();
  rmSync(join(w.base, 'helpers', 'xaibo-statusline'));
  assert.equal(w.c.previewConnect(w.profile, { retention: true, tee: true }).status, 'preview');
});

test('Full Uninstall reverts a report-setup entry after the catalog entry and its access are gone', async () => {
  const w = world();
  const before = sha(w.file);
  assert.equal((await connect(w)).r.status, 'applied');
  w.access.value = null;
  const u = await w.c.uninstall();
  assert.equal(u.status, 'disconnected', JSON.stringify(u));
  assert.equal(sha(w.file), before);
  const pv = w.c.previewRemoval([w.profile], null);
  assert.ok(pv.status === 'refused' && parseRemovalReply('removalPreview', pv));
});

// the access resolver over the real private import store (boot wiring calls it per Connect call, never a cached copy)
const bundled: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((a) => ({ ...a, detection: { ...a.detection, locations: ['~/.local/bin'] } })) };
const SYNTH = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'synthetic', 'catalog', 'valid', 'synthagent.json'), 'utf8')) as Catalog;
test('setupAccess: imported entries need an approved root and a setup grant; bundled report-only entries are catalog-authorized', () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xreport-access-')));
  dirs.push(base);
  const home = join(base, 'home'), dataDir = join(base, 'data');
  mkdirSync(home);
  mkdirSync(dataDir, { mode: 0o700 });
  const o = { home, allowed: [base], denied: deniedRootsFrom({ PATH: '/nonexistent-xaibo' })! };
  const c = structuredClone(SYNTH);
  c.agents[0]!.reportSetup = SETUP;
  assert.equal(setupAccess(dataDir, bundled, 'synthagent', o), null, 'nothing imported');
  assert.equal(importCatalog(dataDir, Buffer.from(JSON.stringify(c)), bundled).status, 'imported');
  assert.deepEqual(setupAccess(dataDir, bundled, 'synthagent', o), { setup: SETUP, root: null, granted: false });
  const root = join(home, '.synthagent');
  mkdirSync(root);
  assert.equal(approveRoot(dataDir, bundled, 'synthagent', 'user', o), true);
  assert.deepEqual(setupAccess(dataDir, bundled, 'synthagent', o), { setup: SETUP, root, granted: false });
  assert.equal(grantSetup(dataDir, bundled, 'synthagent', o), true);
  assert.deepEqual(setupAccess(dataDir, bundled, 'synthagent', o), { setup: SETUP, root, granted: true });
  assert.equal(setupAccess(dataDir, bundled, 'claude', o), null, 'a bundled agent without reportSetup');
  const withBundled: Catalog = { ...bundled, agents: [...bundled.agents, { ...c.agents[0]!, id: 'bundledreport', profileRoots: [{ id: 'user', base: 'home', relative: '.bundledreport' }] }] };
  assert.deepEqual(setupAccess(dataDir, withBundled, 'bundledreport', o), { setup: SETUP, root: join(home, '.bundledreport'), granted: true });
});

// receipt: report-setup is a lifecycle install; a report lifecycle event after it is the receipt; content and usage are not
test('a report lifecycle delivery after setup is the receipt; an earlier one, content.upsert or usage.snapshot are not', async () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'xreport-db-')));
  dirs.push(d);
  const db = (await openStore({ file: join(d, 'xaibo.db'), backupDir: join(d, 'b') })).db;
  let n = 0;
  const report = (event: string, at: number, profile = P1) => db.prepare(`INSERT INTO report_delivery (registration_id, delivery_id, agent, profile_key, native_session_id, event,
    producer_id, producer_seq, received_ts, committed_ts) VALUES ('reg', ?, 'synthagent', ?, 's1', ?, 'p', ?, ?, ?)`).run('d' + n, profile, event, n++, at, at);
  const c = structuredClone(SYNTH);
  c.agents[0]!.reportSetup = SETUP;
  const deps = (): PageDeps => ({
    db, catalog: { ...bundled, agents: [...bundled.agents, c.agents[0]!] }, home: '/tmp/xaibo-fixture/home', now: 10_000,
    detections: [{ agent: 'synthagent', state: 'detected', path: '/x/synthagent', version: '1.0.0', id: { dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 }, manual: true }],
    profiles: [{ id: P1, agent: 'synthagent', root: '/tmp/xaibo-fixture/home/.synthagent', origin: 'default' }],
    reconcile: () => ({ status: 'ready', entries: [{ entry: P1, route: 'report-setup', profileId: P1, state: 'connected', cleanup: [], manual: [] }] }),
    installedAt: () => 2_000, trust: () => null, policy: () => null, trustSteps: () => [],
  });
  const row = () => { const p = answerIntegrationPage(deps(), { cursor: null, direction: 'next', limit: 10 }); return p.status === 'ready' ? p.value.rows.find((r) => r.key.agent === 'synthagent') : null; };
  report('session.start', 1_000); // before setup
  report('content.upsert', 3_000);
  report('usage.snapshot', 4_000);
  report('turn.end', 5_000, '00000000-0000-4000-8000-0000000a5e02'); // another profile
  assert.equal(row()?.receipt, null);
  assert.equal(row()?.state, 'setup-required');
  assert.deepEqual(row()?.reasons, ['waiting-for-receipt']);
  report('turn.end', 6_000);
  assert.deepEqual(row()?.receipt, { source: 'report', event: 'turn.end', receivedAt: 6_000 });
  assert.equal(row()?.state, 'partial-coverage', 'connected config is not verified content coverage');
});
