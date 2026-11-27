// XAIBO-PROD-571 (P6-T01a slice 2; S-38, FR-54, EC-109; design .handoff/p6-t01a-design.md "State transitions and epoch
// rules", security review 3636): the pure sign-in state machine. Declaration wins (explicit Unknown too); a new usage epoch
// only on an effective method change or a declared account change; absence never; only evidence with a trusted source
// time counts; older evidence never replaces newer; an equal-time disagreement is ambiguous whatever the arrival order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySignIn, MAX_BOUNDARIES, nextSignIn, effectiveMethod, type SignInInput, type SignInState } from '../../../src/service/usage/sign-in-state.ts';
import type { KnownMethod } from '../../../src/service/usage/sign-in.ts';

const NOW = Date.UTC(2026, 10, 25, 12);
const ev = (method: KnownMethod, sourceAt: number | null, over: Partial<Extract<SignInInput, { kind: 'evidence' }>> = {}): SignInInput =>
  ({ kind: 'evidence', result: { kind: 'matched', method, ruleId: 'syn-rule' }, source: 'codex-rollout', version: '0.160.0', sourceAt, ...over });
type Step = ReturnType<typeof nextSignIn>;
const ok = (r: Step) => { assert.ok(!('refused' in r)); return r as Exclude<Step, { refused: string }>; };
const run = (s: SignInState, ...inputs: [SignInInput, number?][]) => inputs.reduce((st, [i, now]) => ok(nextSignIn(st, i, now ?? NOW)).state, s);

test('untouched profile: Unknown, generation 0, no times', () => {
  const s = emptySignIn();
  assert.equal(effectiveMethod(s), 'unknown');
  assert.deepEqual([s.revision, s.generation, s.declaration, s.evidence, s.boundaryAt], [0, 0, null, null, null]);
});

test('declaration: a different method starts an epoch; the same again is a no-op keeping its time; explicit Unknown wins too', () => {
  const s0 = emptySignIn();
  const r1 = ok(nextSignIn(s0, { kind: 'declare', method: 'subscription' }, NOW));
  assert.deepEqual([effectiveMethod(r1.state), r1.state.generation, r1.state.revision, r1.state.declaration], ['subscription', 1, 1, { method: 'subscription', at: NOW }]);
  assert.deepEqual(r1.boundary, { generation: 1, at: NOW, reason: 'method', method: 'subscription' });
  const r2 = ok(nextSignIn(r1.state, { kind: 'declare', method: 'subscription' }, NOW + 1000));
  assert.equal(r2.state, r1.state, 'no-op: same object, revision and time unchanged');
  assert.equal(r2.boundary, null);
  const r3 = ok(nextSignIn(r1.state, { kind: 'declare', method: 'unknown' }, NOW + 2000));
  assert.deepEqual([effectiveMethod(r3.state), r3.state.generation, r3.boundary?.method], ['unknown', 2, 'unknown']);
  assert.equal(ok(nextSignIn(s0, { kind: 'declare', method: 'unknown' }, NOW)).boundary, null, 'explicit Unknown on an untouched profile changes no epoch');
});

test('declaration overrides output evidence; a conflict keeps both with their times', () => {
  const s = run(emptySignIn(), [ev('api-key', NOW - 60_000)], [{ kind: 'declare', method: 'subscription' }, NOW + 5]);
  assert.equal(effectiveMethod(s), 'subscription');
  assert.deepEqual([s.evidence?.method, s.evidence?.observedAt, s.evidence?.sourceAt, s.declaration?.at], ['api-key', NOW, NOW - 60_000, NOW + 5]);
  const before = s.generation;
  const s2 = run(s, [ev('gateway', NOW + 1000), NOW + 2000]);
  assert.deepEqual([effectiveMethod(s2), s2.generation, s2.evidence?.method], ['subscription', before, 'gateway'], 'evidence under a declaration starts no epoch');
});

test('clearing: back to differing evidence starts an epoch; to nothing never does, and the old baseline is remembered', () => {
  const decl = run(emptySignIn(), [{ kind: 'declare', method: 'subscription' }]);
  const toNothing = ok(nextSignIn(decl, { kind: 'clear' }, NOW + 1));
  assert.deepEqual([effectiveMethod(toNothing.state), toNothing.boundary, toNothing.state.generation], ['unknown', null, 1]);
  const sameAgain = ok(nextSignIn(toNothing.state, ev('subscription', NOW), NOW + 2));
  assert.equal(sameAgain.boundary, null, 'absence did not reset the baseline, so the same method is no change');
  const withEvidence = run(emptySignIn(), [ev('api-key', NOW - 10)], [{ kind: 'declare', method: 'subscription' }]);
  const back = ok(nextSignIn(withEvidence, { kind: 'clear' }, NOW + 3));
  assert.deepEqual([effectiveMethod(back.state), back.boundary?.reason, back.boundary?.method], ['api-key', 'method', 'api-key']);
  assert.equal(ok(nextSignIn(emptySignIn(), { kind: 'clear' }, NOW)).state.revision, 0, 'clearing nothing is a no-op');
});

