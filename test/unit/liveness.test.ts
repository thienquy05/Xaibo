// XAIBO-PROD-109 (P1-T11, EC-01): live only if the pid exists and its start time and executable match; otherwise
// stale; a pid alone never yields "ended". Fake process table for the pure function; the ps provider is checked on
// this test's own process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveness, parsePs, psLookup, type ProcessInfo } from '../../src/service/liveness.ts';
import { run, type RunOptions, type RunResult } from '../../src/service/spawn.ts';

const START = new Date(2026, 0, 1, 9, 30, 15).getTime(); // ps prints local time
const proc: ProcessInfo = { pid: 4242, startTime: START, executable: '/usr/local/bin/claude' };
const table = new Map([[proc.pid, proc]]);

test('EC-01: matching pid, start time and executable -> live', () => {
  assert.equal(liveness({ pid: 4242, startTime: START + 400, executable: 'claude' }, table), 'live');
});

test('EC-01: a reused pid (different start time) -> stale', () => {
  assert.equal(liveness({ pid: 4242, startTime: START - 60_000, executable: 'claude' }, table), 'stale');
  assert.equal(liveness({ pid: 4242, startTime: START + 1_000, executable: 'claude' }, table), 'stale');
});

test('EC-01: a different executable -> stale', () => {
  assert.equal(liveness({ pid: 4242, startTime: START, executable: '/bin/zsh' }, table), 'stale');
});

test('EC-01: gone, or a record with only a pid -> stale, never ended', () => {
  const results = [
    liveness({ pid: 1, startTime: START, executable: 'claude' }, table),
    liveness({ pid: 4242 }, table),
    liveness({ pid: 4242, startTime: START }, table),
    liveness({ pid: 4242, executable: 'claude' }, table),
  ];
  assert.deepEqual(results, ['stale', 'stale', 'stale', 'stale']);
});

test('parsePs reads a C-locale row, single-digit days included; garbage gives undefined', () => {
  assert.deepEqual(parsePs('  4242 Thu Jan  1 09:30:15 2026     /usr/local/bin/claude\n'), proc);
  assert.deepEqual(parsePs('4242 Sat Jan 10 09:30:15 2026 node'), { pid: 4242, startTime: new Date(2026, 0, 10, 9, 30, 15).getTime(), executable: 'node' });
  for (const bad of ['', '\n', 'PID STARTED COMMAND', '4242 yesterday claude', 'x Thu Jan  1 09:30:15 2026 claude']) assert.equal(parsePs(bad), undefined, bad);
});

test('psLookup: fixed argv and C locale, no shell; a failed or mismatched ps row gives undefined', async () => {
  const calls: unknown[] = [];
  const fake = (out: string, code = 0) => async (file: string, args: readonly string[], o: RunOptions): Promise<RunResult> => {
    calls.push({ file, args, env: o.env, bounded: o.timeoutMs > 0 && o.maxBytes > 0 });
    return { code, signal: null, stdout: Buffer.from(out), timedOut: false, overflow: false, error: false };
  };
  assert.deepEqual(await psLookup(4242, { run: fake('  4242 Thu Jan  1 09:30:15 2026     /usr/local/bin/claude\n') }), proc);
  assert.deepEqual(calls[0], { file: '/bin/ps', args: ['-o', 'pid=,lstart=,comm=', '-p', '4242'], env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }, bounded: true });
  assert.equal(await psLookup(4242, { run: fake('', 1) }), undefined, 'ps exits 1 for an absent pid');
  assert.equal(await psLookup(4242, { run: fake('  77 Thu Jan  1 09:30:15 2026 claude\n') }), undefined, 'another pid');
});

test('psLookup finds this process with a matching start time; invalid or absent pids give undefined', async (t) => {
  if ((await run('/bin/ps', ['-p', '1'], { timeoutMs: 2_000, maxBytes: 4096 })).error) return t.skip('/bin/ps cannot be executed here (Claude sandbox); runs in the unsandboxed gate suite');
  const me = await psLookup(process.pid);
  assert.ok(me);
  assert.equal(me.pid, process.pid);
  assert.ok(Math.abs(me.startTime - (Date.now() - process.uptime() * 1000)) < 2_000);
  assert.equal(liveness({ pid: process.pid, startTime: Date.now() - process.uptime() * 1000, executable: me.executable }, new Map([[me.pid, me]])), 'live');
  for (const pid of [0, -1, 1.5, Number.NaN, 2 ** 31]) assert.equal(await psLookup(pid), undefined, String(pid));
  assert.equal(await psLookup(99_999_999), undefined);
});
