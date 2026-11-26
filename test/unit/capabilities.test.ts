// XAIBO-PROD-212 (P2-T12, EC-53): hook events by agent version from the catalog. Codex 0.160.0 has the S5-verified set
// without PreModelRequest/PostModelRequest; a version outside every listed range is unverified (null). The newer range
// with model-request hooks is synthetic: no such Codex version is verified. Nothing in src/ depends on those events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capabilities, compatibility } from '../../src/service/catalog/capabilities.ts';
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

// XAIBO-PROD-591 (P6-T08 slice B; EC-79, US-8, D-P6-19): per-version, per-surface compatibility from the Gate 0 S6/S7 matrices,
// bundled catalog data only. A label is verified only for an exact tested release and surface; an unknown, prerelease or
// untested version, or a surface without a row (VS Code, Desktop), says unverified with its reason; never supported.
test('P6-T08: compatibility labels for an exact tested release; unverified otherwise, with the tested versions named', () => {
  const c = loadCatalog();
  const codex = compatibility(c, 'codex', '0.160.0');
  // code review M2: attach and ownership were tested only with --no-daemon; the default shared daemon is untested
  assert.ok(codex.some((l) => /^CLI: history visibility verified, resume verified, live attach unverified, ownership unverified for 0\.160\.0 \(.*shared daemon untested\)/.test(l)), codex.join('\n'));
  assert.ok(codex.some((l) => /^Codex non-interactive \(exec\): history visibility verified, .*for 0\.160\.0 \(listed only with --include-non-interactive\)/.test(l)), codex.join('\n'));
  assert.ok(codex.includes('VS Code extension: unverified for 0.160.0 (not tested)'));
  assert.ok(codex.includes('Desktop app: unverified for 0.160.0 (not tested)'));
  const later = compatibility(c, 'codex', '0.161.0');
  assert.ok(later.every((l) => /: unverified for 0\.161\.0 \((tested on 0\.160\.0|not tested)\)$/.test(l)), later.join('\n'));
  assert.ok(compatibility(c, 'codex', '0.160.0-alpha.1').every((l) => / unverified for 0\.160\.0-alpha\.1 /.test(l)), 'a prerelease is not its release');
  assert.ok(compatibility(c, 'codex', null).every((l) => /: unverified for an unknown version /.test(l)));
  const claude = compatibility(c, 'claude', '2.1.322');
  assert.ok(claude.some((l) => /^Claude print mode \(-p\): history visibility unsupported, resume verified/.test(l)), claude.join('\n'));
  assert.ok(compatibility(c, 'claude', '2.1.332').some((l) => l === 'CLI: unverified for 2.1.332 (tested on 2.1.322)'), 'a newer Claude is not assumed');
  // code review M1: S7 recorded who receives approvals, not ownership; L5: --bg is listed, not exercised
  assert.ok(claude.some((l) => /^CLI: history visibility verified, resume verified, live attach unverified, ownership unverified for 2\.1\.322/.test(l)), claude.join('\n'));
  assert.ok(claude.some((l) => /^Background \(--bg\): history visibility unverified, resume unverified, live attach unverified, ownership unverified for 2\.1\.322/.test(l)), claude.join('\n'));
  assert.ok([...codex, ...claude].every((l) => l.length <= 256), 'every line fits the wire bound');
  assert.deepEqual(compatibility(c, 'agy', '1.0.0'), [], 'no rows, no labels');
  assert.deepEqual(compatibility(null, 'codex', '0.160.0'), []);
  for (const l of [...codex, ...later, ...claude]) assert.ok(!/\bsupported\b/.test(l.replace(/unsupported/g, '')), `never "supported": ${l}`);
});
