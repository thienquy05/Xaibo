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
