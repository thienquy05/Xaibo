// XAIBO-PROD-319 (P3-T15, EC-91, PRD §5.11): quota readings from the Claude statusLine tee and Codex token_count
// rate_limits, the minute history step and the read-time usage status, on a fake clock. Missing is a gap, never zero;
// spend over 100 % is kept; an unchanged re-emission with no source time never renews the measurement age; a known
// measurement seen again (replay) adds nothing; reset/window/plan changes are transitions; at reset time the value is
// replaced by "Reset passed; awaiting observation"; stale after 15 minutes; unknown source time is labelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agyUsageStatus, claudeReadings, codexReadings, historyStep, statuslineContext, statuslineCost, usageStatus, type Reading, type Stored,
} from '../../src/service/usage/snapshots.ts';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0); // synthetic fixed base
const MIN = 60_000;
const RESET_S = Date.UTC(2026, 0, 1, 15, 0, 0) / 1000;

test('Claude readings: five_hour/seven_day, epoch-second resets to UTC ms, >100 % kept, absent window = no reading', () => {
  const r = claudeReadings({ rate_limits: { five_hour: { used_percentage: 42, resets_at: RESET_S }, seven_day: { used_percentage: 130 } } });
  assert.deepEqual(r, [
    { stream: 'five_hour', usedPercent: 42, windowMinutes: 300, resetsAt: RESET_S * 1000, plan: null, credits: null, asOf: null },
    { stream: 'seven_day', usedPercent: 130, windowMinutes: 10080, resetsAt: null, plan: null, credits: null, asOf: null },
  ]);
  assert.deepEqual(claudeReadings({ rate_limits: { five_hour: {} } }).map((x) => x.usedPercent), [null], 'present window, missing value: null, not 0');
  assert.deepEqual(claudeReadings({}), [], 'no rate_limits: a gap, no reading');
  assert.deepEqual(claudeReadings({ rate_limits: { five_hour: { resets_at: '2026-01-01T15:00:00Z' } } })[0]!.resetsAt, RESET_S * 1000);
  assert.equal(claudeReadings({ rate_limits: { five_hour: { resets_at: '2026-01-01T15:00:00' } } })[0]!.resetsAt, null, 'no offset: unknown, not local time');
});

test('Codex readings: per window, limit id in the stream, plan and credits kept, source time as as_of', () => {
  const r = codexReadings({ limit_id: 'codex', plan_type: 'pro', credits: { has_credits: false },
    primary: { used_percent: 12.5, window_minutes: 300, resets_at: RESET_S }, secondary: { used_percent: 101, window_minutes: 10080 } }, T0);
  assert.deepEqual(r, [
    { stream: 'codex:primary', usedPercent: 12.5, windowMinutes: 300, resetsAt: RESET_S * 1000, plan: 'pro', credits: '{"has_credits":false}', asOf: T0 },
    { stream: 'codex:secondary', usedPercent: 101, windowMinutes: 10080, resetsAt: null, plan: 'pro', credits: '{"has_credits":false}', asOf: T0 },
  ]);
  assert.equal(codexReadings({ primary: { used_percent: 1 } }, null)[0]!.stream, '-:primary');
  assert.equal(codexReadings({ limit_id: 'x'.repeat(65), primary: { used_percent: 1 } }, null)[0]!.stream, '-:primary', 'oversized limit id is not a stream key');
});

test('review H2/L1: credits allowlisted and re-serialized, plan bounded, out-of-range values dropped (never stored, never 0)', () => {
  const [r] = codexReadings({ plan_type: 'p'.repeat(33), credits: { has_credits: true, balance: '5', account_email: 'x' },
    primary: { used_percent: 10001, window_minutes: 0.5, resets_at: 1e12 } }, null);
  assert.deepEqual(r, { stream: '-:primary', usedPercent: null, windowMinutes: null, resetsAt: null, plan: null, credits: '{"has_credits":true,"balance":"5"}', asOf: null });
  assert.equal(codexReadings({ credits: 'free text', primary: {} }, null)[0]!.credits, null);
  assert.equal(claudeReadings({ rate_limits: { five_hour: { used_percentage: Number.POSITIVE_INFINITY } } })[0]!.usedPercent, null);
});

test('review L3: a source time later than the observation + 5 min is treated as unknown', () => {
  const r: Reading = { stream: 'codex:primary', usedPercent: 1, windowMinutes: 300, resetsAt: null, plan: null, credits: null, asOf: T0 + 6 * MIN };
  assert.deepEqual(historyStep(null, r, T0), { action: 'sample', minute: T0 / MIN, measuredAt: T0, firstObservedAt: T0 });
});

const reading = (o: Partial<Reading> = {}): Reading => ({ stream: 'five_hour', usedPercent: 40, windowMinutes: 300, resetsAt: RESET_S * 1000, plan: null, credits: null, asOf: null, ...o });
const stored = (r: Reading, firstObservedAt: number): Stored => ({ ...r, firstObservedAt, measuredAt: r.asOf ?? firstObservedAt });

