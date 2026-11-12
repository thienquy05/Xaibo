// XAIBO-PROD-309 (P3-T09, PRD §6.4, FR-04, US-4, M8): stuck/loop rules R1–R5 on a fake clock. Findings are rule ids on
// the status, deduplicated per (session, rule, signature), cleared when progress breaks the pattern, and never change the
// lifecycle. Suspended time is excluded from R1/R5. Thresholds are engine options with the PRD defaults (Q3-14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/service/store/db.ts';
import { createEngine, type EngineOptions, type Observation } from '../../src/service/status/engine.ts';
import { RULE_DEFAULTS } from '../../src/service/status/rules.ts';
import { fileObs, hookObs, SID, T0 } from '../helpers/status.ts';

async function harness(agent = 'claude', rules?: EngineOptions['rules']) {
  const dir = mkdtempSync(join(tmpdir(), 'xaibo-rules-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'b') });
  let now = T0;
  const make = () => createEngine({ db, now: () => now, settleMs: 4000, log: () => {}, ...(rules ? { rules } : {}) });
  let e = make();
  const at = (ms: number) => { now = T0 + ms; e.advance(now); };
  const st = () => e.status(agent, SID)!;
  const feed = (o: Observation, ms: number) => { at(ms); e.ingest(o); return st(); };
  const hook = (event: string, p: Record<string, unknown>, ms: number) => feed(hookObs(agent, { hook_event_name: event, ...p }, { at: ms }), ms);
  let n = 0;
  /** One completed call: PreToolUse then PostToolUse (or PostToolUseFailure) 100 ms later. Returns the status after it. */
  const call = (ms: number, tool: string, input: unknown, response: unknown, fail = false) => {
    const id = `call-${++n}`;
    hook('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: id }, ms);
    return hook(fail ? 'PostToolUseFailure' : 'PostToolUse', { tool_name: tool, tool_input: input, tool_use_id: id,
      ...(fail ? (response === null ? {} : { error: response }) : response === undefined ? {} : { tool_response: response }) }, ms + 100);
  };
  return { db, at, st, feed, hook, call, e: () => e, restart: () => { e.close(); e = make(); e.advance(now); } };
}

const NPM = { command: 'npm test' };
const OUT = { stdout: '1 failing', stderr: '' };

test('defaults are the PRD §6.4 thresholds', () => {
  assert.deepEqual(RULE_DEFAULTS, { noProgressMs: 300_000, repeatedTool: 4, repeatedError: 3, cycleRepeats: 3, longToolMs: 600_000 });
});

test('R2: the same tool, args and result 4x in a turn; a different call or a new turn clears it', async () => {
  const h = await harness();
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  for (let i = 1; i <= 3; i++) assert.deepEqual(h.call(i * 1000, 'Bash', NPM, OUT).findings, [], `after ${i}`);
  const s = h.call(4000, 'Bash', NPM, OUT);
  assert.deepEqual([s.findings, s.lifecycle, s.confidence], [['R2'], 'busy', 'confirmed'], 'a finding never changes the lifecycle');
  assert.deepEqual(h.call(5000, 'Bash', NPM, OUT).findings, ['R2'], 'deduplicated: one finding per (session, rule, signature)');
  assert.deepEqual(h.call(6000, 'Read', { file_path: 'a' }, { stdout: 'a' }).findings, [], 'a different call clears it');
  for (let i = 0; i < 4; i++) h.call(7000 + i * 1000, 'Bash', NPM, OUT);
  assert.deepEqual(h.st().findings, ['R2']);
  assert.deepEqual(h.hook('UserPromptSubmit', { prompt: 'p' }, 12_000).findings, [], 'a new turn clears it');
});

test('R2: a different result or different args is not a repeat; key order of args does not matter', async () => {
  const h = await harness();
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  h.call(1000, 'Bash', { command: 'x', description: 'd' }, OUT);
  h.call(2000, 'Bash', { description: 'd', command: 'x' }, OUT);
  h.call(3000, 'Bash', { command: 'x', description: 'd' }, { stdout: '0 failing', stderr: '' });
  assert.deepEqual(h.call(4000, 'Bash', { command: 'x', description: 'd' }, OUT).findings, [], 'the third result differs');
  h.call(5000, 'Bash', { command: 'x', description: 'd' }, OUT);
  h.call(6000, 'Bash', { command: 'x', description: 'd' }, OUT);
  assert.deepEqual(h.call(7000, 'Bash', { description: 'd', command: 'x' }, OUT).findings, ['R2'], 'normalized args');
});

test('R2: a call seen by both hook and transcript counts once (hooks outrank file inference)', async () => {
  const h = await harness();
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  for (let i = 1; i <= 2; i++) {
    const id = `dual-${i}`;
    h.feed(fileObs('claude', { type: 'assistant', message: { id: `m${i}`, content: [{ type: 'tool_use', id, name: 'Bash', input: NPM }] } }, { at: i * 1000 }), i * 1000);
    h.hook('PreToolUse', { tool_name: 'Bash', tool_input: NPM, tool_use_id: id }, i * 1000 + 50);
    h.hook('PostToolUse', { tool_name: 'Bash', tool_input: NPM, tool_use_id: id, tool_response: OUT }, i * 1000 + 300);
    h.feed(fileObs('claude', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: '1 failing', is_error: false }] } },
      { at: i * 1000 + 350 }), i * 1000 + 350);
  }
  assert.deepEqual(h.st().findings, []);
});

