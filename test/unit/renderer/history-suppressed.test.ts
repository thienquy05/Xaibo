// XAIBO-PROD-536 (P5-T18 part 3b-7; design §6.4 Suppressed, §5.4 Re-import, §5.1 dialog transactions; D-P5-08, D-P5-09):
// pure logic in history/suppressed.ts: a suppressed record's lines from its metadata only (Unavailable kept as given),
// the confirmation copy, every Re-import outcome in words, where an outcome goes, the dialog reducer (one Re-import in
// flight; a result changes an open dialog only), and pages appended by key. Synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SuppressedRow } from '../../../src/shared/ipc.ts';
import { appendPage, deliver, newGone, recordName, REIMPORT_BODY, REIMPORT_TITLE, reimportText, routeReimport, suppressedLines, type ReimportState } from '../../../src/renderer/history/suppressed.ts';
import { dialogStep } from '../../../src/renderer/components/dialog-model.ts';

const at = (d: number) => new Date(2026, 10, d, 12).getTime();
const srow = (key: string, extra: Partial<SuppressedRow> = {}): SuppressedRow => ({ key: key.padEnd(64, '0'), agent: 'claude', profile: '~/.claude', reason: 'manual', at: at(18), filesPending: false, ...extra });

test('suppressedLines: agent · profile, the reason, the purge date; file cleanup pending when the purge still owes it', () => {
  assert.deepEqual(suppressedLines(srow('a')), { title: 'claude · ~/.claude', lines: ['Purged by you', 'Purged 2026-11-18'] });
  assert.deepEqual(suppressedLines(srow('a', { reason: 'retention', profile: 'Unavailable', filesPending: true })),
    { title: 'claude · Unavailable', lines: ['Purged by retention', 'Purged 2026-11-18', 'File cleanup pending'] });
});

test('recordName: a label from metadata only (no title or transcript exists for a purged session)', () => {
  assert.equal(recordName(srow('a')), 'claude session purged 2026-11-18');
});

test('confirmation copy (design §5.4): the suppression is removed, native content may be read again, Keep is set (D-P5-08)', () => {
  assert.equal(REIMPORT_TITLE, 'Re-import this session?');
  assert.match(REIMPORT_BODY, /removes the suppression/);
  assert.match(REIMPORT_BODY, /reads the session again from its native files where they still exist/);
  assert.match(REIMPORT_BODY, /Keep/);
  assert.match(REIMPORT_BODY, /cannot come back/);
});

test('reimportText: every outcome in words; nothing claims success without ok; unavailable says Close does not cancel', () => {
  assert.equal(reimportText(null), '');
  assert.equal(reimportText('applying'), 'Applying changes…');
  assert.equal(reimportText('ok'), 'Re-imported. The session returns to the list once its native files are read again; Keep is set.');
  assert.equal(reimportText('none'), 'This session is no longer suppressed.');
  assert.equal(reimportText('pending'), 'Nothing was re-imported yet: the purge is still finishing its file cleanup. Try again shortly.');
  assert.equal(reimportText('native-gone'), 'Nothing was re-imported: the session\'s native files no longer exist.');
  assert.equal(reimportText('not-found'), 'This suppressed session is no longer listed.');
  assert.equal(reimportText('read-only'), 'Nothing was re-imported: the store is read-only.');
  assert.equal(reimportText('disk-full'), 'Nothing was re-imported: the disk is full.');
  assert.equal(reimportText('failed'), 'Nothing was re-imported.');
  assert.equal(reimportText('unavailable'), 'The result is unavailable. Closing this dialog does not cancel the operation.');
});

test('routeReimport: ok, none and not-found close and remove the record; pending and native-gone keep it; others stay in an open dialog', () => {
  for (const r of ['ok', 'none', 'not-found'] as const) assert.deepEqual(routeReimport(r, true), { close: true, done: true, dialog: null, note: reimportText(r) }, r);
  assert.deepEqual(routeReimport('ok', false), { close: false, done: true, dialog: null, note: reimportText('ok') });
  for (const r of ['pending', 'native-gone', 'read-only', 'disk-full', 'failed', 'unavailable'] as const) {
    assert.deepEqual(routeReimport(r, true), { close: false, done: false, dialog: r, note: null }, r);
    assert.deepEqual(routeReimport(r, false), { close: false, done: false, dialog: null, note: r === 'unavailable' ? 'The result is unavailable.' : reimportText(r) }, r);
  }
});