test('declared account change: always one epoch, method and declaration unchanged', () => {
  const s = run(emptySignIn(), [{ kind: 'declare', method: 'subscription' }]);
  const r = ok(nextSignIn(s, { kind: 'account-change' }, NOW + 10));
  assert.deepEqual([r.state.generation, r.boundary?.reason, r.boundary?.method, effectiveMethod(r.state), r.state.declaration], [2, 'declared-account', 'subscription', 'subscription', s.declaration]);
  assert.equal(ok(nextSignIn(emptySignIn(), { kind: 'account-change' }, NOW)).boundary?.method, 'unknown');
});

test('evidence: only matched results with a trusted source time count (review H1)', () => {
  const s = emptySignIn();
  for (const sourceAt of [null, NaN, Infinity, 1.5, -1, Date.UTC(2019, 11, 31), NOW + 5 * 60_000 + 1]) {
    assert.equal(ok(nextSignIn(s, ev('subscription', sourceAt as number), NOW)).state, s, String(sourceAt));
  }
  assert.equal(ok(nextSignIn(s, ev('subscription', NOW + 5 * 60_000), NOW)).state.evidence?.method, 'subscription', 'within the skew allowance');
  for (const reason of ['no-signal', 'unsupported-version', 'unsupported-surface'] as const) {
    assert.equal(ok(nextSignIn(s, { ...ev('subscription', NOW), result: { kind: 'unknown', reason } } as SignInInput, NOW)).state, s, reason);
  }
  for (const bad of [{ version: null }, { version: '0.160' }, { version: '/tmp/xaibo-fixture/v' }, { version: 'v'.repeat(70) }]) {
    assert.equal(ok(nextSignIn(s, ev('subscription', NOW, bad as never), NOW)).state, s, JSON.stringify(bad));
  }
  assert.equal(ok(nextSignIn(s, ev('subscription', NOW, { result: { kind: 'matched', method: 'subscription', ruleId: 'Bad Id 1' } }), NOW)).state, s);
});

test('evidence ordering: older never replaces newer; newer same method advances only the watermark; newer different method replaces', () => {
  const s = run(emptySignIn(), [ev('subscription', NOW - 1000)]);
  assert.equal(s.generation, 1);
  assert.equal(ok(nextSignIn(s, ev('api-key', NOW - 2000), NOW + 1)).state, s, 'older evidence is ignored');
  const same = ok(nextSignIn(s, ev('subscription', NOW - 500), NOW + 2)).state;
  assert.deepEqual([same.evidence?.orderAt, same.evidence?.sourceAt, same.evidence?.observedAt, same.generation], [NOW - 500, NOW - 1000, NOW, 1]);
  const diff = ok(nextSignIn(same, ev('api-key', NOW - 100), NOW + 3));
  assert.deepEqual([diff.state.evidence?.method, diff.state.evidence?.observedAt, diff.boundary?.method, diff.state.generation], ['api-key', NOW + 3, 'api-key', 2]);
  const replayOld = ok(nextSignIn(diff.state, ev('subscription', NOW - 1000), NOW + 4));
  assert.equal(replayOld.state, diff.state, 'A -> B -> replay A changes nothing');
});

test('equal-time disagreement is ambiguous in either arrival order; ambiguous evidence gives no method and no epoch (review M1)', () => {
  const t = NOW - 1000;
  const ab = run(emptySignIn(), [ev('subscription', t)], [ev('api-key', t), NOW + 1]);
  const ba = run(emptySignIn(), [ev('api-key', t)], [ev('subscription', t), NOW + 1]);
  for (const s of [ab, ba]) assert.deepEqual([s.evidence?.ambiguous, effectiveMethod(s)], [true, 'unknown']);
  assert.equal(ab.generation, ba.generation, 'same number of epochs either way');
  const resolved = run(ab, [ev('gateway', t + 1), NOW + 2]);
  assert.deepEqual([resolved.evidence?.ambiguous, effectiveMethod(resolved)], [false, 'gateway']);
  const ambResult = ok(nextSignIn(run(emptySignIn(), [ev('subscription', t)]), { ...ev('subscription', t + 1), result: { kind: 'unknown', reason: 'ambiguous' } } as SignInInput, NOW + 3)).state;
  assert.deepEqual([ambResult.evidence?.ambiguous, effectiveMethod(ambResult)], [true, 'unknown']);
});

