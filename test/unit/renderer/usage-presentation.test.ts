// XAIBO-PROD-406 (P4-T04b2; design §6.1 usage scopes, §7.1 countdown/freshness, §7.2 C16-C20; PRD §5.11, FR-46):
// render-time usage labels. >100 % kept; stale after 15 min; reset passed replaces utilization and countdown; unverified
// scopes stay separate and labelled; agy exactly "Unavailable from passive sources" with no values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockName, countdownText, dayRange, HISTORY_DAYS, historyBounds, scopeBlocks, shiftDay, usageBlocks, usageView } from '../../../src/renderer/usage/presentation.ts';
import type { SignInView, UsageConsumption, UsageProfile, UsageScope } from '../../../src/shared/ipc.ts';

const NOW = new Date(2026, 0, 2, 12, 0, 0).getTime();
const MIN = 60_000;
const s = (o: Partial<UsageScope> = {}): UsageScope => ({ scope: 1, agent: 'claude', profile: 'Default profile', verified: false, stream: 'five_hour', windowMinutes: 300,
  usedPercent: 40, resetsAt: NOW + 65 * MIN + 3000, plan: null, credits: null, asOf: null, firstObservedAt: NOW - MIN, measuredAt: NOW - MIN, unavailable: null,
  profileId: 'p1', generation: 0, boundary: null, ...o }); // XAIBO-PROD-582 fields

test('current reading: window, percent, reset clock, countdown, unknown source time, unverified scope', () => {
  const v = usageView(s(), NOW);
  assert.equal(v.title, '5-hour window');
  assert.equal(v.value, '40%');
  assert.equal(v.percent, 40);
  assert.equal(v.aboveScale, false);
  assert.equal(v.reset, 'Resets 13:05');
  assert.equal(v.countdown, 'in 1 h 5 min 3 s');
  assert.equal(v.stale, null);
  assert.equal(v.freshness, 'Source time unknown; observed 2026-01-02 11:59');
  assert.equal(v.unverified, true);
  const known = usageView(s({ asOf: NOW - 2 * MIN, verified: true, windowMinutes: 10_080, resetsAt: new Date(2026, 0, 5, 8, 30).getTime() }), NOW);
  assert.equal(known.freshness, 'Measured 2026-01-02 11:58 · observed 2026-01-02 11:59');
  assert.equal(known.title, '7-day window');
  assert.equal(known.reset, 'Resets 2026-01-05 08:30', 'another day carries the date');
  assert.equal(known.unverified, false);
});

test('above 100 % stays the reported number with an above-scale flag; a missing reading is unavailable, never 0', () => {
  const over = usageView(s({ usedPercent: 101.5 }), NOW);
  assert.deepEqual([over.value, over.percent, over.aboveScale], ['101.5%', 101.5, true]);
  const none = usageView(s({ usedPercent: null }), NOW);
  assert.deepEqual([none.value, none.percent], ['Utilization unavailable', null]);
  assert.equal(usageView(s({ usedPercent: 0.04 }), NOW).value, '<0.1%');
  assert.equal(usageView(s({ resetsAt: null }), NOW).countdown, null, 'unknown reset has no countdown');
});

test('stale after 15 min without a newer measurement; the value is kept', () => {
  const v = usageView(s({ measuredAt: NOW - 16 * MIN, firstObservedAt: NOW - 16 * MIN }), NOW);
  assert.equal(v.stale, 'Stale · 2026-01-02 11:44');
  assert.equal(v.value, '40%');
  assert.equal(usageView(s({ measuredAt: NOW - 15 * MIN }), NOW).stale, null);
});

test('reset passed replaces utilization and countdown', () => {
  const v = usageView(s({ resetsAt: NOW - 1000 }), NOW);
  assert.deepEqual([v.value, v.percent, v.countdown, v.reset], ['Reset passed; awaiting observation', null, null, null]);
});

test('agy: exactly "Unavailable from passive sources", no percentage, reset or countdown; Claude/Codex without a scope', () => {
  const agy = usageView(s({ scope: null, agent: 'agy', verified: null, stream: null, windowMinutes: null, usedPercent: null, resetsAt: null, firstObservedAt: null, measuredAt: null, unavailable: 'passive' }), NOW);
  assert.deepEqual(agy, { title: 'Quota', value: 'Unavailable from passive sources', percent: null, aboveScale: false, reset: null, countdown: null, stale: null, staleLabel: null,
    freshness: null, unverified: false, plan: null, credits: null, lastKnown: null });
  const blank = { scope: null, verified: null, stream: null, windowMinutes: null, usedPercent: null, resetsAt: null, firstObservedAt: null, measuredAt: null, unavailable: 'no-observation' as const };
  assert.equal(usageView(s({ ...blank }), NOW).value, 'Unavailable — no statusLine quota observation');
  assert.equal(usageView(s({ ...blank, agent: 'codex' }), NOW).value, 'Unavailable — no rate-limit observation');
});

