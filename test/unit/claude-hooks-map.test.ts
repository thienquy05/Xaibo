// XAIBO-PROD-305 (P3-T05, PRD §5.2, FR-51): every Claude hook payload maps to evidence fields; the unknown remainder
// stays raw. Recorded shapes come from the S4 (2.1.319) and S7 (2.1.322) fixtures; events with no recorded shape are
// checked only for the generic fields, with no claim about their payloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_HOOK_EVENTS } from '../../src/service/adapters/claude/hooks.ts';

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
