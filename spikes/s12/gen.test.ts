import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCorpus, checkLive, checkUsage, corpusPlan, corpusStats, LIVE, liveSizes, MB, SCALE, TextPool, usagePlan } from './gen.ts';

// Personal-usage profile (owner decision 2026-11-10): ~1,500 sessions, §6.6 shape capped at 50 MB.
test('corpus plan meets the declared personal size shape', () => {
  const plan = corpusPlan();
  assert.deepEqual(checkCorpus(plan), []);
  const s = corpusStats(plan.sizes);
  assert.equal(s.n, 1_500);
  assert.equal(s.maxBytes, 50 * MB);
});

test('corpus self-check fails with a deliberately wrong size parameter', () => {
  assert.ok(checkCorpus(corpusPlan({ medianBytes: 20_000 })).length > 0);
  assert.ok(checkCorpus(corpusPlan({ maxBytes: 200 * MB })).length > 0);
  assert.ok(checkCorpus(corpusPlan({ sessions: 10_000 })).length > 0);
});

test('live stream: personal 5 sessions at 20/s with bursts to 50/s; a wrong mean fails', () => {
  assert.deepEqual(checkLive(liveSizes(), LIVE), []);
  assert.ok(checkLive(liveSizes({ meanBytes: 40_960 }), LIVE).length > 0);
  assert.ok(checkLive(liveSizes({ burstPerS: 200 }), LIVE).length > 0);
});

test('scale probe: 15 sessions at 60/s with bursts to 150/s; personal plan fails the scale declaration', () => {
  assert.deepEqual(checkLive(liveSizes(SCALE), SCALE), []);
  assert.ok(checkLive(liveSizes(), SCALE).length > 0);
});

test('usage plan: 2 streams x 64,800 minute samples plus 1% transitions', () => {
  assert.deepEqual(checkUsage(usagePlan()), []);
  assert.equal(usagePlan().streams.length, 2);
  assert.ok(checkUsage(usagePlan({ minutes: 6_480 })).length > 0);
});

test('text pool has the declared CJK/emoji fraction and slices exact UTF-8 byte lengths', () => {
  const pool = new TextPool();
  assert.deepEqual(pool.check(), []);
  for (const n of [1, 10, 4096, 300_000]) {
    const len = Buffer.byteLength(pool.slice(Math.random, n));
    assert.ok(len <= n && len >= n - 3, `${n} -> ${len}`);
  }
});
