// XAIBO-PROD-523 (P5-T17a; design §6.1.1, US-20, FR-52, EC-104): one page of the monthly usage ledger from the FR-52
// totals. At most 12 observed months, chronological, with older/newer page cursors; months before the first observation
// are absent; a month empty under the filter is "no observations" (null), an evidenced zero stays 0; cost is never 0 when
// nothing was priced; the model filter never applies to quota; quota scopes get response-local ordinals and a label only
// from a current scope; no opaque key leaves the service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerPage, type LedgerInput } from '../../../src/service/usage/ledger.ts';
import { LEDGER_MONTHS, MAX_SCOPES, parsePortMessage } from '../../../src/shared/ipc.ts';
import type { MonthQuota, MonthUsage } from '../../../src/service/usage/monthly.ts';

const P1 = 'a'.repeat(64), P2 = 'b'.repeat(64), S1 = 'c'.repeat(64), S2 = 'd'.repeat(64);
const u = (month: string, o: Partial<MonthUsage> = {}): MonthUsage => ({ month, agent: 'claude', profileKey: P1, modelId: 'model-a', sessions: 1, turns: 2, requests: 3,
  uncachedInput: 10, cacheRead: 20, cacheWrite: 5, output: 7, tokenGaps: 0, costUsd: 0.25, costFull: 3, costPartial: 0, costNone: 0, costPending: 0, priceRevisions: [1], ...o });
const q = (month: string, o: Partial<MonthQuota> = {}): MonthQuota => ({ month, agent: 'codex', scopeKey: S1, limitId: 'primary', windowMinutes: 300, verified: true, peakPercent: 40, observations: 3, ...o });
const months = (...ms: string[]) => ms.map((month) => ({ month, monthToDate: false, detail: 'full' as const }));
const all = { agent: null, model: null };

function input(): LedgerInput {
  return {
    monthly: {
      usage: [
        u('2026-01'), u('2026-01', { modelId: 'model-b', sessions: 1, turns: 1, requests: 1, uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 1, costUsd: 0.1, costFull: 0, costPartial: 1, priceRevisions: [2] }),
        u('2026-03', { agent: 'codex', profileKey: P2, modelId: 'model-c', costUsd: null, costFull: 0, costNone: 3, priceRevisions: [] }),
        u('2026-04', { sessions: 0, turns: 0, requests: 1, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, costFull: 1 }), // evidenced zero
      ],
      sessions: [{ month: '2026-01', agent: 'claude', profileKey: P1, sessions: 2 }, { month: '2026-03', agent: 'codex', profileKey: P2, sessions: 1 }, { month: '2026-04', agent: 'claude', profileKey: P1, sessions: 1 }],
      quota: [q('2026-01'), q('2026-01', { scopeKey: S2, agent: 'claude', peakPercent: 90 }), q('2026-02', { peakPercent: 55 })],
    },
    status: [...months('2026-01', '2026-02', '2026-03'), { month: '2026-04', monthToDate: true, detail: 'some-expired' }],
    scopeLabels: { [S1]: 'Default profile' },
  };
}

test('months: chronological, absent before the first observation, month-to-date and detail per month', () => {
  const p = ledgerPage(input(), { filter: all, end: null, limit: 12 });
  assert.deepEqual(p.months.map((m) => m.month), ['2026-01', '2026-02', '2026-03', '2026-04']);
  assert.deepEqual(p.months.map((m) => m.monthToDate), [false, false, false, true]);
  assert.equal(p.months[3]!.detail, 'some-expired');
  assert.equal(p.older, null);
  assert.equal(p.newer, null);
});

test('sums per month: sessions, turns, token components and total, cost in exact micros with coverage, price revisions', () => {
  const jan = ledgerPage(input(), { filter: all, end: null, limit: 12 }).months[0]!;
  assert.equal(jan.observed, true);
  assert.equal(jan.sessions, 2, 'sessions from the session-month totals, not the per-model rows');
  assert.equal(jan.turns, 3);
  assert.deepEqual(jan.tokens, { uncachedInput: 11, cacheRead: 20, cacheWrite: 5, output: 8, total: 44, gaps: 0 });
  assert.deepEqual(jan.cost, { usd: 0.35, full: 3, partial: 1, none: 0, pending: 0 });
  assert.deepEqual(jan.priceRevisions, [1, 2]);
  const mar = ledgerPage(input(), { filter: all, end: null, limit: 12 }).months[2]!;
  assert.equal(mar.cost!.usd, null, 'nothing priced: cost unavailable, never 0');
  assert.equal(mar.cost!.none, 3);
});

test('no observations vs evidenced zero: a quota-only month has no usage values; a zero-token request month reads 0', () => {
  const p = ledgerPage(input(), { filter: all, end: null, limit: 12 });
  const feb = p.months[1]!, apr = p.months[3]!;
  assert.equal(feb.observed, false);
  assert.deepEqual([feb.sessions, feb.turns, feb.tokens, feb.cost], [null, null, null, null]);
  assert.equal(apr.observed, true);
  assert.equal(apr.tokens!.total, 0);
  assert.equal(apr.cost!.usd, 0, 'a priced zero is 0');
});

