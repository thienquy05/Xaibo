// XAIBO-PROD-574 (P6-T10 unit 2a; FR-06; design .handoff/p6-t10-design.md section 1 "Derive FR-06", review R2/R3/R7):
// the integration state of one agent/profile from its evidence, in the design order, with named reasons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveState, type StateInput } from '../../src/service/integrations/state.ts';

const base: StateInput = { agent: 'claude', detection: { state: 'detected', version: '2.1.332' }, qualified: true, profile: true,
  entries: ['connected'], blocked: false, trust: null, receipt: true, gaps: [], content: 'verified' };
const d = (o: Partial<StateInput>) => deriveState({ ...base, ...o });

test('not detected wins over everything, with the probe reason when there is one', () => {
  assert.deepEqual(d({ detection: { state: 'not-detected' } }), { state: 'not-detected', reasons: ['no-executable'] });
  assert.deepEqual(d({ detection: { state: 'not-detected', reason: 'probe-not-granted' }, entries: ['drifted'] }), { state: 'not-detected', reasons: ['probe-not-granted'] });
});

test('unknown or unqualified version is unsupported', () => {
  assert.deepEqual(d({ detection: { state: 'detected', version: null } }), { state: 'unsupported-version', reasons: ['version-unknown'] });
  assert.deepEqual(d({ qualified: false }), { state: 'unsupported-version', reasons: ['version-unqualified'] });
});

test('no profile or nothing installed is Detected', () => {
  assert.deepEqual(d({ profile: false }), { state: 'detected', reasons: ['no-profile'] });
  assert.deepEqual(d({ entries: [] }), { state: 'detected', reasons: ['not-connected'] });
});

test('setup required names its blockers: unreadable evidence, drift, external removal, pending recovery; blocked hooks are partial coverage', () => {
  assert.deepEqual(d({ entries: 'unavailable' }), { state: 'setup-required', reasons: ['evidence-unavailable'] });
  assert.deepEqual(d({ entries: ['connected', 'drifted'] }), { state: 'setup-required', reasons: ['drifted'] });
  assert.deepEqual(d({ entries: ['disconnected-externally', 'pending-recovery', 'disconnected-externally'] }), { state: 'setup-required', reasons: ['disconnected-externally', 'pending-recovery'] });
  assert.deepEqual(d({ entries: ['unreadable'] }), { state: 'setup-required', reasons: ['unreadable'] });
  // D-P6-19 (2): a known hooks block is Partial coverage (files only), never Connected
  assert.deepEqual(d({ blocked: true }), { state: 'partial-coverage', reasons: ['hooks-blocked'] });
});

test('installed but unproven: Codex awaits trust; others wait for a lifecycle receipt', () => {
  assert.deepEqual(d({ agent: 'codex', trust: 'awaiting-trust', receipt: false }), { state: 'awaiting-trust', reasons: ['no-receipt'] });
  assert.deepEqual(d({ receipt: false }), { state: 'setup-required', reasons: ['waiting-for-receipt'] });
});

test('a receipt with named limits is Partial coverage; without them Connected', () => {
  assert.deepEqual(d({ gaps: ['spool-overflow'] }), { state: 'partial-coverage', reasons: ['hook-gap'] });
  assert.deepEqual(d({ content: 'unavailable' }), { state: 'partial-coverage', reasons: ['content-unavailable'] });
  assert.deepEqual(d({}), { state: 'connected', reasons: [] });
  assert.deepEqual(d({ agent: 'codex', trust: 'connected' }), { state: 'connected', reasons: [] });
});

test('D-P6-19 (2) and slice C review L3: a hooks block is partial coverage with no receipt, keeps other limits, never hides drift', () => {
  assert.deepEqual(d({ blocked: true, receipt: false }), { state: 'partial-coverage', reasons: ['hooks-blocked'] });
  assert.deepEqual(d({ blocked: true, gaps: ['spool-full'] }), { state: 'partial-coverage', reasons: ['hooks-blocked', 'hook-gap'] });
  assert.deepEqual(d({ blocked: true, entries: ['drifted'] }), { state: 'setup-required', reasons: ['drifted'] });
});
