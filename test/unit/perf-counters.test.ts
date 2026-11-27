// XAIBO-PROD-552 (D-P5-20/22 investigation, Codex round 2): content-free service counters for the perf trace. Changes
// found by the reconciliation scan vs by a watch callback, sync failures and the in-flight count, writer commits with
// SQL vs callback time; takePerf() resets only the per-interval sums and maxima.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { counters, takePerf, timed } from '../../src/service/perf-counters.ts';
import { Watcher, type Closable } from '../../src/service/watch.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }); // Gate 6 G6F-2: no leaked temp folders
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { claudeProfile } from '../helpers/claude-profile.ts';
import { envelope, hookStore } from '../helpers/hook-store.ts';

test('takePerf: the counters plus per-interval timing; only the interval sums and maxima reset', () => {
  takePerf();
  timed('sql', 5); timed('sql', 2); timed('callback', 3);
  const a = takePerf();
  assert.deepEqual([a.sqlMs, a.sqlMaxMs, a.callbackMs, a.callbackMaxMs], [7, 5, 3, 3]);
  const b = takePerf();
  assert.deepEqual([b.sqlMs, b.sqlMaxMs, b.callbackMs, b.callbackMaxMs], [0, 0, 0, 0]);
  assert.equal(b.commits, a.commits, 'counters are cumulative');
  assert.ok(Object.values(b).every((v) => typeof v === 'number'), 'numbers only: no content');
});

test('Watcher: a change found by the scan counts scanChanges; one reported by a watch callback counts watchChanges', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xperf-'));
  dirs.push(dir);
  const f = join(dir, 'a.jsonl');
  writeFileSync(f, 'x\n');
  const callbacks: (() => void)[] = [];
  const watch = (_p: string, cb: () => void): Closable => { callbacks.push(cb); return { close: () => undefined, on: () => undefined }; };
  const w = new Watcher({ list: async () => [{ path: f }], onChange: () => undefined, watch, now: () => Date.now() });
  await w.start();
  const scan0 = counters.scanChanges, watch0 = counters.watchChanges;
  appendFileSync(f, 'y\n');
  await w.scan();
  assert.equal(counters.scanChanges, scan0 + 1);
  assert.ok(callbacks.length > 0, 'fixture: an active file is watched');
  callbacks[0]!();
  assert.equal(counters.watchChanges, watch0 + 1);
  w.stop();
});

test('a failed sync counts syncFailures and leaves nothing in flight', async () => {
  const p = await claudeProfile(['usage-basic']);
  p.writer.enqueue = () => Promise.reject(Object.assign(new Error('database or disk is full'), { code: 'ENOSPC' }));
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  const failed0 = counters.syncFailures, started0 = counters.syncsStarted, pending0 = counters.syncsPending;
  await a.backfill(); // each failed sync is caught and left to the next change or scan
  assert.ok(counters.syncsStarted > started0);
  assert.ok(counters.syncFailures > failed0);
  assert.equal(counters.syncsPending, pending0, 'none left in flight');
});

test('a writer commit counts commits and times SQL and the commit callbacks apart', async () => {
  const h = await hookStore();
  takePerf();
  const commits0 = counters.commits;
  await h.intake.deliver(envelope());
  const t = takePerf();
  assert.equal(t.commits, commits0 + 1);
  assert.ok(t.sqlMs >= 0 && t.sqlMaxMs >= 0 && t.callbackMs >= 0);
});
