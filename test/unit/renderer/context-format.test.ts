// XAIBO-PROD-414 (P4-T06a; PRD FR-47, US-17; design §6.3.1, §7.1 D1): the Current context view from one reading.
// Abbreviations show, exact integers are spoken; unavailable is never 0; compaction without a new reading never keeps
// an old meter; out-of-range readings keep their numbers without a meter; the category ledger stays unavailable (v1-B).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_ROWS, contextView, percentText } from '../../../src/renderer/workspace/context/format.ts';
import { formatTime } from '../../../src/renderer/model.ts';
import type { ContextReading } from '../../../src/shared/ipc.ts';

const T = Date.parse('2026-01-02T10:00:00.000Z');
const read = (o: Partial<ContextReading> = {}): ContextReading => ({ generation: 0, used: 40000, window: 200000, basis: 'reported', source: 'statusline',
  asOf: T, observedAt: T + 1, ...o });

test('percent: one decimal, trailing .0 dropped, a nonzero value below 0.1 is <0.1%, zero stays 0%', () => {
  assert.deepEqual([0, 0.04, 20, 12.34, 99.96, 100].map(percentText), ['0%', '<0.1%', '20%', '12.3%', '100%', '100%']);
});

test('a reported reading: abbreviated visible value, exact integers in accessible text, meter, generation 1-based', () => {
  const v = contextView('claude', true, read(), T + 2);
  assert.equal(v.value, '20% · 40k / 200k');
  assert.equal(v.meter, 20);
  assert.equal(v.meterNote, null);
  assert.equal(v.unoccupied, 'Unoccupied; buffer unknown');
  assert.equal(v.source, 'Source: Claude statusLine');
  assert.equal(v.generation, 'Generation 1');
  assert.equal(v.label, 'Context: 20 percent; 40,000 of 200,000 tokens; source Claude statusLine; generation 1');
  const big = contextView('codex', false, read({ used: 123456, window: 1000000, source: 'rollout', generation: 4 }), T);
  assert.equal(big.value, '12.3% · 123.5k / 1M');
  assert.match(big.label, /123,456 of 1,000,000 tokens; source Codex rollout; generation 5$/);
});

test('no reading, or agy: unavailable with a reason, never 0, no meter', () => {
  for (const v of [contextView('claude', true, null, T), contextView('agy', true, read(), T)]) {
    assert.equal(v.value, 'Context unavailable');
    assert.equal(v.meter, null);
    assert.equal(v.unoccupied, null);
    assert.equal(v.generation, 'Generation unavailable');
    assert.match(v.meterNote!, /^Context meter unavailable — /);
    assert.doesNotMatch(`${v.value} ${v.label}`, /\b0\b|40,000|200,000/);
  }
  assert.match(contextView('agy', true, read(), T).meterNote!, /Antigravity CLI/);
});

test('Claude transcript-only: used tokens kept, window and percentage unavailable until the statusLine reports a window', () => {
  const v = contextView('claude', true, read({ source: 'transcript', used: 9000, window: null, basis: 'unavailable' }), T);
  assert.equal(v.value, '9k used · window unavailable');
  assert.equal(v.meter, null);
  assert.match(v.meterNote!, /^Context meter unavailable — window not reported/);
  assert.equal(v.label, 'Context: percentage unavailable; 9,000 tokens used; window unavailable; source Claude transcript; generation 1');
});

test('after compaction: awaiting next usage with no meter; a postTokens reading is interim', () => {
  const wait = contextView('claude', true, read({ source: 'compaction', used: null, generation: 2 }), T);
  assert.equal(wait.value, 'Awaiting next usage');
  assert.equal(wait.meter, null);
  assert.equal(wait.unoccupied, null);
  assert.match(wait.meterNote!, /awaiting next usage after compaction/);
  assert.doesNotMatch(wait.label, /200,000/); // the window is not shown against no reading
  assert.equal(wait.label, 'Context: awaiting next usage after compaction; source Compaction record; generation 3');
  const interim = contextView('claude', true, read({ source: 'compaction', used: 30000 }), T);
  assert.equal(interim.qualifier, 'Interim after compaction');
  assert.equal(interim.meter, 15);
  assert.match(interim.label, /interim after compaction/);
});

test('used not reported (not a compaction): a reported window is kept on its own, no meter, never 0', () => {
  const v = contextView('claude', true, read({ used: null }), T);
  assert.equal(v.value, 'Used unavailable · 200k window');
  assert.equal(v.meter, null);
  assert.equal(v.label, 'Context: used tokens unavailable; window 200,000 tokens; source Claude statusLine; generation 1');
  assert.equal(contextView('codex', true, read({ used: null, window: null, basis: 'unavailable', source: 'rollout' }), T).value, 'Context unavailable');
});

test('out of range: exact numbers with a warning, no meter', () => {
  const v = contextView('codex', true, read({ used: 210000 }), T);
  assert.equal(v.value, '105% · 210k / 200k');
  assert.equal(v.meter, null);
  assert.equal(v.warning, 'Reading out of range: 210,000 of 200,000 tokens');
  assert.match(v.meterNote!, /out of range/);
  const zero = contextView('codex', true, read({ used: 5, window: 0 }), T);
  assert.equal(zero.meter, null);
  assert.equal(zero.warning, 'Reading out of range: 5 of 0 tokens');
  assert.doesNotMatch(zero.value, /%/);
});

test('an inferred window is an estimate: ~est visible, estimate in accessible text', () => {
  const v = contextView('codex', true, read({ basis: 'inferred' }), T);
  assert.equal(v.value, '~est 20% · 40k / 200k');
  assert.match(v.label, /^Context, estimate: /);
});

test('freshness: measured time or source time unknown; Stale only while live and older than 15 minutes', () => {
  assert.equal(contextView('claude', true, read(), T).freshness, `Measured ${formatTime(T)} · observed ${formatTime(T + 1)}`);
  assert.equal(contextView('claude', true, read({ asOf: null }), T).freshness, `Source time unknown; observed ${formatTime(T + 1)}`);
  assert.equal(contextView('claude', true, read(), T + 15 * 60_000).stale, null);
  assert.equal(contextView('claude', true, read(), T + 15 * 60_000 + 1).stale, `Stale · ${formatTime(T)}`);
  assert.equal(contextView('claude', false, read(), T + 86_400_000).stale, null);
});

test('category ledger: 12 rows in design order, all unavailable with the v1-B or buffer reason, never usable before compaction', () => {
  assert.deepEqual(CATEGORY_ROWS.map((r) => r.name), ['Messages', 'System prompt', 'Memory files', 'Skills', 'MCP server instructions',
    'System tool definitions', 'MCP tool definitions', 'Custom agents', 'Compaction buffer', 'Free space', 'Deferred MCP tool definitions',
    'Deferred system tool definitions']);
  assert.deepEqual([...new Set(CATEGORY_ROWS.map((r) => r.group))], ['Used context', 'Outside used context', 'Deferred definitions']);
  for (const r of CATEGORY_ROWS) {
    assert.equal(r.value, 'Unavailable');
    assert.match(r.label, r.name === 'Free space' ? /^Free space: unavailable — compaction buffer unavailable$/ : /v1-B/);
    assert.doesNotMatch(r.label, /usable before compaction/i);
  }
});
