// XAIBO-PROD-212 (P2-T12, EC-53): hook events by agent version from the catalog. Codex 0.160.0 has the S5-verified set
// without PreModelRequest/PostModelRequest; a version outside every listed range is unverified (null). The newer range
// with model-request hooks is synthetic: no such Codex version is verified. Nothing in src/ depends on those events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capabilities } from '../../src/service/catalog/capabilities.ts';
import { loadCatalog, validateCatalog, type Catalog } from '../../src/service/catalog/validate.ts';

const S5 = ['Interrupt', 'PermissionRequest', 'PostCompact', 'PostToolUse', 'PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop',
  'SubagentStart', 'SubagentStop', 'UserPromptSubmit'];

test('EC-53: bundled Codex 0.160.0 reports the S5 hook set without model-request hooks', () => {
  const c = capabilities(loadCatalog(), 'codex', '0.160.0');
  assert.deepEqual(c && [...c.hookEvents].sort(), S5);
  assert.equal(c?.modelRequestHooks, false);
});

test('EC-53: a newer listed range with both model-request events reports them (synthetic catalog)', () => {
  const base = loadCatalog();
  const codex = base.agents.find((a) => a.id === 'codex')!;
  const synthetic: Catalog = { ...base, agents: [{ ...codex, hookEvents: [
    ...(codex.hookEvents ?? []),
    { versions: { min: '0.170.0' }, events: [...S5, 'PreModelRequest', 'PostModelRequest'], evidence: 'synthetic test range' },
  ] }] };
  assert.deepEqual(validateCatalog(synthetic), []);
  assert.equal(capabilities(synthetic, 'codex', '0.171.2')?.modelRequestHooks, true);
  assert.equal(capabilities(synthetic, 'codex', '0.160.0')?.modelRequestHooks, false);
  const onlyPre: Catalog = { ...base, agents: [{ ...codex, hookEvents: [{ versions: { min: '1.0.0' }, events: ['PreModelRequest'], evidence: 'x' }] }] };
  assert.equal(capabilities(onlyPre, 'codex', '1.2.3')?.modelRequestHooks, false, 'both events are needed');
});

test('EC-53: unverified is null, never an assumed set', () => {
  const c = loadCatalog();
  assert.equal(capabilities(c, 'codex', '0.161.0'), null, 'outside every range');
  assert.equal(capabilities(c, 'codex', '0.159.9'), null);
  assert.equal(capabilities(c, 'codex', null), null, 'no version');
  assert.equal(capabilities(c, 'codex', 'garbage'), null, 'unparsable');
  assert.equal(capabilities(c, 'nope', '0.160.0'), null, 'unknown agent');
  assert.equal(capabilities(c, 'claude', '2.1.319'), null, 'agent without listed hook events');
});

test('EC-53: version ranges compare numerically and are inclusive', () => {
  const base = loadCatalog();
  const codex = base.agents.find((a) => a.id === 'codex')!;
  const c: Catalog = { ...base, agents: [{ ...codex, hookEvents: [{ versions: { min: '0.9.0', max: '0.10.2' }, events: ['Stop'], evidence: 'x' }] }] };
  assert.ok(capabilities(c, 'codex', '0.9.0'));
  assert.ok(capabilities(c, 'codex', '0.10.2'));
  assert.ok(capabilities(c, 'codex', '0.10.0'), '10 > 9 numerically, not as text');
  assert.equal(capabilities(c, 'codex', '0.10.3'), null);
});

test('EC-53: the catalog schema rejects malformed hook-event entries', () => {
  const base = loadCatalog();
  const codex = base.agents.find((a) => a.id === 'codex')!;
  const bad = (hookEvents: unknown) => validateCatalog({ ...base, agents: [{ ...codex, hookEvents }] }).length > 0;
  assert.ok(bad([{ versions: { min: '0.160' }, events: ['Stop'], evidence: 'x' }]), 'version must be x.y.z');
  assert.ok(bad([{ versions: { min: '0.160.0' }, events: ['stop event'], evidence: 'x' }]), 'event names are identifiers');
  assert.ok(bad([{ versions: { min: '0.160.0' }, events: ['Stop'] }]), 'evidence required');
});

test('EC-53: no src file outside the catalog module references the model-request events', () => {
  const src = join(import.meta.dirname, '..', '..', 'src');
  const files = readdirSync(src, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f));
  const users = files.filter((f) => /PreModelRequest|PostModelRequest/.test(readFileSync(join(src, f), 'utf8')));
  assert.deepEqual(users.filter((f) => !f.startsWith(join('service', 'catalog'))), []);
});
