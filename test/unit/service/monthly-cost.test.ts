// XAIBO-PROD-525 (P5-T16; FR-52, EC-105 unit part): monthly cost coverage. Cost is summed only from disjoint, attributable
// per-request estimates: frozen and live parts add up with every price revision kept; a partial estimate adds its known
// subtotal; a month with nothing priced is unavailable (null), never 0; a parent request and a subagent's request are
// separate records, each counted once; an agent-reported session estimate is opaque and never prorated into any month.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { liveMonthly, type MonthUsage } from '../../../src/service/usage/monthly.ts';
import { settle } from '../../../src/service/usage/settle.ts';
import { monthlyStore, removeSessions, reportedCost, request, SECRET, session, turn, tx } from '../../helpers/monthly.ts';

const NOV = Date.UTC(2026, 10, 10, 12), DEC = Date.UTC(2026, 11, 2, 12);
const month = (db: DatabaseSync, m: string): MonthUsage[] => liveMonthly(db, SECRET).usage.filter((u) => u.month === m);
const cost = (rows: MonthUsage[]) => {
  const priced = rows.filter((r) => r.costUsd !== null);
  return { usd: priced.length ? priced.reduce((a, r) => a + Math.round(r.costUsd! * 1e6), 0) / 1e6 : null,
    full: rows.reduce((a, r) => a + r.costFull, 0), partial: rows.reduce((a, r) => a + r.costPartial, 0), none: rows.reduce((a, r) => a + r.costNone, 0),
    pending: rows.reduce((a, r) => a + r.costPending, 0), revisions: [...new Set(rows.flatMap((r) => r.priceRevisions))].sort() };
};
const freeze = (db: DatabaseSync, ids: number[]) => tx(db, () => { settle(db, { sessions: ids, quota: [] }, SECRET, 1); removeSessions(db, ids); });

test('mixed frozen and live: the month adds both parts exactly and keeps every price revision', async () => {
  const db = await monthlyStore();
  const a = session(db, { sid: 'cost-a', last: NOV });
  request(db, a, { identity: 'a1', ts: NOV, model: 'claude-x', input: 10, output: 5, cost: { usd: 0.1, coverage: 'full', rev: 1 } });
  const b = session(db, { sid: 'cost-b', last: NOV });
  request(db, b, { identity: 'b1', ts: NOV, model: 'claude-x', input: 10, output: 5, cost: { usd: 0.2, coverage: 'full', rev: 2 } });
  const before = cost(month(db, '2026-11'));
  freeze(db, [a]);
  assert.deepEqual(cost(month(db, '2026-11')), before, 'freezing one part changes nothing');
  assert.deepEqual(before, { usd: 0.3, full: 2, partial: 0, none: 0, pending: 0, revisions: [1, 2] });
});

test('unknown prices: partial adds its known subtotal; unpriced and pending are counted, never priced; nothing priced is unavailable', async () => {
  const db = await monthlyStore();
  const s = session(db, { sid: 'cost-u', last: DEC });
  request(db, s, { identity: 'p', ts: NOV, model: 'claude-x', input: 1, output: 1, cost: { usd: 0.25, coverage: 'partial', rev: 1 } });
  request(db, s, { identity: 'n', ts: NOV, model: 'claude-x', input: 1, output: 1, cost: { usd: null, coverage: 'none', rev: null } });
  request(db, s, { identity: 'q', ts: NOV, model: 'claude-x', input: 1, output: 1 }); // not priced yet
  request(db, s, { identity: 'd', ts: DEC, model: 'claude-x', input: 1, output: 1, cost: { usd: null, coverage: 'none', rev: null } });
  assert.deepEqual(cost(month(db, '2026-11')), { usd: 0.25, full: 0, partial: 1, none: 1, pending: 1, revisions: [1] });
  assert.deepEqual(cost(month(db, '2026-12')), { usd: null, full: 0, partial: 0, none: 1, pending: 0, revisions: [] }, 'unavailable, not 0');
  freeze(db, [s]);
  assert.deepEqual(cost(month(db, '2026-12')).usd, null, 'still unavailable once frozen');
});

test('parent and subagent requests are disjoint records, each counted once; the session estimate is not added', async () => {
  const db = await monthlyStore();
  const s = session(db, { sid: 'cost-parent', last: NOV });
  turn(db, s, 't1', NOV, 'claude-x');
  request(db, s, { identity: 'parent-1', ts: NOV, model: 'claude-x', input: 100, output: 10, cost: { usd: 1, coverage: 'full', rev: 1 } });
  request(db, s, { identity: 'child-1', ts: NOV + 1000, model: 'claude-y', input: 50, output: 5, cost: { usd: 0.5, coverage: 'full', rev: 1 } });
  reportedCost(db, s, 7); // the agent's session total (inclusion of child work unknown): opaque
  const rows = month(db, '2026-11');
  assert.deepEqual(cost(rows).usd, 1.5);
  assert.equal(rows.reduce((a, r) => a + r.requests, 0), 2);
  assert.equal(rows.reduce((a, r) => a + r.uncachedInput, 0), 150);
  freeze(db, [s]);
  assert.deepEqual(cost(month(db, '2026-11')).usd, 1.5, 'frozen: the same');
});

test('an opaque session estimate spanning months is never prorated: each month has only its own requests', async () => {
  const db = await monthlyStore();
  const s = session(db, { sid: 'cost-span', last: DEC });
  request(db, s, { identity: 'nov', ts: NOV, model: 'claude-x', input: 1, output: 1, cost: { usd: 0.4, coverage: 'full', rev: 1 } });
  request(db, s, { identity: 'dec', ts: DEC, model: 'claude-x', input: 1, output: 1 }); // pending
  reportedCost(db, s, 9);
  assert.equal(cost(month(db, '2026-11')).usd, 0.4);
  assert.equal(cost(month(db, '2026-12')).usd, null, 'December has no priced request: unavailable, no share of the 9');
  freeze(db, [s]);
  assert.equal(cost(month(db, '2026-11')).usd, 0.4);
  assert.equal(cost(month(db, '2026-12')).usd, null);
});
