// XAIBO-PROD-525 (P5-T16; design §6.6 Usage history, §5.4 Clear usage history): the Settings area's Usage history section.
// It explains what clearing does and does not do, offers the Clear usage history button and a modal confirmation with
// Cancel; the outcome is reported in words (read-only and failure included); a read-only store disables the button and
// says why. Server-rendered markup only; the dialog flow and focus return are covered by the E2E.
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
const { Settings, clearStatusText, routeResult } = await import(new URL('../../../src/renderer/settings/Settings.tsx', import.meta.url).href);
loader.deregister();

const api = { clearUsage: () => Promise.resolve('cleared' as const) };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('Usage history section: heading, explanation, button and a modal confirmation with Cancel', () => {
  const html = renderToStaticMarkup(createElement(Settings, { api, readOnly: false }));
  assert.match(html, /<h1[^>]*id="settings-heading"[^>]*tabindex="-1"[^>]*>Settings<\/h1>/);
  assert.match(html, /<h2[^>]*>Usage history<\/h2>/);
  const t = text(html);
  assert.match(t, /frozen monthly totals/);
  assert.match(t, /already observed/);
  assert.match(t, /observed afterwards still counts/);
  assert.match(t, /not a session purge or a quota reset/);
  assert.match(html, /<button[^>]*type="button"[^>]*>Clear usage history<\/button>/);
  assert.doesNotMatch(html.match(/<button[^>]*>Clear usage history<\/button>/)![0], /disabled/);
  assert.match(html, /<dialog[^>]*aria-labelledby="clear-usage-title"/);
  assert.match(html, /<h2 id="clear-usage-title">Clear usage history\?<\/h2>/);
  assert.match(t, /Sessions, account usage snapshots and quotas are not deleted/);
  assert.match(html, />Cancel<\/button>/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /role="status"/, 'the health band keeps the only status role');
});

test('a read-only store disables the button and says why', () => {
  const html = renderToStaticMarkup(createElement(Settings, { api, readOnly: true }));
  assert.match(html, /<button[^>]*disabled=""[^>]*>Clear usage history<\/button>/);
  assert.match(text(html), /Unavailable while the store is read-only/);
});

test('review M4: an outcome is shown in the dialog while it is open, next to the button once it has closed (a forced close while applying)', () => {
  assert.deepEqual(routeResult('cleared', true), { close: true, dialog: null, section: 'cleared' });
  assert.deepEqual(routeResult('cleared', false), { close: false, dialog: null, section: 'cleared' });
  for (const r of ['read-only', 'failed', 'unavailable'] as const) {
    assert.deepEqual(routeResult(r, true), { close: false, dialog: r, section: null });
    assert.deepEqual(routeResult(r, false), { close: false, dialog: null, section: r }, `${r} after the dialog was closed`);
  }
});

test('outcome words', () => {
  assert.equal(clearStatusText(null), '');
  assert.equal(clearStatusText('applying'), 'Applying changes…'); // design §5.1 dialog transaction
  assert.equal(clearStatusText('cleared'), 'Usage history cleared. Usage observed from now on will appear.');
  assert.equal(clearStatusText('read-only'), 'Usage history was not cleared: the store is read-only.');
  assert.equal(clearStatusText('failed'), 'Usage history was not cleared. Nothing was changed.');
  assert.equal(clearStatusText('unavailable'), 'The result is unavailable. Closing this dialog does not cancel the operation.');
});
