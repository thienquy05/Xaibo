// XAIBO-PROD-422 (P4-T09b; EC-56, design §5.2): an open item keeps at most 4 fetched text slices. Loading past the
// fourth evicts the earliest and remembers its cursor for Load previous; Load previous brings it back and evicts the
// farthest one at the end, whose cursor becomes the next Load more text. The continuation cursor always progresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendSlice, MAX_SLICES, openWindow, prependSlice, previousAt } from '../../../src/renderer/workspace/slice.ts';

const s = (n: number, next: number | null) => ({ text: `s${n}`, next });

test('a window opens empty (fetch from the cursor) or with a preview whose remainder starts at its end', () => {
  assert.deepEqual(openWindow('', 0), { slices: [], next: 0, earlier: [] });
  assert.deepEqual(openWindow('pre', 3), { slices: [{ at: 0, text: 'pre' }], next: 3, earlier: [] });
  assert.deepEqual(openWindow('', null), { slices: [], next: null, earlier: [] });
});

test('loading past four slices evicts the earliest; the cursor progresses and the window never exceeds four', () => {
  let w = openWindow('', 0);
  for (let i = 0; i < 6; i++) {
    const at = w.next!;
    w = appendSlice(w, at, s(i, (i + 1) * 10));
    assert.ok(w.slices.length <= MAX_SLICES);
    assert.ok(w.next! > at, 'progress');
  }
  assert.equal(MAX_SLICES, 4);
  assert.deepEqual(w.slices.map((x) => x.text), ['s2', 's3', 's4', 's5']);
  assert.deepEqual([w.earlier, w.next, previousAt(w)], [[0, 10], 60, 10]);
});

test('Load previous restores the latest evicted slice and evicts the farthest; Load more refetches it', () => {
  let w = openWindow('', 0);
  for (let i = 0; i < 6; i++) w = appendSlice(w, w.next!, s(i, (i + 1) * 10));
  w = prependSlice(w, previousAt(w)!, s(1, 20));
  assert.deepEqual(w.slices.map((x) => [x.at, x.text]), [[10, 's1'], [20, 's2'], [30, 's3'], [40, 's4']]);
  assert.deepEqual([w.earlier, w.next, previousAt(w)], [[0], 50, 0]);
  w = appendSlice(w, w.next!, s(5, 60));
  assert.deepEqual(w.slices.map((x) => x.at), [20, 30, 40, 50]);
  assert.deepEqual([w.earlier, w.next], [[0, 10], 60]);
});

test('a slice refetched where a shorter preview started is cut where the following slice starts (no repeated text)', () => {
  let w = openWindow('abc', 3); // a 3-unit preview; its remainder starts at 3
  for (let i = 0; i < 4; i++) w = appendSlice(w, 3 + i * 4, { text: 'wxyz', next: 7 + i * 4 });
  assert.deepEqual([w.earlier, w.slices[0]!.at], [[0], 3]);
  w = prependSlice(w, 0, { text: 'abcwxyz', next: 7 }); // the service's slice at 0 runs past the preview
  assert.deepEqual(w.slices.map((x) => [x.at, x.text]), [[0, 'abc'], [3, 'wxyz'], [7, 'wxyz'], [11, 'wxyz']]);
});

test('the end of the text leaves no next cursor; a prepend at the start leaves no earlier one', () => {
  let w = appendSlice(openWindow('', 0), 0, s(0, null));
  assert.deepEqual([w.next, previousAt(w)], [null, null]);
  w = openWindow('', 0);
  for (let i = 0; i < 5; i++) w = appendSlice(w, w.next!, s(i, i === 4 ? null : (i + 1) * 10));
  assert.deepEqual([w.earlier, w.next], [[0], null]);
  w = prependSlice(w, 0, s(0, 10));
  assert.deepEqual([w.slices.map((x) => x.at), w.earlier, w.next], [[0, 10, 20, 30], [], 40]);
});
