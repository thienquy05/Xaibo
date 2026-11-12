// XAIBO-PROD-308 (P3-T08, PRD §6.1-§6.3, FR-04, FR-05; EC-40, EC-41, EC-70): status engine core. Pending requests are
// tracked per native id and cleared only by a matching id; a delayed earlier event never regresses newer evidence;
// Stop shows Finishing… and settles; heuristic waits are labelled heuristic, never confirmed; silence never ends a
// session; duplicates count once; a restarted engine continues from the store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/service/store/db.ts';
import { createEngine, type Observation } from '../../src/service/status/engine.ts';
import { fileObs, hookObs, SID, T0 } from '../helpers/status.ts';

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'xaibo-status-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'b') });
  let now = T0;
  const logs: string[] = [];
  const make = () => createEngine({ db, now: () => now, settleMs: 4000, log: (l) => logs.push(l) });
  let e = make();
  const at = (ms: number) => { now = T0 + ms; e.advance(now); };
  const feed = (o: Observation, ms: number) => { at(ms); e.ingest(o); return e.status('claude', SID); };
  return { db, logs, e: () => e, at, feed, restart: () => { e.close(); e = make(); e.advance(now); }, st: () => e.status('claude', SID) };
}
const H = (event: string, p: Record<string, unknown> = {}, at = 0) => hookObs('claude', { hook_event_name: event, ...p }, { at });

test('unknown session -> null; a session with only non-lifecycle evidence -> unknown', async () => {
  const h = await harness();
  assert.equal(h.st(), null);
  h.feed(H('CwdChanged'), 0);
  assert.deepEqual([h.st()!.lifecycle, h.st()!.confidence], ['unknown', 'inferred']);
});

test('two interleaved pending requests are resolved individually by id', async () => {
  const h = await harness();
  h.feed(H('UserPromptSubmit', { prompt: 'p' }), 0);
  h.feed(H('PreToolUse', { tool_use_id: 'a', tool_name: 'Write' }), 10);
  assert.equal(h.feed(H('PermissionRequest', { tool_name: 'Write' }, 20), 20)!.lifecycle, 'waiting-for-permission');
  assert.equal(h.feed(H('Elicitation', { mcp_server_name: 's' }, 30), 30)!.lifecycle, 'needs-input');
  assert.equal(h.feed(H('PostToolUse', { tool_use_id: 'zzz' }, 40), 40)!.lifecycle, 'needs-input', 'an unmatched completion clears nothing');
  assert.equal(h.feed(H('ElicitationResult', { mcp_server_name: 's', action: 'cancel' }, 50), 50)!.lifecycle, 'waiting-for-permission');
  const s = h.feed(H('PostToolUse', { tool_use_id: 'a' }, 60), 60)!;
  assert.deepEqual([s.lifecycle, s.confidence, s.outcome], ['busy', 'confirmed', 'cancelled']);
});

test('Stop shows Finishing… at once, preserves a pending wait, then settles; a delayed earlier PreToolUse does not regress', async () => {
  const h = await harness();
  h.feed(H('UserPromptSubmit', { prompt: 'p' }), 0);
  const s = h.feed(H('Stop', {}, 1000), 1000)!;
  assert.deepEqual([s.lifecycle, s.reason], ['busy', 'Finishing…']);
  h.feed(H('PreToolUse', { tool_use_id: 'late', tool_name: 'Bash' }, 500), 1200);
  assert.deepEqual([h.st()!.lifecycle, h.st()!.reason], ['busy', 'Finishing…'], 'the delayed earlier event sorts before Stop');
  h.at(5001);
  assert.deepEqual([h.st()!.lifecycle, h.st()!.reason, h.st()!.confidence], ['idle', null, 'confirmed']);
  h.feed(H('UserPromptSubmit', { prompt: 'p' }, 6000), 6000);
  h.feed(H('PreToolUse', { tool_use_id: 'w', tool_name: 'Write' }, 6100), 6100);
  h.feed(H('PermissionRequest', {}, 6200), 6200);
  h.feed(H('Stop', {}, 6300), 6300);
  assert.equal(h.st()!.lifecycle, 'waiting-for-permission', 'Stop never hides an unresolved wait');
});

test('idle_prompt keeps idle and never means needs-input; StopFailure is error; SessionEnd is ended', async () => {
  const h = await harness();
  h.feed(H('SessionStart'), 0);
  assert.equal(h.feed(H('Notification', { notification_type: 'idle_prompt' }, 10), 10)!.lifecycle, 'idle');
  h.feed(H('UserPromptSubmit', { prompt: 'p' }, 20), 20);
  assert.equal(h.feed(H('StopFailure', {}, 30), 30)!.lifecycle, 'error');
  assert.equal(h.feed(H('SessionEnd', {}, 40), 40)!.lifecycle, 'ended');
});

