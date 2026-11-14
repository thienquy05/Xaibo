// XAIBO-PROD-313 (P3-T13a; PRD §6.8, §5.10; EC-83): catalog hook mappings select normalized evidence by exact event name
// and exact field predicates (null = absent) and never execute anything; no matching rule is reduced coverage, not an
// invented state. agy rules come from P2-T00 only. Report events map through the same engine and correlation rules:
// a resolution clears only its own request, an unknown kind never implies a wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Envelope } from '../../src/shared/hook-protocol.ts';
import { hookMapper } from '../../src/service/adapters/generic/mapping.ts';
import { reportEvidence } from '../../src/service/adapters/generic/report.ts';
import { loadCatalog, validateCatalog, type Catalog } from '../../src/service/catalog/validate.ts';
import { openStore } from '../../src/service/store/db.ts';
import { createEngine, type Observation } from '../../src/service/status/engine.ts';
import { SID, T0 } from '../helpers/status.ts';

const catalog = loadCatalog();
const agy = catalog.agents.find((a) => a.id === 'agy')!;
let n = 0;
const env = (agent: string, payload: Record<string, unknown>, at = 0): Envelope => ({
  v: 1, delivery_id: `g-${++n}`, agent, profile_key: 'p1', event: String(payload['hookEventName'] ?? payload['event'] ?? 'unknown'),
  session_id: SID, cwd: null, received_ts: T0 + at, payload,
});
const CANARY = 'xaibo-canary-agy-last-user-input-do-not-log';
const agyHook = (event: string, more: Record<string, unknown> = {}, at = 0): Observation => ({ source: 'hook', envelope: env('agy', {
  conversationId: SID, hookEventName: event, lastUserInput: CANARY, modelName: 'gemini-3.8-flash-high', transcriptPath: '~/x/transcript_full.jsonl',
  artifactDirectoryPath: '~/x', workspacePaths: ['/tmp/xaibo-fixture/agy'], cwd: '/tmp/xaibo-fixture/agy', ...more }, at) });
const STOP = { continuationActive: false, executionNum: 1, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' };

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'xaibo-generic-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'b') });
  let now = T0;
  const logs: string[] = [];
  const e = createEngine({ db, now: () => now, settleMs: 4000, log: (l) => logs.push(l) });
  return { logs, feed: (o: Observation, ms: number) => { now = T0 + ms; e.ingest(o); return e.status('envelope' in o ? o.envelope.agent : o.agent, 'p1', SID); },
    at: (ms: number) => { now = T0 + ms; }, st: (agent: string) => e.status(agent, 'p1', SID) };
}

test('mapper: exact event and exact predicates (null = absent); no matching rule -> null (reduced coverage)', () => {
  const map = hookMapper({ evidence: 'test', rules: [
    { event: 'Done', where: { 'r.reason': 'ok', flag: false, error: null }, map: 'turn.end' },
    { event: 'Go', map: 'tool.start', id: 'call.id', tool: 'call.name', args: 'call.args' },
  ] });
  assert.deepEqual(map(env('x', { hookEventName: 'Done', r: { reason: 'ok' }, flag: false })), [{ k: 'turn.end' }]);
  assert.equal(map(env('x', { hookEventName: 'Done', r: { reason: 'ok' }, flag: false, error: 'boom' })), null);
  assert.equal(map(env('x', { hookEventName: 'Done', r: { reason: 'OK' }, flag: false })), null);
  assert.equal(map(env('x', { hookEventName: 'Done', r: { reason: 'ok' }, flag: 'false' })), null);
  assert.equal(map(env('x', { hookEventName: 'done', r: { reason: 'ok' }, flag: false })), null);
  const go = map(env('x', { hookEventName: 'Go', call: { id: 'c1', name: 'read', args: { a: 1 } } }))!;
  assert.equal(go.length, 1);
  assert.deepEqual({ ...go[0], sig: undefined }, { k: 'tool.start', id: 'c1', tool: 'read', sig: undefined });
  assert.equal(map(env('x', { hookEventName: 'Go', call: { name: 'read' } })), null, 'a tool rule without its id is unmapped');
  assert.equal(map(env('x', { hookEventName: 'Go', call: Object.create({ id: 'inherited' }) })), null, 'own properties only');
});

