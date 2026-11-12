// XAIBO-PROD-207 (P2-T07, EC-94, EC-93 context/model part, PRD §5.11, D-P2-04): the latest context reading per
// generation. Claude used = input + cache read + cache creation (output excluded); its window comes only from a reported
// statusLine window (Phase 3 tee; synthetic here), never from the model list (D-P2-04). Codex: last total over the
// reported model_context_window, no second reduction. Compaction, model change and window change start a new generation;
// a numeric postTokens is an interim reading, otherwise "awaiting"; an old numerator never meets a new denominator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextStep, type ContextObs, type Snapshot } from '../../src/service/usage/context.ts';

const run = (obs: ContextObs[]) => obs.reduce<Snapshot | null>((s, o) => contextStep(s, o), null);
const pick = (s: Snapshot | null) => s && { g: s.generation, model: s.model, used: s.used, window: s.window, basis: s.basis, pct: s.percentage, source: s.source };
const OPUS = 'claude-opus-5-5';
const cu = (used: number | null, model: string | null = OPUS): ContextObs => ({ kind: 'claude-usage', model, used, at: 1, locator: 'u' });
const sl = (window: number | null, used: number | null, model: string | null = OPUS): ContextObs => ({ kind: 'statusline', model, window, used, at: 1, locator: 's' });

test('EC-94 transcript-only Claude: used without a window -> unavailable basis, no percentage (D-P2-04)', () => {
  assert.deepEqual(pick(run([cu(146)])), { g: 0, model: OPUS, used: 146, window: null, basis: 'unavailable', pct: null, source: 'transcript' });
});

test('statusLine-reported window takes precedence and later transcript usage keeps it', () => {
  assert.deepEqual(pick(run([cu(146), sl(200000, 150)])), { g: 0, model: OPUS, used: 150, window: 200000, basis: 'reported', pct: 0.075, source: 'statusline' });
  assert.deepEqual(pick(run([cu(146), sl(200000, 150), cu(400)])), { g: 0, model: OPUS, used: 400, window: 200000, basis: 'reported', pct: 0.2, source: 'transcript' });
});

test('EC-94 1M <-> 200k: a window change is a new generation; the new window is never paired with the old used count', () => {
  const s = run([sl(200000, 150000), sl(1000000, null)]);
  assert.deepEqual(pick(s), { g: 1, model: OPUS, used: null, window: 1000000, basis: 'reported', pct: null, source: 'statusline' });
  assert.deepEqual(pick(contextStep(s, cu(160000))), { g: 1, model: OPUS, used: 160000, window: 1000000, basis: 'reported', pct: 16, source: 'transcript' });
});

test('EC-94 compaction: new generation; postTokens -> labelled interim; without it -> awaiting next usage', () => {
  const before = run([sl(200000, 1200), cu(1200)]);
  assert.deepEqual(pick(contextStep(before, { kind: 'compaction', postTokens: 300, at: 2, locator: 'c' })),
    { g: 1, model: OPUS, used: 300, window: 200000, basis: 'reported', pct: 0.15, source: 'compaction' });
  assert.deepEqual(pick(contextStep(before, { kind: 'compaction', postTokens: null, at: 2, locator: 'c' })),
    { g: 1, model: OPUS, used: null, window: 200000, basis: 'reported', pct: null, source: 'compaction' });
});

test('EC-94 null current_usage invalidates the reading in place; a model change drops the old window', () => {
  assert.deepEqual(pick(run([sl(200000, 1200), sl(200000, null)])), { g: 0, model: OPUS, used: null, window: 200000, basis: 'reported', pct: null, source: 'statusline' });
  assert.deepEqual(pick(run([sl(200000, 1200), cu(50, 'claude-sonnet-5-5')])),
    { g: 1, model: 'claude-sonnet-5-5', used: 50, window: null, basis: 'unavailable', pct: null, source: 'transcript' });
});

test('EC-93 Codex: reported effective window, no second reduction; model or window change -> new generation', () => {
  const cx = (used: number | null, window: number | null, model = 'gpt-6.1-sol'): ContextObs => ({ kind: 'codex', model, used, window, at: 1, locator: 'x' });
  assert.deepEqual(pick(run([cx(1800, 200000)])), { g: 0, model: 'gpt-6.1-sol', used: 1800, window: 200000, basis: 'reported', pct: 0.9, source: 'rollout' });
  assert.equal(run([cx(1200, 200000), cx(1800, 200000)])!.generation, 0, 'same model and window');
  assert.equal(run([cx(1800, 200000), cx(900, 400000)])!.generation, 1, 'window change');
  assert.equal(run([cx(1800, 200000), cx(900, 200000, 'gpt-6.1-sol-next')])!.generation, 1, 'model change');
  assert.deepEqual(pick(run([cx(null, null)])), { g: 0, model: 'gpt-6.1-sol', used: null, window: null, basis: 'unavailable', pct: null, source: 'rollout' }, 'missing inputs stay unavailable');
});

test('agy and any session without context observations has no reading (shown as unavailable)', () => {
  assert.equal(run([]), null);
});
