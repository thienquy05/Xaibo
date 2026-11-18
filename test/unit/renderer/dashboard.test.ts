// DD2 review regressions: render the actual summary with synthetic rows, without a browser or service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { SessionRow } from '../../../src/shared/ipc.ts';

const loader = registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('.tsx')) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
  }).outputText };
} });
const { Dashboard } = await import(new URL('../../../src/renderer/overview/Dashboard.tsx', import.meta.url).href);
loader.deregister();
const row = (id: number, extra: Partial<SessionRow> = {}): SessionRow => ({ id, agent: 'claude', entrypoint: null, origin: null, interactive: null, model: 'Model unavailable',
  cwd: null, title: null, lastActivity: 60_000, drift: false, compressed: false, quarantined: 0, live: null, contextPct: null, costUsd: null,
  costCoverage: 'unavailable', tokens: null, tokensComplete: false, ...extra });
function render(rows: SessionRow[], failed = false, loaded = true) {
  return renderToStaticMarkup(createElement(Dashboard, { live: { rows, more: false, loaded }, liveFailed: failed, lastKnown: null,
    onRetryLive() {}, agents: [], banners: [], api: { async usage() { return []; }, async history() { return { records: [], next: null }; } }, tick: 0, onSetPath() {} }));
}

test('M1/M2: actual microchart alternatives format cost coverage and incomplete tokens', () => {
  const html = render([row(1, { costUsd: 0.1 + 0.2, costCoverage: 'full', tokens: 12 }),
    row(2, { costUsd: 4e-7, costCoverage: 'partial', tokens: 0, tokensComplete: true }), row(3, { costUsd: 0.5, costCoverage: 'uncertain' }), row(4)]);
  assert.match(html, /Session 1: Estimated cost ~\$0\.30</);
  assert.match(html, /Session 2: Estimated cost ~\$&lt;0\.01 known subtotal</);
  assert.match(html, /Session 3: Estimated cost ~\$0\.50 known subtotal</);
  assert.match(html, /Session 4: Estimated cost ~\$ unavailable</);
  assert.match(html, /Session 1: 12 tokens known subtotal</);
  assert.match(html, /Session 2: 0 tokens</);
  assert.doesNotMatch(html, /0\.30000000000000004|4e-7/);
});

test('L3: failed refresh retains cached summary/tiles with Last known and a failure note', () => {
  const html = render([row(1, { tokens: 123, tokensComplete: true })], true);
  assert.match(html, /Last known live-session set/);
  assert.match(html, /data-field="tokens"/);
  assert.match(html, /123 tokens/);
  assert.match(html, /Couldn&#x27;t refresh live sessions/);
  assert.match(html, /Retry/);
  assert.doesNotMatch(html, /Couldn&#x27;t load live sessions/);
});

test('L3: initial load failure has no cached values or fabricated Last known data', () => {
  const html = render([], true, false);
  assert.match(html, /Couldn&#x27;t load live sessions/);
  assert.doesNotMatch(html, /data-field="tokens"|Last known live-session set/);
});
