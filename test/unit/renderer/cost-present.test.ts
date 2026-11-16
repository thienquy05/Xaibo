// XAIBO-PROD-417 (P4-T07a; plan P4-T07 U; PRD FR-48, US-18; design §6.3.2, §7.1 Estimated USD): the Cost section's
// words. Every amount has ~ and accessible text starting "Estimated cost"; a null keeps its reason; a reported 0 stays
// ~$0.00; mixed revisions are listed with Prices as of; an owner fallback is labeled; rates are exact table rates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { componentRows, costHeadline, groupTitle, revisionRows, usdText, usdWords } from '../../../src/renderer/workspace/cost/present.ts';
import type { CostComponent, CostDetail, CostGroup } from '../../../src/shared/ipc.ts';

const c = (o: Partial<CostComponent> = {}): CostComponent => ({ name: 'output', tokens: 40, missing: 0, unpriced: 0, rate: 200, rateVaries: false, usd: 0.008, ...o });
const group = (o: Partial<CostGroup> = {}): CostGroup => ({ model: 'Claude Opus 5.5', revision: 2, basis: 'token_table', requests: 2, priced: 2, from: 1, to: 2,
  components: [c({ name: 'uncached_input', tokens: 15, rate: 4, usd: 0.00006 }), c({ name: 'cache_write_1h', tokens: null, missing: 2, rate: null, usd: null }), c()], ...o });
const detail = (o: Partial<CostDetail> = {}): CostDetail => ({ amountUsd: 0.0083, basis: 'token_table', coverage: 'full', reportedUsd: null, requests: 2, priced: 2,
  gaps: [], reasons: [], groups: [group()], more: false,
  revisions: [{ id: 2, label: 'bundled-2026-11', pricesAsOf: '2026-11-01', source: 'bundled', references: ['anthropic: https://example.com/p (retrieved 2026-11-01)'] }], ...o });

test('§7.1 USD: valid zero, <0.01, two decimals half-up, comma grouping; words for screen readers', () => {
  assert.deepEqual([0, 0.004, 4e-7, 0.005, 1.005, 10.005, 1234.567].map(usdText), ['~$0.00', '~$<0.01', '~$<0.01', '~$0.01', '~$1.01', '~$10.01', '~$1,234.57']);
  assert.deepEqual([0, 0.004, 1234.567].map(usdWords), ['0 US dollars', 'less than 0.01 US dollars', '1,234.57 US dollars']);
});

test('headline: calculated full, partial known subtotal, uncertain, and unavailable with its reason (never 0)', () => {
  const full = costHeadline(detail());
  assert.deepEqual([full.value, full.basis, full.coverage], ['~$0.01', 'Calculated from tokens', '2 of 2 requests priced']);
  assert.equal(full.label, 'Estimated cost: 0.01 US dollars; 2 of 2 requests priced');
  const part = costHeadline(detail({ coverage: 'partial', requests: 4, priced: 3, gaps: ['cache_write'], reasons: ['unpriced-model'] }));
  assert.equal(part.value, '~$0.01 known subtotal');
  assert.equal(part.coverage, '3 of 4 requests priced; missing: cache write; model has no verified price');
  assert.match(part.label, /^Estimated cost: 0\.01 US dollars; known subtotal; 3 of 4 requests priced/);
  assert.ok(costHeadline(detail({ coverage: 'uncertain' })).notes.includes('Aggregate coverage uncertain'));
  const none = costHeadline(detail({ amountUsd: null, coverage: 'unavailable', priced: 0, reasons: ['unknown-service_tier'] }));
  assert.equal(none.value, '~$ unavailable');
  assert.equal(none.label, 'Estimated cost unavailable: unknown service tier');
  assert.doesNotMatch(`${none.value} ${none.label}`, /\$0|\b0 US/);
  assert.equal(costHeadline(detail({ amountUsd: null, coverage: 'unavailable', requests: 0, priced: 0, groups: [], revisions: [] })).label,
    'Estimated cost unavailable: no priced usage recorded');
});

