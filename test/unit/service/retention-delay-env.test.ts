// Gate 5 (U5 perf hook): XAIBO_RETENTION_DELAY_MS sets the wait before the first retention run, so a perf probe can
// overlap a real retention run. It is honoured only under XAIBO_PERF_TRACE=1 (test only) and only as a positive integer
// of milliseconds; anything else leaves boot's default (undefined).
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('retentionDelayFromEnv: a positive integer only with XAIBO_PERF_TRACE=1; otherwise undefined', async () => {
  const boot = await import('../../../src/service/boot.ts') as Record<string, unknown>;
  assert.equal(typeof boot.retentionDelayFromEnv, 'function', 'boot.retentionDelayFromEnv exists');
  const of = boot.retentionDelayFromEnv as (env: Record<string, string | undefined>) => number | undefined;
  assert.equal(of({ XAIBO_PERF_TRACE: '1', XAIBO_RETENTION_DELAY_MS: '1500' }), 1500);
  assert.equal(of({ XAIBO_RETENTION_DELAY_MS: '1500' }), undefined, 'ignored without the perf trace');
  assert.equal(of({ XAIBO_PERF_TRACE: '0', XAIBO_RETENTION_DELAY_MS: '1500' }), undefined);
  assert.equal(of({ XAIBO_PERF_TRACE: '1' }), undefined, 'absent');
  for (const bad of ['', '0', '-5', '1.5', '1e3', ' 15', '15ms', '0x10', '9007199254740993'])
    assert.equal(of({ XAIBO_PERF_TRACE: '1', XAIBO_RETENTION_DELAY_MS: bad }), undefined, JSON.stringify(bad));
  // review L: setTimeout clamps a delay above 2^31 - 1 ms to 1 ms, so a larger value is ignored
  assert.equal(of({ XAIBO_PERF_TRACE: '1', XAIBO_RETENTION_DELAY_MS: '2147483647' }), 2_147_483_647);
  assert.equal(of({ XAIBO_PERF_TRACE: '1', XAIBO_RETENTION_DELAY_MS: '2147483648' }), undefined);
});
