// Gate 5 TP retention probe (run 179; design review 3029): the purge's event batches held the service thread ~95% of a
// retention run (p95 1.3 s, max 4.2 s per batch), so live updates waited seconds. Event batches are capped by stored
// bytes, and every purge transaction is paced per writer (min(2x its time, 250 ms)), so live intake keeps most of the
// thread whatever number of purge loops run. Pure parts here; the TP retention probe measures the effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('pauseMs: three times the transaction time, capped at 250 ms; 0 (a setImmediate yield) under 1 ms', async () => {
  const p = await import('../../../src/service/history/purge.ts') as Record<string, unknown>;
  assert.equal(typeof p.pauseMs, 'function', 'pauseMs exported');
  const pause = p.pauseMs as (ms: number) => number;
  assert.equal(pause(0.4), 0);
  assert.equal(pause(20), 60); // tuned on the TP retention probe: live M1 p95 232 ms during a purge at 3x, 529 ms at 2x
  assert.equal(pause(4179), 250, 'capped: a longer pause only idles past the M1 budget');
});

test('paced/paceWait: one busy-until time per writer; loops share it (max, not added); other writers are free', async () => {
  const p = await import('../../../src/service/history/purge.ts') as Record<string, unknown>;
  assert.equal(typeof p.paced, 'function', 'paced exported');
  assert.equal(typeof p.paceWait, 'function', 'paceWait exported');
  const paced = p.paced as (w: object, ms: number, now: number) => void;
  const wait = p.paceWait as (w: object, now: number) => number;
  const a = {}, b = {};
  assert.equal(wait(a, 1000), 0, 'nothing ran yet');
  paced(a, 20, 1000);
  assert.equal(wait(a, 1000), 60);
  assert.equal(wait(a, 1030), 30);
  assert.equal(wait(a, 1060), 0);
  paced(a, 20, 2000); paced(a, 5, 2000); // a second loop's shorter batch does not shorten the first one's pause
  assert.equal(wait(a, 2000), 60);
  assert.equal(wait(b, 2000), 0, 'per writer');
  // pacing review M1: a monotonic clock by default (a wall clock set back would stall every purge for the jump)
  const c = {};
  (paced as (w: object, ms: number) => void)(c, 20);
  const left = wait(c, performance.now());
  assert.ok(left > 0 && left <= 60, `default clock is performance.now (left ${left} ms)`);
});

test('EVENT_BATCH: sizes rows by stored bytes (content and raw), never loading a value to test it', async () => {
  const p = await import('../../../src/service/history/purge.ts') as Record<string, unknown>;
  const sql = String(p.EVENT_BATCH);
  assert.match(sql, /octet_length\(raw\)/, 'raw counts');
  assert.match(sql, /octet_length\(content\)/);
  // measured on Electron's SQLite 3.53: CAST(.. AS BLOB), <> '' and IS NOT NULL load the whole value; octet_length does not
  assert.doesNotMatch(sql, /CAST\(content AS BLOB\)|content <> ''|content IS NOT NULL/, 'no full-value loads');
});
