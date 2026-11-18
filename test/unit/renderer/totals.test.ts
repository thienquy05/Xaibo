// XAIBO-PROD-406 (P4-T04b2; design §6.1 live-set summary, §7.1 D1 tokens, §5.12): totals over the live set. Unavailable
// is never 0; a partial total is a known subtotal; every session counts once; coverage below 80 % is flagged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abbreviate, liveSetSummary } from '../../../src/renderer/overview/totals.ts';
import type { LiveStatus, SessionRow } from '../../../src/shared/ipc.ts';

const live = (lifecycle: LiveStatus['lifecycle'], o: Partial<LiveStatus> = {}): LiveStatus =>
  ({ lifecycle, confidence: 'confirmed', health: 'connected', reason: null, outcome: null, findings: [], since: null, ...o });
const r = (id: number, o: Partial<SessionRow> = {}): SessionRow => ({ id, agent: 'claude', entrypoint: null, origin: null, interactive: null, model: 'Model unavailable',
  cwd: null, title: null, lastActivity: id, drift: false, compressed: false, quarantined: 0, live: live('idle'), contextPct: null, costUsd: null,
  costCoverage: 'unavailable', tokens: null, tokensComplete: true, ...o });

test('no known tokens or cost: unavailable (null), never 0; counts still exact', () => {
  const s = liveSetSummary([r(1), r(2)], false);
  assert.equal(s.sessions, 2);
  assert.equal(s.atLeast, false);
  assert.deepEqual(s.tokens, { value: null, observed: 0, eligible: 2, partial: false, low: true });
  assert.deepEqual(s.cost, { usd: null, priced: 0, eligible: 2, partial: false, low: true });
  assert.deepEqual(liveSetSummary([], false).tokens, { value: null, observed: 0, eligible: 0, partial: false, low: false }, 'no denominator: coverage unavailable, not low');
});

test('known subtotal: sums known values only and marks partial; complete when every member is known and full', () => {
  const rows = [r(1, { tokens: 1000, costUsd: 0.5, costCoverage: 'full' }), r(2, { tokens: 500, tokensComplete: false, costUsd: 0.25, costCoverage: 'partial' }),
    r(3, { tokens: null }), r(4, { tokens: 0, costUsd: 0, costCoverage: 'full' }), r(5, { tokens: 10, costUsd: 0.1, costCoverage: 'full' })];
  const s = liveSetSummary(rows, false);
  assert.deepEqual(s.tokens, { value: 1510, observed: 4, eligible: 5, partial: true, low: false });
  assert.equal(s.cost.usd, 0.85);
  assert.deepEqual({ ...s.cost, usd: 0 }, { usd: 0, priced: 4, eligible: 5, partial: true, low: false });
  const full = liveSetSummary([r(1, { tokens: 7, costUsd: 0, costCoverage: 'full' })], false);
  assert.deepEqual([full.tokens.partial, full.cost.partial, full.cost.usd, full.tokens.value], [false, false, 0, 7], 'an evidenced zero stays 0');
  assert.equal(liveSetSummary([r(1, { tokens: 7, costUsd: 1, costCoverage: 'uncertain' })], false).cost.partial, true);
});

test('below 80 % eligible coverage is flagged; exactly 80 % is not', () => {
  const four = [1, 2, 3, 4].map((id) => r(id, { tokens: 1 }));
  assert.equal(liveSetSummary([...four, r(5)], false).tokens.low, false);
  assert.equal(liveSetSummary([...four, r(5), r(6)], false).tokens.low, true);
});

test('a session listed twice counts once; active agents are distinct agents with busy or waiting sessions; capped sets read as at least', () => {
  const rows = [r(1, { tokens: 100 }), r(1, { tokens: 100 }), r(2, { agent: 'codex', live: live('busy', { reason: 'Background work' }) }),
    r(3, { agent: 'codex', live: live('needs-input') }), r(4, { agent: 'claude', live: live('waiting-for-permission', { confidence: 'heuristic', reason: 'Probably waiting' }) }),
    r(5, { agent: 'agy', live: live('idle') }), r(6, { agent: 'agy', live: live('error') }), r(7, { agent: 'agy', live: live('unknown', { confidence: 'inferred' }) })];
  const s = liveSetSummary(rows, true);
  assert.equal(s.sessions, 7);
  assert.equal(s.atLeast, true);
  assert.equal(s.tokens.value, 100);
  assert.equal(s.activeAgents, 2, 'codex (background work, needs input) and claude (waiting); agy idle/error/unknown is not active');
});

test('D1 token abbreviation: full below 1,000; one decimal half up; trailing .0 dropped; suffix promoted at rounding', () => {
  const cases: [number, string][] = [[0, '0'], [999, '999'], [1000, '1k'], [1250, '1.3k'], [12_000, '12k'], [12_345, '12.3k'], [999_949, '999.9k'],
    [999_950, '1M'], [1_200_000, '1.2M'], [1_500_000_000, '1.5B'], [999_960_000, '1B']];
  for (const [n, s] of cases) assert.equal(abbreviate(n), s, String(n));
});

test('review: a non-finite cost sum is unavailable; T above B; partial only describes a known value', () => {
  const s = liveSetSummary([r(1, { costUsd: 1e308, costCoverage: 'full' }), r(2, { costUsd: 1e308, costCoverage: 'full' })], false);
  assert.equal(s.cost.usd, null);
  assert.equal(abbreviate(999_950_000_000), '1T');
  assert.equal(abbreviate(2 ** 53), '9007.2T');
  const none = liveSetSummary([r(1)], false);
  assert.deepEqual([none.tokens.partial, none.cost.partial], [false, false], 'unavailable is not a known subtotal');
});
