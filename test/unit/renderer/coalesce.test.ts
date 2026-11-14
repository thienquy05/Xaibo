// P4-T02 (S-29, M4/M12): the renderer's live-delta coalescer. Bounded by distinct sessions, latest value wins, one
// flush per animation frame; overflowing the bound drops the batch and asks for a cursor resync, so the final state is
// never lost (the store answers it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoalescer } from '../../../src/renderer/data/coalesce.ts';

function harness(max: number) {
  const frames: (() => void)[] = [];
  const flushed: { values: { id: number; v: number }[]; tags: number[] }[] = [];
  let resyncs = 0;
  const c = createCoalescer<{ id: number; v: number }>({
    max, schedule: (cb) => { frames.push(cb); },
    flush: (values, tags) => flushed.push({ values, tags }), resync: () => { resyncs++; },
  });
  const frame = () => frames.splice(0).forEach((f) => f());
  return { c, frames, flushed, frame, resyncs: () => resyncs };
}

test('10,000 deltas over 100 sessions: size stays within the bound, one frame, last value per session wins', () => {
  const h = harness(100);
  let maxSize = 0;
  for (let i = 0; i < 10_000; i++) { h.c.push(i % 100, { id: i % 100, v: i }); maxSize = Math.max(maxSize, h.c.size); }
  assert.ok(maxSize <= 100, `size ${maxSize}`);
  assert.equal(h.frames.length, 1, 'one flush scheduled per frame, however many deltas');
  h.frame();
  assert.equal(h.flushed.length, 1);
  const got = new Map(h.flushed[0]!.values.map((x) => [x.id, x.v]));
  assert.equal(got.size, 100);
  for (let k = 0; k < 100; k++) assert.equal(got.get(k), 9_900 + k, `session ${k} keeps its last value`);
  assert.equal(h.c.size, 0, 'emptied by the flush');
});

test('after a flush the next delta schedules a new frame; nothing pending schedules nothing', () => {
  const h = harness(10);
  h.c.push(1, { id: 1, v: 1 });
  h.frame();
  assert.equal(h.frames.length, 0);
  h.c.push(1, { id: 1, v: 2 });
  assert.equal(h.frames.length, 1);
  h.frame();
  assert.deepEqual(h.flushed.map((f) => f.values.map((x) => x.v)), [[1], [2]]);
});

test('more distinct sessions than the bound in one frame: the batch is dropped and one resync is requested', () => {
  const h = harness(10);
  for (let i = 0; i < 11; i++) h.c.push(i, { id: i, v: i });
  assert.ok(h.c.size <= 10);
  for (let i = 0; i < 1_000; i++) h.c.push(i, { id: i, v: i }); // still overflowed: held at zero, not growing
  assert.equal(h.c.size, 0);
  h.frame();
  assert.equal(h.resyncs(), 1);
  assert.equal(h.flushed.length, 0, 'no partial batch is applied');
  h.c.push(3, { id: 3, v: 3 }); // back to normal after the resync request
  h.frame();
  assert.deepEqual(h.flushed.map((f) => f.values), [[{ id: 3, v: 3 }]]);
});

test('perf-trace tags (delta ids) of every coalesced push reach the flush, bounded like the values', () => {
  const h = harness(4);
  h.c.push(1, { id: 1, v: 1 }, 7);
  h.c.push(1, { id: 1, v: 2 }, 8);
  h.c.push(2, { id: 2, v: 3 });
  h.frame();
  assert.deepEqual(h.flushed[0]!.tags, [7, 8]);
  for (let i = 0; i < 100; i++) h.c.push(1, { id: 1, v: i }, i + 100);
  h.frame();
  assert.ok(h.flushed[1]!.tags.length <= 64, 'tags are capped (trace only)');
});
