// XAIBO-PROD-556 (P6-T02; EC-73, EC-90, FR-33, D-9, D-19): the Connect plan's retention offers. Claude: a default-selected,
// deselectable increase of cleanupPeriodDays to max(effective, 45) on the claude-retention route; never lowers; managed
// policy wins and is shown; a value Xaibo cannot read is not offered. Disconnect is the FR-32 revert: the prior value back
// (or the key removed) only while Xaibo's value is unchanged, else a conflict that keeps the owner's value. Gemini: not
// offered until S11 runtime-verifies retention. Synthetic temp profiles only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeRetentionOffer, RETENTION_DAYS, retentionOps } from '../../../src/service/catalog/setup-plans.ts';
import { claudeCleanupDays } from '../../../src/service/history/native-availability.ts';
import { targetOf } from '../../../src/service/integrations/connect.ts';
import { apply, ConfigError, plan, readManifest, revert, type Bounds, type Op } from '../../../src/service/config/transaction.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A temp profile, managed-policy dir and data dir; `user`/`managed` are settings.json texts (undefined = no file). */
function setup(o: { user?: string; managed?: string; dropIn?: string } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'xsetup-')));
  dirs.push(base);
  const profile = join(base, 'claude'), managed = join(base, 'managed'), dataDir = join(base, 'data');
  for (const d of [profile, managed, dataDir]) mkdirSync(d);
  const file = join(profile, 'settings.json');
  if (o.user !== undefined) writeFileSync(file, o.user);
  if (o.managed !== undefined) writeFileSync(join(managed, 'managed-settings.json'), o.managed);
  if (o.dropIn !== undefined) { mkdirSync(join(managed, 'managed-settings.d')); writeFileSync(join(managed, 'managed-settings.d', '10-x.json'), o.dropIn); }
  const bounds: Bounds = { root: profile, denied: [join(base, 'denied')] };
  return { profile, managed, dataDir, file, bounds };
}
const connect = (s: ReturnType<typeof setup>) => {
  const offer = claudeRetentionOffer(s.profile, s.managed, readManifest(s.dataDir));
  return apply(plan(s.file, 'claude-retention', retentionOps(offer), s.bounds), { dataDir: s.dataDir, bounds: s.bounds });
};
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
const SET = [{ op: 'set', pointer: '/cleanupPeriodDays', value: 45 }];

test('EC-73 offers: below 45 (unset, lower) is offered from the effective value; 45 or more is never lowered', () => {
  const none = setup();
  assert.deepEqual(claudeRetentionOffer(none.profile, none.managed, []), { offered: true, from: 30, to: 45, layer: 'default', ops: SET }, 'no settings file: the 30-day default');
  const unset = setup({ user: '{"theme":"dark"}\n' });
  assert.deepEqual(claudeRetentionOffer(unset.profile, unset.managed, []), { offered: true, from: 30, to: 45, layer: 'default', ops: SET });
  const lower = setup({ user: '{"cleanupPeriodDays":10}' });
  assert.deepEqual(claudeRetentionOffer(lower.profile, lower.managed, []), { offered: true, from: 10, to: 45, layer: 'user', ops: SET });
  for (const v of [45, 90]) {
    const s = setup({ user: JSON.stringify({ cleanupPeriodDays: v }) });
    assert.deepEqual(claudeRetentionOffer(s.profile, s.managed, readManifest(s.dataDir)), { offered: false, reason: 'enough', days: v }, `${v}`);
  }
  assert.equal(RETENTION_DAYS, 45);
});