test('catalog: agy hookMappings validate; bad paths, kinds and predicates are rejected by the strict schema', () => {
  assert.ok(agy.hookMappings);
  const withRules = (rules: unknown[]): Catalog => ({ ...catalog, agents: catalog.agents.map((a) => (a.id === 'agy' ? { ...a, hookMappings: { evidence: 'x', rules } } : a)) } as Catalog);
  for (const bad of [
    [{ event: 'Go', map: 'exec' }],
    [{ event: 'Go', map: 'tool.start', id: '__proto__.x' }],
    [{ event: 'Go', map: 'tool.start', id: 'a..b' }],
    [{ event: 'Go', map: 'turn.end', where: { a: { nested: 1 } } }],
    [{ event: 'Go', map: 'turn.end', code: 'return 1' }],
  ]) assert.notDeepEqual(validateCatalog(withRules(bad)), [], JSON.stringify(bad));
});

test('agy: the six P2-T00 events; tool ids pair once; PreInvocation counts no turn; PostInvocation does not settle', async () => {
  const h = await harness();
  assert.deepEqual([h.feed(agyHook('SessionStart'), 0)!.lifecycle], ['idle']);
  assert.deepEqual([h.feed(agyHook('PreInvocation', { initialNumSteps: 0, invocationNum: 1 }, 1000), 1000)!.lifecycle], ['busy']);
  const call = { toolCall: { id: 'agy_tool_0001', name: 'read_file', args: { Path: '/tmp/xaibo-fixture/agy/notes.txt' } }, stepIdx: 3 };
  h.feed(agyHook('PreToolUse', call, 1500), 1500);
  h.feed(agyHook('PreToolUse', call, 1600), 1600); // a second delivery of the same call id
  h.feed(agyHook('PostToolUse', call, 1700), 1700);
  let s = h.feed(agyHook('PostInvocation', { initialNumSteps: 5, invocationNum: 1 }, 2000), 2000)!;
  assert.deepEqual([s.lifecycle, s.reason, s.toolCalls, s.turns], ['busy', null, 1, 0]);
  s = h.feed(agyHook('Stop', STOP, 2100), 2100)!;
  assert.deepEqual([s.lifecycle, s.reason], ['busy', 'Finishing…']);
  h.at(6200);
  s = h.st('agy')!;
  assert.deepEqual([s.lifecycle, s.confidence, s.model, s.effort], ['idle', 'confirmed', 'gemini-3.8-flash-high', null]);
  s = h.feed(agyHook('PreInvocation', { initialNumSteps: 6, invocationNum: 1 }, 7000), 7000)!;
  assert.equal(s.lifecycle, 'busy', 'the next prompt opens again after a settled stop');
  assert.ok(!h.logs.some((l) => l.includes(CANARY)) && !JSON.stringify(s).includes(CANARY), 'lastUserInput never reaches logs or status');
});

test('agy: Stop with error, continuationActive or another reason, and unknown events -> reduced coverage, no error or wait', async () => {
  for (const stop of [{ ...STOP, error: 'boom' }, { ...STOP, continuationActive: true }, { ...STOP, terminationReason: 'MAX_STEPS' }, { ...STOP, fullyIdle: false }]) {
    const h = await harness();
    h.feed(agyHook('SessionStart'), 0);
    h.feed(agyHook('PreInvocation', {}, 1000), 1000);
    const s = h.feed(agyHook('Stop', stop, 2000), 2000)!;
    assert.deepEqual([s.lifecycle, s.reason], ['busy', null], JSON.stringify(stop));
    assert.ok(h.logs.includes('status_unmapped'));
  }
  const h = await harness();
  h.feed(agyHook('SessionStart'), 0);
  h.feed(agyHook('Notification', { notificationType: 'ToolPermission' }, 500), 500);
  assert.equal(h.st('agy')!.lifecycle, 'idle', 'no unverified notification or permission mapping');
  assert.deepEqual(h.logs, ['status_unmapped']);
});

const rep = (event: string, more: Record<string, unknown> = {}, at = 0): Observation => ({ source: 'report', envelope: env('custom-agent', {
  v: 1, delivery_id: `r-${++n}`, session_id: SID, producer_id: 'p', producer_seq: n, event, source_ts: '2026-01-01T00:00:00Z', payload: {}, ...more }, at) });

