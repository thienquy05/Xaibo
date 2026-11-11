// P2-T00: agy usage relationships, booleans only (EC-93/95 inputs for T06/T10). Synthetic numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageRelations } from './facts.ts';

const u = (input_tokens: number, output_tokens: number, thinking_tokens: number, cache_read_tokens: number, total_tokens = input_tokens + output_tokens + thinking_tokens) =>
  ({ input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens });

test('relations hold: total = in + out + thinking, cache read within input, result cumulative over the conversation', () => {
  const r = usageRelations([
    { steps: [u(100, 5, 10, 40), u(130, 3, 0, 100)], result: u(230, 8, 10, 140) },
    { steps: [u(150, 2, 0, 120)], result: u(380, 10, 10, 260) }, // a resume: totals include the earlier run
  ]);
  assert.deepEqual(r, {
    observed: true, totalEqualsInputOutputThinking: true, totalEqualsInputOutput: false,
    cacheReadWithinInput: true, thinkingWithinOutput: false, resultCumulativeOverConversation: true,
  });
});

test('a broken relation in any run is false; a per-run (non-cumulative) result is not cumulative', () => {
  const r = usageRelations([
    { steps: [u(10, 1, 0, 0)], result: u(10, 1, 0, 0) },
    { steps: [u(10, 1, 0, 20)], result: u(10, 1, 0, 20) },
  ]);
  assert.equal(r.cacheReadWithinInput, false);
  assert.equal(r.resultCumulativeOverConversation, false);
  assert.equal(r.totalEqualsInputOutput, true);
  assert.equal(r.thinkingWithinOutput, true);
});

test('no usage observed: nulls, never false', () => {
  assert.deepEqual(usageRelations([]), {
    observed: false, totalEqualsInputOutputThinking: null, totalEqualsInputOutput: null, cacheReadWithinInput: null,
    thinkingWithinOutput: null, resultCumulativeOverConversation: null,
  });
});
