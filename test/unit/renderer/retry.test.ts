// XAIBO-PROD-438 (D-P4-10; design §6.13 B3): a Retry is disabled while it runs; a failure brings a short notice back,
// and a failed retry says so with the time of the attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failText, retryIdle, retryLabel, retryStep } from '../../../src/renderer/retry.ts';

test('retryStep: start marks busy once; a failure counts and stamps the time; success resets', () => {
  let s = retryStep(retryIdle, { type: 'fail', at: 100 });
  assert.deepEqual(s, { failures: 1, at: 100, busy: false });
  s = retryStep(s, { type: 'start' });
  assert.deepEqual(s, { failures: 1, at: 100, busy: true });
  assert.equal(retryStep(s, { type: 'start' }), s, 'a second activation while busy changes nothing');
  s = retryStep(s, { type: 'fail', at: 200 });
  assert.deepEqual(s, { failures: 2, at: 200, busy: false });
  assert.deepEqual(retryStep(s, { type: 'ok' }), retryIdle);
});

test('failText: short first notice; a failed retry adds Still and the clock time; refresh wording', () => {
  const at = new Date(2026, 0, 2, 14, 32).getTime();
  assert.equal(failText('transcript', 1, at), "Couldn't load transcript");
  assert.equal(failText('transcript', 0, null), "Couldn't load transcript");
  assert.equal(failText('transcript', 2, at), "Still couldn't load transcript · 14:32");
  assert.equal(failText('live sessions', 1, at, 'refresh'), "Couldn't refresh live sessions");
  assert.equal(failText('live sessions', 3, at, 'refresh'), "Still couldn't refresh live sessions · 14:32");
});

test('retryLabel: Retry, or Retrying… while it runs', () => {
  assert.equal(retryLabel(false), 'Retry');
  assert.equal(retryLabel(true), 'Retrying…');
});

// review HIGH: only the first failure and a failure after the user's Retry count; a background reload that fails again
// leaves the notice as it is (no "Still couldn't …" without a retry, no re-announcement).
test('retryStep: a background failure after the first changes nothing; a failed user retry counts', () => {
  const first = retryStep(retryIdle, { type: 'fail', at: 100 });
  assert.equal(retryStep(first, { type: 'fail', at: 200 }), first, 'background failure: same state');
  const retried = retryStep(retryStep(first, { type: 'start' }), { type: 'fail', at: 300 });
  assert.deepEqual(retried, { failures: 2, at: 300, busy: false });
});
