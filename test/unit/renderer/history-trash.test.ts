// XAIBO-PROD-534 (P5-T18 part 3b-5; design §6.4, §5.4, §5.1; D-P5-07, D-P5-09): Trash Restore and Purge. Pure logic in
// history/trash.ts: the Purge confirmation copy (§5.4: title, item count, suppression and Re-import effect, native files
// untouched, not forensic secure erasure), the outcome texts in words, where a result goes (purged or gone closes and
// removes the record; anything else stays in the open dialog with Close, or goes next to the trigger when the dialog was
// already closed), and the open session's Trash banner lines. Synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryRow } from '../../../src/shared/ipc.ts';
import { formatTime } from '../../../src/renderer/model.ts';
import { neighbourId, PURGE_BODY, PURGE_TITLE, purgeStep, purgeText, routePurge, trashBanner, type PurgeState } from '../../../src/renderer/history/trash.ts';

const at = (d: number) => new Date(2026, 10, d, 12).getTime();
const day = (ms: number) => formatTime(ms).slice(0, 10);
const hrow = (extra: Partial<HistoryRow> = {}): HistoryRow => ({ id: 5, agent: 'claude', entrypoint: null, origin: null, interactive: null, model: 'Model unavailable',
  cwd: null, title: null, lastActivity: at(5), drift: false, compressed: false, quarantined: 0, live: null, contextPct: null, costUsd: null,
  costCoverage: 'unavailable', tokens: null, tokensComplete: false, project: null, folder: null, pinned: false, archivedAt: null,
  trashedAt: at(6), trashPurgeAt: at(36), keep: false, purgeAt: null, ...extra });

test('the Purge confirmation copy (design §5.4)', () => {
  assert.equal(PURGE_TITLE, 'Purge Xaibo copy?');
  assert.match(PURGE_BODY, /^1 session\./); // review: one session per purge (no batch, D-P5-07)
  assert.match(PURGE_BODY, /Re-import/);
  assert.match(PURGE_BODY, /Native files are untouched\. This is logical deletion, not forensic secure erasure\./);
});

test('purge texts: every phase in words; busy names the per-minute cap (D-P5-07); unknown says closing does not cancel', () => {
  assert.equal(purgeText(null), '');
  assert.equal(purgeText('applying'), 'Applying changes…');
  assert.equal(purgeText('purged'), 'Purged. Only the Xaibo copy was removed; native files are untouched.');
  assert.equal(purgeText('not-found'), 'This session is no longer available.');
  assert.equal(purgeText('busy'), 'Nothing was purged: at most 10 purges a minute. Try again shortly.');
  assert.equal(purgeText('read-only'), 'Nothing was purged: the store is read-only.');
  assert.equal(purgeText('disk-full'), 'Nothing was purged: the disk is full.');
  assert.equal(purgeText('failed'), 'Nothing was purged.');
  assert.equal(purgeText('unavailable'), 'The result is unavailable. Closing this dialog does not cancel the operation.');
});

test('routePurge: purged or gone closes and removes; other results stay in the open dialog, or go next to the trigger', () => {
  assert.deepEqual(routePurge('purged', true), { close: true, gone: true, dialog: null, note: purgeText('purged') });
  assert.deepEqual(routePurge('not-found', true), { close: true, gone: true, dialog: null, note: purgeText('not-found') });
  assert.deepEqual(routePurge('purged', false), { close: false, gone: true, dialog: null, note: purgeText('purged') });
  for (const r of ['busy', 'read-only', 'disk-full', 'failed', 'unavailable'] as const) {
    assert.deepEqual(routePurge(r, true), { close: false, gone: false, dialog: r, note: null }, r);
    assert.deepEqual(routePurge(r, false), { close: false, gone: false, dialog: null, note: purgeText(r) }, `${r} after the dialog closed`);
  }
});

test('trashBanner: when it went to Trash and when Trash empties it; an unknown date is said, never guessed', () => {
  assert.deepEqual(trashBanner(hrow()), { trashed: `Moved to Trash ${day(at(6))}`, autoEmpty: `Auto-empty ${day(at(36))}` });
  assert.deepEqual(trashBanner(hrow({ trashPurgeAt: null })), { trashed: `Moved to Trash ${day(at(6))}`, autoEmpty: 'Auto-empty date unavailable' });
});

test('neighbourId: the following record, else the previous, else none (the list heading)', () => {
  const rows = [{ id: 3 }, { id: 2 }, { id: 1 }];
  assert.equal(neighbourId(rows, 3), 2);
  assert.equal(neighbourId(rows, 1), 2);
  assert.equal(neighbourId([{ id: 7 }], 7), null);
  assert.equal(neighbourId(rows, 99), null);
});

// review M1: one purge in flight at a time; a dialog reopened while one runs shows it applying and cannot send another;
// a late reply changes the dialog only while it still shows that session, and always routes the outcome
test('purgeStep: open, confirm once, results for the shown session only, unexpected close keeps the request', () => {
  const idle: PurgeState = { shown: null, inflight: null, phase: null };
  let r = purgeStep(idle, { type: 'open', id: 4 });
  assert.deepEqual(r.s, { shown: 4, inflight: null, phase: null });
  r = purgeStep(r.s, { type: 'confirm' });
  assert.equal(r.send, 4);
  assert.deepEqual(r.s, { shown: 4, inflight: 4, phase: 'applying' });
  assert.equal(purgeStep(r.s, { type: 'confirm' }).send, undefined, 'never twice');
  const closed = purgeStep(r.s, { type: 'closed' }).s; // Chromium closed it on a second Escape while applying
  assert.deepEqual(closed, { shown: null, inflight: 4, phase: null });
  const reopened = purgeStep(closed, { type: 'open', id: 7 }).s;
  assert.deepEqual(reopened, { shown: 7, inflight: 4, phase: 'applying' }, 'another purge waits for the one in flight');
  assert.equal(purgeStep(reopened, { type: 'confirm' }).send, undefined);
  const late = purgeStep(reopened, { type: 'result', session: 4, result: 'busy', dialogOpen: true });
  assert.deepEqual(late.s, { shown: 7, inflight: null, phase: null }, "A's busy never lands in B's dialog; B can be confirmed");
  assert.equal(late.close, false);
  assert.deepEqual(late.outcome, routePurge('busy', false), "A's outcome goes beside its trigger");
  const own = purgeStep({ shown: 4, inflight: 4, phase: 'applying' }, { type: 'result', session: 4, result: 'purged', dialogOpen: true });
  assert.deepEqual(own, { s: { shown: 4, inflight: null, phase: null }, close: true, outcome: routePurge('purged', true) });
  const failed = purgeStep({ shown: 4, inflight: 4, phase: 'applying' }, { type: 'result', session: 4, result: 'failed', dialogOpen: true });
  assert.deepEqual(failed.s, { shown: 4, inflight: null, phase: 'failed' });
  const goneElsewhere = purgeStep(reopened, { type: 'result', session: 4, result: 'purged', dialogOpen: true });
  assert.equal(goneElsewhere.close, false, "A's success never closes B's dialog");
  assert.equal(goneElsewhere.outcome?.gone, true);
});
