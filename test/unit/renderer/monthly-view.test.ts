// XAIBO-PROD-524 (P5-T17b; design §6.1.1, US-20, FR-52): the monthly usage chart. monthly-view.ts holds the logic (metric
// values, bar geometry, labels, months per page by width, quota rows); MonthlyLedger is rendered with react-dom/server
// from synthetic pages. A month with no observations or an unavailable value shows words and no bar; an evidenced zero
// shows 0 with a baseline marker; cost reads ~$ with "known subtotal" when partly priced; quota peaks stay separate per
// scope with a label or a view-local "Scope N".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { LedgerMonth, LedgerPage, LedgerQuota } from '../../../src/shared/ipc.ts';
import { bars, ledgerStatus, metricValue, monthLabel, monthsPerPage, quotaRows, scaleCaption } from '../../../src/renderer/history/monthly-view.ts';

const loader = registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('.tsx')) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
  }).outputText };
} });
const { MonthlyLedger } = await import(new URL('../../../src/renderer/history/MonthlyChart.tsx', import.meta.url).href);
loader.deregister();

const tokens = (total: number) => ({ uncachedInput: total, cacheRead: 0, cacheWrite: 0, output: 0, total, gaps: 0 });
const m = (month: string, o: Partial<LedgerMonth> = {}): LedgerMonth => ({ month, monthToDate: false, detail: 'full', observed: true, sessions: 2, turns: 5,
  tokens: tokens(1000), cost: { usd: 1.5, full: 3, partial: 0, none: 0, pending: 0 }, priceRevisions: [1], ...o });
const none = (month: string): LedgerMonth => ({ month, monthToDate: false, detail: 'full', observed: false, sessions: null, turns: null, tokens: null, cost: null, priceRevisions: [] });
const q = (o: Partial<LedgerQuota> = {}): LedgerQuota => ({ month: '2026-03', scope: 1, label: 'Default profile', agent: 'codex', limitId: 'primary', windowMinutes: 300, verified: true, peakPercent: 61.5, observations: 4, ...o });
const page = (months: LedgerMonth[], quota: LedgerQuota[] = []): LedgerPage => ({ months, quota, older: '2025-12', newer: null, agents: ['claude', 'codex'], models: ['model-a'] });

test('metric values: words for no observations and unavailable, exact numbers otherwise; cost ~$ with known subtotal', () => {
  assert.deepEqual(metricValue(none('2026-01'), 'tokens'), { kind: 'none', text: 'No observations' });
  assert.deepEqual(metricValue(m('2026-01', { tokens: null }), 'tokens'), { kind: 'unavailable', text: 'Unavailable' });
  assert.deepEqual(metricValue(m('2026-01'), 'tokens'), { kind: 'value', value: 1000, text: '1k', exact: '1,000 tokens' });
  assert.equal(metricValue(m('2026-01', { tokens: tokens(0) }), 'tokens').text, '0');
  assert.equal(metricValue(m('2026-01'), 'cost').text, '~$1.50');
  assert.equal(metricValue(m('2026-01', { cost: { usd: 1.5, full: 1, partial: 1, none: 1, pending: 0 } }), 'cost').text, '~$1.50 known subtotal');
  assert.deepEqual(metricValue(m('2026-01', { cost: { usd: null, full: 0, partial: 0, none: 3, pending: 0 } }), 'cost'), { kind: 'unavailable', text: '~$ unavailable' });
  assert.equal(metricValue(m('2026-01'), 'sessions').text, '2');
  assert.equal(metricValue(m('2026-01'), 'turns').text, '5');
});

test('bars: scale local to the shown months, from zero; no bar for words; an evidenced zero gets a baseline marker', () => {
  const b = bars([m('2026-01', { tokens: tokens(500) }), none('2026-02'), m('2026-03', { tokens: tokens(0) }), m('2026-04')], 'tokens');
  assert.equal(b[0]!.height, 80, 'half of the local maximum');
  assert.equal(b[1]!.height, null, 'no observations: no bar');
  assert.deepEqual([b[2]!.height, b[2]!.zero], [0, true], 'evidenced zero: a baseline marker');
  assert.equal(b[3]!.height, 160, 'the local maximum fills the plot');
  assert.equal(scaleCaption([m('2026-01'), none('2026-02')], 'tokens'), 'Scale: 0 to 1k tokens across the months shown');
  assert.equal(scaleCaption([none('2026-02')], 'tokens'), 'No values to scale in the months shown');
});

test('labels and months per page: month to date, detail state; 12 wide, 6 normal, 3 narrow, 1 below 320 px', () => {
  assert.equal(monthLabel(m('2026-03')), 'Mar 2026');
  assert.equal(monthLabel(m('2026-11', { monthToDate: true })), 'Nov 2026 · month to date');
  assert.equal(monthLabel(m('2026-03', { detail: 'some-expired' })), 'Mar 2026 · some details expired');
  assert.equal(monthLabel(m('2026-03', { detail: 'totals-only' })), 'Mar 2026 · details expired, totals only');
  assert.deepEqual([monthsPerPage(1280), monthsPerPage(800), monthsPerPage(500), monthsPerPage(300)], [12, 6, 3, 1]);
});

