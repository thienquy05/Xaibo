// XAIBO-PROD-528 (P5-T18 part 2; design §6.6, §5.1, US-6, FR-11/FR-12; look D-P5-09): the Settings retention, Trash and
// Storage sections. Logic in retention-view.ts (draft from the stored setting, validation without clamping, save status in
// words, byte formatting, storage rows as shares of what Xaibo uses with Unavailable parts); markup through Settings.tsx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { RETENTION_MAX, type StorageReport } from '../../../src/shared/ipc.ts';
import { RETENTION_DEFAULT } from '../../../src/shared/ipc.ts';
import { draftOf, formatBytes, initialRetention, lastRunText, measureStorage, RANGE_ERROR, retentionReducer, saveText, settingOf, storageView, storageWhen, toSend,
  type RetentionAction, type RetentionState } from '../../../src/renderer/settings/retention-view.ts';

const loader = registerHooks({ load(url, context, nextLoad) {
  if (!url.endsWith('.tsx')) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
  }).outputText };
} });
const { Settings, RetentionSection } = await import(new URL('../../../src/renderer/settings/Settings.tsx', import.meta.url).href);
loader.deregister();

test('draftOf: the stored setting picks the radio; unreadable checks none', () => {
  assert.equal(RETENTION_DEFAULT, 45);
  assert.deepEqual(draftOf({ days: 45 }), { choice: 'default', days: '' });
  assert.deepEqual(draftOf('never'), { choice: 'never', days: '' });
  assert.deepEqual(draftOf({ days: 90 }), { choice: 'other', days: '90' });
  assert.deepEqual(draftOf(null), { choice: null, days: '' });
});

test('settingOf: whole days 1..RETENTION_MAX, never clamped; errors say how to fix it', () => {
  assert.deepEqual(settingOf({ choice: 'default', days: '' }), { value: { days: 45 } });
  assert.deepEqual(settingOf({ choice: 'never', days: '7' }), { value: 'never' });
  assert.deepEqual(settingOf({ choice: 'other', days: ' 90 ' }), { value: { days: 90 } });
  assert.deepEqual(settingOf({ choice: 'other', days: '1' }), { value: { days: 1 } });
  assert.deepEqual(settingOf({ choice: 'other', days: String(RETENTION_MAX) }), { value: { days: RETENTION_MAX } });
  const range = `Enter a whole number of days from 1 to ${RETENTION_MAX}.`;
  for (const bad of ['', '0', '-3', '2.5', '1e2', 'abc', String(RETENTION_MAX + 1), '99999999999999999999']) {
    assert.deepEqual(settingOf({ choice: 'other', days: bad }), { error: range }, bad);
  }
  assert.deepEqual(settingOf({ choice: null, days: '' }), { error: 'Choose how long to keep inactive history.' });
});

test('saveText: every outcome in words; failures say nothing changed', () => {
  assert.equal(saveText(null), '');
  assert.equal(saveText('applying'), 'Saving…');
  assert.equal(saveText('saved'), 'Saved.');
  assert.match(saveText('invalid'), /^Not saved:/);
  assert.equal(saveText('read-only'), 'Not saved: the store is read-only.');
  assert.equal(saveText('disk-full'), 'Not saved: the disk is full.');
  assert.equal(saveText('failed'), 'Not saved. Nothing was changed.');
  assert.match(saveText('unavailable'), /unavailable/i);
});

test('lastRunText: the last run time, or that none ran yet', () => {
  const at = new Date(2026, 10, 19, 14, 2).getTime();
  assert.equal(lastRunText(at), 'Last retention run: 2026-11-19 14:02');
  assert.equal(lastRunText(null), 'No retention run yet.');
});

test('formatBytes: decimal units, three significant digits, never 1000 of a unit', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(2_100_000), '2.1 MB');
  assert.equal(formatBytes(41_000_000), '41 MB');
  assert.equal(formatBytes(896_400_000), '896 MB');
  assert.equal(formatBytes(1_420_000_000), '1.42 GB');
  assert.equal(formatBytes(999_960), '1 MB'); // 999.96 KB rounds to 1000 KB: the next unit
  assert.equal(formatBytes(300_000), '300 KB');
});

const report: StorageReport = {
  measuredAt: new Date(2026, 10, 19, 14, 1).getTime(),
  files: { database: 896_000_000, wal: 41_000_000, contentChunks: 437_000_000, spool: 2_100_000, backups: null },
  total: 1_420_000_000,
  database: { bytes: 896_000_000, categories: { content: 520_000_000, search: 241_000_000, usage: 84_000_000, prices: 300_000, other: 19_000_000, free: 32_000_000 } },
};

