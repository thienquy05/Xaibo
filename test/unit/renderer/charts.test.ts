// DD2 rev 3: chart art must preserve missing evidence and the live-set total semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionRow, UsageRecord } from '../../../src/shared/ipc.ts';
import { barGeometry, historyGeometry, quotaArc, tileSeries } from '../../../src/renderer/overview/charts.ts';

const row = (id: number, extra: Partial<SessionRow> = {}): SessionRow => ({ id, agent: 'claude', entrypoint: null, origin: null, interactive: null, model: 'Model unavailable',
  cwd: null, title: null, lastActivity: id, drift: false, compressed: false, quarantined: 0, live: null, contextPct: null, costUsd: null,
  costCoverage: 'unavailable', tokens: null, tokensComplete: false, ...extra });
const sample = (id: number, minute: number, extra: Partial<UsageRecord> = {}): UsageRecord => ({ id, kind: 'sample', measuredAt: minute * 60_000,
  usedPercent: 20 + minute, windowMinutes: 300, resetsAt: 50 * 60_000, sourceTimeKnown: true, ...extra });

test('microseries count only active agents (distinct agents with busy or waiting sessions), include all supplied states and retain nulls', () => {
  const live = (lifecycle: NonNullable<SessionRow['live']>['lifecycle']) => ({ lifecycle, confidence: 'confirmed' as const, health: 'connected' as const, reason: null, outcome: null, findings: [], since: null });
  const series = tileSeries([row(1, { tokens: 7, costUsd: 2, costCoverage: 'full', live: live('busy') }),
    row(2, { agent: 'codex', live: live('idle') }), row(3, { agent: 'agy', costUsd: 9, live: live('error') }), row(4, { live: live('needs-input'), tokens: 0 }), row(5)], (id) => id);
  assert.deepEqual(series.agents, [{ label: 'claude', value: 2 }]);
  assert.equal(series.states.find((s) => s.label === 'unknown')?.value, 1);
  assert.equal(series.states.find((s) => s.label === 'error')?.value, 1);
  assert.deepEqual(series.tokens.map((s) => s.value), [7, null, null, 0, null]);
  assert.deepEqual(series.cost.map((s) => s.value), [2, null, null, null, null]);
});

test('microbar scale starts at zero, preserves unavailable and represents observed zero with a baseline marker', () => {
  const bars = barGeometry([10, null, 0, 20]);
  assert.equal(bars.length, 4);
  assert.equal(bars[1], null);
  assert.equal(bars[2]?.height, 0);
  assert.equal(bars[3]?.height, 40);
  assert.equal(bars[0]?.height, 20);
  assert.deepEqual(barGeometry([]), []);
  assert.equal(barGeometry([Infinity, -1, NaN]).every((b) => b === null), true);
  assert.equal(barGeometry([Number.MAX_VALUE])[0]?.height, 40);
});

test('history sorts loaded observations, uses elapsed time, keeps exact values above scale and breaks missing minutes', () => {
  const g = historyGeometry([sample(3, 4, { usedPercent: 125 }), sample(1, 1), sample(2, 2)]);
  assert.equal(g.segments.length, 2);
  assert.deepEqual(g.segments.map((s) => s.length), [2, 1]);
  assert.deepEqual(g.points.map((p) => p.record.id), [1, 2, 3]);
  assert.equal(g.points[2]?.record.usedPercent, 125);
  assert.equal(g.maxPercent, 125);
  assert.equal(historyGeometry([sample(1, 1, { usedPercent: 100 }), sample(2, 2, { usedPercent: 200 })]).points[0]?.y, 110);
  assert.equal(g.points[2]?.y, 20);
  assert.equal(g.points[1]!.x - g.points[0]!.x, (g.points[2]!.x - g.points[0]!.x) / 3);
  assert.deepEqual(historyGeometry([]).points, []);
});

test('history breaks at null, transition, reset/window changes, same-minute duplicates and source-time uncertainty', () => {
  for (const change of [{ usedPercent: null }, { kind: 'transition' as const }, { resetsAt: 60 * 60_000 }, { windowMinutes: 60 }, { sourceTimeKnown: false }, { windowMinutes: null }, { resetsAt: null }]) {
    const g = historyGeometry([sample(1, 1), sample(2, 2, change), sample(3, 3)]);
    assert.ok(g.segments.every((s) => s.length === 1), JSON.stringify(change));
  }
  assert.ok(historyGeometry([sample(1, 1), sample(2, 1)]).segments.every((s) => s.length === 1));
  assert.equal(historyGeometry([sample(1, 1)]).points[0]?.x, 280);
});

test('arc clamps art only, has no empty gauge for unavailable, and keeps endpoints finite', () => {
  assert.equal(quotaArc(null), null);
  assert.equal(quotaArc(NaN), null);
  assert.equal(quotaArc(-1), null);
  assert.equal(quotaArc(125), quotaArc(100));
  assert.equal(quotaArc(0), '');
  assert.match(quotaArc(50)!, /^M20 130 A110 110 0 0 1 130 20$/);
});

test('review M1: cost data retain full, partial, uncertain and unavailable coverage without changing values', () => {
  const rows = [row(1, { costUsd: 0.1 + 0.2, costCoverage: 'full' }), row(2, { costUsd: 4e-7, costCoverage: 'partial' }),
    row(3, { costUsd: 0.5, costCoverage: 'uncertain' }), row(4, { costUsd: 9, costCoverage: 'unavailable' }), row(5)];
  const series = tileSeries(rows, (id) => id);
  assert.deepEqual(series.cost, [
    { label: 'Session 1', value: 0.1 + 0.2, coverage: 'full' },
    { label: 'Session 2', value: 4e-7, coverage: 'partial' },
    { label: 'Session 3', value: 0.5, coverage: 'uncertain' },
    { label: 'Session 4', value: null, coverage: 'unavailable' },
    { label: 'Session 5', value: null, coverage: 'unavailable' },
  ]);
});

test('review M2: token data retain incomplete known subtotals, complete zero and missing values', () => {
  const series = tileSeries([row(1, { tokens: 12, tokensComplete: false }), row(2, { tokens: 0, tokensComplete: true }), row(3)], (id) => id);
  assert.deepEqual(series.tokens, [
    { label: 'Session 1', value: 12, partial: true },
    { label: 'Session 2', value: 0, partial: false },
    { label: 'Session 3', value: null, partial: true },
  ]);
});

test('review L5: active-agent series use display names without merging different agent identities', () => {
  const live = { lifecycle: 'busy' as const, confidence: 'confirmed' as const, health: 'connected' as const, reason: null, outcome: null, findings: [], since: null };
  const series = tileSeries([row(1, { live }), row(2, { agent: 'custom', live }), row(3, { agent: 'missing', live })],
    (id) => ({ claude: 'Claude Code', custom: 'custom agent' })[id] ?? id);
  assert.deepEqual(series.agents, [{ label: 'Claude Code', value: 1 }, { label: 'custom agent', value: 1 }, { label: 'missing', value: 1 }]);
});
