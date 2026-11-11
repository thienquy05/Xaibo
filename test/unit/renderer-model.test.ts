// XAIBO-PROD-110 (P1-T12): list state for the session list. First page replaces; Load more appends without duplicates;
// deltas update loaded rows and add new ones only inside the loaded window, which stays bounded (no virtualization
// before Phase 4). Order matches the service keyset: last activity descending (unknown last), then id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDelta, applyPage, compareRows, emptyList, formatTime, markers, PAGE } from '../../src/renderer/model.ts';
import type { SessionRow } from '../../src/shared/ipc.ts';

const r = (id: number, lastActivity: number | null, extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id, agent: 'claude', entrypoint: 'cli', cwd: `/tmp/xaibo-fixture/${id}`, title: null, lastActivity, drift: false, compressed: false, quarantined: 0, ...extra });
const ids = (s: { rows: SessionRow[] }) => s.rows.map((x) => x.id);

test('order: newest first, ties by id, unknown activity last', () => {
  assert.deepEqual([r(3, 5), r(1, null), r(2, 9), r(4, 5)].sort(compareRows).map((x) => x.id), [2, 3, 4, 1]);
});

test('first page replaces, Load more appends without duplicates and widens the window', () => {
  let s = applyPage(emptyList, { rows: [r(9, 1)], next: null }, false);
  s = applyPage(s, { rows: [r(1, 30), r(2, 20)], next: { lastActivity: 20, id: 2 } }, false);
  assert.deepEqual(ids(s), [1, 2]);
  assert.equal(s.loaded, true);
  s = applyPage(s, { rows: [r(2, 20), r(3, 10)], next: null }, true);
  assert.deepEqual(ids(s), [1, 2, 3]);
  assert.equal(s.next, null);
  assert.equal(s.capacity, 2 * PAGE);
});

test('a delta updates a loaded row and moves it up', () => {
  let s = applyPage(emptyList, { rows: [r(1, 30), r(2, 20)], next: null }, false);
  s = applyDelta(s, [r(2, 40, { drift: true })]);
  assert.deepEqual(ids(s), [2, 1]);
  assert.equal(s.rows[0]!.drift, true);
});

test('a new session is added inside the loaded window and ignored beyond it', () => {
  let s = applyPage(emptyList, { rows: [r(1, 30), r(2, 20)], next: { lastActivity: 20, id: 2 } }, false);
  s = applyDelta(s, [r(5, 25), r(6, 10)]);
  assert.deepEqual(ids(s), [1, 5, 2], 'id 6 sorts after the last loaded row and comes with Load more');
  s = applyPage(emptyList, { rows: [], next: null }, false);
  s = applyDelta(s, [r(7, 1)]);
  assert.deepEqual(ids(s), [7], 'everything is loaded, so new sessions always show');
});

test('the window stays bounded; trimmed rows come back through Load more', () => {
  let s = applyPage(emptyList, { rows: [], next: null }, false);
  s = applyDelta(s, Array.from({ length: PAGE + 5 }, (_, i) => r(i + 1, 1000 - i)));
  assert.equal(s.rows.length, PAGE);
  assert.deepEqual(s.next, { lastActivity: 1000 - (PAGE - 1), id: PAGE });
});

test('coverage markers are text plus glyph; time is local and readable', () => {
  assert.deepEqual(markers(r(1, 1)), []);
  assert.deepEqual(markers(r(1, 1, { drift: true, compressed: true, quarantined: 2 })).map((m) => m.text),
    ['Format drift', 'Compressed, not imported', '2 quarantined lines']);
  assert.ok(markers(r(1, 1, { quarantined: 1 }))[0]!.glyph.length > 0);
  assert.equal(markers(r(1, 1, { quarantined: 1 }))[0]!.text, '1 quarantined line');
  assert.equal(formatTime(new Date(2026, 0, 2, 3, 4, 5).getTime()), '2026-01-02 03:04');
  assert.equal(formatTime(null), 'Unknown');
});