test('plan and reported credits as source values', () => {
  const v = usageView(s({ agent: 'codex', plan: 'pro', credits: { hasCredits: true, unlimited: null, balance: '12.50' } }), NOW);
  assert.deepEqual([v.plan, v.credits], ['Plan pro', 'Reported credits 12.50']);
  assert.equal(usageView(s({ credits: { hasCredits: null, unlimited: true, balance: null } }), NOW).credits, 'Unlimited credits');
});

test('scope blocks: one block per scope, never merged (no combined curve); unverified flagged; profile rows kept in order', () => {
  const rows = [s({ scope: 1, stream: 'five_hour' }), s({ scope: 1, stream: 'seven_day' }), s({ scope: 2, stream: 'five_hour' }),
    s({ scope: 3, agent: 'codex', verified: true, stream: 'codex:primary' }), s({ scope: null, agent: 'agy', verified: null, unavailable: 'passive' })];
  const b = scopeBlocks(rows);
  assert.deepEqual(b.map((x) => [x.agent, x.scope, x.unverified, x.rows.length]), [['claude', 1, true, 2], ['claude', 2, true, 1], ['codex', 3, false, 1], ['agy', null, false, 1]]);
});

test('countdown per §7.1: omit zero leading units, keep seconds; days drop seconds; positive under 1 s', () => {
  const cases: [number, string][] = [[500, 'in <1 s'], [5000, 'in 5 s'], [65_000, 'in 1 min 5 s'], [3_903_000, 'in 1 h 5 min 3 s'], [3_600_000, 'in 1 h 0 min 0 s'],
    [93_780_000, 'in 1 d 2 h 3 min']];
  for (const [ms, t] of cases) assert.equal(countdownText(ms), t, String(ms));
});

// Security review (P4-T04b2): untrusted source strings are escaped; impossible times never print NaN; a value just
// above 100 % never rounds to 100 %; a reading without a measurement time still ages from its first observation.
test('review: bidi/control characters in plan, stream and balance are escaped; out-of-range times read Unknown', () => {
  const v = usageView(s({ plan: 'pro‮', stream: 'x\u0007', windowMinutes: null, credits: { hasCredits: null, unlimited: null, balance: '1‏' } }), NOW);
  assert.equal(v.plan, 'Plan pro\\u202E');
  assert.equal(v.title, 'x\\x07');
  assert.equal(v.credits, 'Reported credits 1\\u200F');
  assert.equal(usageView(s({ resetsAt: 9e15 }), NOW).reset, 'Resets Unknown');
});

test('review: 100.04 % reads >100 % (above scale); a reading with no measured time ages from its first observation', () => {
  assert.deepEqual([usageView(s({ usedPercent: 100.04 }), NOW).value, usageView(s({ usedPercent: 100.04 }), NOW).aboveScale], ['>100%', true]);
  assert.equal(usageView(s({ measuredAt: null, firstObservedAt: NOW - 20 * MIN }), NOW).stale, 'Stale · 2026-01-02 11:40');
});

// XAIBO-PROD-407 (P4-T04c, design §6.1 Observed history): local day windows and the 45 retained days.
test('day range: local midnight to next midnight; history bounds cover 45 elapsed days ending today', () => {
  const at = new Date(2026, 0, 2, 15, 30).getTime();
  assert.deepEqual(dayRange(at), { from: new Date(2026, 0, 2).getTime(), to: new Date(2026, 0, 3).getTime(), date: '2026-01-02' });
  assert.equal(shiftDay(new Date(2026, 0, 2).getTime(), -1), new Date(2026, 0, 1).getTime());
  assert.equal(shiftDay(new Date(2026, 0, 2).getTime(), 1), new Date(2026, 0, 3).getTime());
  assert.deepEqual(historyBounds(at), { first: new Date(2025, 10, 19).getTime(), last: new Date(2026, 0, 2).getTime() });
  assert.equal(HISTORY_DAYS, 45);
});

// XAIBO-PROD-432 (P4-T14, EC-97, design §6.13 B4): with the collector lost, a reading is never presented as current.
test('collector lost: a row with a reading says Last known with the collector label; unavailable phrases stay as they are', () => {
  assert.equal(usageView(s(), NOW).lastKnown, null, 'collector running: no qualifier');
  const lost = usageView(s(), NOW, 'since 2026-01-02 11:58');
  assert.equal(lost.lastKnown, 'Last known · since 2026-01-02 11:58');
  assert.equal(lost.value, '40%', 'the last reading stays readable');
  assert.equal(usageView(s({ resetsAt: NOW - MIN }), NOW, 'since 11:58').lastKnown, 'Last known · since 11:58', 'reset passed is a reading state too');
  assert.equal(usageView(s({ unavailable: 'no-observation' }), NOW, 'since 11:58').lastKnown, null);
  assert.equal(usageView(s({ agent: 'agy', unavailable: 'passive' }), NOW, 'since 11:58').lastKnown, null);
});

