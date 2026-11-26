// XAIBO-PROD-592 (P6-T08 slice C; design §6.5.2, D-P6-19): the Add agent wizard model. Six steps; Next only when the step is
// satisfied; a stale scan reply is ignored; a new agent or profile clears what follows; Back never reapplies; the result only
// after an applied preview and a receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidates, canNext, detailKey, importText, openWizard, previewOpen, setUp, receiptEvent, stepKey, STEPS, wizardStep, type Wizard, type WizardEvent } from '../../../src/renderer/agent-map/add-agent.ts';
import type { IntegrationDetail, IntegrationRow } from '../../../src/shared/ipc.ts';

const P = '00000000-0000-4000-8000-0000000aa001', Q = '00000000-0000-4000-8000-0000000aa002';
type Ev = WizardEvent | ((w: Wizard) => WizardEvent);
const run = (w: Wizard, ...evs: Ev[]) => evs.reduce((s, e) => wizardStep(s, typeof e === 'function' ? e(s) : e), w);
const applied = (w: Wizard): WizardEvent => ({ type: 'applied', gen: w.gen }), receipt = (w: Wizard): WizardEvent => ({ type: 'receipt', gen: w.gen });

test('the six steps in design order; it opens scanning on the first', () => {
  assert.deepEqual([...STEPS], ['candidates', 'prerequisites', 'profile', 'preview', 'receipt', 'result']);
  const w = openWizard();
  assert.deepEqual([w.step, w.scan, w.agent, w.profileId, w.applied, w.receipt], ['candidates', 'scanning', null, null, false, false]);
});

test('Next only when the step is satisfied; the result only after an applied preview and a receipt', () => {
  let w = openWizard();
  assert.equal(canNext(w), false, 'no agent chosen');
  assert.equal(wizardStep(w, { type: 'next' }), w, 'refused Next changes nothing');
  w = run(w, { type: 'agent', agent: 'codex' }, { type: 'next' });
  assert.equal(w.step, 'prerequisites');
  w = run(w, { type: 'next' });
  assert.equal(w.step, 'profile');
  assert.equal(run(w, { type: 'next' }).step, 'profile', 'no profile chosen');
  w = run(w, { type: 'profile', profileId: P }, { type: 'next' });
  assert.equal(w.step, 'preview');
  assert.equal(run(w, { type: 'next' }).step, 'preview', 'nothing applied yet');
  assert.equal(run(w, receipt).receipt, false, 'no receipt before the preview applied');
  w = run(w, applied, { type: 'next' });
  assert.equal(w.step, 'receipt');
  assert.equal(run(w, { type: 'next' }).step, 'receipt', 'waiting for a receipt');
  w = run(w, receipt, { type: 'next' });
  assert.equal(w.step, 'result');
  assert.equal(canNext(w), false, 'the last step');
});

test('a stale scan reply is ignored; a rescan returns to the candidates and keeps the chosen agent', () => {
  let w = openWizard();
  const first = w.seq;
  w = run(w, { type: 'rescan' });
  assert.equal(run(w, { type: 'scanned', seq: first, result: { status: 'ready' } }).scan, 'scanning', 'an older reply');
  w = run(w, { type: 'scanned', seq: w.seq, result: { status: 'refused', code: 'rate-limited', retryAfterMs: 3_000 } });
  assert.deepEqual(w.scan, { refused: 'rate-limited', retryAfterMs: 3_000 });
  w = run(w, { type: 'rescan' }, { type: 'scanned', seq: w.seq + 1, result: { status: 'ready' } });
  assert.equal(w.scan, 'ready');
  w = run(w, { type: 'agent', agent: 'codex' }, { type: 'next' }, { type: 'next' }, { type: 'profile', profileId: P }, { type: 'rescan' });
  assert.deepEqual([w.step, w.agent, w.profileId], ['candidates', 'codex', null], 'a rescan clears the profile');
});

test('another agent or profile clears what follows; the same choice changes nothing', () => {
  let w = run(openWizard(), { type: 'agent', agent: 'codex' }, { type: 'next' }, { type: 'next' }, { type: 'profile', profileId: P }, { type: 'next' }, applied);
  assert.equal(w.applied, true);
  assert.equal(run(w, { type: 'profile', profileId: P }), w, 'same profile');
  const other = run(w, { type: 'profile', profileId: Q });
  assert.deepEqual([other.profileId, other.applied, other.receipt], [Q, false, false]);
  const agent = run(w, { type: 'agent', agent: 'claude' });
  assert.deepEqual([agent.agent, agent.profileId, agent.applied], ['claude', null, false]);
});

