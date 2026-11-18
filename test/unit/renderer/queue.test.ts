// XAIBO-PROD-406 (P4-T04b2; design §6.2 attention queue, §7.1 since/duration): groups in fixed order, one record per
// session, oldest onset first with unknown last, stable id tie-break; heuristic waits apart and labelled by group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionQueue, durationText, sinceText } from '../../../src/renderer/overview/queue.ts';
import type { LiveStatus, SessionRow } from '../../../src/shared/ipc.ts';

const live = (lifecycle: LiveStatus['lifecycle'], o: Partial<LiveStatus> = {}): LiveStatus =>
  ({ lifecycle, confidence: 'confirmed', health: 'connected', reason: null, outcome: null, findings: [], since: null, ...o });
const r = (id: number, l: LiveStatus | null): SessionRow => ({ id, agent: 'claude', entrypoint: null, origin: null, interactive: null, model: 'Model unavailable',
  cwd: null, title: null, lastActivity: id, drift: false, compressed: false, quarantined: 0, live: l, contextPct: null, costUsd: null,
  costCoverage: 'unavailable', tokens: null, tokensComplete: true });

test('group order: confirmed (permission then input) > errors > unconfirmed > probably waiting > findings; others are not queued', () => {
  const rows = [
    r(1, live('busy', { findings: ['R2'] })),
    r(2, live('waiting-for-permission', { confidence: 'heuristic', reason: 'Probably waiting', since: 10 })),
    r(3, live('needs-input', { since: 5 })),
    r(4, live('error', { since: 7, findings: ['R3'] })),
    r(5, live('waiting-for-permission', { since: 9 })),
    r(6, live('needs-input', { confidence: 'inferred', since: 1 })),
    r(7, live('idle')), r(8, live('busy')), r(9, null), r(10, live('unknown', { confidence: 'inferred' })),
  ];
  const q = attentionQueue(rows);
  assert.deepEqual(q.map((g) => [g.name, g.rows.map((x) => x.id)]), [
    ['Confirmed requests', [5, 3]],
    ['Errors', [4]],
    ['Unconfirmed requests', [6]],
    ['Probably waiting', [2]],
    ['Findings', [1]],
  ]);
  assert.equal(q.flatMap((g) => g.rows).length, new Set(q.flatMap((g) => g.rows.map((x) => x.id))).size, 'one record per session');
});

test('within a group: oldest onset first, unknown onset last, then id', () => {
  const rows = [r(4, live('error', { since: null })), r(3, live('error', { since: 20 })), r(1, live('error', { since: null })), r(2, live('error', { since: 10 }))];
  assert.deepEqual(attentionQueue(rows)[0]!.rows.map((x) => x.id), [2, 3, 1, 4]);
  assert.deepEqual(attentionQueue([]), [], 'nothing queued: no groups');
});

test('since text: clock time plus elapsed duration; unknown onset; a source clock ahead never reads negative', () => {
  const at = new Date(2026, 0, 2, 14, 3, 0).getTime();
  assert.equal(sinceText(at, at + 302_000), 'Since 14:03 · 5 min 2 s');
  const yesterday = new Date(2026, 0, 1, 9, 5, 0).getTime();
  assert.equal(sinceText(yesterday, at), 'Since 2026-01-01 09:05 · 1 d 4 h');
  assert.equal(sinceText(null, at), 'Since Unknown');
  assert.equal(sinceText(at + 60_000, at), 'Source clock ahead · 2026-01-02 14:04');
});

test('durations per §7.1: floor units, never zero for data', () => {
  const cases: [number, string][] = [[500, '<1 s'], [45_000, '45 s'], [302_000, '5 min 2 s'], [7_380_000, '2 h 3 min'], [104_400_000, '1 d 5 h']];
  for (const [ms, s] of cases) assert.equal(durationText(ms), s, String(ms));
});

// XAIBO-PROD-437 review M1: the Open session order Return restores against comes from data, not from mounted rows.
test('openOrder: the live set order, the attention queue order (groups flattened), none for usage', async () => {
  const { openOrder } = await import('../../../src/renderer/overview/queue.ts');
  const rows = [r(1, live('busy')), r(2, live('waiting-for-permission')), r(3, live('needs-input'))];
  assert.deepEqual(openOrder('live', rows), [1, 2, 3]);
  assert.deepEqual(openOrder('attention', rows), attentionQueue(rows).flatMap((g) => g.rows.map((r) => r.id)));
  assert.deepEqual(openOrder('usage', rows), []);
});

// XAIBO-PROD-448 (G4c-4; design §6.13 A2): before the live set first loads the queue is Loading, after its first load
// fails it reads Couldn't load attention (the summary keeps the one Retry); Nothing needs attention only once loaded,
// and records already loaded stay on a later failure.
test('attentionState: loading or failed before the first load; empty or queue once loaded (a later failure keeps them)', async () => {
  const { attentionState } = await import('../../../src/renderer/overview/queue.ts');
  assert.equal(attentionState(false, false, 0), 'loading');
  assert.equal(attentionState(false, true, 0), 'failed');
  assert.equal(attentionState(true, false, 0), 'empty');
  assert.equal(attentionState(true, false, 2), 'queue');
  assert.equal(attentionState(true, true, 2), 'queue', 'existing records retained');
  assert.equal(attentionState(true, true, 0), 'empty');
});
