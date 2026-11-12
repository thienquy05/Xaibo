// XAIBO-PROD-308 (P3-T08, PRD §6.3): Codex 0.160.0 hook and rollout observations -> normalized status evidence. Hook and
// rollout rows of §6.3 (notify rows are v1-B, app-server v1-A); Interrupt is its own evidence; turn ids join hook and
// rollout turns; token_count totals are cumulative (one key, latest wins), never summed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexEvidence } from '../../src/service/adapters/codex/status-map.ts';
import { hookObs, fileObs } from '../helpers/status.ts';

const hook = (event: string, p: Record<string, unknown> = {}) => codexEvidence(hookObs('codex', { hook_event_name: event, ...p }));
const roll = (type: string, payload: Record<string, unknown>) => codexEvidence(fileObs('codex', { timestamp: '2026-01-01T00:00:00.000Z', type, payload }));

test('hook rows: session, prompt with turn id, tools, PermissionRequest, Stop, Interrupt, subagents, SessionEnd', () => {
  assert.deepEqual(hook('SessionStart', { source: 'startup' }), [{ k: 'session.start' }]);
  assert.deepEqual(hook('UserPromptSubmit', { turn_id: 'u1', prompt: 'p' }), [{ k: 'turn.start', typed: true, turn: 'u1' }]);
  assert.deepEqual(hook('PreToolUse', { turn_id: 'u1', tool_name: 'Bash', tool_use_id: 'c1' }), [{ k: 'tool.start', id: 'c1', tool: 'Bash' }]);
  assert.deepEqual(hook('PostToolUse', { tool_use_id: 'c1' }), [{ k: 'tool.end', id: 'c1' }]);
  assert.deepEqual(hook('PermissionRequest', { tool_use_id: 'c1' }), [{ k: 'request', kind: 'permission', id: 'c1' }]);
  assert.deepEqual(hook('Stop'), [{ k: 'turn.end' }]);
  assert.deepEqual(hook('Interrupt'), [{ k: 'interrupt' }]);
  assert.deepEqual(hook('SubagentStart', { agent_id: 'a1' }), [{ k: 'child.start', id: 'a1' }]);
  assert.deepEqual(hook('SubagentStop', { agent_id: 'a1' }), [{ k: 'child.end', id: 'a1' }]);
  assert.deepEqual(hook('SessionEnd', { reason: 'x' }), [{ k: 'session.end' }]);
  for (const e of ['PreCompact', 'PostCompact', 'FutureEvent']) assert.deepEqual(hook(e), [], e);
});

test('rollout rows: task_started/task_complete, tool calls, messages, token_count; meta and context carry nothing', () => {
  assert.deepEqual(roll('event_msg', { type: 'task_started', turn_id: 'u1' }), [{ k: 'turn.start', typed: true, turn: 'u1' }]);
  assert.deepEqual(roll('event_msg', { type: 'task_complete', turn_id: 'u1' }), [{ k: 'turn.end' }]);
  assert.deepEqual(roll('response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec_command' }), [{ k: 'tool.start', id: 'c1', tool: 'exec_command' }]);
  assert.deepEqual(roll('response_item', { type: 'function_call', call_id: 'c2', name: 'shell' }), [{ k: 'tool.start', id: 'c2', tool: 'shell' }]);
  assert.deepEqual(roll('response_item', { type: 'custom_tool_call_output', call_id: 'c1' }), [{ k: 'tool.end', id: 'c1' }]);
  assert.deepEqual(roll('response_item', { type: 'function_call_output', call_id: 'c2' }), [{ k: 'tool.end', id: 'c2' }]);
  assert.deepEqual(roll('response_item', { type: 'message', role: 'assistant' }), [{ k: 'activity' }]);
  const tot = { input_tokens: 10, cached_input_tokens: 6, output_tokens: 2, reasoning_output_tokens: 1 };
  assert.deepEqual(roll('event_msg', { type: 'token_count', info: { total_token_usage: tot } }),
    [{ k: 'usage', key: 'total', usage: { input: 10, cacheRead: 6, output: 2, reasoning: 1 } }]);
  for (const [t, p] of [['session_meta', {}], ['turn_context', { turn_id: 'u1' }], ['compacted', {}], ['future_record', {}]] as const) assert.deepEqual(roll(t, p), [], t);
  assert.deepEqual(codexEvidence({ ...fileObs('codex', {}), line: 'not json' }), []);
});
