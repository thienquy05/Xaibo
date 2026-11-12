// XAIBO-PROD-305 (P3-T05, PRD §5.2, FR-51): every Claude hook payload maps to evidence fields; the unknown remainder
// stays raw. Recorded shapes come from the S4 (2.1.319) and S7 (2.1.322) fixtures; events with no recorded shape are
// checked only for the generic fields, with no claim about their payloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_HOOK_EVENTS, mapClaudeHook, TOOL_INPUT_PREVIEW } from '../../src/service/adapters/claude/hooks.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'claude');
const USED = ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'prompt_id', 'permission_mode', 'agent_id', 'agent_type',
  'tool_name', 'tool_use_id', 'tool_input', 'notification_type', 'model', 'effort'];
const payloads = (version: string) => readdirSync(join(FIX, version, 'hooks')).flatMap((c) =>
  readFileSync(join(FIX, version, 'hooks', c, 'hooks.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>));
const recorded = [...payloads('2.1.319'), ...payloads('2.1.322')];

test('the subscribed set is exactly the PRD §5.2 list', () => {
  assert.deepEqual([...CLAUDE_HOOK_EVENTS], ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PermissionRequest', 'PermissionDenied', 'Notification', 'Elicitation', 'ElicitationResult', 'SubagentStart', 'SubagentStop', 'Stop',
    'StopFailure', 'PreCompact', 'PostCompact', 'CwdChanged', 'SessionEnd']);
});

test('the 2.1.322 fixture carries exactly the key sets S7 recorded', () => {
  const s7 = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'spikes', 's7', 'evidence', 's7.json'), 'utf8'));
  const keys = (ev: string) => Object.keys(payloads('2.1.322').find((p) => p['hook_event_name'] === ev)!).sort();
  assert.deepEqual(keys('Elicitation'), [...s7.t3.accept.elicitationKeys].sort());
  assert.deepEqual(keys('ElicitationResult'), [...s7.t3.accept.elicitationResultKeys].sort());
  assert.deepEqual(keys('PostCompact'), [...s7.s13.compact.postCompactKeys].sort());
});

test('every recorded payload maps: generic fields, event fields, effort, preview; the rest stays raw', () => {
  for (const p of recorded) {
    const e = mapClaudeHook(p, p['hook_event_name'] as string);
    const want = (k: string) => (typeof p[k] === 'string' ? p[k] : null);
    assert.equal(e.event, p['hook_event_name']);
    assert.deepEqual([e.sessionId, e.transcriptPath, e.cwd, e.promptId, e.permissionMode, e.agentId, e.agentType, e.toolName, e.toolUseId, e.notificationType],
      ['session_id', 'transcript_path', 'cwd', 'prompt_id', 'permission_mode', 'agent_id', 'agent_type', 'tool_name', 'tool_use_id', 'notification_type'].map(want));
    if (p['tool_input'] !== undefined) assert.ok(JSON.stringify(p['tool_input']).startsWith(e.toolInputPreview!));
    else assert.equal(e.toolInputPreview, null);
    assert.equal(e.effort, (p['effort'] as { level?: string } | undefined)?.level ?? null);
    assert.deepEqual(Object.keys(e.extra).sort(), Object.keys(p).filter((k) => !USED.includes(k)).sort());
    for (const k of Object.keys(e.extra)) assert.deepEqual(e.extra[k], p[k]);
  }
  const seen = new Set(recorded.map((p) => p['hook_event_name']));
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop',
    'SessionEnd', 'Elicitation', 'ElicitationResult', 'Notification', 'PostCompact']) assert.ok(seen.has(ev), ev);
});

test('events without a recorded shape map generically; a new field is kept raw, nothing is guessed', () => {
  for (const ev of ['PostToolUseFailure', 'PermissionDenied', 'Stop', 'StopFailure', 'PreCompact', 'CwdChanged', 'SomeFutureEvent']) {
    const e = mapClaudeHook({ session_id: 's', hook_event_name: ev, brand_new: { x: 1 } }, ev);
    assert.equal(e.event, ev);
    assert.equal(e.sessionId, 's');
    assert.equal(e.toolName, null);
    assert.deepEqual(e.extra, { brand_new: { x: 1 } });
  }
});

test('preview is bounded and never splits a code point; model and effort accept their reported shapes only', () => {
  const big = mapClaudeHook({ hook_event_name: 'PreToolUse', tool_input: { command: '\u{1F600}'.repeat(500) } }, 'PreToolUse');
  assert.equal([...big.toolInputPreview!].length, TOOL_INPUT_PREVIEW);
  assert.ok(!/[\uD800-\uDBFF]$/.test(big.toolInputPreview!));
  const m = (model: unknown, effort: unknown) => { const e = mapClaudeHook({ hook_event_name: 'SessionStart', model, effort }, 'SessionStart'); return [e.model, e.effort]; };
  assert.deepEqual(m('claude-fixture-1', 'high'), ['claude-fixture-1', 'high']);
  assert.deepEqual(m({ id: 'claude-fixture-2', display_name: 'Fixture' }, { level: 'low' }), ['claude-fixture-2', 'low']);
  assert.deepEqual(m(42, ['x']), [null, null]);
});

test('a malformed or truncated delivery (payload null) maps to the envelope event and nothing else', () => {
  const e = mapClaudeHook(null, 'unknown');
  assert.equal(e.event, 'unknown');
  assert.equal(e.sessionId, null);
  assert.deepEqual(e.extra, {});
});