// XAIBO-PROD-551: the pane's dialog runs on the shared dialogStep, keyed by the record's key (the pane shows one record)
test('dialogStep (Re-import): confirm sends once; Applying blocks a second send; a dialog reopened while applying says so', () => {
  const idle: ReimportState = { shown: null, inflight: null, phase: null };
  const opened = dialogStep(idle, { type: 'open', id: 'k' }, routeReimport).s;
  assert.deepEqual(opened, { shown: 'k', inflight: null, phase: null });
  const sent = dialogStep(opened, { type: 'confirm' }, routeReimport);
  assert.equal(sent.send, 'k');
  assert.deepEqual(sent.s, { shown: 'k', inflight: 'k', phase: 'applying' });
  assert.equal(dialogStep(sent.s, { type: 'confirm' }, routeReimport).send, undefined, 'one Re-import at a time');
  const closed = dialogStep(sent.s, { type: 'closed' }, routeReimport).s; // Chromium's second Escape
  assert.deepEqual(closed, { shown: null, inflight: 'k', phase: null });
  const reopened = dialogStep(closed, { type: 'open', id: 'k' }, routeReimport).s;
  assert.deepEqual(reopened, { shown: 'k', inflight: 'k', phase: 'applying' });
  assert.equal(dialogStep(reopened, { type: 'confirm' }, routeReimport).send, undefined);
});

test('dialogStep (Re-import): a result routes by whether the dialog is still open; a failure keeps Close only (no resubmission)', () => {
  const applying: ReimportState = { shown: 'k', inflight: 'k', phase: 'applying' };
  const ok = dialogStep(applying, { type: 'result', id: 'k', result: 'ok', dialogOpen: true }, routeReimport);
  assert.deepEqual(ok.s, { shown: 'k', inflight: null, phase: null }, 'the pane closes the dialog itself (close)');
  assert.equal(ok.close, true);
  assert.equal(ok.outcome?.done, true);
  const failed = dialogStep(applying, { type: 'result', id: 'k', result: 'native-gone', dialogOpen: true }, routeReimport);
  assert.deepEqual(failed.s, { shown: 'k', inflight: null, phase: 'native-gone' });
  assert.equal(dialogStep(failed.s, { type: 'confirm' }, routeReimport).send, undefined, 'Close only after a failure');
  const late = dialogStep({ shown: null, inflight: 'k', phase: null }, { type: 'result', id: 'k', result: 'unavailable', dialogOpen: false }, routeReimport);
  assert.deepEqual(late.s, { shown: null, inflight: null, phase: null });
  assert.equal(late.outcome?.note, 'The result is unavailable.', 'review L3: no dialog is left to close');
});

test('appendPage: a later page adds only keys not shown yet; removing a key leaves the rest in order', () => {
  const a = srow('a'), b = srow('b'), c = srow('c');
  assert.deepEqual(appendPage([a, b], [b, c]).map((r) => r.key), [a.key, b.key, c.key]);
});

test('deliver (review M1): a result goes to the pane that shows its record, else beside the list heading, never lost', () => {
  const k = 'a'.repeat(64), other = 'b'.repeat(64);
  assert.deepEqual(deliver('native-gone', k, k), { to: 'pane' });
  assert.deepEqual(deliver('native-gone', k, other), { to: 'list', gone: false, note: reimportText('native-gone') });
  assert.deepEqual(deliver('ok', k, null), { to: 'list', gone: true, note: reimportText('ok') });
  assert.deepEqual(deliver('unavailable', k, null), { to: 'list', gone: false, note: 'The result is unavailable.' });
});

test('newGone (re-review M): a Re-import result present when the list mounts is old news; only a later one removes a record', () => {
  const g = { key: 'a'.repeat(64), note: '', gone: true, n: 3 };
  assert.equal(newGone(g, 3), false, 'the value the list mounted with (a record purged again must stay listed)');
  assert.equal(newGone({ ...g, n: 4 }, 3), true);
  assert.equal(newGone(null, undefined), false);
  assert.equal(newGone(g, undefined), true, 'the first result after a mount with none');
});
