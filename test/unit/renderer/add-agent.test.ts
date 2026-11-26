// XAIBO-PROD-592 (P6-T08 slice C; design §6.5.2, D-P6-19): the Add agent wizard model. Six steps; Next only when the step is
// satisfied; a stale scan reply is ignored; a new agent or profile clears what follows; Back never reapplies; the result only
// after an applied preview and a receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canNext, openWizard, STEPS, wizardStep, type Wizard, type WizardEvent } from '../../../src/renderer/agent-map/add-agent.ts';

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
