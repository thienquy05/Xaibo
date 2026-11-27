// XAIBO-PROD-551 (Phase 6 cleanup unit, renderer run; D-P5-15): one confirmation dialog, one result routing and dialog
// step model, shared day formatting, dialog strings, window titles, map labels and IPC constants; local copies gone
// (source scans, as cleanup-renderer.test.ts). The dialog flow and focus return stay covered by the E2E.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { dialogStep, routeResult } from '../../../src/renderer/components/dialog-model.ts';
import { APPLYING, day, formatTime, RESULT_UNAVAILABLE } from '../../../src/renderer/model.ts';
import { windowTitle } from '../../../src/renderer/usage/presentation.ts';
import { quotaRows } from '../../../src/renderer/history/monthly-view.ts';
import { base, kindOf } from '../../../src/renderer/agent-map/tree.ts';
import * as browse from '../../../src/renderer/history/browse.ts';
import { purgeText, routePurge } from '../../../src/renderer/history/trash.ts';
import { reimportText, routeReimport } from '../../../src/renderer/history/suppressed.ts';
import { moveText, routeMove } from '../../../src/renderer/history/move.ts';
import { isActive, QUERY_MAX_TERMS, RETENTION_DEFAULT } from '../../../src/shared/ipc.ts';

const loader = registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('.tsx')) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
  }).outputText };
} });
const { ConfirmDialog } = await import(new URL('../../../src/renderer/components/ConfirmDialog.tsx', import.meta.url).href);
loader.deregister();

