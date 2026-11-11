// Gate 1 hotfix H5 (Codex 7, EC-60/M6): the sanctioned spawn module reports a child killed by a signal it did not send
// itself (the audit profile kills a process on its first non-loopback attempt) and logs it as a content-free code;
// its own timeout and overflow kills are not reported as external.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externallyKilled, run } from '../../src/service/spawn.ts';

const recorder = () => {
  const logged: [string, Record<string, unknown> | undefined][] = [];
  return { logged, log: { log: (event: string, fields?: Record<string, string | number | boolean | undefined>) => { logged.push([event, fields]); } } };
};

test('H5: a child killed by an outside signal is reported and logged as child_killed', async () => {
  const { logged, log } = recorder();
  const r = await run('/bin/sh', ['-c', 'kill -9 $$'], { timeoutMs: 5_000, maxBytes: 1024, log });
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(externallyKilled(r), true);
  assert.deepEqual(logged, [['child_killed', { error: 'SIGKILL' }]]);
});

test('H5: our own timeout kill and a normal exit are not reported as external', async () => {
  const { logged, log } = recorder();
  const slow = await run('/bin/sleep', ['5'], { timeoutMs: 100, maxBytes: 1024, log });
  assert.equal(slow.timedOut, true);
  assert.equal(externallyKilled(slow), false);
  const ok = await run('/bin/sh', ['-c', 'exit 3'], { timeoutMs: 5_000, maxBytes: 1024, log });
  assert.deepEqual([ok.code, ok.signal, externallyKilled(ok)], [3, null, false]);
  assert.deepEqual(logged, []);
});
