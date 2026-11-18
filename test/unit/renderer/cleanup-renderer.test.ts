// XAIBO-PROD-502 (Phase 5 cleanup unit B, D-P4-13): one clock/short-time helper and one set of duration units in
// model.ts, one freshness/stale label helper, one lifecycle name, one roving-group key handler, shared `show`, plain
// string markers, and no live-set dedupe of ids the service never repeats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, DAY, findingBadges, HOUR, markers, MIN, SEC, shortTime } from '../../../src/renderer/model.ts';
import { readingLabels } from '../../../src/renderer/usage/presentation.ts';
import { lifecycleName } from '../../../src/renderer/status/presentation.ts';
import { show } from '../../../src/renderer/text.ts';
import { rovingKey } from '../../../src/renderer/components/virtual-list-model.ts';
import { liveSetSummary } from '../../../src/renderer/overview/totals.ts';
import * as view from '../../../src/renderer/workspace/view.ts';
import type { LiveStatus, SessionRow } from '../../../src/shared/ipc.ts';

test('clock and shortTime: local HH:MM; the date only on another day; unknown is said', () => {
  const at = new Date(2026, 0, 2, 9, 5).getTime();
  assert.equal(clock(at), '09:05');
  assert.equal(clock(null), 'Time unknown');
  assert.equal(clock(Number.MAX_VALUE), 'Time unknown');
  assert.equal(shortTime(at, new Date(2026, 0, 2, 23, 59).getTime()), '09:05');
  assert.equal(shortTime(at, new Date(2026, 0, 3, 0, 1).getTime()), '2026-01-02 09:05');
  assert.equal('clock' in view, false, 'one clock, in model.ts');
});

test('duration units', () => {
  assert.deepEqual([SEC, MIN, HOUR, DAY], [1000, 60_000, 3_600_000, 86_400_000]);
});

test('readingLabels: measured vs source time unknown; stale names its basis', () => {
  const asOf = new Date(2026, 0, 2, 9, 5).getTime(), seen = asOf + MIN;
  assert.deepEqual(readingLabels(asOf, seen, asOf, false),
    { freshness: 'Measured 2026-01-02 09:05 · observed 2026-01-02 09:06', stale: null, staleLabel: null });
  assert.deepEqual(readingLabels(null, seen, seen, true),
    { freshness: 'Source time unknown; observed 2026-01-02 09:06', stale: 'Stale · 2026-01-02 09:06', staleLabel: 'Stale, last observation 2026-01-02 09:06' });
  assert.equal(readingLabels(asOf, null, asOf, true).freshness, null, 'no first observation: no freshness line');
  assert.equal(readingLabels(asOf, null, asOf, true).staleLabel, 'Stale, last measurement 2026-01-02 09:05');
});

test('lifecycleName: the status badge words', () => {
  assert.deepEqual((['busy', 'waiting-for-permission', 'needs-input', 'unknown'] as const).map(lifecycleName),
    ['Busy', 'Waiting for permission', 'Needs input', 'Unknown']);
});

test('show: visible text or the fallback', () => {
  assert.equal(show(null, 'Untitled'), 'Untitled');
  assert.equal(show('', 'Untitled'), 'Untitled');
  assert.equal(show('a\u001bb', 'x'), 'a\\x1Bb');
});

test('rovingKey: arrows move focus in a horizontal group; other keys do nothing', () => {
  const focused: number[] = [];
  const refs = [0, 1, 2].map((i) => ({ focus: () => focused.push(i) }));
  let prevented = 0;
  const key = (k: string) => ({ key: k, preventDefault: () => { prevented++; } });
  rovingKey(key('ArrowRight'), 0, 3, refs);
  rovingKey(key('End'), 0, 3, refs);
  rovingKey(key('ArrowDown'), 1, 3, refs);
  rovingKey(key('Home'), 2, 0, []);
  assert.deepEqual(focused, [1, 2]);
  assert.equal(prevented, 2);
});

test('markers and finding badges are plain text', () => {
  const live = { lifecycle: 'busy', confidence: 'confirmed', health: 'connected', reason: null, outcome: null, findings: ['R2'], since: null } as LiveStatus;
  assert.deepEqual(findingBadges(live), ['R2 Repeated tool']);
  assert.deepEqual(markers({ drift: true, compressed: false, quarantined: 1 } as SessionRow), ['Format drift', '1 quarantined line']);
});

test('the live-set summary leaves active agents to the agent series', () => {
  assert.equal('activeAgents' in liveSetSummary([], false), false);
});