// XAIBO-PROD-435 (P4-T14b; design C20): Stale is spoken with what the time is.
test('usage Stale accessible text: last measurement, or last observation when no measured time exists', () => {
  // review HIGH: the service always stores measuredAt (source time, else first observation); only asOf says the source time is known
  assert.equal(usageView(s({ asOf: NOW - 16 * MIN, measuredAt: NOW - 16 * MIN }), NOW).staleLabel, 'Stale, last measurement 2026-01-02 11:44');
  assert.equal(usageView(s({ asOf: null, measuredAt: NOW - 20 * MIN, firstObservedAt: NOW - 20 * MIN }), NOW).staleLabel, 'Stale, last observation 2026-01-02 11:40');
  assert.equal(usageView(s(), NOW).staleLabel, null);
});

// XAIBO-PROD-436 (P4-T14b): a read that failed (e.g. pending when the service restarted) retries at the next tick, once:
// review M: a read that keeps failing falls back to the 5 s throttle, and the one retry never overlaps itself.
test('usage refresh: at most every 5 s; right after a first failure once, never while that retry is in flight', async () => {
  const { usageRefreshDue } = await import('../../../src/renderer/usage/presentation.ts');
  assert.equal(usageRefreshDue(10_000, 14_999, 0, false), false);
  assert.equal(usageRefreshDue(10_000, 15_000, 0, false), true);
  assert.equal(usageRefreshDue(10_000, 10_001, 1, false), true, 'first failure: retry at once');
  assert.equal(usageRefreshDue(10_000, 10_001, 1, true), false, 'that retry is still pending');
  assert.equal(usageRefreshDue(10_000, 10_001, 2, false), false, 'the retry failed too: throttled');
  assert.equal(usageRefreshDue(10_000, 15_000, 2, false), true);
  assert.equal(usageRefreshDue(0, 10_000, 0, false), true, 'never read yet');
});

// XAIBO-PROD-449 (G4c-2): a tick throttled by the 5 s rule scheduled nothing, so the last reading of a burst waited for
// new activity. A throttled refresh wakes when the 5 s window ends; a clock moved back never waits longer than 5 s.
test('usage wake: the ms until the 5 s window ends, never negative, never above 5 s', async () => {
  const { usageRefreshDue, usageWakeIn } = await import('../../../src/renderer/usage/presentation.ts');
  assert.equal(usageWakeIn(10_000, 12_000), 3000);
  assert.equal(usageWakeIn(10_000, 14_999), 1);
  assert.equal(usageWakeIn(10_000, 15_000), 0);
  assert.equal(usageWakeIn(10_000, 30_000), 0);
  assert.equal(usageWakeIn(10_000, 9_000), 5000, 'clock moved back');
  const last = 10_000, now = 12_000;
  assert.equal(usageRefreshDue(last, now + usageWakeIn(last, now), 0, false), true, 'the wake lands on a due refresh');
});