test('quota rows: label or a view-local "Scope N", window and verification in words, uncapped peak', () => {
  const rows = quotaRows([q(), q({ scope: 2, label: null, windowMinutes: null, verified: false, agent: null, peakPercent: 120 })]);
  assert.deepEqual(rows.map((r) => [r.scope, r.window, r.peak, r.verified]),
    [['Default profile', '5-hour window', '61.5%', 'Verified scope'], ['Scope 2', 'Window unknown', '120%', 'Scope not verified']]);
});

test('MonthlyLedger markup: SVG with visible numbers, words without bars, month controls, table, separate quota section', () => {
  const html = renderToStaticMarkup(createElement(MonthlyLedger, {
    page: page([m('2026-01'), none('2026-02'), m('2026-03', { tokens: tokens(0), cost: { usd: 0, full: 1, partial: 0, none: 0, pending: 0 }, monthToDate: true })], [q()]),
    metric: 'tokens', selected: 0, open: null, onSelect() {}, onOpen() {}, onKey() {}, controls: { current: [] },
  }));
  assert.match(html, /<svg[^>]*role="img"/);
  assert.match(html, /<svg[^>]*preserveAspectRatio="xMinYMid meet"/, 'the chart starts at the left edge under its controls (visual check)');
  assert.match(html, />1k</, 'a visible number above the bar');
  assert.match(html, />No observations</, 'words at the month position');
  assert.match(html, /class="x-zero"/, 'evidenced zero marker');
  assert.match(html, /Mar 2026 · month to date/);
  assert.match(html, /<table/);
  assert.equal((html.match(/<div class="x-monthly-scroll" tabindex="0" role="region" aria-label="[^"]+"><table/g) ?? []).length, 2,
    'each table scrolls in its own keyboard-reachable region, never the page (T15b reflow)');
  assert.match(html, /1,000/, 'exact value in the table');
  assert.match(html, /Quota peaks are per usage scope; model filter does not apply/);
  assert.match(html, /Default profile/);
  assert.equal((html.match(/aria-pressed/g) ?? []).length, 0, 'month controls are not toggle buttons');
  assert.equal((html.match(/data-month=/g) ?? []).length, 3, 'one control per month');
});

test('review M1/M3: paging stays focusable (aria-disabled, never disabled) and failures are announced in the live region', async () => {
  const { MonthlyChart } = await (async () => {
    const l = registerHooks({ load(url, context, nextLoad) {
      if (!url.endsWith('.tsx')) return nextLoad(url, context);
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 } }).outputText };
    } });
    try { return await import(new URL('../../../src/renderer/history/MonthlyChart.tsx', import.meta.url).href); } finally { l.deregister(); }
  })();
  const html = renderToStaticMarkup(createElement(MonthlyChart, { api: async () => page([]), name: (a: string) => a }));
  assert.match(html, /aria-disabled="true"[^>]*>Previous months</);
  assert.doesNotMatch(html, /disabled=""/, 'a native disabled button would drop keyboard focus');
  assert.equal(ledgerStatus({ loading: true, failed: false, range: '' }), 'Loading monthly usage…');
  assert.equal(ledgerStatus({ loading: false, failed: true, range: '' }), 'Could not load monthly usage');
  assert.equal(ledgerStatus({ loading: false, failed: false, range: 'Jan 2026 to Mar 2026' }), 'Showing Jan 2026 to Mar 2026');
});

test('visual regression: the ledger classes never reuse the Session timeline class names (x-ledger, x-ledger-row)', () => {
  const css = readFileSync(new URL('../../../src/renderer/styles/tokens.css', import.meta.url), 'utf8');
  const chart = readFileSync(new URL('../../../src/renderer/history/MonthlyChart.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(chart, /\bx-ledger\b|x-ledger-/, 'the monthly panel has its own class prefix');
  const ledgerRules = css.match(/^\.x-ledger[^{]*\{/gm) ?? [];
  assert.deepEqual(ledgerRules, ['.x-ledger-row {'], 'only the timeline rule uses the x-ledger prefix');
});

// Gate 5 G5c-2 (design §6.1.1): a month whose token total has gaps (requests with missing counts) is a known subtotal,
// never a complete total; gaps with a known subtotal of 0 prove no zero, so the month is unavailable (no zero marker).
test('G5c-2 tokens with gaps: "known subtotal"; a 0 subtotal with gaps is unavailable, never an evidenced zero', () => {
  const gappy = (total: number, gaps: number) => ({ ...tokens(total), gaps });
  assert.equal(metricValue(m('2026-01', { tokens: gappy(1000, 2) }), 'tokens').text, '1k known subtotal');
  assert.equal(metricValue(m('2026-01', { tokens: gappy(1000, 0) }), 'tokens').text, '1k', 'no gaps: a complete total');
  assert.equal(metricValue(m('2026-01', { tokens: gappy(0, 3) }), 'tokens').kind, 'unavailable');
  const b = bars([m('2026-01', { tokens: gappy(0, 3) }), m('2026-02')], 'tokens');
  assert.deepEqual([b[0]!.height, b[0]!.zero], [null, false], 'no bar and no evidenced-zero marker');
  assert.equal(metricValue(m('2026-01', { tokens: gappy(0, 0) }), 'tokens').text, '0', 'no gaps: an evidenced zero stays 0');
});
