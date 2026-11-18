// XAIBO-PROD-512 (P5-T04; FR-52, EC-103 unit part): settlement freezes retained contributions into monthly totals inside
// the deleting transaction. Split batches equal one batch; the live view is the same before and after settle + delete;
// settled keys block replay and re-import while new contributions count; cost is per-request only (known subtotal,
// unavailable when none, price revision frozen); the tables hold only opaque keys.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { liveMonthly } from '../../../src/service/usage/monthly.ts';
import { settle } from '../../../src/service/usage/settle.ts';
import { dump, monthlyStore, removeSessions, reportedCost, request, scope, sample, SECRET, session, turn, tx } from '../../helpers/monthly.ts';

const NOV = Date.UTC(2026, 10, 10, 12), DEC = Date.UTC(2026, 11, 2, 12);

/** Two Claude sessions and one Codex session (with a counter reset) across November and December, plus quota samples. */
async function fixture() {
  const db = await monthlyStore();
  const a = session(db, { sid: 'sid-a', last: DEC });
  turn(db, a, 'a1', NOV, 'claude-x'); turn(db, a, 'a2', DEC, 'claude-x');
  request(db, a, { identity: 'a-r1', ts: NOV, model: 'claude-x', input: 10, read: 5, write: 2, output: 3, cost: { usd: 1, coverage: 'full', rev: 1 } });
  request(db, a, { identity: 'a-r2', ts: DEC, model: 'claude-x', input: 4, output: 1, write: null, cost: { usd: 0.5, coverage: 'partial', rev: 2 } });
  const b = session(db, { sid: 'sid-b', last: NOV });
  turn(db, b, 'b1', NOV, 'claude-x');
  request(db, b, { identity: 'b-r1', ts: NOV, model: 'claude-x', input: 1, output: 1, cost: { usd: null, coverage: 'none', rev: 1 } });
  request(db, b, { identity: 'b-r2', ts: NOV, model: 'claude-x', input: 2, output: 2 }); // not priced yet
  reportedCost(db, b, 9); // opaque: never in monthly cost
  const c = session(db, { profile: 'p2', sid: 'sid-c', last: NOV });
  turn(db, c, 'c1', NOV, 'gpt-y');
  request(db, c, { identity: '0:100', ts: NOV, model: 'gpt-y', input: 60, output: 40, cost: { usd: 2, coverage: 'full', rev: 1 } });
  request(db, c, { identity: '1:30', ts: NOV + 1000, model: 'gpt-y', input: 20, output: 10, cost: { usd: 0.25, coverage: 'full', rev: 1 } }); // after a counter reset
  const s = scope(db, 'scope-c', true);
  const q = [sample(db, s, { percent: 40, at: NOV }), sample(db, s, { percent: 70, at: NOV + 60_000 }), sample(db, s, { percent: 10, at: DEC })];
  return { db, a, b, c, q };
}
const view = (db: DatabaseSync) => liveMonthly(db, SECRET);
const claudeNov = (db: DatabaseSync) => view(db).usage.find((u) => u.month === '2026-11' && u.agent === 'claude')!;

test('the live view sums retained contributions: per-request deltas, turns, sessions, cost coverage and price revisions', async () => {
  const { db } = await fixture();
  const v = view(db);
  const nov = claudeNov(db);
  assert.deepEqual({ ...nov, profileKey: undefined }, {
    month: '2026-11', agent: 'claude', profileKey: undefined, modelId: 'claude-x', sessions: 2, turns: 2, requests: 3,
    uncachedInput: 13, cacheRead: 5, cacheWrite: 2, output: 6, tokenGaps: 0,
    costUsd: 1, costFull: 1, costPartial: 0, costNone: 1, costPending: 1, priceRevisions: [1],
  });
  const dec = v.usage.find((u) => u.month === '2026-12')!;
  assert.deepEqual([dec.sessions, dec.turns, dec.requests, dec.costUsd, dec.costPartial, dec.tokenGaps, dec.priceRevisions], [1, 1, 1, 0.5, 1, 1, [2]]);
  const codex = v.usage.find((u) => u.agent === 'codex')!;
  assert.deepEqual([codex.uncachedInput, codex.output, codex.requests, codex.costUsd], [80, 50, 2, 2.25]); // reset = a new delta, never negative
  assert.deepEqual(v.sessions.map((s) => [s.month, s.agent, s.sessions]), [['2026-11', 'claude', 2], ['2026-11', 'codex', 1], ['2026-12', 'claude', 1]]);
  assert.deepEqual(v.quota.map((q) => [q.month, q.peakPercent, q.observations]), [['2026-11', 70, 2], ['2026-12', 10, 1]]);
  assert.match(nov.profileKey, /^[0-9a-f]{64}$/);
});