test('Back never reapplies: an applied preview stays applied when revisited; Back stops at the first step', () => {
  let w = run(openWizard(), { type: 'agent', agent: 'codex' }, { type: 'next' }, { type: 'next' }, { type: 'profile', profileId: P }, { type: 'next' }, applied, { type: 'next' });
  w = run(w, { type: 'back' });
  assert.deepEqual([w.step, w.applied], ['preview', true]);
  assert.equal(run(w, applied), w, 'applied once');
  assert.equal(run(openWizard(), { type: 'back' }).step, 'candidates');
});

test('code review H1: another agent or profile on a later step goes back to where that choice is made', () => {
  const done = run(openWizard(), { type: 'agent', agent: 'codex' }, { type: 'next' }, { type: 'next' }, { type: 'profile', profileId: P }, { type: 'next' }, applied, { type: 'next' }, receipt, { type: 'next' });
  assert.equal(done.step, 'result');
  const p = run(done, { type: 'profile', profileId: Q });
  assert.deepEqual([p.step, p.applied, p.receipt], ['profile', false, false]);
  const a = run(done, { type: 'agent', agent: 'claude' });
  assert.deepEqual([a.step, a.profileId, a.applied], ['prerequisites', null, false]);
  const r = run(done, { type: 'rescan' });
  assert.deepEqual([r.step, r.applied, r.receipt], ['candidates', false, false], 'a rescan from the result');
  const early = run(openWizard(), { type: 'agent', agent: 'codex' }, { type: 'agent', agent: 'claude' });
  assert.equal(early.step, 'candidates', 'an earlier step stays where it is');
});

test('code review M1: an applied or receipt reply for an earlier selection is ignored', () => {
  let w = run(openWizard(), { type: 'agent', agent: 'codex' }, { type: 'next' }, { type: 'next' }, { type: 'profile', profileId: P }, { type: 'next' }, applied, { type: 'next' });
  const oldGen = w.gen;
  w = run(w, { type: 'back' }, { type: 'back' }, { type: 'profile', profileId: Q }, { type: 'next' });
  assert.equal(run(w, { type: 'applied', gen: oldGen }).applied, false, "P's late apply");
  w = run(w, applied, { type: 'next' });
  assert.equal(run(w, { type: 'receipt', gen: oldGen }).receipt, false, "P's late receipt");
  assert.equal(run(w, receipt).receipt, true);
  const onReceipt = run(openWizard(), { type: 'agent', agent: 'codex' }, { type: 'next' }, { type: 'next' }, { type: 'profile', profileId: P }, { type: 'next' }, applied, { type: 'next' });
  assert.equal(run({ ...onReceipt, applied: false }, receipt).receipt, false, 'no receipt on the receipt step without an applied preview');
  const refused = run(openWizard(), (x) => ({ type: 'scanned', seq: x.seq, result: { status: 'refused', code: 'failed' } }));
  assert.deepEqual(refused.scan, { refused: 'failed' });
});

// XAIBO-PROD-593 (P6-T08 slice D): step 1's candidates: one per agent (its detection is the agent's, whatever the profile),
// detected first, then not detected, each in service order; the name and version from the service rows.
test('candidates: one per agent, detected first, names and versions from the rows', () => {
  const row = (agent: string, name: string, state: IntegrationRow['state'], version: string | null, profileId: string | null) => ({
    key: { agent, profileId }, name, profileLabel: null, version, state, reasons: [], lifecycleGaps: [], receipt: null,
    content: { mode: 'unavailable', assurance: 'unavailable', evidence: null, gaps: [] } } as IntegrationRow);
  assert.deepEqual(candidates([
    row('agy', 'Antigravity CLI', 'not-detected', null, null),
    row('claude', 'Claude Code', 'detected', '2.1.332', P), row('claude', 'Claude Code', 'connected', '2.1.332', Q),
    row('codex', 'Codex', 'unsupported-version', '0.170.0', null),
  ]), [
    { agent: 'claude', name: 'Claude Code', version: '2.1.332', detected: true },
    { agent: 'codex', name: 'Codex', version: '0.170.0', detected: true },
    { agent: 'agy', name: 'Antigravity CLI', version: null, detected: false },
  ]);
  assert.deepEqual(candidates([]), []);
});

// XAIBO-PROD-593 (slice D, E2E finding): before a profile is chosen the detail is read through the agent's first listed profile
// (a profile-less key exists only for an agent with no profile); a chosen profile always wins.
test('detailKey: the chosen profile, else the agent\'s first listed profile, else the profile-less key', () => {
  const row = (agent: string, profileId: string | null) => ({ key: { agent, profileId } } as IntegrationRow);
  const rows = [row('claude', P), row('codex', Q), row('codex', P)];
  assert.deepEqual(detailKey(rows, 'codex', null), { agent: 'codex', profileId: Q });
  assert.deepEqual(detailKey(rows, 'codex', P), { agent: 'codex', profileId: P });
  assert.deepEqual(detailKey(rows, 'agy', null), { agent: 'agy', profileId: null });
  assert.deepEqual(detailKey([], 'codex', null), { agent: 'codex', profileId: null });
});