test('report: requests resolve by request_id only; unknown kinds never wait; tools by item_id; model and effort', async () => {
  const h = await harness();
  h.feed(rep('session.start'), 0);
  h.feed(rep('turn.start', { turn_id: 't1', model: { id: 'model-x' }, effort: 'high' }, 1000), 1000);
  assert.equal(h.feed(rep('permission.request', { request_id: 'req-1' }, 1100), 1100)!.lifecycle, 'waiting-for-permission');
  assert.equal(h.feed(rep('permission.resolve', { request_id: 'req-2', payload: { decision: 'allow' } }, 1200), 1200)!.lifecycle, 'waiting-for-permission');
  assert.equal(h.feed(rep('permission.resolve', { payload: { decision: 'allow' } }, 1250), 1250)!.lifecycle, 'waiting-for-permission', 'no request_id: matches nothing');
  assert.equal(h.feed(rep('permission.resolve', { request_id: 'req-1', payload: { decision: 'deny' } }, 1300), 1300)!.outcome, 'denied');
  assert.equal(h.feed(rep('notification', { payload: { message: 'needs you' } }, 1400), 1400)!.lifecycle, 'busy');
  assert.equal(h.feed(rep('input.request', { request_id: 'q-1' }, 1500), 1500)!.lifecycle, 'needs-input');
  assert.equal(h.feed(rep('input.resolve', { request_id: 'q-1', payload: { action: 'cancel' } }, 1600), 1600)!.outcome, 'cancelled');
  h.feed(rep('tool.start', { item_id: 'tool-1', payload: { tool: 'fixture_tool' } }, 1700), 1700);
  const s = h.feed(rep('tool.end', { item_id: 'tool-1', payload: { tool: 'fixture_tool', ok: true } }, 1800), 1800)!;
  assert.deepEqual([s.lifecycle, s.toolCalls, s.turns, s.model, s.effort], ['busy', 1, 1, 'model-x', 'high']);
  assert.ok(h.logs.includes('status_unmapped'), 'the unknown kind is reported as reduced coverage');
  assert.equal(reportEvidence(env('custom-agent', { v: 2, event: 'turn.start' })), null, 'an unsupported version maps to nothing');
});

test('review M1: a transcript (inferred) end sorted before the hook start does not swallow the confirmed start', async () => {
  const h = await harness();
  const claudeHook = (event: string, p: Record<string, unknown>, at: number): Observation => ({ source: 'hook', envelope: env('claude', { hook_event_name: event, ...p }, at) });
  h.feed(claudeHook('UserPromptSubmit', { prompt: 'p' }, 0), 0);
  h.feed({ source: 'file', agent: 'claude', profile: 'p1', sessionId: SID, file: 't.jsonl', offset: 10, receivedTs: T0 + 100,
    line: JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w', content: 'ok' }] } }) }, 100);
  h.feed(claudeHook('PreToolUse', { tool_use_id: 'w', tool_name: 'Write' }, 200), 200);
  assert.equal(h.feed(claudeHook('PermissionRequest', { tool_name: 'Write' }, 300), 300)!.lifecycle, 'waiting-for-permission');
  assert.equal(h.feed(claudeHook('PostToolUse', { tool_use_id: 'w' }, 400), 400)!.lifecycle, 'busy', 'the request joined the hook call and cleared with it');
});

test('review M2–M4: usage keys allowlisted; a request without request_id or a session mismatch maps to nothing', async () => {
  const h = await harness();
  h.feed(rep('session.start'), 0);
  h.feed(rep('turn.start', { turn_id: 't1' }, 1000), 1000);
  const s = h.feed(rep('usage.snapshot', { payload: { input_tokens: 10, output_tokens: 2, constructor: 5, ['x'.repeat(300)]: 1 } }, 1100), 1100)!;
  assert.deepEqual(s.usage, { input: 10, output: 2 });
  const before = h.logs.length;
  assert.equal(h.feed(rep('permission.request', {}, 1200), 1200)!.lifecycle, 'busy');
  assert.equal(h.feed(rep('input.request', {}, 1300), 1300)!.lifecycle, 'busy');
  assert.equal(h.logs.length - before, 2, 'both are reduced coverage');
  const other = rep('session.end', { session_id: 'another-session' }, 1400);
  assert.equal(h.feed(other, 1400)!.lifecycle, 'busy', 'a report whose session_id differs from the envelope maps to nothing');
});

test('a call delivered after its own end never starts again (no phantom in-flight call, no reopened turn)', async () => {
  const h = await harness();
  h.feed(rep('session.start'), 0);
  h.feed(rep('turn.start', { turn_id: 't1' }, 1000), 1000);
  h.feed(rep('tool.end', { item_id: 'tool-1', payload: { tool: 'x' } }, 1500), 1500);
  h.feed(rep('turn.end', { turn_id: 't1' }, 2000), 2000);
  h.feed(rep('tool.start', { item_id: 'tool-1', payload: { tool: 'x' } }, 2100), 2100); // delayed, after its end
  h.at(2100 + 4001);
  assert.equal(h.st('custom-agent')!.lifecycle, 'idle');
  h.at(2100 + 4001 + 3_600_000);
  assert.deepEqual(h.st('custom-agent')!.findings, [], 'no R5 for a call that already ended');
});