test('R2 without hooks: transcript calls drive the rule', async () => {
  const h = await harness();
  h.feed(fileObs('claude', { type: 'user', message: { content: 'p' } }, { at: 0 }), 0);
  for (let i = 1; i <= 4; i++) {
    const id = `f-${i}`;
    h.feed(fileObs('claude', { type: 'assistant', message: { id: `m${i}`, content: [{ type: 'tool_use', id, name: 'Bash', input: NPM }] } }, { at: i * 1000 }), i * 1000);
    h.feed(fileObs('claude', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: '1 failing', is_error: false }] } },
      { at: i * 1000 + 300 }), i * 1000 + 300);
  }
  assert.deepEqual(h.st().findings, ['R2']);
});

test('R2 survives a restart (rebuilt from the store) and signatures carry no content', async () => {
  const h = await harness();
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  for (let i = 1; i <= 4; i++) h.call(i * 1000, 'Bash', { command: 'secret-canary-arg' }, { stdout: 'secret-canary-out' });
  h.restart();
  assert.deepEqual(h.st().findings, ['R2']);
  const rows = JSON.stringify(h.db.prepare('SELECT ev FROM status_evidence').all());
  assert.ok(!rows.includes('secret-canary'), 'no args or output in stored evidence');
});

test('R3: the same tool error 3x in a row; a success clears it; Codex has no verified error flag (D-P3-08 e)', async () => {
  const h = await harness();
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  const LINT = { command: 'npm run lint' };
  assert.deepEqual(h.call(1000, 'Bash', LINT, null, true).findings, []);
  assert.deepEqual(h.call(2000, 'Bash', LINT, null, true).findings, []);
  const s = h.call(3000, 'Bash', LINT, null, true);
  assert.deepEqual([s.findings, s.lifecycle], [['R3'], 'busy'], 'never error lifecycle');
  assert.deepEqual(h.call(4000, 'Bash', LINT, OUT).findings, [], 'a success clears it');

  const c = await harness('codex');
  c.hook('UserPromptSubmit', { prompt: 'p', turn_id: 't' }, 0);
  for (let i = 1; i <= 3; i++) c.call(i * 1000, 'Bash', LINT, 'Exit code 1');
  assert.deepEqual(c.st().findings, []);
});

