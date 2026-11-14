// XAIBO-PROD-308 (P3-T08, PRD §6.2): Claude hook and transcript observations -> normalized status evidence. Every §6.2
// row the engine needs, including the S7 readings: PermissionRequest has no tool_use_id (joined by order), idle_prompt
// and elicitation notifications are not input requests, a transcript rejection is its own evidence, subagent tool calls
// never restart the parent turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeEvidence } from '../../src/service/adapters/claude/status-map.ts';
import type { Ev } from '../../src/service/status/engine.ts';
import { hookObs, fileObs } from '../helpers/status.ts';

// R2–R4 signatures (P3-T09) are checked in their own test; the row tests compare the rest.
const bare = (evs: Ev[]) => evs.map((e) => { const { sig: _s, ...rest } = e as Ev & { sig?: string }; return rest; });
const hook = (event: string, p: Record<string, unknown> = {}) => bare(claudeEvidence(hookObs('claude', { hook_event_name: event, ...p })));
const line = (r: Record<string, unknown>) => bare(claudeEvidence(fileObs('claude', r)));

test('signatures (P3-T09): tool and normalized args on start, result on end; hashes, never content', () => {
  const start = (input: unknown) => claudeEvidence(hookObs('claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: input, tool_use_id: 't' }))[0] as { sig?: string };
  assert.match(start({ a: 1, b: 'secret-canary' }).sig ?? '', /^[0-9a-f]{16}$/);
  assert.equal(start({ a: 1, b: 2 }).sig, start({ b: 2, a: 1 }).sig, 'key order does not matter');
  assert.notEqual(start({ a: 1 }).sig, start({ a: 2 }).sig);
  const end = (r: unknown) => (claudeEvidence(hookObs('claude', { hook_event_name: 'PostToolUse', tool_use_id: 't', tool_response: r }))[0] as { sig?: string }).sig;
  assert.equal(end({ stdout: 'x' }), end({ stdout: 'x' }));
  assert.notEqual(end({ stdout: 'x' }), end({ stdout: 'y' }));
});

test('hook rows: session, turn, tools, Stop, StopFailure, SessionEnd', () => {
  assert.deepEqual(hook('SessionStart', { source: 'startup' }), [{ k: 'session.start' }]);
  assert.deepEqual(hook('UserPromptSubmit', { prompt: 'p' }), [{ k: 'turn.start', typed: true }]);
  assert.deepEqual(hook('UserPromptSubmit'), [{ k: 'turn.start', typed: false }]);
  assert.deepEqual(hook('UserPromptSubmit', { prompt: 'p'.repeat(5000) }), [{ k: 'turn.start', typed: true }], 'a long prompt is still typed');
  assert.deepEqual(hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 't1' }), [{ k: 'tool.start', id: 't1', tool: 'Bash' }]);
  assert.deepEqual(hook('PreToolUse', { tool_name: 'Bash', tool_input: { run_in_background: true }, tool_use_id: 't1' }),
    [{ k: 'tool.start', id: 't1', tool: 'Bash', background: true }]);
  assert.deepEqual(hook('PostToolUse', { tool_use_id: 't1' }), [{ k: 'tool.end', id: 't1' }]);
  assert.deepEqual(hook('PostToolUseFailure', { tool_use_id: 't1' }), [{ k: 'tool.end', id: 't1', err: true }]);
  assert.deepEqual(hook('Stop'), [{ k: 'turn.end' }]);
  assert.deepEqual(hook('StopFailure'), [{ k: 'turn.error' }]);
  assert.deepEqual(hook('SessionEnd', { reason: 'other' }), [{ k: 'session.end' }]);
});

