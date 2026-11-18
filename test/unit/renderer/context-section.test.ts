// XAIBO-PROD-415 (P4-T06b; PRD FR-47, US-17; design §6.3.1, C21): the Context section rendered from synthetic
// readings without a browser or service. A meter appears only for an in-range reading; exact integers are spoken;
// the three category tables are always present and unavailable until v1-B.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { ContextReading, LiveStatus, SessionRow } from '../../../src/shared/ipc.ts';

const loader = registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('.tsx')) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
  }).outputText };
} });
const { ContextPane, ContextSection } = await import(new URL('../../../src/renderer/workspace/context/ContextSection.tsx', import.meta.url).href);
loader.deregister();

const T = Date.parse('2026-01-03T10:00:00.000Z');
const row = (extra: Partial<SessionRow> = {}): SessionRow => ({ id: 1, agent: 'codex', entrypoint: null, origin: null, interactive: null, model: 'GPT · high',
  cwd: null, title: null, lastActivity: T, drift: false, compressed: false, quarantined: 0, live: null, contextPct: null, costUsd: null,
  costCoverage: 'unavailable', tokens: null, tokensComplete: false, ...extra });
const read = (o: Partial<ContextReading> = {}): ContextReading => ({ generation: 0, used: 1200, window: 200000, basis: 'reported', source: 'rollout',
  asOf: T, observedAt: T, ...o });
const render = (r: SessionRow, c: ContextReading | null) => renderToStaticMarkup(createElement(ContextSection, { row: r, reading: c, now: T }));

test('in-range reading: model, abbreviated value, exact spoken text, meter with unoccupied label, source, generation', () => {
  const html = render(row(), read());
  assert.match(html, /<h3[^>]*>Current context<\/h3>/);
  assert.match(html, /GPT · high/);
  assert.match(html, /aria-hidden="true">0\.6% · 1\.2k \/ 200k</);
  assert.match(html, /class="x-sr-only">Context: 0\.6 percent; 1,200 of 200,000 tokens; source Codex rollout; generation 1</);
  assert.match(html, /role="img" aria-label="Context meter: 0\.6 percent used"/); // review L: the unoccupied note is read once, below
  assert.match(html, /width:0\.6%/);
  assert.match(html, />Unoccupied; buffer unknown</);
  assert.match(html, />Source: Codex rollout</);
  assert.match(html, />Generation 1</);
  assert.doesNotMatch(html, /Context meter unavailable/);
});

test('category tables: three, in design order, every value Unavailable with the v1-B explanation', () => {
  const html = render(row(), read());
  assert.deepEqual([...html.matchAll(/<caption>([^<]+)<\/caption>/g)].map((m) => m[1]), ['Used context', 'Outside used context', 'Deferred definitions']);
  assert.equal([...html.matchAll(/aria-hidden="true">Unavailable</g)].length, 12);
  assert.match(html, /Composition estimates arrive in v1-B/);
  assert.match(html, /<th scope="row">Free space<\/th><td><span aria-hidden="true">Unavailable<\/span><span class="x-sr-only">Unavailable — compaction buffer unavailable<\/span>/);
  assert.doesNotMatch(html, /usable before compaction/i);
});

test('awaiting next usage, agy, transcript-only and out of range: no meter, the reason instead', () => {
  const wait = render(row({ agent: 'claude' }), read({ source: 'compaction', used: null }));
  assert.match(wait, />Awaiting next usage</);
  assert.match(wait, /Context meter unavailable — awaiting next usage after compaction/);
  const agy = render(row({ agent: 'agy' }), read());
  assert.match(agy, /aria-hidden="true">Context unavailable</);
  assert.match(agy, /Antigravity CLI context inputs and window are unverified/);
  const claude = render(row({ agent: 'claude' }), read({ source: 'transcript', used: 9000, window: null, basis: 'unavailable' }));
  assert.match(claude, /9k used · window unavailable/);
  const over = render(row(), read({ used: 210000 }));
  assert.match(over, /Reading out of range: 210,000 of 200,000 tokens/);
  for (const html of [wait, agy, claude, over]) {
    assert.doesNotMatch(html, /role="img"/);
    assert.doesNotMatch(html, /Unoccupied; buffer unknown/);
  }
  assert.doesNotMatch(`${agy}${claude}`, /\d%/);
});

