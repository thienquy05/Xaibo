// XAIBO-PROD-205 (P2-T05, EC-10, PRD §5.5): hook, transcript/rollout and OTel observations of one tool call join on
// the native call id (tool_use_id / call_id) into one ToolCall with combined provenance, whatever the arrival order.
// No id = unlinked: never joined by timing or name. Hook observations come from the S4 hook fixtures; the OTel one is
// a synthetic normalized observation (the OTel adapter is v1-B). agy (T00): transcript tool calls carry no id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeToolCalls, type ToolCallObservation } from '../../src/service/normalize.ts';

const HOOKS = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'claude', '2.1.319', 'hooks', 'permission-granted', 'hooks.jsonl');
const hookObs: ToolCallObservation[] = readFileSync(HOOKS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>)
  .filter((h) => h.tool_use_id).map((h) => ({ source: 'hook', callId: h.tool_use_id!, tool: h.tool_name }));
const ID = hookObs[0]!.callId!;

function permutations<T>(xs: T[]): T[][] {
  return xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

test('EC-10: hook (Pre+Post), transcript and OTel in any order -> one ToolCall listing all three', () => {
  assert.equal(hookObs.length, 2, 'PreToolUse and PostToolUse carry the same tool_use_id');
  const obs: ToolCallObservation[] = [...hookObs,
    { source: 'transcript', callId: ID, tool: 'Bash', argsEventId: 11 },
    { source: 'transcript', callId: ID, resultEventId: 12 },
    { source: 'otel', callId: ID, tool: 'bash' }];
  const expected = [{ callId: ID, sources: ['hook', 'otel', 'transcript'], tool: 'Bash', argsEventId: 11, resultEventId: 12 }];
  for (const p of permutations(obs)) assert.deepEqual(mergeToolCalls(p), expected, JSON.stringify(p.map((o) => o.source)));
});

test('different ids stay apart; observations without an id are never joined, even with the same tool', () => {
  const got = mergeToolCalls([
    { source: 'rollout', callId: 'call_a', tool: 'shell' }, { source: 'rollout', callId: 'call_b', tool: 'shell' },
    { source: 'transcript', callId: null, tool: 'read_file' }, { source: 'transcript', callId: null, tool: 'read_file' },
  ]);
  assert.deepEqual(got.map((c) => c.callId), ['call_a', 'call_b', null, null]);
  assert.ok(got.every((c) => c.sources.length === 1));
});

test('agy (T00): transcript tool calls (no id) stay unlinked from a hook call with an id; missing fields stay null', () => {
  const got = mergeToolCalls([{ source: 'hook', callId: 'agy-tool-1', tool: 'read_file' }, { source: 'transcript', callId: null, tool: 'read_file' }]);
  assert.deepEqual(got, [
    { callId: 'agy-tool-1', sources: ['hook'], tool: 'read_file', argsEventId: null, resultEventId: null },
    { callId: null, sources: ['transcript'], tool: 'read_file', argsEventId: null, resultEventId: null },
  ]);
  assert.deepEqual(mergeToolCalls([]), []);
});
