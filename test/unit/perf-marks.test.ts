// XAIBO-PROD-112 (P1-T14, M3): the first-usable-page mark is set once, two frames after the first commit with at least
// one row; long frames above 100 ms become measures (LoAF preferred, longtask fallback). Injected frame scheduler,
// mark and PerformanceObserver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_PAGE_MARK, firstUsablePage, watchLongFrames } from '../../src/renderer/perf-marks.ts';

test('mark once, two frames after the first commit with a row', () => {
  const frames: (() => void)[] = [];
  const marks: string[] = [];
  const commit = firstUsablePage({ raf: (cb) => { frames.push(cb); }, mark: (n) => { marks.push(n); } });
  commit(0);
  assert.equal(frames.length, 0, 'no row yet');
  commit(3);
  commit(4); // a second commit before the frames run schedules nothing more
  assert.equal(frames.length, 1);
  frames.shift()!();
  assert.deepEqual(marks, []);
  assert.equal(frames.length, 1, 'the second frame');
  frames.shift()!();
  assert.deepEqual(marks, [FIRST_PAGE_MARK]);
  commit(9);
  assert.equal(frames.length, 0);
  assert.deepEqual(marks, [FIRST_PAGE_MARK]);
});

function fakeObserver(supported: string[]) {
  const observers: { type?: string; cb: (list: { getEntries(): { startTime: number; duration: number }[] }) => void }[] = [];
  class PO {
    static supportedEntryTypes = supported;
    #o: (typeof observers)[number];
    constructor(cb: (typeof observers)[number]['cb']) { this.#o = { cb }; observers.push(this.#o); }
    observe(opts: { type: string; buffered: boolean }) { this.#o.type = opts.type; assert.equal(opts.buffered, true); }
  }
  const emit = (entries: { startTime: number; duration: number }[]) => observers.forEach((o) => o.cb({ getEntries: () => entries }));
  return { PO, observers, emit };
}

test('long frames above 100 ms are recorded; LoAF preferred over longtask', () => {
  const f = fakeObserver(['longtask', 'long-animation-frame']);
  const seen: [number, number][] = [];
  assert.equal(watchLongFrames((s, d) => seen.push([s, d]), f.PO), 'long-animation-frame');
  assert.equal(f.observers.length, 1);
  f.emit([{ startTime: 1, duration: 50 }, { startTime: 2, duration: 100 }, { startTime: 3, duration: 180 }]);
  assert.deepEqual(seen, [[3, 180]]);
});

test('longtask fallback; nothing when unsupported', () => {
  const f = fakeObserver(['longtask']);
  assert.equal(watchLongFrames(() => {}, f.PO), 'longtask');
  assert.equal(f.observers[0]!.type, 'longtask');
  assert.equal(watchLongFrames(() => {}, fakeObserver(['paint']).PO), null);
  assert.equal(watchLongFrames(() => {}, undefined), null);
});