test('requests: PermissionRequest joins by order (no id); permission_prompt requests; idle_prompt and elicitation notices do not', () => {
  assert.deepEqual(hook('PermissionRequest', { tool_name: 'Write' }), [{ k: 'request', kind: 'permission', id: null }]);
  assert.deepEqual(hook('Notification', { notification_type: 'permission_prompt' }), [{ k: 'request', kind: 'permission', id: null }]);
  for (const t of ['idle_prompt', 'elicitation_dialog', 'elicitation_response', 'auth_success']) assert.deepEqual(hook('Notification', { notification_type: t }), [], t);
});

test('input requests: Elicitation, ElicitationResult accept/decline/cancel resolve only the same server', () => {
  assert.deepEqual(hook('Elicitation', { mcp_server_name: 's' }), [{ k: 'request', kind: 'input', id: 'elicit:s' }]);
  assert.deepEqual(hook('ElicitationResult', { mcp_server_name: 's', action: 'accept' }), [{ k: 'resolve', id: 'elicit:s', outcome: null }]);
  assert.deepEqual(hook('ElicitationResult', { mcp_server_name: 's', action: 'decline' }), [{ k: 'resolve', id: 'elicit:s', outcome: 'declined' }]);
  assert.deepEqual(hook('ElicitationResult', { mcp_server_name: 's', action: 'cancel' }), [{ k: 'resolve', id: 'elicit:s', outcome: 'cancelled' }]);
});

test('subagents: start/stop are children; a subagent tool call never restarts the parent turn', () => {
  assert.deepEqual(hook('SubagentStart', { agent_id: 'a1' }), [{ k: 'child.start', id: 'a1' }]);
  assert.deepEqual(hook('SubagentStop', { agent_id: 'a1' }), [{ k: 'child.end', id: 'a1' }]);
  assert.deepEqual(hook('PreToolUse', { agent_id: 'a1', tool_name: 'Read', tool_use_id: 't9' }), [{ k: 'tool.start', id: 't9', tool: 'Read', child: true }]);
});

test('no lifecycle evidence: compaction, cwd change, unknown events; a null payload still maps by envelope event', () => {
  for (const e of ['PreCompact', 'PostCompact', 'CwdChanged', 'FutureEvent']) assert.deepEqual(hook(e), [], e);
  const o = hookObs('claude', {});
  assert.deepEqual(claudeEvidence({ ...o, envelope: { ...o.envelope, payload: null, event: 'Stop' } }), [{ k: 'turn.end' }]);
});

test('transcript: prompt, tool_use, tool_result, rejection, end_turn, usage; other records carry nothing', () => {
  assert.deepEqual(line({ type: 'user', message: { role: 'user', content: 'p' } }), [{ k: 'turn.start', typed: true }]);
  const use = { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use',
    usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 } } };
  assert.deepEqual(line(use), [{ k: 'activity' }, { k: 'tool.start', id: 't1', tool: 'Bash' },
    { k: 'usage', key: 'm1', usage: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4 } }]);
  const result = (content: string, is_error: boolean) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content, is_error }] } });
  assert.deepEqual(result('ok', false), [{ k: 'tool.end', id: 't1' }]);
  assert.deepEqual(result('Exit code 1', true), [{ k: 'tool.end', id: 't1', err: true }]);
  assert.deepEqual(result("The user doesn't want to proceed with this tool use. The tool use was rejected.", true), [{ k: 'tool.rejected', id: 't1' }]);
  assert.deepEqual(line({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'r' }], stop_reason: 'end_turn' } }), [{ k: 'activity' }, { k: 'turn.idle' }]);
  for (const r of [{ type: 'queue-operation', operation: 'enqueue' }, { type: 'system', subtype: 'compact_boundary' }, { type: 'future-record' }]) assert.deepEqual(line(r), []);
  assert.deepEqual(claudeEvidence({ ...fileObs('claude', {}), line: '{"broken' }), []);
});

test('ElicitationResult with a prototype-named action resolves with a null outcome', () => {
  for (const action of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual(hook('ElicitationResult', { mcp_server_name: 's', action }), [{ k: 'resolve', id: 'elicit:s', outcome: null }], action);
  }
});
