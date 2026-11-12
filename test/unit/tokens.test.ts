// XAIBO-PROD-206 (P2-T06, EC-93, PRD §5.5/§5.6): agent-specific token normalization. Claude components map directly
// (S9/S13); Codex cached ⊂ input and reasoning ⊂ output, cache_write has no established relation (S13) so it stays NULL
// with a gap; Codex cumulative totals form counter segments; rate_limits windows in epoch seconds become ms;
// token_usage_record shape drift is a gap (D-P2-03); agy per D-P2-02 (cache read inside input; reasoning unavailable).
// Missing is NULL, never 0. Values are the synthetic fixtures' (claude usage-basic, codex usage-basic/rate-limits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agyUsage, claudeUsage, codexRateLimits, codexStep, codexUsage, tokenRecordDrift } from '../../src/service/usage/tokens.ts';

const R = 'reported';

test('Claude: four components with 5m/1h cache-write classes; missing keys stay NULL', () => {
  assert.deepEqual(claudeUsage({ input_tokens: 10, cache_creation_input_tokens: 30, cache_read_input_tokens: 100, output_tokens: 20,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 30 }, service_tier: 'standard' }), {
    uncachedInput: 10, cacheRead: 100, cacheWrite: 30, cacheWriteClasses: { '5m': 30, '1h': 0 }, output: 20,
    completeness: { uncachedInput: R, cacheRead: R, cacheWrite: R, output: R },
  });
  assert.deepEqual(claudeUsage({ output_tokens: 7 }), {
    uncachedInput: null, cacheRead: null, cacheWrite: null, cacheWriteClasses: null, output: 7,
    completeness: { uncachedInput: 'missing', cacheRead: 'missing', cacheWrite: 'missing', output: R },
  });
});

test('Codex: cached is inside input, reasoning inside output; cache_write relation unverified -> NULL with a gap', () => {
  assert.deepEqual(codexUsage({ input_tokens: 1500, cached_input_tokens: 1200, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 120, total_tokens: 1800 }), {
    uncachedInput: 300, cacheRead: 1200, cacheWrite: null, cacheWriteClasses: null, output: 300,
    completeness: { uncachedInput: R, cacheRead: R, cacheWrite: 'relation-unverified', output: R },
  });
  const bad = codexUsage({ input_tokens: 10, cached_input_tokens: 20, output_tokens: 1 });
  assert.equal(bad.uncachedInput, null, 'cached above input is never a negative uncached count');
  assert.equal(bad.completeness.uncachedInput, 'missing');
});

test('EC-93: Codex counter segments — duplicate adds nothing, a decrease starts a new segment, never negative', () => {
  const steps: [number, { segment: number; total: number; advanced: boolean }][] = [
    [1200, { segment: 0, total: 1200, advanced: true }],
    [3000, { segment: 0, total: 3000, advanced: true }],
    [3000, { segment: 0, total: 3000, advanced: false }],
    [500, { segment: 1, total: 500, advanced: true }],
    [500, { segment: 1, total: 500, advanced: false }],
    [0, { segment: 2, total: 0, advanced: false }],
  ];
  let prev: { segment: number; total: number } | null = null;
  for (const [total, want] of steps) {
    const got = codexStep(prev, total);
    assert.deepEqual(got, want, `total ${total}`);
    prev = got;
  }
  assert.deepEqual(codexStep(null, 0), { segment: 0, total: 0, advanced: false });
});

test('rate_limits: windows with duration, percent and reset in ms; absent fields stay NULL', () => {
  assert.deepEqual(codexRateLimits({ limit_name: null, primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1767243600 },
    secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1767830400 } }), {
    limitId: null, plan: null, credits: null,
    windows: [{ kind: 'primary', durationMinutes: 300, usedPercent: 12.5, resetsAt: 1767243600000 },
      { kind: 'secondary', durationMinutes: 10080, usedPercent: 40, resetsAt: 1767830400000 }],
  });
  assert.deepEqual(codexRateLimits({ limit_id: 'codex', plan_type: 'plus', primary: { used_percent: 101 } }), {
    limitId: 'codex', plan: 'plus', credits: null, windows: [{ kind: 'primary', durationMinutes: null, usedPercent: 101, resetsAt: null }],
  });
});

test('D-P2-03: token_usage_record shape drift (missing, non-numeric or unknown usage keys) is a gap', () => {
  const u = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 };
  const ok = { thread_id: 't', turn_id: 'u', session_id: 's', root_turn_id: 'u', response_id: 'r', usage: u, turn_token_usage: u, thread_token_usage: u };
  assert.equal(tokenRecordDrift(ok), false);
  assert.equal(tokenRecordDrift({ ...ok, usage: { ...u, new_tokens: 1 } }), true, 'unknown key');
  assert.equal(tokenRecordDrift({ ...ok, usage: { ...u, output_tokens: '1' } }), true, 'non-numeric');
  const { thread_token_usage: _t, ...missing } = ok;
  assert.equal(tokenRecordDrift(missing), true, 'missing object');
  const { total_tokens: _x, ...short } = u;
  assert.equal(tokenRecordDrift({ ...ok, turn_token_usage: short }), true, 'missing key');
});

test('agy (D-P2-02): cache read inside input; cache write unavailable; unknown relationships stay NULL', () => {
  assert.deepEqual(agyUsage({ input_tokens: 120, output_tokens: 30, cache_read_tokens: 80 }), {
    uncachedInput: 40, cacheRead: 80, cacheWrite: null, cacheWriteClasses: null, output: 30,
    completeness: { uncachedInput: R, cacheRead: R, cacheWrite: 'unavailable', output: R },
  });
  const noCache = agyUsage({ input_tokens: 120, output_tokens: 30 });
  assert.deepEqual([noCache.uncachedInput, noCache.cacheRead, noCache.completeness.cacheRead], [null, null, 'missing'], 'input may hold cached tokens');
});