test('silence never ends a session; no hooks: a pending non-Agent tool > 5 s is a heuristic wait, an Agent call is not', async () => {
  const h = await harness();
  h.feed(H('UserPromptSubmit', { prompt: 'p' }), 0);
  h.at(86_400_000);
  assert.equal(h.st()!.lifecycle, 'busy');
  const f = await harness();
  const use = (id: string, name: string, ms: number) => f.feed(fileObs('claude', { type: 'assistant', message: { id, content: [{ type: 'tool_use', id, name, input: {} }], stop_reason: 'tool_use' } }, { at: ms }), ms);
  use('t1', 'Bash', 0);
  f.at(5001);
  assert.deepEqual([f.st()!.lifecycle, f.st()!.confidence, f.st()!.reason], ['waiting-for-permission', 'heuristic', 'Probably waiting']);
  const g = await harness();
  const useG = (ms: number) => g.feed(fileObs('claude', { type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: {} }], stop_reason: 'tool_use' } }, { at: ms }), ms);
  useG(0);
  g.at(60_000);
  assert.deepEqual([g.st()!.lifecycle, g.st()!.confidence], ['busy', 'inferred']);
});

test('Finishing… holds while a subagent runs; the last SubagentStop starts the settle (EC-40)', async () => {
  const h = await harness();
  h.feed(H('UserPromptSubmit', { prompt: 'p' }), 0);
  h.feed(H('SubagentStart', { agent_id: 'a1' }, 10), 10);
  h.feed(H('Stop', {}, 20), 20);
  h.at(60_000);
  assert.deepEqual([h.st()!.lifecycle, h.st()!.reason], ['busy', 'Finishing…']);
  h.feed(H('SubagentStop', { agent_id: 'a1' }, 61_000), 61_000);
  h.at(64_000);
  assert.equal(h.st()!.reason, 'Finishing…');
  h.at(65_001);
  assert.equal(h.st()!.lifecycle, 'idle');
});

test('interrupt: Claude transcript rejection -> idle inferred interrupted; Codex Interrupt -> Finishing… then idle (EC-70)', async () => {
  const h = await harness();
  h.feed(H('UserPromptSubmit', { prompt: 'p' }), 0);
  h.feed(H('PreToolUse', { tool_use_id: 't1', tool_name: 'Bash' }, 10), 10);
  const s = h.feed(fileObs('claude', { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true,
    content: "The user doesn't want to proceed with this tool use. The tool use was rejected." }] } }, { at: 20 }), 20)!;
  assert.deepEqual([s.lifecycle, s.confidence, s.outcome], ['idle', 'inferred', 'interrupted']);
  const c = await harness();
  const C = (event: string, ms: number) => { c.at(ms); c.e().ingest(hookObs('codex', { hook_event_name: event, turn_id: 'u' }, { at: ms })); return c.e().status('codex', SID)!; };
  C('UserPromptSubmit', 0);
  const i = C('Interrupt', 10);
  assert.deepEqual([i.lifecycle, i.reason, i.outcome], ['busy', 'Finishing…', 'interrupted']);
  c.at(4011);
  assert.deepEqual([c.e().status('codex', SID)!.lifecycle, c.e().status('codex', SID)!.outcome], ['idle', 'interrupted']);
});

test('duplicates count once; a restarted engine continues from the store; status carries no content', async () => {
  const h = await harness();
  h.feed(H('UserPromptSubmit', { prompt: 'xaibo-canary-status-prompt' }), 0);
  const pre = H('PreToolUse', { tool_use_id: 't1', tool_name: 'Bash' }, 10);
  h.feed(pre, 10);
  h.feed(pre, 11);
  assert.equal(h.st()!.toolCalls, 1);
  h.feed(H('PermissionRequest', {}, 20), 20);
  h.restart();
  assert.deepEqual([h.st()!.lifecycle, h.st()!.toolCalls], ['waiting-for-permission', 1]);
  h.feed(pre, 30);
  assert.equal(h.st()!.toolCalls, 1, 'a redelivery after restart is still a duplicate');
  const rows = JSON.stringify(h.db.prepare('SELECT * FROM status_evidence').all());
  assert.ok(!rows.includes('xaibo-canary-status-prompt') && !JSON.stringify(h.st()).includes('xaibo-canary-status-prompt') && !h.logs.join('\n').includes('xaibo-canary-status-prompt'));
});