test('boundary times never go backwards (review H1)', () => {
  const s = run(emptySignIn(), [{ kind: 'declare', method: 'subscription' }, NOW]);
  const r = ok(nextSignIn(s, { kind: 'account-change' }, NOW - 3_600_000)); // the wall clock stepped back an hour
  assert.equal(r.boundary?.at, NOW);
  assert.equal(r.state.boundaryAt, NOW);
});

test('an evidence epoch starts at the evidence source time, never before the previous boundary (slice 4)', () => {
  const r = ok(nextSignIn(emptySignIn(), ev('subscription', NOW - 600_000), NOW));
  assert.equal(r.boundary?.at, NOW - 600_000);
  const later = ok(nextSignIn(run(emptySignIn(), [{ kind: 'account-change' }, NOW]), ev('api-key', NOW + 60_000), NOW + 120_000));
  assert.equal(later.boundary?.at, NOW + 60_000, 'after the previous boundary: its own source time');
});

test('an evidence epoch never starts in the future nor before a stored reading (slice-4 review H1)', () => {
  assert.equal(ok(nextSignIn(emptySignIn(), ev('subscription', NOW + 3 * 60_000), NOW)).boundary?.at, NOW);
  assert.equal(ok(nextSignIn(emptySignIn(), ev('subscription', NOW - 600_000), NOW, NOW - 60_000)).boundary?.at, NOW - 60_000, 'raised to the newest stored reading');
});

test('evidence older than the latest boundary is ignored (slice-4 review M2)', () => {
  const s = run(emptySignIn(), [{ kind: 'declare', method: 'gateway' }, NOW], [{ kind: 'clear' }, NOW + 1]);
  assert.equal(ok(nextSignIn(s, ev('subscription', NOW - 1000), NOW + 2)).state, s);
});

test('evidence stops 16 epochs short of the cap, keeping a reserve for the owner (slice-4 review M1)', () => {
  let s = emptySignIn();
  for (let i = 0; i < MAX_BOUNDARIES - 16; i++) s = ok(nextSignIn(s, { kind: 'account-change' }, NOW + i)).state;
  assert.equal(ok(nextSignIn(s, ev('subscription', NOW + 300), NOW + 300)).state, s);
  assert.equal(ok(nextSignIn(s, { kind: 'declare', method: 'subscription' }, NOW + 301)).state.generation, MAX_BOUNDARIES - 15);
});

test('a boundary stored with the clock far ahead does not block later evidence either (slice-4 code review M1)', () => {
  const ahead = run(emptySignIn(), [{ kind: 'declare', method: 'subscription' }, NOW + 365 * 86_400_000], [{ kind: 'clear' }, NOW + 365 * 86_400_000 + 1]);
  assert.equal(ok(nextSignIn(ahead, ev('api-key', NOW - 1000), NOW)).state.evidence?.method, 'api-key');
});

test('a boundary stored while the clock ran far ahead does not pin later ones (code review M1)', () => {
  const ahead = run(emptySignIn(), [{ kind: 'declare', method: 'subscription' }, NOW + 365 * 86_400_000]); // clock a year ahead
  const r = ok(nextSignIn(ahead, { kind: 'account-change' }, NOW)); // clock corrected
  assert.equal(r.boundary?.at, NOW);
});

test('at most MAX_BOUNDARIES epochs per profile (review H2): owner actions are refused, evidence changes nothing', () => {
  let s = emptySignIn();
  for (let i = 0; i < MAX_BOUNDARIES; i++) s = ok(nextSignIn(s, { kind: 'account-change' }, NOW + i)).state;
  assert.equal(s.generation, MAX_BOUNDARIES);
  assert.deepEqual(nextSignIn(s, { kind: 'account-change' }, NOW + 1e6), { refused: 'limit' });
  assert.deepEqual(nextSignIn(s, { kind: 'declare', method: 'subscription' }, NOW + 1e6), { refused: 'limit' });
  assert.equal(ok(nextSignIn(s, ev('subscription', NOW + 1e6), NOW + 1e6)).state, s);
  assert.equal(ok(nextSignIn(s, { kind: 'declare', method: 'unknown' }, NOW + 1e6)).state.revision, s.revision + 1, 'a change that adds no epoch still works');
});