test('filters: agent applies everywhere; model applies to usage and sessions, never to quota; filter options are unfiltered', () => {
  const codex = ledgerPage(input(), { filter: { agent: 'codex', model: null }, end: null, limit: 12 });
  assert.deepEqual(codex.months.map((m) => m.observed), [false, false, true, false]);
  assert.deepEqual(codex.quota.map((x) => x.agent), ['codex', 'codex']);
  const b = ledgerPage(input(), { filter: { agent: null, model: 'model-b' }, end: null, limit: 12 });
  assert.equal(b.months[0]!.sessions, 1, 'sessions that used the model');
  assert.deepEqual(b.months[0]!.tokens, { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 1, total: 2, gaps: 0 });
  assert.equal(b.quota.length, 3, 'model filter does not apply to quota');
  assert.deepEqual(b.agents, ['claude', 'codex']);
  assert.deepEqual(b.models, ['model-a', 'model-b', 'model-c']);
});

test('quota: per month/scope/limit/window, response-local ordinals, labels only from a current scope, no opaque keys', () => {
  const p = ledgerPage(input(), { filter: all, end: null, limit: 12 });
  assert.deepEqual(p.quota.map((x) => [x.month, x.scope, x.label, x.peakPercent]), [['2026-01', 1, 'Default profile', 40], ['2026-01', 2, null, 90], ['2026-02', 1, 'Default profile', 55]]);
  const json = JSON.stringify(p);
  for (const key of [P1, P2, S1, S2]) assert.ok(!json.includes(key), 'no opaque key in the page');
});

test('review L7: a month with sessions but no usage request has no evidenced tokens or cost (unavailable, not 0)', () => {
  const p = ledgerPage({ monthly: { usage: [], sessions: [{ month: '2026-01', agent: 'claude', profileKey: P1, sessions: 2 }], quota: [] }, status: months('2026-01'), scopeLabels: {} },
    { filter: all, end: null, limit: 12 });
  const jan = p.months[0]!;
  assert.equal(jan.observed, true);
  assert.equal(jan.sessions, 2);
  assert.equal(jan.tokens, null);
  assert.equal(jan.cost, null);
  assert.ok(parsePortMessage({ v: 1, type: 'monthly', id: 1, ...p }), 'the renderer accepts it');
});

test('review M2: agent-supplied values over the IPC bounds never make the whole reply unreadable', () => {
  const longModel = 'm'.repeat(300);
  const usage = [u('2026-01', { modelId: longModel }), ...Array.from({ length: 300 }, (_, i) => u('2026-01', { modelId: `model-${i}`, priceRevisions: [i + 1] }))];
  const quota = Array.from({ length: LEDGER_MONTHS * MAX_SCOPES + 5 }, (_, i) => q('2026-01', { scopeKey: String(i).padStart(64, '0') }));
  const p = ledgerPage({ monthly: { usage, sessions: [], quota }, status: months('2026-01'), scopeLabels: {} }, { filter: all, end: null, limit: 12 });
  assert.ok(parsePortMessage({ v: 1, type: 'monthly', id: 1, ...p }), 'the reply passes the renderer parser');
  assert.ok(!p.models.includes(longModel), 'an over-long model id is not offered as a filter');
  assert.equal(p.months[0]!.tokens!.total, 301 * 42, 'its usage still counts in the month');
});

test('re-review MEDIUM: a token sum that is not a safe integer (fractional or huge agent values) reads unavailable, never an unreadable reply', () => {
  for (const bad of [{ uncachedInput: 1.5 }, { output: 2 ** 53 }]) {
    const p = ledgerPage({ monthly: { usage: [u('2026-01', bad), u('2026-01')], sessions: [], quota: [] }, status: months('2026-01'), scopeLabels: {} }, { filter: all, end: null, limit: 12 });
    assert.equal(p.months[0]!.tokens, null, JSON.stringify(bad));
    assert.equal(p.months[0]!.turns, 4, 'the other counts stay');
    assert.ok(parsePortMessage({ v: 1, type: 'monthly', id: 1, ...p }), 'the reply passes the renderer parser');
  }
});

test('paging: at most `limit` months ending at `end`; older/newer cursors walk the observed months', () => {
  const big: LedgerInput = { monthly: { usage: [], sessions: [], quota: [] }, status: months(...Array.from({ length: 30 }, (_, i) => `20${24 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`)), scopeLabels: {} };
  const latest = ledgerPage(big, { filter: all, end: null, limit: 12 });
  assert.deepEqual([latest.months[0]!.month, latest.months.at(-1)!.month, latest.months.length], ['2025-07', '2026-06', 12]);
  assert.equal(latest.older, '2025-06');
  assert.equal(latest.newer, null);
  const prev = ledgerPage(big, { filter: all, end: latest.older, limit: 12 });
  assert.deepEqual([prev.months[0]!.month, prev.months.at(-1)!.month], ['2024-07', '2025-06']);
  assert.equal(prev.newer, '2026-06');
  const first = ledgerPage(big, { filter: all, end: prev.older, limit: 12 });
  assert.deepEqual([first.months[0]!.month, first.months.length, first.older], ['2024-01', 6, null]);
  assert.equal(first.newer, '2025-06');
  assert.equal(ledgerPage(big, { filter: all, end: '2025-09', limit: 3 }).months.map((m) => m.month).join(), '2025-07,2025-08,2025-09');
  assert.equal(ledgerPage(big, { filter: all, end: null, limit: 99 }).months.length, 12, 'limit capped at 12');
  assert.deepEqual(ledgerPage({ ...big, status: [] }, { filter: all, end: null, limit: 12 }).months, [], 'no observations: no months, never zero bars');
});