test('R4: a 2- and a 3-call sequence repeated 3x; one repeated call is R2, not R4; a break clears it', async () => {
  const A = ['Read', { file_path: 'a' }, { stdout: 'a' }] as const, B = ['Bash', NPM, OUT] as const, C = ['Edit', { file_path: 'a' }, { stdout: 'e' }] as const;
  for (const seq of [[A, B], [A, B, C]]) {
    const h = await harness();
    h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
    const total = seq.length * 3;
    for (let i = 0; i < total; i++) {
      const [tool, input, out] = seq[i % seq.length]!;
      const s = h.call((i + 1) * 1000, tool, input, out);
      assert.deepEqual(s.findings, i === total - 1 ? ['R4'] : [], `${seq.length}-cycle after ${i + 1}`);
    }
    assert.deepEqual(h.call(100_000, 'Read', { file_path: 'other' }, { stdout: 'o' }).findings, [], 'a break clears it');
  }
  const h = await harness();
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  for (let i = 1; i <= 6; i++) h.call(i * 1000, 'Bash', NPM, OUT);
  assert.deepEqual(h.st().findings, ['R2']);
});

test('R1: busy with no evidence for 5 min and no known wait; new evidence clears it; suspended time is excluded', async () => {
  const h = await harness();
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  h.at(300_000);
  assert.deepEqual(h.st().findings, []);
  h.at(300_001);
  const s = h.st();
  assert.deepEqual([s.findings, s.lifecycle], [['R1'], 'busy']);
  assert.deepEqual(h.hook('PreToolUse', { tool_name: 'Read', tool_input: {}, tool_use_id: 'x' }, 300_100).findings, [], 'progress clears it');

  const g = await harness();
  g.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  g.at(100_000); g.e().suspend(T0 + 100_000);
  g.at(3_700_000); g.e().resume(T0 + 3_700_000);
  assert.deepEqual(g.st().findings, [], 'one hour asleep is not inactivity');
  g.at(3_900_001);
  assert.deepEqual(g.st().findings, ['R1'], '5 min of awake time');
});

test('R1: never while a tool runs, a subagent runs, background work is known, or the session is idle', async () => {
  const h = await harness();
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  h.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run build' }, tool_use_id: 'b' }, 1000);
  h.at(400_000);
  assert.deepEqual(h.st().findings, [], 'a running tool is R5 territory');

  const b = await harness();
  b.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  b.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'srv', run_in_background: true }, tool_use_id: 'bg' }, 1000);
  b.hook('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_use_id: 'bg', tool_response: {} }, 1100);
  b.hook('Stop', {}, 2000);
  b.at(1_000_000);
  assert.deepEqual([b.st().reason, b.st().findings], ['Background work', []]);

  const s = await harness();
  s.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  s.hook('SubagentStart', { agent_id: 'sub' }, 1000);
  s.hook('Stop', {}, 2000);
  s.at(1_000_000);
  assert.deepEqual([s.st().reason, s.st().findings], ['Finishing…', []]);

  const i = await harness();
  i.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  i.hook('Stop', {}, 1000);
  i.at(1_000_000);
  assert.deepEqual([i.st().lifecycle, i.st().findings], ['idle', []]);
});

