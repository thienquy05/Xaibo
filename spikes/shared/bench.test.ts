import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mulberry32, summary } from './bench.ts';

test('summary uses nearest-rank percentiles', () => {
  const s = summary(Array.from({ length: 100 }, (_, i) => 100 - i));
  assert.equal(s.p50, 50);
  assert.equal(s.p95, 95);
  assert.equal(s.p99, 99);
  assert.equal(s.max, 100);
  assert.equal(s.n, 100);
  assert.equal(s.mean, 50.5);
});

test('summary of a single sample is that sample', () => {
  assert.deepEqual(summary([7]), { n: 1, mean: 7, p50: 7, p95: 7, p99: 7, max: 7 });
});

test('summary rejects an empty sample set', () => {
  assert.throws(() => summary([]));
});

test('mulberry32 is deterministic per seed', () => {
  const take5 = (seed: number) => { const r = mulberry32(seed); return Array.from({ length: 5 }, r); };
  const a = take5(42);
  assert.deepEqual(a, take5(42));
  assert.notDeepEqual(a, take5(43));
  assert.ok(a.every((v) => v >= 0 && v < 1));
  assert.equal(new Set(a).size, 5);
});