const SRC = join(import.meta.dirname, '..', '..', '..', 'src');
const src = (f: string) => readFileSync(join(SRC, f), 'utf8');
const renderer = (readdirSync(join(SRC, 'renderer'), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => `renderer/${f}`);
const noop = () => undefined;
const dialog = (phase: string | null, danger = false) => renderToStaticMarkup(createElement(ConfirmDialog, {
  dialog: { current: null }, name: 'demo', title: 'Do it?', body: 'What happens.', phase, text: phase === 'applying' ? APPLYING : '', confirm: 'Do it',
  danger, onConfirm: noop, onDismiss: noop, onClosed: noop,
}));

test('item 1: ConfirmDialog: Cancel and the confirm action before submission, both disabled while applying, Close only once settled', () => {
  const idle = dialog(null, true);
  assert.match(idle, /<dialog[^>]*aria-labelledby="demo-title"[^>]*aria-describedby="demo-body"/);
  assert.match(idle, /<h2 id="demo-title">Do it\?<\/h2>/);
  assert.match(idle, /<button[^>]*class="x-btn x-btn-secondary"[^>]*>Cancel<\/button>/);
  assert.match(idle, /<button[^>]*class="x-btn x-btn-danger"[^>]*>Do it<\/button>/);
  assert.doesNotMatch(idle, />Close</);
  assert.match(dialog(null), /class="x-btn x-btn-primary"[^>]*>Do it</, 'primary unless danger');
  const applying = dialog('applying');
  assert.equal((applying.match(/aria-disabled="true"/g) ?? []).length, 2, 'Cancel and the action are disabled while applying');
  assert.match(applying, /aria-busy="true"[^>]*>Do it</);
  assert.match(applying, /Applying changes…/);
  const settled = dialog('failed');
  assert.match(settled, />Close<\/button>/);
  assert.doesNotMatch(settled, />Cancel<|>Do it</, 'no resubmission after a failure');
  // diff review L3: a double confirm is refused by the dialog itself (Settings has no step function of its own)
  assert.match(src('renderer/components/ConfirmDialog.tsx'), /onClick=\{\(\) => \{ if \(phase === null\) onConfirm\(\); \}\}/);
  for (const f of ['renderer/history/PurgeDialog.tsx', 'renderer/history/SuppressedPane.tsx', 'renderer/settings/Settings.tsx']) {
    assert.doesNotMatch(src(f), /<dialog ref/, `${f} uses ConfirmDialog`);
  }
});

test('item 2: routeResult: success closes an open dialog and is said beside the trigger; other results stay in the dialog or go beside it', () => {
  const text = (p: string) => `said ${p}`;
  assert.deepEqual(routeResult('ok', true, true, text), { close: true, done: true, dialog: null, note: 'said ok' });
  assert.deepEqual(routeResult('ok', true, false, text), { close: false, done: true, dialog: null, note: 'said ok' });
  assert.deepEqual(routeResult('bad', false, true, text), { close: false, done: false, dialog: 'bad', note: null });
  assert.deepEqual(routeResult('bad', false, false, text), { close: false, done: false, dialog: null, note: 'said bad' });
  assert.deepEqual(routePurge('purged', true), { close: true, done: true, dialog: null, note: purgeText('purged') });
  assert.deepEqual(routeReimport('ok', true), { close: true, done: true, dialog: null, note: reimportText('ok') });
  assert.equal(routeReimport('unavailable', false).note, 'The result is unavailable.', 'beside the trigger no dialog is left to close');
  assert.deepEqual(routeMove('moved', true), { close: true, done: true, dialog: null, note: moveText('moved'), refresh: true });
});

test('item 2: dialogStep: one request in flight; a result changes the dialog only while it shows that id', () => {
  const route = (r: 'ok' | 'bad', open: boolean) => routeResult(r, r === 'ok', open, (p) => p);
  let r = dialogStep({ shown: null, inflight: null, phase: null }, { type: 'open', id: 4 }, route);
  assert.deepEqual(r.s, { shown: 4, inflight: null, phase: null });
  r = dialogStep(r.s, { type: 'confirm' }, route);
  assert.equal(r.send, 4);
  assert.deepEqual(r.s, { shown: 4, inflight: 4, phase: 'applying' });
  assert.equal(dialogStep(r.s, { type: 'confirm' }, route).send, undefined, 'never twice');
  const reopened = dialogStep(dialogStep(r.s, { type: 'closed' }, route).s, { type: 'open', id: 7 }, route).s;
  assert.deepEqual(reopened, { shown: 7, inflight: 4, phase: 'applying' }, 'another dialog says Applying while one runs');
  const late = dialogStep(reopened, { type: 'result', id: 4, result: 'bad', dialogOpen: true }, route);
  assert.deepEqual(late, { s: { shown: 7, inflight: null, phase: null }, close: false, outcome: route('bad', false) }, "4's outcome goes beside its trigger");
  const own = dialogStep({ shown: 4, inflight: 4, phase: 'applying' }, { type: 'result', id: 4, result: 'ok', dialogOpen: true }, route);
  assert.deepEqual(own, { s: { shown: 4, inflight: null, phase: null }, close: true, outcome: route('ok', true) });
});

test('items 6, 7: the mode group uses nextFocus; groupLabel takes kindOf and the one base', () => {
  assert.equal('modeKey' in browse, false);
  // diff review L2: the mode group's Left/Right/Home/End go through the shared roving helper
  assert.match(src('renderer/history/SessionBrowser.tsx'), /nextFocus\(i, e\.key, MODES\.length, 'horizontal'\)/);
  assert.equal(base('/a/b/'), 'b');
  assert.equal(base('/'), '', 'the map says a blank name is unavailable');
  assert.equal(browse.groupLabel(({ group: { project: null, at: { cwd: '/' } }, project: null }) as never).label, '/', 'the Session list keeps the path, never a blank label');
  const node = (at: unknown, project: { name: string } | null = null) => ({ group: { project: null, at }, project }) as never;
  for (const [n, label, kind] of [
    [node(null, { name: 'P' }), 'P', 'project'], [node({ repo: '/r/x/.git', worktree: null }), 'x', 'repo'],
    [node({ repo: '/r/x/.git', worktree: '/r/x-wt' }), 'x-wt', 'worktree'], [node({ cwd: '/a/b' }), 'b', 'folder'],
  ] as const) {
    const l = browse.groupLabel(n);
    assert.deepEqual([l.label, l.kind], [label, kind]);
    assert.equal(l.kind, kindOf((n as { group: never }).group));
  }
  assert.doesNotMatch(src('renderer/history/browse.ts'), /const base = /);
  assert.match(src('renderer/history/SessionBrowser.tsx'), /holdsSessions\(/, 'the expandable check');
});

test('item 11: day() and the two dialog strings are defined once (model.ts)', () => {
  const t = Date.UTC(2026, 10, 22, 15);
  assert.equal(day(t), formatTime(t).slice(0, 10));
  assert.equal(APPLYING, 'Applying changes…');
  assert.equal(RESULT_UNAVAILABLE, 'The result is unavailable. Closing this dialog does not cancel the operation.');
  for (const f of renderer.filter((x) => x !== 'renderer/model.ts')) {
    const s = src(f);
    assert.doesNotMatch(s, /const day = /, f);
    assert.ok(!s.includes("'Applying changes…'") && !s.includes('Closing this dialog does not cancel the operation.'), `${f}: the strings come from model.ts`);
  }
});

test('item 13: one window title; the monthly quota table says 5-hour window and Window unknown', () => {
  assert.equal(windowTitle(300, 'Quota'), '5-hour window');
  assert.equal(windowTitle(7 * 1440, 'Quota'), '7-day window');
  assert.equal(windowTitle(90, 'Quota'), '90-minute window');
  assert.equal(windowTitle(null, 'Window unknown'), 'Window unknown');
  assert.equal(windowTitle(0, 'Quota'), '0-minute window', 'a zero window is never a day or hour window');
  const q = { month: '2026-11', scope: 1, label: null, agent: null, limitId: 'l', verified: true, peakPercent: 1, observations: 1 };
  assert.deepEqual(quotaRows([{ ...q, windowMinutes: 300 }, { ...q, windowMinutes: null }]).map((r) => r.window), ['5-hour window', 'Window unknown']);
  assert.doesNotMatch(src('renderer/history/monthly-view.ts'), /function windowText/);
});

test('item 15 and small cuts: shared constants defined once in ipc.ts; aliases and local copies gone', () => {
  assert.equal(QUERY_MAX_TERMS, 16);
  assert.equal(RETENTION_DEFAULT, 45);
  for (const l of ['busy', 'waiting-for-permission', 'needs-input'] as const) assert.equal(isActive(l), true, l);
  for (const l of ['idle', null] as const) assert.equal(isActive(l), false, String(l));
  assert.doesNotMatch(src('renderer/history/browse.ts'), /SEARCH_TERMS = /);
  assert.doesNotMatch(src('renderer/settings/retention-view.ts'), /DEFAULT_DAYS = /);
  assert.doesNotMatch(src('renderer/history/actions.ts'), /const ACTIVE/);
  assert.doesNotMatch(src('service/retention/policy.ts'), /RETENTION_DEFAULT = |export const isActive/);
  assert.doesNotMatch(src('service/search/query.ts'), /QUERY_MAX_TERMS = /);
  for (const f of renderer) assert.doesNotMatch(src(f), /\(typeof (SAVE|PURGE|REIMPORT)_RESULTS\)\[number\]/, `${f}: result aliases from ipc.ts`);
  assert.doesNotMatch(src('renderer/agent-map/tree.ts'), /const titleOf = /);
  const map = src('renderer/agent-map/AgentMap.tsx');
  assert.doesNotMatch(map, /rootsEmptyFlag/);
  assert.equal((map.match(/setFocusReq\(\(f\) =>/g) ?? []).length, 1, 'one focusTo');
});