test('EC-73 managed policy wins and is shown, lower or higher, in managed-settings.json or a drop-in', () => {
  for (const [o, days] of [[{ user: '{"cleanupPeriodDays":90}', managed: '{"cleanupPeriodDays":7}' }, 7], [{ managed: '{"cleanupPeriodDays":100}' }, 100],
    [{ user: '{"cleanupPeriodDays":10}', managed: '{"cleanupPeriodDays":20}', dropIn: '{"cleanupPeriodDays":12}' }, 12]] as const) {
    const s = setup(o);
    assert.deepEqual(claudeRetentionOffer(s.profile, s.managed, readManifest(s.dataDir)), { offered: false, reason: 'policy', days }, JSON.stringify(o));
  }
  const bad = setup({ user: '{"cleanupPeriodDays":10}', managed: '{"cleanupPeriodDays":"x"}' });
  assert.deepEqual(claudeRetentionOffer(bad.profile, bad.managed, []), { offered: false, reason: 'policy', days: null }, 'a managed value Xaibo cannot read still wins');
  const nul = setup({ user: '{"cleanupPeriodDays":10}', dropIn: '{"cleanupPeriodDays":null}' });
  assert.deepEqual(claudeRetentionOffer(nul.profile, nul.managed, []), { offered: false, reason: 'policy', days: null }, 'review M1: a managed null is the policy layer');
});

test('a value or file Xaibo cannot read is not offered (never a guessed effective value)', () => {
  for (const user of ['{"cleanupPeriodDays":"45"}', '{"cleanupPeriodDays":"60"}', '{"cleanupPeriodDays":0}', '{"cleanupPeriodDays":-3}', '{"cleanupPeriodDays":1.5}',
    '{"cleanupPeriodDays":30.5}', '{"cleanupPeriodDays":1e20}', '{"cleanupPeriodDays":1e300}', '{"cleanupPeriodDays":true}', '{"cleanupPeriodDays":{}}',
    '{"cleanupPeriodDays":null}', '{ not json', '[]']) { // review M1: an explicit null is set, not unset, and never overwritten
    const s = setup({ user });
    assert.deepEqual(claudeRetentionOffer(s.profile, s.managed, readManifest(s.dataDir)), { offered: false, reason: 'unknown', days: null }, user);
  }
  const managedBroken = setup({ user: '{"cleanupPeriodDays":10}', managed: '{ not json' });
  assert.deepEqual(claudeRetentionOffer(managedBroken.profile, managedBroken.managed, []), { offered: false, reason: 'unknown', days: null });
});

test('default-selected; deselected or not offered gives no ops', () => {
  const s = setup({ user: '{"cleanupPeriodDays":10}' });
  const offer = claudeRetentionOffer(s.profile, s.managed, readManifest(s.dataDir));
  assert.deepEqual(retentionOps(offer), SET);
  assert.deepEqual(retentionOps(offer, false), []);
  assert.deepEqual(retentionOps({ offered: false, reason: 'enough', days: 90 }), []);
});

test('Disconnect with the value unchanged: a byte-identical restore, or the prior value back / the key removed when other keys changed', () => {
  const lower = setup({ user: '{\n  "cleanupPeriodDays": 10,\n  "theme": "dark"\n}\n' });
  const before = readFileSync(lower.file);
  const e1 = connect(lower);
  assert.equal(json(lower.file).cleanupPeriodDays, 45);
  assert.equal(readManifest(lower.dataDir)[0]!.route, 'claude-retention');
  assert.deepEqual(revert(e1, { dataDir: lower.dataDir, bounds: lower.bounds }), { result: 'restored', conflicts: [] });
  assert.deepEqual(readFileSync(lower.file), before, 'byte-identical');

  const e2 = connect(lower);
  writeFileSync(lower.file, JSON.stringify({ ...json(lower.file), theme: 'light' }));
  assert.deepEqual(revert(e2, { dataDir: lower.dataDir, bounds: lower.bounds }), { result: 'structural', conflicts: [] });
  assert.deepEqual(json(lower.file), { cleanupPeriodDays: 10, theme: 'light' }, 'the prior value back, the owner change kept');

  const unset = setup({ user: '{"theme":"dark"}' });
  const e3 = connect(unset);
  writeFileSync(unset.file, JSON.stringify({ ...json(unset.file), model: 'm' }));
  assert.deepEqual(revert(e3, { dataDir: unset.dataDir, bounds: unset.bounds }), { result: 'structural', conflicts: [] });
  assert.deepEqual(json(unset.file), { theme: 'dark', model: 'm' }, 'the key Xaibo added is removed');

  const none = setup();
  const e4 = connect(none);
  assert.deepEqual(revert(e4, { dataDir: none.dataDir, bounds: none.bounds }), { result: 'removed', conflicts: [] }, 'a file Xaibo created goes away');
  assert.deepEqual(readManifest(none.dataDir), []);
});