test('history step: first reading is a sample in its UTC minute; measured = source time, else first observation', () => {
  assert.deepEqual(historyStep(null, reading(), T0 + 30_000), { action: 'sample', minute: T0 / MIN, measuredAt: T0 + 30_000, firstObservedAt: T0 + 30_000 });
  assert.deepEqual(historyStep(null, reading({ asOf: T0 - 5 * MIN }), T0), { action: 'sample', minute: T0 / MIN - 5, measuredAt: T0 - 5 * MIN, firstObservedAt: T0 });
});

test('EC-91: an unchanged re-emission without source time is skipped, so its age is not renewed', () => {
  const prev = stored(reading(), T0);
  assert.deepEqual(historyStep(prev, reading(), T0 + 20 * MIN), { action: 'skip' });
  assert.equal(historyStep(prev, reading({ usedPercent: 41 }), T0 + 20 * MIN).action, 'sample');
});

test('EC-91 stale replay: the same measured reading seen again adds nothing; a newer measurement is a sample', () => {
  const prev = stored(reading({ stream: 'codex:primary', asOf: T0 }), T0);
  assert.deepEqual(historyStep(prev, reading({ stream: 'codex:primary', asOf: T0 }), T0 + 9 * MIN), { action: 'skip' });
  assert.equal(historyStep(prev, reading({ stream: 'codex:primary', asOf: T0 + MIN }), T0 + MIN).action, 'sample');
});

test('reset, window and plan changes are transitions, kept apart from the minute samples', () => {
  const prev = stored(reading(), T0);
  assert.equal(historyStep(prev, reading({ resetsAt: RESET_S * 1000 + 5 * 3600_000 }), T0 + MIN).action, 'transition');
  assert.equal(historyStep(prev, reading({ windowMinutes: 600 }), T0 + MIN).action, 'transition');
  assert.equal(historyStep(prev, reading({ plan: 'team' }), T0 + MIN).action, 'transition');
});

test('usage status: none -> unavailable; fresh; stale after 15 min with its value; unknown source time labelled', () => {
  assert.deepEqual(usageStatus(null, T0), { state: 'unavailable', usedPercent: null, resetsAt: null, measuredAt: null, sourceTimeKnown: false, label: 'No observation yet' });
  const s = stored(reading({ usedPercent: 130, resetsAt: null }), T0);
  assert.deepEqual(usageStatus(s, T0 + 15 * MIN), { state: 'current', usedPercent: 130, resetsAt: null, measuredAt: T0, sourceTimeKnown: false,
    label: 'Source time unknown; observed 2026-01-01T12:00:00.000Z' });
  assert.equal(usageStatus(s, T0 + 15 * MIN + 1).state, 'stale');
  assert.equal(usageStatus(s, T0 + 15 * MIN + 1).usedPercent, 130, 'stale keeps its value and timestamp');
  assert.equal(usageStatus(stored(reading({ asOf: T0 }), T0 + MIN), T0 + 2 * MIN).label, null, 'known source time: no label');
});

test('EC-91: at reset time the value is replaced by "Reset passed; awaiting observation", never zero', () => {
  const s = stored(reading({ resetsAt: T0 + 10 * MIN }), T0);
  assert.deepEqual(usageStatus(s, T0 + 10 * MIN), { state: 'reset-passed', usedPercent: null, resetsAt: T0 + 10 * MIN, measuredAt: T0, sourceTimeKnown: false,
    label: 'Reset passed; awaiting observation' });
});

test('agy: an explicit unavailable usage state, never an empty or zero snapshot (FR-46)', () => {
  assert.deepEqual(agyUsageStatus(), { state: 'unavailable', usedPercent: null, resetsAt: null, measuredAt: null, sourceTimeKnown: false, label: 'Unavailable from passive sources' });
});

test('statusLine context: used = input + cache read + cache creation (output excluded), reported window; null after /compact', () => {
  const rec = { model: { id: 'claude-opus-5-5' }, context_window: { context_window_size: 200000,
    current_usage: { input_tokens: 10, output_tokens: 999, cache_creation_input_tokens: 20, cache_read_input_tokens: 70 } } };
  assert.deepEqual(statuslineContext(rec, 'd1'), { kind: 'statusline', model: 'claude-opus-5-5', window: 200000, used: 100, at: null, locator: 'd1' });
  assert.equal((statuslineContext({ context_window: { context_window_size: 200000, current_usage: null } }, 'd2') as { used: number | null }).used, null);
  assert.equal(statuslineContext({ model: { id: 'm' } }, 'd3'), null, 'no context_window: no context observation');
});

test('statusLine cost: total_cost_usd when reported (a valid zero stays 0), else null', () => {
  assert.equal(statuslineCost({ cost: { total_cost_usd: 1.25 } }), 1.25);
  assert.equal(statuslineCost({ cost: { total_cost_usd: 0 } }), 0);
  assert.equal(statuslineCost({ cost: {} }), null);
  assert.equal(statuslineCost({}), null);
  assert.equal(statuslineCost({ cost: { total_cost_usd: 1e7 } }), null, 'review L5: implausible value dropped');
});