test('settle + delete in one transaction leaves the view identical; one batch and split batches freeze the same totals', async () => {
  const one = await fixture(), split = await fixture();
  const before = view(one.db);
  tx(one.db, () => { settle(one.db, { sessions: [one.a, one.b, one.c], quota: one.q }, SECRET, NOV); removeSessions(one.db, [one.a, one.b, one.c]); one.db.prepare('DELETE FROM usage_history').run(); });
  assert.deepEqual(view(one.db), before);
  tx(split.db, () => { settle(split.db, { sessions: [split.a], quota: [split.q[0]!] }, SECRET, NOV); removeSessions(split.db, [split.a]); });
  tx(split.db, () => { settle(split.db, { sessions: [split.b, split.c], quota: split.q.slice(1) }, SECRET, NOV); removeSessions(split.db, [split.b, split.c]); split.db.prepare('DELETE FROM usage_history').run(); });
  assert.deepEqual(view(split.db), before);
  assert.equal(dump(split.db), dump(one.db));
});

test('settled keys block replay and re-import; a genuinely new contribution still counts', async () => {
  const { db, a } = await fixture();
  const before = view(db);
  tx(db, () => { settle(db, { sessions: [a], quota: [] }, SECRET, NOV); removeSessions(db, [a]); });
  // replay / re-import brings the same session records back
  const again = session(db, { sid: 'sid-a', last: DEC });
  turn(db, again, 'a1', NOV, 'claude-x'); turn(db, again, 'a2', DEC, 'claude-x');
  request(db, again, { identity: 'a-r1', ts: NOV, model: 'claude-x', input: 10, read: 5, write: 2, output: 3, cost: { usd: 1, coverage: 'full', rev: 1 } });
  request(db, again, { identity: 'a-r2', ts: DEC, model: 'claude-x', input: 4, output: 1, write: null, cost: { usd: 0.5, coverage: 'partial', rev: 2 } });
  assert.deepEqual(view(db), before);
  const frozen = dump(db);
  assert.deepEqual(tx(db, () => settle(db, { sessions: [again], quota: [] }, SECRET, NOV)), { added: 0, skipped: 8 }); // 2 requests, 2 turns, 2 session-months, 2 session-month-models
  assert.equal(dump(db), frozen);
  // new native activity after the purge: one more turn and request in December
  turn(db, again, 'a3', DEC + 1000, 'claude-x');
  request(db, again, { identity: 'a-r3', ts: DEC + 1000, model: 'claude-x', output: 7, cost: { usd: 0.1, coverage: 'full', rev: 2 } });
  const dec = view(db).usage.find((u) => u.month === '2026-12')!;
  assert.deepEqual([dec.sessions, dec.turns, dec.requests, dec.output, dec.costUsd], [1, 2, 2, 8, 0.6]);
});

test('frozen cost keeps its price revision: a later re-price of a settled request changes nothing', async () => {
  const { db, b, c } = await fixture();
  tx(db, () => settle(db, { sessions: [b, c], quota: [] }, SECRET, NOV)); // settled, records still retained (e.g. Keep)
  const before = view(db);
  db.prepare("UPDATE cost_estimates SET amount_usd = 99, price_revision_id = 2, coverage = '{\"coverage\":\"full\",\"model\":\"gpt-y\"}' WHERE session_id = ?").run(c);
  assert.deepEqual(view(db), before);
  const novCodex = view(db).usage.find((u) => u.agent === 'codex')!;
  assert.deepEqual([novCodex.costUsd, novCodex.priceRevisions], [2.25, [1]]);
  // a month whose requests are all unavailable or unpriced has no cost, never 0
  const only = await monthlyStore();
  const s = session(only, { sid: 'sid-n', last: NOV });
  request(only, s, { identity: 'n1', ts: NOV, model: 'claude-x', output: 1, cost: { usd: null, coverage: 'none', rev: 1 } });
  request(only, s, { identity: 'n2', ts: NOV, model: 'claude-x', output: 1 });
  assert.equal(view(only).usage[0]!.costUsd, null);
});

test('settle only runs inside the caller\'s transaction', async () => {
  const { db, a } = await fixture();
  assert.throws(() => settle(db, { sessions: [a], quota: [] }, SECRET, NOV), /transaction/);
  assert.equal(dump(db), dump(await monthlyStore()));
});

// Security review (run 144) findings, each fixed test-first.
test('review M2: a request or turn without its own time falls back to its event receipt, then the session time; never lost', async () => {
  const db = await monthlyStore();
  const s = session(db, { sid: 'sid-t', last: NOV });
  request(db, s, { identity: 'no-ts', ts: null, model: 'claude-x', output: 4, cost: { usd: 1, coverage: 'full', rev: 1 } });
  turn(db, s, 'no-ts-turn', null, 'claude-x');
  const nov = claudeNov(db);
  assert.deepEqual([nov.requests, nov.turns, nov.output, nov.costUsd], [1, 1, 4, 1]);
});

