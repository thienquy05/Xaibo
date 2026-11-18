// XAIBO-PROD-436 (P4-T14b; owner decision D-P4-09): the persistent collection band reads Paused (disk full) with the
// warning glyph while the service reports disk full, in every area. Rendered with react-dom/server, the .tsx transpiled
// by TypeScript as in context-section.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const loader = registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('.tsx')) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
  }).outputText };
} });
const { HealthStatus } = await import(new URL('../../../src/renderer/Health.tsx', import.meta.url).href);
loader.deregister();

const running = { v: 1, type: 'health', state: 'running', attempt: 0, readOnly: null };
const band = (banners: unknown[]) => renderToStaticMarkup(createElement(HealthStatus, { health: running, banners }));

test('disk full: the band says Collection: Paused (disk full) in the warning tone; without it, Running in the success tone', () => {
  const paused = band([{ kind: 'disk-full' }]);
  assert.match(paused, /x-tone-warning/);
  assert.match(paused, /Collection: Paused \(disk full\)/);
  assert.doesNotMatch(paused, /Running/);
  const ok = band([]);
  assert.match(ok, /x-tone-success/);
  assert.match(ok, /Collection: Running/);
});

test('XAIBO-PROD-438 (D-P4-10): Starting and Restarting show the animated loading glyph; Running, Paused, Stopped do not', () => {
  const at = (state: string, attempt = 0) => renderToStaticMarkup(createElement(HealthStatus, { health: { ...running, state, attempt }, banners: [] }));
  assert.match(at('starting'), /class="x-icon x-loading"/);
  assert.match(at('restarting', 2), /class="x-icon x-loading"[\s\S]*Collection: Restarting \(attempt 2\)/);
  assert.match(renderToStaticMarkup(createElement(HealthStatus, { health: null, banners: [] })), /class="x-icon x-loading"/, 'no health yet: starting');
  for (const h of [at('running'), band([{ kind: 'disk-full' }]), at('stopped')]) assert.doesNotMatch(h, /x-loading/);
});

test('XAIBO-PROD-438 visual check: the band text is its own shrinkable span, so it wraps beside the glyph (wide rail)', () => {
  assert.match(band([]), /<\/span><span class="x-band-text">Collection: Running<\/span>/);
});