test('Disconnect after the owner changed the value: a conflict, the owner value stays', () => {
  for (const user of ['{"cleanupPeriodDays":10}', '{"theme":"dark"}', undefined]) {
    const s = setup(user === undefined ? {} : { user });
    const e = connect(s);
    writeFileSync(s.file, JSON.stringify({ ...json(s.file), cleanupPeriodDays: 60 }));
    assert.deepEqual(revert(e, { dataDir: s.dataDir, bounds: s.bounds }), { result: 'structural', conflicts: [{ pointer: '/cleanupPeriodDays' }] }, String(user));
    assert.equal(json(s.file).cleanupPeriodDays, 60);
    assert.equal(readManifest(s.dataDir)[0]!.partial, true, 'the conflict stays recorded');
  }
});

test('EC-90: a Gemini profile has no Connect target, so no maxAge offer until S11 runtime-verifies retention', () => {
  // XAIBO-PROD-608: the dead geminiRetentionOffer builder is gone; a Gemini profile has no Connect target, so no plan or offer
  assert.equal(targetOf({ id: '00000000-0000-4000-8000-0000000e9001', agent: 'gemini', root: realpathSync(tmpdir()), origin: 'default' }), null);
});

test('claudeCleanupDays keeps its answers on the layer-aware resolver', () => {
  const cases: [Parameters<typeof setup>[0], number | null][] = [[{}, 30], [{ user: '{"cleanupPeriodDays":10}' }, 10], [{ user: '{"cleanupPeriodDays":10}', managed: '{"cleanupPeriodDays":7}' }, 7],
    [{ user: '{"cleanupPeriodDays":"x"}' }, null], [{ user: '{ bad' }, null], [{ user: '{"cleanupPeriodDays":null}' }, null]]; // review M1: null = no estimate
  for (const [o, days] of cases) { const s = setup(o); assert.equal(claudeCleanupDays(s.profile, s.managed), days, JSON.stringify(o)); }
});

// design review H1: never lowers at the write, whatever the caller passes; H2: one retention entry per settings.json
const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return e instanceof ConfigError ? e.code : String(e); } };
test('the claude-retention route takes only the 45-day set over an absent value or a positive integer below 45', () => {
  const s = setup({ user: '{"cleanupPeriodDays":10}' });
  for (const ops of [[{ op: 'set', pointer: '/theme', value: 'x' }], [{ op: 'set', pointer: '/cleanupPeriodDays', value: 46 }], [{ op: 'set', pointer: '/cleanupPeriodDays', value: 1 }],
    [{ op: 'append', pointer: '/cleanupPeriodDays', value: 45 }], [...SET, ...SET], [...SET, { op: 'set', pointer: '/hooks', value: {} }]] as Op[][]) {
    assert.equal(code(() => plan(s.file, 'claude-retention', ops, s.bounds)), 'retention', JSON.stringify(ops));
  }
  assert.equal(code(() => plan(s.file, 'claude-retention', SET as Op[], s.bounds)), 'ok');
  for (const user of ['{"cleanupPeriodDays":60}', '{"cleanupPeriodDays":45}', '{"cleanupPeriodDays":"x"}', '{"cleanupPeriodDays":null}', '{"cleanupPeriodDays":0}', '{"cleanupPeriodDays":2.5}']) {
    writeFileSync(s.file, user); // the file changed after the offer: the write never lowers or replaces an unreadable value
    assert.equal(code(() => plan(s.file, 'claude-retention', SET as Op[], s.bounds)), 'retention', user);
  }
});

test('one retention entry per settings.json: a second Connect is refused and the offer says connected', () => {
  const s = setup({ user: '{"cleanupPeriodDays":10}' });
  connect(s);
  writeFileSync(s.file, JSON.stringify({ cleanupPeriodDays: 30 })); // the owner lowers it again
  assert.deepEqual(claudeRetentionOffer(s.profile, s.managed, readManifest(s.dataDir)), { offered: false, reason: 'connected', days: 30 });
  assert.equal(code(() => apply(plan(s.file, 'claude-retention', SET as Op[], s.bounds), { dataDir: s.dataDir, bounds: s.bounds })), 'duplicate');
  assert.equal(readManifest(s.dataDir).length, 1);
});

