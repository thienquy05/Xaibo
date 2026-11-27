// XAIBO-PROD-620 (P7-T08; FR-20, FR-21): launch templates are bundled catalog data only: an agent carries either a tested
// interactive launch template (whole tokens; placeholders only {id} and {cwd}; never a headless token) with its evidence, or a
// launchDisabled reason. Claude: --session-id {id}, pre-allocated (S7, 2.1.322); Codex: the interactive TUI (S6, 0.160.0); agy:
// disabled. Imported, unknown or Gemini agents are disabled with a reason; headless mode is never an interactive fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogIssues, loadCatalog, type Catalog } from '../../../src/service/catalog/validate.ts';
import { launchTemplate, NOT_VERIFIED } from '../../../src/service/catalog/launch-templates.ts';

const bundled = loadCatalog();
const synth = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'synthetic', 'catalog', 'valid', 'synthagent.json'), 'utf8')) as Catalog;
const withAgent = (extra: Record<string, unknown>) => ({ ...synth, agents: [{ ...synth.agents[0]!, ...extra }] });

test('bundled templates: Claude pre-allocates its id, Codex starts its TUI, agy and others are disabled with a reason', () => {
  assert.deepEqual(launchTemplate(bundled, 'claude'), { args: ['--session-id', '{id}'], preallocatedId: true });
  assert.deepEqual(launchTemplate(bundled, 'codex'), { args: [], preallocatedId: false });
  assert.deepEqual(launchTemplate(bundled, 'agy'), { disabled: 'agy interactive launch not verified' });
  assert.deepEqual(launchTemplate(bundled, 'gemini'), { disabled: NOT_VERIFIED });
  for (const a of bundled.agents) for (const t of a.launch?.args ?? []) assert.doesNotMatch(t, /^(?:-p|--print|exec|--headless)$/, `${a.id}: headless token`);
  // 620 review MEDIUM: every bundled template is pinned here, so a new one (an app-server-like mode, say) needs a reviewed row
  assert.deepEqual(Object.fromEntries(bundled.agents.filter((a) => a.launch).map((a) => [a.id, a.launch!.args])), { claude: ['--session-id', '{id}'], codex: [] });
  assert.deepEqual(catalogIssues(bundled), [], 'the bundled catalog stays valid');
});

test('launch data is bundled only, one of the two, interactive, and pre-allocation needs {id}', () => {
  const launch = { args: ['--session-id', '{id}'], preallocatedId: true, evidence: 'synthetic fixture' };
  assert.deepEqual(catalogIssues(withAgent({ launch })), []);
  assert.deepEqual(catalogIssues(withAgent({ launch }), bundled), [{ code: 'unsafe-value', at: '/agents/0/launch' }], 'an imported entry carries none');
  assert.deepEqual(catalogIssues(withAgent({ launchDisabled: 'x' }), bundled), [{ code: 'unsafe-value', at: '/agents/0/launchDisabled' }]);
  assert.deepEqual(catalogIssues(withAgent({ launch, launchDisabled: 'x' })), [{ code: 'unsafe-value', at: '/agents/0/launchDisabled' }]);
  assert.deepEqual(catalogIssues(withAgent({ launch: { ...launch, args: ['-p', '{id}'] } })), [{ code: 'unsafe-value', at: '/agents/0/launch/args/0' }]);
  assert.deepEqual(catalogIssues(withAgent({ launch: { ...launch, args: [] } })), [{ code: 'unsafe-value', at: '/agents/0/launch/preallocatedId' }]);
  for (const bad of [['--session-id={id}'], ['{session}'], ['a b'], ['$(x)']]) {
    const issues = catalogIssues(withAgent({ launch: { ...launch, args: bad } }));
    assert.ok(issues.length > 0 && issues.every((i) => i.code === 'schema-invalid'), JSON.stringify([bad, issues]));
  }
  assert.ok(catalogIssues(withAgent({ launch: { args: [] } })).some((i) => i.code === 'schema-invalid'), 'evidence required');
});