// XAIBO-PROD-593 (slice D, E2E finding): the receipt step learns of a passed Test receipt through a pure mapping read in an
// effect (never a dispatch inside a state updater, which React may replay without it).
test('receiptEvent: a received test on the receipt step is the receipt for the current selection; nothing otherwise', () => {
  const at = run(openWizard(), { type: 'agent', agent: 'codex' }, { type: 'next' }, { type: 'next' }, { type: 'profile', profileId: P }, { type: 'next' }, applied, { type: 'next' });
  const got = { phase: 'received', receipt: { source: 'hook', event: 'Stop', receivedAt: 5 } } as const;
  assert.deepEqual(receiptEvent(got, at), { type: 'receipt', gen: at.gen });
  assert.equal(receiptEvent({ phase: 'waiting', startedAt: 1, until: 2 }, at), null);
  assert.equal(receiptEvent(got, run(at, { type: 'back' })), null, 'not on the receipt step');
  assert.equal(receiptEvent(got, run(at, receipt)), null, 'already received');
});

// XAIBO-PROD-593 (slice D, E2E finding): per-step state (the detail read, the receipt test) belongs to one step of one selection;
// state stamped with another key is treated as absent, so nothing is reset after the owner has already acted.
test('stepKey: changes with the step and with the selection (agent, profile, rescan), not otherwise', () => {
  const w = run(openWizard(), { type: 'agent', agent: 'codex' });
  const k = stepKey(w);
  assert.equal(stepKey(run(w, { type: 'scanned', seq: w.seq, result: { status: 'ready' } })), k, 'a scan reply is not a new step');
  assert.notEqual(stepKey(run(w, { type: 'next' })), k);
  assert.notEqual(stepKey(run(w, { type: 'agent', agent: 'claude' })), k);
  assert.notEqual(stepKey(run(w, { type: 'rescan' })), k);
  const p = run(w, { type: 'next' }, { type: 'next' }, { type: 'profile', profileId: P });
  assert.notEqual(stepKey(run(p, { type: 'profile', profileId: Q })), stepKey(p));
});

// XAIBO-PROD-593 (slice D, E2E finding): the Connect dialog may open only on the preview step, for the chosen profile, before
// anything is applied; a remembered request never reopens it on a later step (a stale modal blocked the receipt step).
test('previewOpen: only on the preview step with a profile and nothing applied yet', () => {
  const at = run(openWizard(), { type: 'agent', agent: 'codex' }, { type: 'next' }, { type: 'next' }, { type: 'profile', profileId: P }, { type: 'next' });
  assert.equal(previewOpen(at), true);
  assert.equal(previewOpen(run(at, applied)), false, 'applied');
  assert.equal(previewOpen(run(at, applied, { type: 'next' })), false, 'the receipt step');
  assert.equal(previewOpen(run(at, { type: 'back' })), false, 'the profile step');
});

// XAIBO-PROD-593 (slice D review M3): only a lifecycle setup counts as applied (a partial apply that left Connect offered does not)
test('setUp: a profile with Xaibo entries and no Connect left to offer; a partial apply is not set up', () => {
  const det = (entries: IntegrationDetail['entries'], state: IntegrationDetail['row']['state'] = 'awaiting-trust') => ({
    row: { key: { agent: 'codex', profileId: P }, name: 'Codex', profileLabel: 'p', version: '0.160.0', state, reasons: [], lifecycleGaps: [], receipt: null,
      content: { mode: 'unavailable', assurance: 'unavailable', evidence: null, gaps: [] } },
    profiles: [{ id: P, label: 'p' }], entries, trustSteps: [], boundary: null, compatibility: [] } as IntegrationDetail);
  const E = '00000000-0000-4000-8000-0000000aae01';
  assert.equal(setUp(det([{ entry: E, route: 'codex-hooks', state: 'connected', reason: null }])), true);
  assert.equal(setUp(det([{ entry: E, route: 'claude-retention', state: 'connected', reason: null }], 'detected')), false, 'hooks not installed: Connect still offered');
  assert.equal(setUp(det([], 'detected')), false);
});

// XAIBO-PROD-595 (P6-T08 slice E part 2): the wizard's import message: the agent id and the restart and grant notes, or the
// codes and pointers (never file content); nothing before a result.
test('importText: imported names the agent, a restart and that nothing is granted; rejected lists codes and pointers', () => {
  assert.equal(importText(null), null);
  assert.equal(importText({ status: 'imported', agent: 'synthagent' }), 'Imported synthagent. Restart Xaibo to list it; importing grants nothing.');
  assert.equal(importText({ status: 'rejected', issues: [{ code: 'shadow', at: '/agents/0/id' }, { code: 'schema-invalid', at: '/agents/0' }] }),
    'Not imported: shadow at /agents/0/id; schema-invalid at /agents/0.');
});
