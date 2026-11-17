// XAIBO-PROD-433 (P4-T14, EC-97, design §6.13 A3 B2): the Files, Tools and Subagents sections of an open session say
// they are loading while their first page is pending, instead of an empty table that reads as "none". Rendered from
// synthetic pages with react-dom/server, the .tsx modules transpiled by TypeScript as in cost-section.test.ts.
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
const { Files, Tools, Subagents } = await import(new URL('../../../src/renderer/workspace/sections.tsx', import.meta.url).href);
loader.deregister();

const page = (o: { items?: unknown[]; loading?: boolean; more?: boolean; failed?: boolean } = {}) => ({ items: [], more: false, loading: false, failed: false, loadMore: () => {}, ...o });
const html = (el: unknown) => renderToStaticMarkup(el as Parameters<typeof renderToStaticMarkup>[0]);
const sections = [
  { name: 'Files', render: (p: ReturnType<typeof page>) => html(createElement(Files, { files: p, tools: [] })), empty: 'No file touches recorded.' },
  { name: 'Tools', render: (p: ReturnType<typeof page>) => html(createElement(Tools, { tools: p, touches: [] })), empty: 'No tool calls recorded.' },
  { name: 'Subagents', render: (p: ReturnType<typeof page>) => html(createElement(Subagents, { subagents: p })), empty: 'No subagents recorded.' },
];

for (const s of sections) {
  test(`${s.name}: a pending first page says Loading records, with no empty table; once loaded with none, the empty note`, () => {
    const pending = s.render(page({ loading: true }));
    assert.match(pending, /Loading records/);
    assert.doesNotMatch(pending, /<table/, 'no empty table while the first page loads');
    assert.doesNotMatch(pending, new RegExp(s.empty), 'not "none" before the answer');
    // security review M: a failed first load is an error with Retry, never also "none"
    const failed = s.render({ ...page(), failed: true });
    assert.match(failed, /Records could not be loaded/);
    assert.doesNotMatch(failed, new RegExp(s.empty), 'a failed load does not read as none');
    const none = s.render(page());
    assert.match(none, new RegExp(s.empty));
    assert.doesNotMatch(none, /Loading records/);
  });
}

// XAIBO-PROD-435 (P4-T14b; review L of -433): loading and failed record states are announced in a polite live region.
for (const s of sections) {
  test(`${s.name}: Loading records and a failed load are announced; idle announces nothing`, () => {
    const live = (h: string) => /<span class="x-sr-only" aria-live="polite">([^<]*)<\/span>/.exec(h)?.[1];
    assert.equal(live(s.render(page({ loading: true }))), 'Loading records');
    assert.equal(live(s.render(page({ loading: true, more: true, items: [] }))), 'Loading records');
    assert.equal(live(s.render(page({ failed: true }))), 'Records could not be loaded');
    assert.equal(live(s.render(page())), '');
  });
}
