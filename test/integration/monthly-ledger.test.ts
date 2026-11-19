// XAIBO-PROD-523 (P5-T17a; design §6.1.1, US-20, FR-52; P5-T04 review L8): the monthly ledger is computed in a worker
// thread with its own read-only connection and cached. Requests share one run; a commit (invalidate), a month change or
// the maximum age recomputes; a store that cannot answer says failed. Privacy: the page carries no opaque key, account
// identity or profile root; a quota scope is labelled only while it is a current scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/service/store/db.ts';
import { answerMonthly, MonthlyCache } from '../../src/service/usage/ledger.ts';
import { profileKey, scopeKey } from '../../src/service/usage/monthly.ts';
import { parsePortMessage } from '../../src/shared/ipc.ts';

const SECRET = Buffer.alloc(32, 9);
const HOME = '/tmp/xaibo-fixture/home';
const ACCOUNT = 'acct-canary-0000-account-id'; // a usage scope key carrying an account-like identity: never in a page
const T = new Date(2026, 3, 15, 12).getTime(); // mid-April 2026, local time

async function store() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'xledger-')));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'codex', ?, 'manual')").run(`${HOME}/.codex-work`);
  db.prepare("INSERT INTO usage_scopes (scope_key, profile_id, agent, verified) VALUES (?, 'p1', 'codex', 1)").run(ACCOUNT);
  const pk = profileKey(SECRET, 'p1');
  const usage = db.prepare(`INSERT INTO monthly_usage (month, agent, profile_key, model_id, sessions, turns, requests, uncached_input, cache_read, cache_write, output, token_gaps,
    cost_micros, cost_full, cost_partial, cost_none, cost_pending, price_revisions) VALUES (?, 'codex', ?, 'model-a', 1, 2, 3, 100, 0, 0, 50, 0, 250000, 3, 0, 0, 0, '[1]')`);
  usage.run('2026-03', pk);
  db.prepare("INSERT INTO monthly_sessions (month, agent, profile_key, sessions) VALUES ('2026-03', 'codex', ?, 1)").run(pk);
  const peak = db.prepare('INSERT INTO monthly_quota_peaks (month, scope_key, limit_id, window_minutes, verified, peak_percent, observations, agent) VALUES (?, ?, ?, 300, 1, ?, 2, ?)');
  peak.run('2026-03', scopeKey(SECRET, ACCOUNT), 'primary', 61, 'codex');
  peak.run('2026-03', scopeKey(SECRET, 'gone-scope'), 'primary', 12, 'codex'); // its scope no longer exists
  return { dir, db, file: join(dir, 'xaibo.db'), pk, add: (month: string) => usage.run(month, pk) };
}
const req = (o: Partial<{ end: string | null; limit: number; agent: string | null; model: string | null }> = {}) =>
  ({ v: 1 as const, type: 'monthly' as const, id: 7, filter: { agent: o.agent ?? null, model: o.model ?? null }, end: o.end ?? null, limit: o.limit ?? 12 });
const months = (m: Awaited<ReturnType<typeof answerMonthly>>) => ('months' in m ? m.months.map((x) => x.month) : null);

test('answers from a worker run, cached; the reply passes the renderer parser; privacy canaries never appear', async () => {
  const s = await store();
  const cache = new MonthlyCache({ file: s.file, secret: SECRET, home: HOME, now: () => T });
  let done = false, tickDuring = false;
  const first = answerMonthly(cache, req());
  void first.then(() => { done = true; });
  setTimeout(() => { tickDuring = !done; }, 0);
  const r = await first;
  assert.ok(tickDuring, 'the service loop keeps running while the worker computes');
  assert.deepEqual(months(r), ['2026-03']);
  assert.ok(parsePortMessage(r), 'the reply passes the renderer parser');
  if (!('months' in r)) throw new Error('no page');
  assert.deepEqual(r.months[0]!.tokens, { uncachedInput: 100, cacheRead: 0, cacheWrite: 0, output: 50, total: 150, gaps: 0 });
  assert.deepEqual(r.quota.map((x) => [x.scope, x.label, x.peakPercent]).sort(), [[1, '~/.codex-work', 61], [2, null, 12]].sort());
  const json = JSON.stringify(r);
  for (const canary of [ACCOUNT, s.pk, scopeKey(SECRET, ACCOUNT), HOME]) assert.ok(!json.includes(canary), `no ${canary.slice(0, 12)}… in the page`);
  assert.equal(cache.runs, 1);
  await answerMonthly(cache, req());
  assert.equal(cache.runs, 1, 'served from the cache');
});

test('concurrent requests share one run; invalidate, a month change and the maximum age recompute', async () => {
  const s = await store();
  let now = T;
  const cache = new MonthlyCache({ file: s.file, secret: SECRET, home: HOME, now: () => now, maxAgeMs: 60_000 });
  const [a, b] = await Promise.all([answerMonthly(cache, req()), answerMonthly(cache, req())]);
  assert.deepEqual(months(a), months(b));
  assert.equal(cache.runs, 1, 'one worker run for both');
  s.add('2026-04');
  assert.deepEqual(months(await answerMonthly(cache, req())), ['2026-03'], 'cached until invalidated');
  cache.invalidate();
  assert.deepEqual(months(await answerMonthly(cache, req())), ['2026-03', '2026-04'], 'a commit makes the next request recompute');
  assert.equal(cache.runs, 2);
  now = new Date(2026, 4, 1, 0, 1).getTime(); // May: April is no longer month to date
  const may = await answerMonthly(cache, req());
  assert.equal(cache.runs, 3, 'a month change recomputes');
  assert.equal('months' in may && may.months.find((m) => m.month === '2026-04')!.monthToDate, false);
  now += 61_000;
  await answerMonthly(cache, req());
  assert.equal(cache.runs, 4, 'past the maximum age');
});

test('review M1/L5: a worker past its deadline is stopped and the reply says failed; a clock that went back recomputes', async () => {
  const s = await store();
  const logged: [string, object][] = [];
  const slow = new MonthlyCache({ file: s.file, secret: SECRET, home: HOME, now: () => T, timeoutMs: 1, log: (e, f) => logged.push([e, f]) });
  const r = await answerMonthly(slow, req());
  assert.equal('failed' in r && r.failed, true, 'a hung run never blocks the ledger');
  assert.deepEqual(logged, [['ledger_worker_failed', { code: 'timeout' }]], 'failed by the deadline; a fixed code only');
  let now = T;
  const cache = new MonthlyCache({ file: s.file, secret: SECRET, home: HOME, now: () => now });
  await answerMonthly(cache, req());
  now -= 10_000;
  await answerMonthly(cache, req());
  assert.equal(cache.runs, 2, 'a clock that went back recomputes');
});

test('a store that cannot answer says failed; the next request tries again', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'xledger-none-')));
  const cache = new MonthlyCache({ file: join(dir, 'xaibo.db'), secret: SECRET, home: HOME, now: () => T });
  const r = await answerMonthly(cache, req());
  assert.equal('failed' in r && r.failed, true);
  assert.ok(parsePortMessage(r));
  await answerMonthly(cache, req());
  assert.equal(cache.runs, 2, 'a failure is not cached');
});
