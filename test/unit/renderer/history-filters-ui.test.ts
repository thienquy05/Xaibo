// XAIBO-PROD-555 (D-P5-17 part 2; design §6.4 Filters, §6.1.1 month -> retained sessions; semantics D-P6-05): the Session
// list query's cwd, date range, state and model reach the service filter only when set; the plain All view is only the
// unfiltered one; a ledger month and two date-input values become local-midnight [from, to) bounds.
process.env.TZ = 'America/New_York'; // a zone with DST: bounds are local midnights, not UTC
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayRange, filterOf, initialQuery, isPlain, listTexts, monthRange } from '../../../src/renderer/history/browse.ts';

test('filterOf passes each set filter and omits the unset ones', () => {
  assert.deepEqual(filterOf(initialQuery), { mode: 'all', agent: null, project: null, folder: null });
  const q = { ...initialQuery, cwd: '/w/app', from: 1, to: 2, state: 'kept' as const, model: 'm-a' };
  assert.deepEqual(filterOf(q), { mode: 'all', agent: null, project: null, folder: null, cwd: '/w/app', from: 1, to: 2, state: 'kept', model: 'm-a' });
  assert.deepEqual(filterOf({ ...initialQuery, state: 'native-deleted' }), { mode: 'all', agent: null, project: null, folder: null, state: 'native-deleted' });
});

test('isPlain only without any filter', () => {
  assert.equal(isPlain(initialQuery), true);
  for (const extra of [{ cwd: '/w' }, { from: 1, to: 2 }, { state: 'pinned' as const }, { model: 'm' }]) assert.equal(isPlain({ ...initialQuery, ...extra }), false, JSON.stringify(extra));
});

test('monthRange: the local month as [first midnight, next month first midnight)', () => {
  assert.deepEqual(monthRange('2026-11'), { from: new Date(2026, 10, 1).getTime(), to: new Date(2026, 11, 1).getTime() });
  assert.deepEqual(monthRange('2026-12'), { from: new Date(2026, 11, 1).getTime(), to: new Date(2027, 0, 1).getTime() });
  for (const bad of ['2026-13', '2026-1', 'x', '']) assert.equal(monthRange(bad), null, bad);
});

test('dayRange: From and To date inputs as [From midnight, the day after To); both or neither, in order', () => {
  assert.deepEqual(dayRange('2026-11-01', '2026-11-03'), { from: new Date(2026, 10, 1).getTime(), to: new Date(2026, 10, 4).getTime() });
  assert.deepEqual(dayRange('2026-03-08', '2026-03-08'), { from: new Date(2026, 2, 8).getTime(), to: new Date(2026, 2, 9).getTime() }, 'a DST day is one calendar day');
  assert.equal(dayRange('', ''), null, 'no range');
  for (const [a, b] of [['2026-11-03', '2026-11-01'], ['2026-11-01', ''], ['', '2026-11-01'], ['2026-02-30', '2026-03-01'],
    ['1969-12-31', '1970-01-02'], ['0050-01-01', '0050-01-02']]) assert.equal(dayRange(a, b), undefined, `${a}..${b}: invalid`); // review M2: never a negative bound the service refuses
});

test('listTexts: any Session list filter gives the filtered empty text (review L3)', () => {
  const live = { loaded: true, failed: false, more: false };
  for (const extra of [{ cwd: '/w' }, { from: 1, to: 2 }, { state: 'kept' as const }, { model: 'm' }]) {
    assert.equal(listTexts({ ...initialQuery, ...extra }, live).empty, 'No sessions match these filters.', JSON.stringify(extra));
    assert.equal(listTexts({ ...initialQuery, mode: 'trash', ...extra }, live).empty, 'No sessions match these filters.');
  }
  assert.equal(listTexts(initialQuery, live).empty, 'No sessions yet.');
});