test('R5: a call in flight > 10 min; suspended time excluded; completion clears it; lifecycle stays busy', async () => {
  const h = await harness();
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  h.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run build' }, tool_use_id: 'b' }, 1000);
  h.at(601_000);
  assert.deepEqual(h.st().findings, []);
  h.at(601_001);
  const s = h.st();
  assert.deepEqual([s.findings, s.lifecycle, s.confidence], [['R5'], 'busy', 'confirmed']);
  assert.deepEqual(h.hook('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_use_id: 'b', tool_response: {} }, 902_000).findings, []);

  const g = await harness();
  g.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  g.hook('PreToolUse', { tool_name: 'Bash', tool_input: {}, tool_use_id: 'b' }, 1000);
  g.at(60_000); g.e().suspend(T0 + 60_000);
  g.at(7_260_000); g.e().resume(T0 + 7_260_000);
  assert.deepEqual(g.st().findings, [], 'two hours asleep do not count');
});

test('review: R2–R4 end with the turn (Stop, interrupt)', async () => {
  const h = await harness();
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  for (let i = 1; i <= 4; i++) h.call(i * 1000, 'Bash', NPM, OUT);
  assert.deepEqual(h.st().findings, ['R2']);
  const s = h.hook('Stop', {}, 5000);
  assert.deepEqual([s.reason, s.findings], ['Finishing…', []]);

  const c = await harness('codex');
  c.hook('UserPromptSubmit', { prompt: 'p', turn_id: 't' }, 0);
  for (let i = 1; i <= 4; i++) c.call(i * 1000, 'Bash', NPM, 'out');
  assert.deepEqual(c.st().findings, ['R2']);
  assert.deepEqual(c.hook('Interrupt', {}, 5000).findings, []);
});

test('review: an absent result or args never makes calls alike; it breaks the pattern', async () => {
  const h = await harness();
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  for (let i = 1; i <= 4; i++) h.call(i * 1000, 'Bash', NPM, undefined);
  assert.deepEqual(h.st().findings, [], 'no tool_response: no repeat');
  for (let i = 0; i < 3; i++) h.call(10_000 + i * 1000, 'Bash', NPM, OUT);
  h.call(13_000, 'Bash', NPM, undefined);
  assert.deepEqual(h.call(14_000, 'Bash', NPM, OUT).findings, [], 'an unknown result between repeats breaks the run');

  // Codex rollout only: calls known by `action` alone stay distinct; function_call arguments drive R2.
  const c = await harness('codex');
  const roll = (payload: Record<string, unknown>, ms: number) =>
    c.feed(fileObs('codex', { timestamp: '2026-01-01T00:00:00.000Z', type: 'response_item', payload }, { at: ms }), ms);
  c.feed(fileObs('codex', { timestamp: '2026-01-01T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } }, { at: 0 }), 0);
  for (let i = 1; i <= 4; i++) {
    roll({ type: 'local_shell_call', call_id: `l${i}`, action: { command: ['cmd', String(i)] } }, i * 1000);
    roll({ type: 'local_shell_call_output', call_id: `l${i}`, output: '' }, i * 1000 + 100);
  }
  assert.deepEqual(c.st().findings, [], 'different actions');
  for (let i = 1; i <= 4; i++) {
    roll({ type: 'function_call', call_id: `f${i}`, name: 'shell', arguments: '{"command":["ls"]}' }, 10_000 + i * 1000);
    roll({ type: 'function_call_output', call_id: `f${i}`, output: 'a' }, 10_000 + i * 1000 + 100);
  }
  assert.deepEqual(c.st().findings, ['R2']);
});

test('review: R3 compares error text when present', async () => {
  const h = await harness();
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  const LINT = { command: 'npm run lint' };
  h.call(1000, 'Bash', LINT, 'error A', true);
  h.call(2000, 'Bash', LINT, 'error B', true);
  assert.deepEqual(h.call(3000, 'Bash', LINT, 'error A', true).findings, [], 'different errors');
  h.call(4000, 'Bash', LINT, 'error A', true);
  assert.deepEqual(h.call(5000, 'Bash', { command: 'npm run lint -- x' }, 'error A', true).findings, ['R3'], 'same tool and error, other args');
});

test('review: time waiting for permission shows the wait, not R5; completion leaves nothing', async () => {
  const h = await harness();
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  h.hook('PreToolUse', { tool_name: 'Bash', tool_input: NPM, tool_use_id: 'w' }, 1000);
  h.hook('PermissionRequest', { tool_name: 'Bash' }, 2000);
  h.at(1_000_000);
  assert.deepEqual([h.st().lifecycle, h.st().findings], ['waiting-for-permission', []]);
  assert.deepEqual(h.hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'w', tool_response: OUT }, 1_000_100).findings, []);
});

test('thresholds are configurable (Q3-14)', async () => {
  const h = await harness('claude', { repeatedTool: 2, noProgressMs: 10_000 });
  h.hook('UserPromptSubmit', { prompt: 'p' }, 0);
  h.call(1000, 'Bash', NPM, OUT);
  assert.deepEqual(h.call(2000, 'Bash', NPM, OUT).findings, ['R2']);
  h.at(12_200);
  assert.deepEqual(h.st().findings, ['R1', 'R2'], 'sorted rule ids');
});
