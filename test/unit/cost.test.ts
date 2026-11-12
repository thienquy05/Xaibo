// XAIBO-PROD-210 (P2-T10, EC-95): per-request cost from normalized components and synthetic rates (golden values),
// gaps and qualifiers, and read-time session selection (reported total replaces, children, model filter).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceRequest, selectSessionCost, type CostRow, type UsageIn } from '../../src/service/usage/cost.ts';
import type { ModelList } from '../../src/service/usage/models.ts';
import { ratesFor } from '../../src/service/usage/prices.ts';

const table: ModelList = {
  schemaVersion: 1, revision: 't', currency: 'USD', prices_as_of: '2026-01-01', sources: [{ id: 's', url: 'https://example.com/p', retrieved: '2026-01-01' }],
  models: [
    { id: 'm-a', display_name: 'A', source: 's', prices_verified: true, qualifiers: { service_tier: ['standard'], speed: ['standard'] },
      rates: { input: 3, output: 15, cache_read: 0.3, cache_write: { '5m': 3.75, '1h': 6 } } },
    { id: 'm-b', display_name: 'B', source: 's', prices_verified: true, qualifiers: { service_tier: ['default'] },
      rates: { input: 1, output: 4, cache_read: 0.1 }, tiers: [{ above_prompt_tokens: 1000, rates: { input: 2, output: 8, cache_read: 0.2 } }] },
  ],
};
const A = ratesFor(table, 'claude', 'm-a');
const B = ratesFor(table, 'codex', 'm-b');
const QA = { service_tier: 'standard', speed: 'standard' };
const QB = { service_tier: 'default' };
const claude = (o: Partial<UsageIn> = {}): UsageIn => ({ uncachedInput: 1000, cacheRead: 2000, cacheWrite: 400, cacheWriteClasses: { '5m': 300, '1h': 100 }, output: 500,
  cacheWriteInPrompt: true, ...o });
const codex = (o: Partial<UsageIn> = {}): UsageIn => ({ uncachedInput: 600, cacheRead: 300, cacheWrite: null, cacheWriteClasses: null, output: 100, cacheWriteInPrompt: false, ...o });
const near = (a: number | null, b: number, why = '') => assert.ok(a !== null && Math.abs(a - b) < 1e-12, `${a} != ${b} ${why}`);

test('EC-95: every component priced with its rate and cache-write class (golden)', () => {
  const c = priceRequest(claude(), A, QA);
  near(c.amountUsd, (1000 * 3 + 2000 * 0.3 + 300 * 3.75 + 100 * 6 + 500 * 15) / 1e6);
  assert.equal(c.coverage, 'full');
  assert.deepEqual(c.gaps, []);
  assert.deepEqual(c.applied, A!.rates);
});

test('EC-95: Codex-shaped usage: cache write unverified is a gap, known subtotal kept; tier by prompt size', () => {
  const base = priceRequest(codex(), B, QB);
  near(base.amountUsd, (600 * 1 + 300 * 0.1 + 100 * 4) / 1e6);
  assert.equal(base.coverage, 'partial');
  assert.deepEqual(base.gaps, ['cache_write']);
  const tier = priceRequest(codex({ uncachedInput: 1200 }), B, QB); // prompt 1500 > 1000
  near(tier.amountUsd, (1200 * 2 + 300 * 0.2 + 100 * 8) / 1e6);
  assert.deepEqual(tier.applied, { input: 2, output: 8, cache_read: 0.2 });
  assert.equal(priceRequest(codex({ uncachedInput: null }), B, QB).reason, 'tier-undetermined');
});

test('EC-95: unknown cache-write class, classes not summing, missing rate or missing tokens are gaps', () => {
  const unknownClass = priceRequest(claude({ cacheWriteClasses: { '5m': 300, '2h': 100 } }), A, QA);
  assert.deepEqual(unknownClass.gaps, ['cache_write']);
  near(unknownClass.amountUsd, (1000 * 3 + 2000 * 0.3 + 500 * 15) / 1e6);
  assert.deepEqual(priceRequest(claude({ cacheWriteClasses: { '5m': 300 } }), A, QA).gaps, ['cache_write'], 'classes must account for the total');
  assert.deepEqual(priceRequest(claude({ cacheWriteClasses: null }), A, QA).gaps, ['cache_write']);
  assert.deepEqual(priceRequest(codex({ cacheWrite: 0, cacheWriteInPrompt: true }), B, QB).gaps, [], 'zero needs no rate');
  assert.deepEqual(priceRequest(codex({ cacheWrite: 5, cacheWriteInPrompt: true }), B, QB).gaps, ['cache_write'], 'no cache-write rate in the table');
  const noOutput = priceRequest(claude({ output: null }), A, QA);
  assert.equal(noOutput.coverage, 'partial');
  assert.deepEqual(noOutput.gaps, ['output']);
});