test('review L3: a month with a known model gets no "model unavailable" session row', async () => {
  const db = await monthlyStore();
  const s = session(db, { sid: 'sid-m', last: NOV });
  turn(db, s, 'm1', NOV, null);
  request(db, s, { identity: 'm-r1', ts: NOV, model: 'claude-x', output: 1 });
  assert.deepEqual(view(db).usage.map((u) => [u.modelId, u.sessions, u.turns]), [['', 0, 1], ['claude-x', 1, 0]]);
});

test('review L4: key parts are encoded unambiguously (ids may contain NUL)', async () => {
  const db = await monthlyStore();
  const x = session(db, { sid: 'a', last: NOV }), y = session(db, { sid: 'a\0b', last: NOV });
  turn(db, x, 'b\0c', NOV);
  turn(db, y, 'c', NOV);
  tx(db, () => { settle(db, { sessions: [x, y], quota: [] }, SECRET, NOV); removeSessions(db, [x, y]); });
  assert.equal(claudeNov(db).turns, 2);
});

test('review L5/L6: malformed or missing estimate coverage never blocks settlement and never disagrees with its amount', async () => {
  const db = await monthlyStore();
  const s = session(db, { sid: 'sid-j', last: NOV });
  request(db, s, { identity: 'bad', ts: NOV, model: 'claude-x', output: 1, cost: { usd: 1, coverage: 'full', rev: 1 } });
  request(db, s, { identity: 'nocov', ts: NOV, model: 'claude-x', output: 1, cost: { usd: 2, coverage: 'full', rev: 1 } });
  db.prepare("UPDATE cost_estimates SET coverage = '{not json' WHERE covered_scope = 'usage:transcript:bad'").run();
  db.prepare("UPDATE cost_estimates SET coverage = NULL WHERE covered_scope = 'usage:transcript:nocov'").run();
  const nov = claudeNov(db);
  assert.deepEqual([nov.costUsd, nov.costPending, nov.costFull + nov.costPartial], [3, 0, 2]);
  assert.deepEqual(tx(db, () => settle(db, { sessions: [s], quota: [] }, SECRET, NOV)).added > 0, true);
});

test('review L7: a scope that becomes verified is verified in frozen and live totals alike', async () => {
  const db = await monthlyStore();
  const sc = scope(db, 'scope-v', false);
  const first = sample(db, sc, { percent: 10, at: NOV });
  tx(db, () => settle(db, { sessions: [], quota: [first] }, SECRET, NOV));
  db.prepare('UPDATE usage_scopes SET verified = 1 WHERE id = ?').run(sc);
  const second = sample(db, sc, { percent: 20, at: NOV + 60_000 });
  assert.deepEqual(view(db).quota.map((q) => [q.verified, q.peakPercent, q.observations]), [[true, 20, 2]]);
  tx(db, () => settle(db, { sessions: [], quota: [second] }, SECRET, NOV));
  assert.deepEqual(view(db).quota.map((q) => [q.verified, q.peakPercent, q.observations]), [[true, 20, 2]]);
});

test('review L9: cost sums are exact, so any batch order freezes the same total', async () => {
  const db = await monthlyStore();
  const ids = [0.1, 0.2, 0.3].map((usd, i) => {
    const s = session(db, { sid: `sid-f${i}`, last: NOV });
    request(db, s, { identity: `f${i}`, ts: NOV, model: 'claude-x', output: 1, cost: { usd, coverage: 'full', rev: 1 } });
    return s;
  });
  assert.equal(claudeNov(db).costUsd, 0.6);
  for (const s of [...ids].reverse()) tx(db, () => { settle(db, { sessions: [s], quota: [] }, SECRET, NOV); removeSessions(db, [s]); });
  assert.equal(claudeNov(db).costUsd, 0.6);
});

test('privacy: monthly tables hold opaque keys only, no ids, paths, titles or locators', async () => {
  const db = await monthlyStore();
  const s = session(db, { sid: 'CANARY-sid', cwd: '/tmp/xaibo-fixture/CANARY-path', title: 'CANARY-title', last: NOV });
  turn(db, s, 'CANARY-turn', NOV, 'claude-x');
  request(db, s, { identity: 'CANARY-req', ts: NOV, model: 'claude-x', output: 1, cost: { usd: 1, coverage: 'full', rev: 1 } });
  const q = sample(db, scope(db, 'CANARY-scope', false), { percent: 5, at: NOV, locator: 'CANARY-locator', limit: 'codex' });
  tx(db, () => settle(db, { sessions: [s], quota: [q] }, SECRET, NOV));
  const out = dump(db);
  for (const bad of ['CANARY', 'p1', 'p2', '/tmp/']) assert.ok(!out.includes(bad), bad);
});