test('storageView: parts as shares of the reported total; unmeasured parts Unavailable with no share', () => {
  const v = storageView(report);
  assert.equal(v.total, '1.42 GB');
  assert.equal('measured' in v, false, 'the time line is storageWhen()');
  assert.deepEqual(v.disk.map((r) => r.label), ['Database', 'Write-ahead log', 'Content files', 'Spool', 'Backups']);
  assert.deepEqual(v.disk.map((r) => r.text), ['896 MB', '41 MB', '437 MB', '2.1 MB', 'Unavailable']);
  assert.equal(v.disk[0].share, 896 / 1420 * 100);
  assert.equal(v.disk[4].share, null);
  assert.deepEqual(v.inside?.map((r) => r.label), ['Sessions and content', 'Search index', 'Usage, context and cost', 'Prices', 'Other', 'Free space (reusable)']);
  assert.equal(v.inside?.[0].share, 520 / 896 * 100); // inside the database: a share of the database pages
});

test('storageView: no report, no total or no database breakdown read Unavailable, never a guessed sum', () => {
  const none = storageView(null);
  assert.equal(none.total, 'Unavailable');
  assert.deepEqual(none.disk, []);
  assert.equal(none.inside, null);
  const partial = storageView({ ...report, total: null, database: null });
  assert.equal(partial.total, 'Unavailable');
  assert.equal(partial.inside, null);
  assert.ok(partial.disk.every((r) => r.share === null), 'no share without a measured total');
  assert.equal(partial.disk[0].text, '896 MB'); // the measured part itself is still shown
  const zero = storageView({ ...report, total: 0, files: { database: 0, wal: 0, contentChunks: 0, spool: 0, backups: 0 }, database: null });
  assert.ok(zero.disk.every((r) => r.share === null), 'no division by a zero total');
});

// review M1/L1-L4 (security review of run 159): the section's state as a pure reducer
const at = (s: RetentionState, ...as: RetentionAction[]) => as.reduce(retentionReducer, s);
const ready = at(initialRetention, { type: 'loaded', setting: { days: 45 }, lastRunAt: null });

test('review M1: no change while a Save is applying; a reply for an older Save is ignored', () => {
  const applying = at(ready, { type: 'change', draft: { choice: 'other', days: '90' } }, { type: 'save' });
  assert.equal(applying.phase, 'applying');
  assert.deepEqual(applying.pending, { seq: applying.seq, value: { days: 90 } });
  const tried = at(applying, { type: 'change', draft: { choice: 'never', days: '90' } });
  assert.equal(tried, applying, 'the choice is frozen while applying');
  assert.equal(at(applying, { type: 'save' }), applying, 'no second Save while applying');
  const done = at(applying, { type: 'saved', seq: applying.seq, result: 'saved' });
  assert.equal(done.phase, 'saved');
  assert.equal(done.pending, null);
  assert.deepEqual(done.loaded, { setting: { days: 90 }, lastRunAt: null });
  assert.equal(at(done, { type: 'saved', seq: applying.seq - 1, result: 'failed' }), done, 'a stale reply changes nothing');
});

test('review L1: a Save after a failed load keeps the last run unknown, never "no run yet"', () => {
  const s = at(initialRetention, { type: 'loadFailed' }, { type: 'change', draft: { choice: 'never', days: '' } }, { type: 'save' });
  const done = at(s, { type: 'saved', seq: s.seq, result: 'saved' });
  assert.deepEqual(done.loaded, { setting: 'never', lastRunAt: undefined });
  assert.equal(lastRunText(undefined), 'Last retention run: Unavailable');
});

test('review L2/L4: a failed Save shows the error first, then asks for focus on the invalid control', () => {
  const empty = at(ready, { type: 'change', draft: { choice: 'other', days: '' } }, { type: 'save' });
  assert.equal(empty.error, RANGE_ERROR);
  assert.equal(empty.phase, null);
  assert.deepEqual(empty.focus, { target: 'days', n: 1 });
  assert.equal(empty.announce, '', 'focus reads the error through aria-describedby: no second announcement');
  const none = at(initialRetention, { type: 'loaded', setting: null, lastRunAt: null }, { type: 'save' });
  assert.equal(none.error, 'Choose how long to keep inactive history.');
  assert.deepEqual(none.focus, { target: 'first', n: 1 });
  assert.deepEqual(at(none, { type: 'save' }).focus, { target: 'first', n: 2 }, 'each failed Save asks again');
});

test('review L3: a late load reply never overwrites a choice the user already made', () => {
  const s = at(initialRetention, { type: 'change', draft: { choice: 'never', days: '' } }, { type: 'loaded', setting: { days: 45 }, lastRunAt: 5 });
  assert.deepEqual(s.draft, { choice: 'never', days: '' });
  assert.deepEqual(s.loaded, { setting: { days: 45 }, lastRunAt: 5 });
  assert.deepEqual(ready.draft, { choice: 'default', days: '' }, 'untouched: the stored value is shown');
});

test('blur: shows a new error once (announced); a correction clears it', () => {
  const bad = at(ready, { type: 'change', draft: { choice: 'other', days: '0' } });
  assert.equal(bad.error, null, 'not while typing');
  const blurred = at(bad, { type: 'blur' });
  assert.equal(blurred.error, RANGE_ERROR);
  assert.equal(blurred.announce, RANGE_ERROR);
  assert.equal(at(blurred, { type: 'blur' }).announce, RANGE_ERROR);
  const fixed = at(blurred, { type: 'change', draft: { choice: 'other', days: '30' } });
  assert.equal(fixed.error, null);
  assert.equal(fixed.announce, '');
});