test('review: interim after compaction keeps its meter and says so', () => {
  const html = render(row({ agent: 'claude' }), read({ source: 'compaction', used: 30000 }));
  assert.match(html, /class="x-chip">Interim after compaction</);
  assert.match(html, /role="img" aria-label="Context meter: 15 percent used"/);
});

test('review M: the pane shows loading, then the section; a failed detail is unavailable with Retry, never endless loading', () => {
  const pane = (o: object) => renderToStaticMarkup(createElement(ContextPane, { row: row(), detail: null, failed: false, onRetry() {}, now: T, ...o }));
  assert.match(pane({}), />Loading context…</);
  const failed = pane({ failed: true });
  assert.match(failed, /Couldn&#x27;t load context/);
  assert.match(failed, /<button[^>]*>Retry<\/button>/);
  assert.doesNotMatch(failed, /Loading context/);
  assert.match(pane({ detail: { row: row(), coverage: [], context: read() } }), /Current context/);
});

test('stale while live; untrusted model text stays escaped', () => {
  const live: LiveStatus = { lifecycle: 'busy', confidence: 'confirmed', health: 'connected', reason: null, outcome: null, findings: [], since: null };
  const html = renderToStaticMarkup(createElement(ContextSection, { row: row({ live, model: '<img src=x onerror=1>' }), reading: read(), now: T + 16 * 60_000 }));
  assert.match(html, /Stale · /);
  assert.doesNotMatch(html, /<img/);
});

test('XAIBO-PROD-435: Stale shows its short form and speaks the C20 text', () => {
  const live: LiveStatus = { lifecycle: 'busy', confidence: 'confirmed', health: 'connected', reason: null, outcome: null, findings: [], since: null };
  const html = renderToStaticMarkup(createElement(ContextSection, { row: row({ live }), reading: read(), now: T + 16 * 60_000 }));
  assert.match(html, /<span aria-hidden="true">Stale · [^<]+<\/span><span class="x-sr-only">Stale, last measurement [^<]+<\/span>/);
});

test('XAIBO-PROD-438 (D-P4-10): a Retry in progress is disabled and reads Retrying…; loading leads with the glyph', () => {
  const pane = (o: object) => renderToStaticMarkup(createElement(ContextPane, { row: row(), detail: null, failed: false, onRetry() {}, now: T, ...o }));
  assert.match(pane({ failed: true, retry: { failures: 1, at: null, busy: true } }), /aria-busy="true"[^>]*>.*Retrying…<\/button>/);
  assert.match(pane({}), /class="x-icon x-loading"[\s\S]*Loading context…/);
});

test('review HIGH (XAIBO-PROD-438): the alert wraps only the notice text; the Retry button stays outside it; loading lines are flex rows', () => {
  const pane = (o: object) => renderToStaticMarkup(createElement(ContextPane, { row: row(), detail: null, failed: false, onRetry() {}, now: T, ...o }));
  const failed = pane({ failed: true });
  assert.match(failed, /<span role="alert">[\s\S]*?Couldn&#x27;t load context<\/span><button/);
  assert.doesNotMatch(failed, /<p[^>]*role="alert"/);
  assert.match(pane({}), /class="x-context-note x-loading-line"/);
});

// XAIBO-PROD-452 (G4d-5): a refresh that fails after a success keeps the last reading and still offers Retry.
test('a failed refresh with a retained reading shows Retry above the reading', () => {
  const html = renderToStaticMarkup(createElement(ContextPane, { row: row(), detail: { row: row(), coverage: [], context: read() }, failed: true, onRetry() {}, now: T }));
  assert.match(html, /Couldn&#x27;t load context[\s\S]*<button[^>]*>Retry<\/button>[\s\S]*Current context/);
});