test('EC-95: qualifiers must be listed for the model; unknown or unsupported -> unavailable, never base rates', () => {
  for (const [q, reason] of [[{ ...QA, service_tier: 'priority' }, 'unsupported-service_tier'], [{ service_tier: 'standard' }, 'unknown-speed'],
    [{ ...QA, speed: null }, 'unknown-speed'], [{ ...QA, extra_mode: 'x' }, 'unsupported-extra_mode']] as const) {
    const c = priceRequest(claude(), A, q);
    assert.equal(c.amountUsd, null);
    assert.equal(c.coverage, 'none');
    assert.equal(c.reason, reason);
  }
  assert.equal(priceRequest(codex(), B, {}).reason, 'unknown-service_tier');
});

test('EC-95: no rates -> unavailable, never 0; an all-zero request is exactly 0 only when it is eligible (G2-7)', () => {
  const none = priceRequest(claude(), null, QA, 'unlisted');
  assert.equal(none.amountUsd, null);
  assert.equal(none.reason, 'unpriced-model');
  assert.equal(priceRequest(claude(), null, QA, null).reason, 'model-unavailable');
  const zeros = claude({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, cacheWriteClasses: { '5m': 0, '1h': 0 }, output: 0 });
  assert.deepEqual({ ...priceRequest(zeros, null, {}, 'unlisted') }, { amountUsd: null, coverage: 'none', gaps: [], applied: null, reason: 'unpriced-model' }, 'unknown model stays unavailable');
  assert.equal(priceRequest(zeros, A, { service_tier: 'priority', speed: 'standard' }).reason, 'unsupported-service_tier');
  const zero = priceRequest(zeros, A, QA);
  assert.equal(zero.amountUsd, 0);
  assert.equal(zero.coverage, 'full');
});

const row = (o: Partial<CostRow>): CostRow => ({ basis: 'token_table', amountUsd: 0.1, coverage: 'full', reported: false, child: false, modelId: 'm-a', ...o });

test('EC-95: session total = sum of request estimates; partial and unavailable coverage', () => {
  near(selectSessionCost([row({}), row({ amountUsd: 0.2, modelId: 'm-b' })]).amountUsd, 0.3);
  assert.equal(selectSessionCost([row({}), row({ amountUsd: 0.2 })]).coverage, 'full');
  const partial = selectSessionCost([row({}), row({ amountUsd: null, coverage: 'none' }), row({ amountUsd: 0.05, coverage: 'partial' })]);
  near(partial.amountUsd, 0.15);
  assert.equal(partial.coverage, 'partial');
  assert.deepEqual(selectSessionCost([row({ amountUsd: null, coverage: 'none' })]), { amountUsd: null, basis: 'token_table', coverage: 'unavailable', opaqueExcluded: false });
  assert.equal(selectSessionCost([]).amountUsd, null, 'no usage: unavailable, not 0');
});

test('EC-95: an agent-reported session estimate replaces the calculated total; children not added; zero stays zero', () => {
  const rep = selectSessionCost([row({ amountUsd: 0.9 }), row({ basis: 'agent_reported', reported: true, amountUsd: 0.5, modelId: null })]);
  assert.deepEqual(rep, { amountUsd: 0.5, basis: 'agent_reported', coverage: 'full', opaqueExcluded: false });
  const withChild = selectSessionCost([row({}), row({ child: true, amountUsd: 0.4 }), row({ basis: 'agent_reported', reported: true, amountUsd: 0.5, modelId: null })]);
  assert.equal(withChild.amountUsd, 0.5, 'child estimate not added to the reported total');
  assert.equal(withChild.coverage, 'uncertain');
  assert.equal(selectSessionCost([row({}), row({ basis: 'agent_reported', reported: true, amountUsd: 0, modelId: null })]).amountUsd, 0);
  near(selectSessionCost([row({}), row({ basis: 'agent_reported', reported: true, amountUsd: null, modelId: null })]).amountUsd, 0.1, 'an unavailable report is not eligible');
  near(selectSessionCost([row({}), row({ child: true, amountUsd: 0.4 })]).amountUsd, 0.5, 'without a reported total, child requests are their own requests');
});

test('EC-95: a model filter uses attributable request rows only; an opaque reported total is never prorated', () => {
  const rows = [row({}), row({ amountUsd: 0.2, modelId: 'm-b' }), row({ basis: 'agent_reported', reported: true, amountUsd: 0.5, modelId: null })];
  const f = selectSessionCost(rows, { modelId: 'm-b' });
  near(f.amountUsd, 0.2);
  assert.equal(f.opaqueExcluded, true);
  assert.equal(selectSessionCost(rows, { modelId: 'none' }).amountUsd, null);
});