// XAIBO-PROD-587 (P6-T10a unit 5; PRD §6.9, review R1/R11, D-P6-17): blocks carry their sign-in method and lead and their consumption
test('usageBlocks: method per epoch, lead, consumption once per profile and epoch, consumption-only profiles', () => {
  const C = '00000000-0000-4000-8000-0000000c8701', X = '00000000-0000-4000-8000-0000000c8702', K = '00000000-0000-4000-8000-0000000c8703';
  const view = (profileId: string, method: SignInView['method'], generation: number): SignInView => ({ profileId, revision: 1, method, source: method === 'unknown' ? null : 'owner', at: 1,
    declaration: method === 'unknown' ? null : { method, at: 1 }, evidence: null, conflict: false, usingDeclaration: method !== 'unknown', outputStatus: 'unavailable', generation, boundary: null });
  const g = (generation: number, scope: number | null, usd: number): UsageConsumption => ({ generation, scope, tokens: 10, estimatedUsd: usd, coverage: 'full', from: 1, to: 2, limited: false });
  const prof = (profileId: string, agent: string, label: string, signIn: SignInView, consumption: UsageConsumption[]): UsageProfile => ({ profileId, agent, label, signIn, consumption, consumptionLimited: false });
  const scopes = [
    s({ scope: 7, agent: 'codex', profile: 'Default profile', profileId: X, verified: true, generation: 1, boundary: { method: 'subscription', at: 1, reason: 'method' } }), // an earlier epoch
    s({ scope: 9, agent: 'codex', profile: 'Default profile', profileId: X, verified: true, generation: 2, boundary: { method: 'api-key', at: 5, reason: 'declared-account' } }),
    s({ scope: 3, agent: 'claude', profile: 'Default profile', profileId: C, verified: false, generation: 0 }),
  ];
  const profiles = [
    prof(C, 'claude', 'Default profile', view(C, 'unknown', 0), [g(0, null, 1)]),
    prof(X, 'codex', 'Default profile', view(X, 'api-key', 2), [g(2, 9, 4), g(1, 7, 2)]),
    prof(K, 'claude', '~/keys', view(K, 'api-key', 0), [g(0, null, 8)]), // no quota scope at all
  ];
  const b = usageBlocks(scopes, profiles);
  const pick = (x: (typeof b)[number]) => [x.key, x.method, x.lead, x.current, x.consumption.map((c) => c.estimatedUsd)];
  assert.deepEqual(b.map(pick), [
    ['scope:7', 'subscription', 'quota', false, [2]], // its own epoch's method, not today's
    ['scope:9', 'api-key', 'consumption', true, [4]],
    ['scope:3', 'unknown', 'none', true, []], // a per-session unverified scope: Session Cost covers its requests
    ['consumption:' + C + ':0', 'unknown', 'none', true, [1]], // the profile's requests, once, apart from the session scope
    ['consumption:' + K + ':0', 'api-key', 'consumption', true, [8]], // consumption-only: no quota observed
  ]);
  assert.deepEqual(b.map((x) => x.profileId), [X, X, C, C, K]);
  assert.deepEqual(usageBlocks(scopes, []).map((x) => [x.method, x.lead, x.consumption.length]), [['unknown', 'none', 0], ['unknown', 'none', 0], ['unknown', 'none', 0]], 'no profile list: nothing guessed');
});

test('unit 5 review M1-M3: an older epoch keeps its own method for scope-less consumption; current blocks carry provenance; a capped read is said', () => {
  const C = '00000000-0000-4000-8000-0000000c8711';
  const v = (method: SignInView['method'], generation: number): SignInView => ({ profileId: C, revision: 2, method, source: 'owner', at: 5, declaration: { method, at: 5 }, evidence: null,
    conflict: false, usingDeclaration: true, outputStatus: 'unavailable', generation, boundary: { at: 5, reason: 'method' } });
  const g = (generation: number, usd: number): UsageConsumption => ({ generation, scope: null, tokens: 1, estimatedUsd: usd, coverage: 'full', from: 1, to: 2, limited: false });
  const p: UsageProfile = { profileId: C, agent: 'claude', label: 'Default profile', signIn: v('api-key', 1), consumption: [g(1, 3), g(0, 1)], consumptionLimited: true };
  const scopes = [s({ scope: null, agent: 'claude', profile: 'Default profile', profileId: C, verified: null, stream: null, unavailable: 'no-observation', generation: null })];
  const b = usageBlocks(scopes, [p]);
  assert.deepEqual(b.map((x) => [x.key, x.method, x.current, x.consumption.map((c) => c.estimatedUsd), x.signIn?.method ?? null, x.limited]), [
    ['profile:' + C, 'api-key', true, [3], 'api-key', true], // the current epoch's requests under today's method, with its provenance
    ['consumption:' + C + ':0', 'unknown', false, [1], null, true], // generation 0 had no recorded method: never relabelled API key
  ]);
});

test('unit 5: an earlier-epoch block has its own name, so two blocks of one profile never share a region name', () => {
  const C = '00000000-0000-4000-8000-0000000c8721';
  const view: SignInView = { profileId: C, revision: 2, method: 'gateway', source: 'owner', at: 5, declaration: { method: 'gateway', at: 5 }, evidence: null, conflict: false, usingDeclaration: true, outputStatus: 'unavailable', generation: 1, boundary: { at: 5, reason: 'method' } };
  const b = usageBlocks([s({ scope: null, agent: 'codex', profile: '~/b', profileId: C, verified: null, stream: null, unavailable: 'no-observation', generation: null })],
    [{ profileId: C, agent: 'codex', label: '~/b', signIn: view, consumption: [{ generation: 0, scope: null, tokens: 150, estimatedUsd: 0.25, coverage: 'full', from: 1, to: 2, limited: false }], consumptionLimited: false }]);
  assert.deepEqual(b.map((x) => blockName(x, 'Codex')), ['Codex · ~/b', 'Codex · ~/b · earlier usage epoch']);
});
