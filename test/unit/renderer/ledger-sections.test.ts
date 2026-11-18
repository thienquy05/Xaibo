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
const { Files, Tools, Subagents, MarkerNotice } = await import(new URL('../../../src/renderer/workspace/sections.tsx', import.meta.url).href);
loader.deregister();

const page = (o: { items?: unknown[]; loading?: boolean; more?: boolean; failed?: boolean; retry?: { failures: number; at: number | null; busy: boolean } } = {}) =>
  ({ items: [], more: false, loading: false, failed: false, loadMore: () => {}, retry: { failures: o.failed ? 1 : 0, at: null, busy: false }, ...o });
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
    assert.match(failed, /Couldn&#x27;t load records/);
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
    assert.equal(live(s.render(page({ failed: true }))), 'Couldn&#x27;t load records'); // static markup escapes the apostrophe
    assert.equal(live(s.render(page())), '');
  });
}

// XAIBO-PROD-438 (D-P4-10): Retry is disabled while it runs and reads Retrying…; a failed retry says Still … · HH:MM;
// Loading records leads with the loading glyph.
for (const s of sections) {
  test(`${s.name}: Retrying state, repeated failure notice, loading glyph`, () => {
    const busy = s.render(page({ failed: true, loading: true, retry: { failures: 1, at: null, busy: true } }));
    assert.match(busy, /<button[^>]*aria-disabled="true"[^>]*aria-busy="true"[^>]*>.*Retrying…<\/button>/);
    const at = new Date(2026, 0, 2, 14, 32).getTime();
    assert.match(s.render(page({ failed: true, retry: { failures: 2, at, busy: false } })), /Still couldn&#x27;t load records · 14:32/);
    assert.match(s.render(page({ loading: true })), /class="x-icon x-loading"[\s\S]*Loading records/);
  });
}

// review LOW (XAIBO-PROD-438): a background reload after a failure shows Retrying… too (its Retry would do nothing)
for (const s of sections) {
  test(`${s.name}: a reload in flight after a failure reads Retrying…`, () => {
    assert.match(s.render(page({ failed: true, loading: true })), /aria-busy="true"[^>]*>.*Retrying…<\/button>/);
  });
}

// XAIBO-PROD-454 (G4d-3 follow-up): markers still paged past the MARKER_PAGES budget are said, with a bounded
// continuation (one page per click) where the markers Retry appears; a failure keeps its Retry.
test('MarkerNotice: more markers after the budget show Load more model markers; a click loads one page', () => {
  let clicks = 0;
  const p = { ...page({ more: true }), loadMore: () => { clicks++; } };
  const out = html(createElement(MarkerNotice, { markers: p }));
  assert.match(out, /Some model switches are not loaded yet/);
  assert.match(out, /<button[^>]*>Load more model markers<\/button>/);
  const button = (function find(n: unknown): { props: { onClick: () => void } } | null {
    if (!n || typeof n !== 'object') return null;
    const el = n as { type?: unknown; props?: { children?: unknown; onClick?: () => void } };
    if (el.type === 'button') return el as { props: { onClick: () => void } };
    const kids = el.props?.children;
    for (const k of Array.isArray(kids) ? kids : [kids]) { const f = find(k); if (f) return f; }
    return null;
  })(MarkerNotice({ markers: p }));
  button!.props.onClick();
  assert.equal(clicks, 1);
  assert.match(html(createElement(MarkerNotice, { markers: { ...p, loading: true } })), /aria-disabled="true"[^>]*>Loading model markers<\/button>/);
  assert.match(html(createElement(MarkerNotice, { markers: page({ failed: true, more: true }) })), /Couldn&#x27;t load model markers[\s\S]*Retry/);
  assert.equal(html(createElement(MarkerNotice, { markers: page({ items: [1] }) })), '', 'all markers loaded: nothing');
});