test('review L5: a failed refresh that returns the last report says how old it is', () => {
  assert.equal(storageWhen({ report, failed: true }), 'Storage could not be measured. Showing the measurement from 2026-11-19 14:01.');
  assert.equal(storageWhen({ report: null, failed: true }), 'Storage could not be measured.');
  assert.equal(storageWhen({ report, failed: false }), 'Measured 2026-11-19 14:01');
  assert.equal(storageWhen({ report: null, failed: false }), 'Not measured');
});

test('measureStorage: always asks for a measurement (refresh=false only returns the last one); a lost reply is failed', async () => {
  const asked: boolean[] = [];
  const got = await measureStorage({ storage: (refresh: boolean) => { asked.push(refresh); return Promise.resolve({ report, failed: false }); } });
  assert.deepEqual(asked, [true]);
  assert.deepEqual(got, { report, failed: false });
  assert.deepEqual(await measureStorage({ storage: () => Promise.reject(new Error('gone')) }), { report: null, failed: true });
});

const api = {
  clearUsage: () => Promise.resolve('cleared' as const),
  retention: () => Promise.resolve({ setting: { days: 45 }, lastRunAt: null }),
  setRetention: () => Promise.resolve('saved' as const),
  storage: () => Promise.resolve({ report, failed: false }),
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('Settings: retention, Trash, Storage and Usage history sections in design §6.6 order', () => {
  const html = renderToStaticMarkup(createElement(Settings, { api, readOnly: false }));
  const order = ['Session retention', 'Trash', 'Storage', 'Usage history'].map((h) => html.indexOf(`>${h}</h2>`));
  assert.ok(order.every((i) => i > 0), `headings ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const t = text(html);
  assert.match(t, /Live sessions and sessions marked Keep are never purged/);
  assert.match(html, /<fieldset[^>]*>\s*<legend[^>]*>Purge inactive history after<\/legend>/);
  for (const label of ['45 days \\(default\\)', 'Never', 'Other']) assert.match(t, new RegExp(label));
  assert.match(html, /type="radio"/);
  assert.match(t, /emptied 30 days after/);
  assert.match(t, /Keep and Never above do not change this/);
  assert.match(t, /Storage used/);
  assert.match(t, /kept for 45 days/);
  assert.match(t, /monthly totals do not expire/);
  assert.match(html, /aria-live="polite"/);
});

test('E2E-found: a field error appears below Save, so showing it on blur never moves Save away from a click', () => {
  assert.equal(typeof RetentionSection, 'function', 'RetentionSection is exported');
  const shown = at(ready, { type: 'change', draft: { choice: 'other', days: '' } }, { type: 'blur' });
  const html = renderToStaticMarkup(createElement(RetentionSection, { api, readOnly: false, initial: shown }));
  const save = html.indexOf('>Save</button>'), err = html.indexOf('class="x-error"');
  assert.ok(save > 0 && err > 0, 'both rendered');
  assert.ok(err > save, 'the error follows the Save row');
  assert.match(html, /aria-invalid="true"/);
});

test('re-review L-A: the request follows the reducer\'s pending Save, once per seq (a Save during the reply gap is sent)', () => {
  const first = at(ready, { type: 'change', draft: { choice: 'never', days: '' } }, { type: 'save' });
  assert.deepEqual(toSend(first, 0), { seq: 1, value: 'never' });
  assert.equal(toSend(first, 1), null, 'already sent');
  // the double-click race: the reply is queued, then Save; the reducer applies saved, then save
  const after = at(first, { type: 'saved', seq: 1, result: 'saved' }, { type: 'save' });
  assert.deepEqual(after.pending, { seq: 2, value: 'never' });
  assert.deepEqual(toSend(after, 1), { seq: 2, value: 'never' }, 'the new pending Save is sent, never left Saving… forever');
  assert.equal(toSend(ready, 0), null);
});

test('re-review L-B/L-C: the error line is reserved (nothing below moves); the choices are disabled while applying', () => {
  const plain = renderToStaticMarkup(createElement(RetentionSection, { api, readOnly: false, initial: ready }));
  assert.match(plain, /<p class="x-error"[^>]*><\/p>/, 'an empty reserved error line');
  assert.doesNotMatch(plain, /<p class="x-error"[^>]*id=/, 'no id (nothing references it) while empty');
  assert.doesNotMatch(plain, /<fieldset[^>]*disabled/);
  const applying = at(ready, { type: 'change', draft: { choice: 'never', days: '' } }, { type: 'save' });
  const busy = renderToStaticMarkup(createElement(RetentionSection, { api, readOnly: false, initial: applying }));
  assert.match(busy, /<fieldset[^>]*disabled=""/);
});

test('Settings: a read-only store disables retention Save and says why', () => {
  const html = renderToStaticMarkup(createElement(Settings, { api, readOnly: true }));
  const save = html.match(/<button[^>]*>Save<\/button>/);
  assert.ok(save, 'a Save button');
  assert.match(save![0], /disabled/);
  assert.match(text(html), /Unavailable while the store is read-only/);
});
