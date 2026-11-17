// XAIBO-PROD-418 (P4-T07b; PRD FR-48, US-18; design §6.3.2, §7.1): the Cost section rendered from a synthetic breakdown
// without a browser or service. Every amount shows ~ and has screen-reader text starting "Estimated cost"; revisions
// are listed separately with Prices as of; references are plain text; a failed request is unavailable with Retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { CostComponent, CostDetail, CostGroup } from '../../../src/shared/ipc.ts';

const loader = registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('.tsx')) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
  }).outputText };
} });
const { CostPane } = await import(new URL('../../../src/renderer/workspace/cost/CostSection.tsx', import.meta.url).href);
loader.deregister();

const c = (o: Partial<CostComponent> = {}): CostComponent => ({ name: 'output', tokens: 40, missing: 0, unpriced: 0, rate: 200, rateVaries: false, usd: 0.008, ...o });
const group = (o: Partial<CostGroup> = {}): CostGroup => ({ model: 'Claude Opus 5.5', revision: 2, basis: 'token_table', requests: 2, priced: 2, from: 1, to: 2,
  components: [c({ name: 'uncached_input', tokens: 15, rate: 4, usd: 0.00006 }), c({ name: 'cache_write_1h', tokens: 15, unpriced: 1, rate: null, usd: null }), c()], ...o });
const detail: CostDetail = { amountUsd: 0.0083, basis: 'token_table', coverage: 'partial', reportedUsd: null, requests: 3, priced: 3, gaps: ['cache_write'], reasons: [],
  groups: [group(), group({ revision: 3, model: 'Synthetic <b>model</b>', basis: 'owner_fallback', requests: 1, priced: 1 })], more: false, revisions: [
    { id: 2, label: 'bundled-2026-11', pricesAsOf: '2026-11-01', source: 'bundled', references: ['anthropic: https://example.com/p (retrieved 2026-11-01)'] },
    { id: 3, label: 'owner-1', pricesAsOf: null, source: 'override', references: ['Owner-set fallback'] }] };
const render = (o: object) => renderToStaticMarkup(createElement(CostPane, { cost: detail, failed: false, onRetry() {}, ...o }));

test('headline: Estimated cost heading, ~$ visible, spoken text starting Estimated cost, basis and coverage', () => {
  const html = render({});
  assert.match(html, /<h3[^>]*>Estimated cost<\/h3>/);
  assert.match(html, /aria-hidden="true">~\$0\.01 known subtotal</);
  assert.match(html, /class="x-sr-only">Estimated cost: 0\.01 US dollars; known subtotal; 3 of 3 requests priced; missing: cache write</);
  assert.match(html, />Calculated from tokens</);
  assert.match(html, /<span aria-hidden="true">3 of 3 requests priced; missing: cache write<\/span>/, 'review L2: coverage is spoken once, in the headline');
});

test('groups: one table per group named by its title, Price rate column, every amount with ~ and Estimated cost text', () => {
  const html = render({});
  // review L3: the caption alone names each table (no duplicate aria-label)
  assert.match(html, /<table class="x-table x-context-table"><caption>Claude Opus 5\.5 · Price table bundled-2026-11 · 2 of 2 requests priced<\/caption>/);
  assert.match(html, /<caption>Synthetic &lt;b&gt;model&lt;\/b&gt; · Owner-set fallback · 1 of 1 requests priced<\/caption>/);
  assert.doesNotMatch(html, /<table[^>]*aria-label/);
  assert.match(html, /<th[^>]*>Price rate<\/th>/);
  const amounts = [...html.matchAll(/<td class="x-cost-usd"><span aria-hidden="true">([^<]+)<\/span><span class="x-sr-only">([^<]+)<\/span><\/td>/g)];
  assert.equal(amounts.length, 6);
  for (const [, visible, spoken] of amounts) {
    assert.match(visible!, /^~\$/);
    assert.match(spoken!, /^Estimated cost/);
  }
  assert.match(html, /\$4 per 1M tokens/);
  assert.match(html, /15 · 1 request not priced for this component/);
  assert.doesNotMatch(html, /<b>model/);
});

test('price provenance: each revision with Prices as of, source and Owner-set fallback; references are plain text, never links', () => {
  const html = render({});
  assert.match(html, /<h4[^>]*>Price provenance<\/h4>/);
  assert.match(html, /Prices as of 2026-11-01/);
  assert.match(html, /Prices as of unavailable/);
  assert.match(html, /Bundled price table/);
  assert.match(html, /Owner override/);
  assert.match(html, /class="x-chip x-chip-warn">Owner-set fallback</); // review L5: C11 warning badge
  assert.match(html, /anthropic: https:\/\/example\.com\/p \(retrieved 2026-11-01\)/);
  assert.doesNotMatch(html, /<a[\s>]/);
});

test('reported estimate notes; loading; failed with Retry; session gone; never 0 for unavailable', () => {
  const rep = render({ cost: { ...detail, amountUsd: 0, basis: 'agent_reported', coverage: 'full', reportedUsd: 0 } });
  assert.match(rep, /aria-hidden="true">~\$0\.00</);
  assert.match(rep, /Agent-reported basis; local price revision not applied/);
  assert.match(rep, /Component cost unavailable — agent estimate has no split/);
  assert.match(render({ cost: undefined }), />Loading estimated cost…</);
  const failed = render({ cost: undefined, failed: true });
  assert.match(failed, /Couldn&#x27;t load cost/);
  assert.match(failed, /<button[^>]*>Retry<\/button>/);
  assert.match(render({ cost: null }), /Estimated cost unavailable — session not found/);
  const none = render({ cost: { ...detail, amountUsd: null, coverage: 'unavailable', priced: 0, groups: [], revisions: [], reasons: ['unpriced-model'] } });
  assert.match(none, /aria-hidden="true">~\$ unavailable</);
  assert.match(none, /Estimated cost unavailable: model has no verified price/);
  assert.doesNotMatch(none, /\$0/);
});

test('review M1: revisions sharing a label stay distinguishable (id shown) and keyed apart; override text is escaped (bidi, controls)', () => {
  const dup: CostDetail = { ...detail, groups: [group({ revision: 2 }), group({ revision: 4 })], revisions: [
    { id: 2, label: 'owner-1', pricesAsOf: '2026-11-12', source: 'override', references: ['owner: https://example.com/a\u202E (retrieved 2026-11-12)'] },
    { id: 4, label: 'owner-1', pricesAsOf: '2026-11-12', source: 'override', references: ['owner: https://example.com/a\u202E (retrieved 2026-11-12)'] }] };
  const html = render({ cost: dup });
  assert.match(html, /<caption>Claude Opus 5\.5 · Price table owner-1 \(revision 2\) · 2 of 2 requests priced<\/caption>/);
  assert.match(html, /<caption>Claude Opus 5\.5 · Price table owner-1 \(revision 4\) · 2 of 2 requests priced<\/caption>/);
  assert.equal([...html.matchAll(/<strong>owner-1 \(revision \d\)<\/strong>/g)].length, 2);
  assert.doesNotMatch(html, /\u202E/);
});

test('XAIBO-PROD-438 (D-P4-10): a Retry in progress is disabled and reads Retrying…', () => {
  assert.match(render({ cost: undefined, failed: true, retry: { failures: 1, at: null, busy: true } }), /aria-busy="true"[^>]*>.*Retrying…<\/button>/);
});