test('suspend/resume: health stale across the gap until new evidence', async () => {
  const h = await harness();
  h.feed(H('UserPromptSubmit', { prompt: 'p' }), 0);
  h.at(1000); h.e().suspend(T0 + 1000);
  h.at(7_201_000); h.e().resume(T0 + 7_201_000);
  assert.equal(h.st()!.health, 'stale');
  assert.equal(h.feed(H('PreToolUse', { tool_use_id: 't', tool_name: 'Bash' }, 7_202_000), 7_202_000)!.health, 'connected');
});

// Security review fixes (P3-T08): adversarial agent names, corrupt rows, huge lines, spoofed rejections, paths, usage.
test('an agent name on Object.prototype is ignored, never persisted; a corrupt stored row does not stop startup', async () => {
  const h = await harness();
  const o = hookObs('constructor', { hook_event_name: 'Stop' });
  assert.doesNotThrow(() => h.e().ingest(o));
  assert.equal(h.e().status('constructor', SID), null);
  assert.equal(h.db.prepare("SELECT count(*) AS n FROM status_evidence WHERE agent = 'constructor'").get()!['n'], 0);
  h.db.prepare("INSERT INTO status_evidence (agent, native_session_id, dedup, ts, rank, seq, confidence, ev) VALUES ('claude', ?, 'd:bad', 0, 0, 0, 'confirmed', '{bad')").run(SID);
  h.db.prepare("INSERT INTO status_evidence (agent, native_session_id, dedup, ts, rank, seq, confidence, ev) VALUES ('claude', ?, 'd:obj', 0, 0, 1, 'confirmed', '{}')").run(SID);
  assert.doesNotThrow(() => h.restart());
  assert.equal(h.feed(H('UserPromptSubmit', { prompt: 'p' }, 10), 10)!.lifecycle, 'busy');
});

test('a huge transcript line neither throws nor grows evidence without bound', async () => {
  const h = await harness();
  const content = Array.from({ length: 200_000 }, (_, i) => ({ type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} }));
  h.feed(fileObs('claude', { type: 'assistant', message: { id: 'm', content, stop_reason: 'tool_use' } }), 0);
  h.at(6000);
  assert.doesNotThrow(() => h.st());
  assert.ok(h.st()!.toolCalls <= 256);
});

test('a rejection marker inside ordinary tool output, or for a call not in flight, changes nothing', async () => {
  const h = await harness();
  h.feed(H('UserPromptSubmit', { prompt: 'p' }), 0);
  h.feed(H('PreToolUse', { tool_use_id: 't1', tool_name: 'Read' }, 10), 10);
  const result = (id: string, content: string, ms: number) => h.feed(fileObs('claude', { type: 'user', message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content }] } }, { at: ms }), ms)!;
  assert.equal(result('t1', "file says: The user doesn't want to proceed with this tool use. The tool use was rejected.", 20).lifecycle, 'busy');
  assert.equal(result('nope', "The user doesn't want to proceed with this tool use. The tool use was rejected.", 30).lifecycle, 'busy');
});

test('stored evidence carries no file path; overlong ids and invalid usage numbers are dropped', async () => {
  const h = await harness();
  h.feed({ ...fileObs('claude', { type: 'user', message: { role: 'user', content: 'p' } }), file: '/tmp/xaibo-fixture/secret-project/t.jsonl' }, 0);
  assert.ok(!JSON.stringify(h.db.prepare('SELECT dedup FROM status_evidence').all()).includes('secret-project'));
  h.feed(H('PreToolUse', { tool_use_id: 'x'.repeat(300), tool_name: 'Bash' }, 10), 10);
  assert.equal(h.st()!.toolCalls, 0);
  h.feed(fileObs('claude', { type: 'assistant', message: { id: 'm1', content: [], usage: { input_tokens: -5, output_tokens: 1e999, cache_read_input_tokens: 7 } } }), 20);
  assert.deepEqual(h.st()!.usage, { cacheRead: 7 });
});

test('a stored row with a non-evidence element is skipped whole, never half-applied', async () => {
  const h = await harness();
  h.feed(H('SessionStart'), 0);
  h.db.prepare("INSERT INTO status_evidence (agent, native_session_id, dedup, ts, rank, seq, confidence, ev) VALUES ('claude', ?, 'd:half', 5, 0, 99, 'confirmed', ?)")
    .run(SID, JSON.stringify([{ k: 'turn.start', typed: true }, null]));
  h.restart();
  assert.equal(h.st()!.lifecycle, 'idle', 'the row is dropped as a whole');
});