test('design review L1: a manifest entry with an unknown route is refused on revert', () => {
  const s = setup({ user: '{"cleanupPeriodDays":10}' });
  const e = connect(s);
  assert.equal(code(() => revert({ ...e, route: 'bogus' as never }, { dataDir: s.dataDir, bounds: s.bounds })), 'manifest');
});

// code review LOW-1: on a case-insensitive volume a profile path in other letter case is the same settings.json; the offer
// matches the engine's own path resolution (realpath native), so it says connected rather than an offer apply() refuses
test('connected is found for the profile path in other letter case (case-insensitive volumes)', (t) => {
  const s = setup({ user: '{"cleanupPeriodDays":10}' });
  const other = s.profile.replace(/claude$/, 'CLAUDE');
  if (!existsSync(other)) { t.skip('case-sensitive volume'); return; }
  connect(s);
  assert.equal(claudeRetentionOffer(other, s.managed, readManifest(s.dataDir)).offered, false);
  assert.deepEqual(claudeRetentionOffer(other, s.managed, readManifest(s.dataDir)), { offered: false, reason: 'connected', days: 45 });
});

// XAIBO-PROD-560 (P6-T03 part 2b; owner D-P6-07): the Claude Connect route comes from the catalog's connectRoutes, plugin and
// fallback qualified from 2.1.319 with no upper bound; below it, a prerelease, an unknown version or an undetected Claude is
// unverified (null); where a version qualifies both, the plugin wins (D-2); the fallback only where it alone qualifies.
test('2b claudeConnectRoute: D-P6-07 range from 2.1.319, plugin preferred, everything else unverified', async () => {
  const { claudeConnectRoute } = await import('../../../src/service/catalog/setup-plans.ts');
  const { loadCatalog, validateCatalog } = await import('../../../src/service/catalog/validate.ts');
  const cat = loadCatalog();
  const id = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 };
  const det = (version: string | null) => ({ agent: 'claude', state: 'detected' as const, path: '/tmp/xaibo-fixture/claude', version, id, manual: false });
  assert.equal(claudeConnectRoute(cat, det('2.1.319')), 'claude-plugin');
  assert.equal(claudeConnectRoute(cat, det('2.1.322')), 'claude-plugin', 'no upper bound (D-P6-07)');
  assert.equal(claudeConnectRoute(cat, det('3.0.0')), 'claude-plugin');
  for (const v of ['2.1.318', '2.0.999', '2.1.319-beta.1', null]) assert.equal(claudeConnectRoute(cat, det(v)), null, String(v));
  assert.equal(claudeConnectRoute(cat, { agent: 'claude', state: 'not-detected' }), null);
  assert.equal(claudeConnectRoute(cat, undefined), null);
  const claude = cat.agents.find((a) => a.id === 'claude')!;
  const only = (routes: unknown) => ({ ...cat, agents: cat.agents.map((a) => (a.id === 'claude' ? { ...claude, connectRoutes: routes } : a)) });
  const fb = only([{ route: 'claude-settings-fallback', versions: { min: '2.1.319' }, evidence: 'fixture' }]);
  assert.deepEqual(validateCatalog(fb), []);
  assert.equal(claudeConnectRoute(fb as typeof cat, det('2.1.320')), 'claude-settings-fallback');
  // part 2c review H1: a manually chosen executable never gets the plugin route (it would be run); the fallback runs nothing
  assert.equal(claudeConnectRoute(cat, { ...det('2.1.319'), manual: true }), 'claude-settings-fallback');
  assert.notDeepEqual(validateCatalog(only([{ route: 'claude-tee', versions: { min: '2.1.319' }, evidence: 'x' }])), [], 'only the two Connect routes');
  assert.notDeepEqual(validateCatalog(only([{ route: 'claude-plugin', versions: {}, evidence: 'x' }])), [], 'min required');
});