test('review M2: an unreadable breakdown keeps the total and says why', () => {
  const h = costHeadline(detail({ groups: [], revisions: [], reasons: ['breakdown-unavailable'], coverage: 'partial' }));
  assert.match(h.coverage, /cost breakdown could not be read/);
  assert.equal(h.value, '~$0.01 known subtotal');
});

test('reported estimate: a reported 0 stays ~$0.00; agent basis notes; never added to the calculated copy', () => {
  const h = costHeadline(detail({ amountUsd: 0, basis: 'agent_reported', reportedUsd: 0 }));
  assert.deepEqual([h.value, h.basis], ['~$0.00', 'Agent-reported estimate']);
  assert.equal(h.label, 'Estimated cost: 0 US dollars; agent-reported estimate');
  assert.deepEqual(h.notes, ['Agent-reported basis; local price revision not applied', 'Component cost unavailable — agent estimate has no split',
    'Calculated components below are not added to the agent estimate']);
});

test('component rows: exact tokens, exact table rate per 1M, ~$ with Estimated cost text on every amount; unavailable keeps its reason', () => {
  const rows = componentRows(group());
  assert.deepEqual(rows.map((r) => r.name), ['Input (uncached)', 'Cache write (1 h)', 'Output']);
  assert.deepEqual(rows.map((r) => [r.tokens, r.rate, r.usd]), [
    ['15', '$4 per 1M tokens', '~$<0.01'], ['Unavailable · 2 requests without this component', 'Rate unavailable', '~$ unavailable'], ['40', '$200 per 1M tokens', '~$0.01']]);
  for (const r of rows) {
    assert.match(r.usd, /^~\$/);
    assert.match(r.label, /^Estimated cost/);
  }
  assert.equal(rows[1]!.label, 'Estimated cost unavailable: Cache write (1 h), no applied rate');
  assert.equal(componentRows(group({ components: [c({ rate: null, rateVaries: true, usd: 0.5 })] }))[0]!.rate, 'Rate varies by tier');
  // review M1: a request priced without this component (unpriced > 0) makes the component a known subtotal
  assert.equal(componentRows(group({ components: [c({ unpriced: 1 })] }))[0]!.usd, '~$0.01 known subtotal');
  assert.equal(componentRows(group({ components: [c({ unpriced: 1 })] }))[0]!.tokens, '40 · 1 request not priced for this component');
  assert.equal(componentRows(group({ components: [c({ rate: 1e-7 })] }))[0]!.rate, '$0.0000001 per 1M tokens', 'review L6: exact decimal, no exponent');
  assert.equal(componentRows(group({ components: [c({ tokens: 12000, missing: 1 })] }))[0]!.tokens, '12,000 · 1 request without this component');
});

test('group title and revisions: basis, Owner-set fallback, mixed revisions each with Prices as of and their sources', () => {
  assert.equal(groupTitle(group(), detail().revisions), 'Claude Opus 5.5 · Price table bundled-2026-11 · 2 of 2 requests priced');
  assert.equal(groupTitle(group({ basis: 'owner_fallback', revision: 9 }), []), 'Claude Opus 5.5 · Owner-set fallback · 2 of 2 requests priced');
  const d = detail({ groups: [group(), group({ revision: 3, model: 'Synthetic', basis: 'owner_fallback' })], revisions: [
    ...detail().revisions, { id: 3, label: 'owner-1', pricesAsOf: null, source: 'override', references: ['Owner-set fallback'] }] });
  const rows = revisionRows(d);
  assert.deepEqual(rows.map((r) => [r.label, r.asOf, r.source, r.fallback, r.models]), [
    ['bundled-2026-11', 'Prices as of 2026-11-01', 'Bundled price table', false, 'Claude Opus 5.5'],
    ['owner-1', 'Prices as of unavailable', 'Owner override', true, 'Synthetic']]);
  assert.deepEqual(rows[0]!.references, ['anthropic: https://example.com/p (retrieved 2026-11-01)']);
});
