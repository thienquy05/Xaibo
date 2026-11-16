// XAIBO-PROD-104 (P1-T06): versioned IPC messages with hand-written validation; invalid messages dropped and counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accept, healthText, parseHealth, parsePortMessage, parsePortRequest, parseServiceCommand, parseServiceEvent, READ_ONLY_BANNER } from '../../src/shared/ipc.ts';

test('service commands: known types pass, extra fields are stripped', () => {
  for (const type of ['quit', 'wake', 'port', 'reloadPrices'] as const) assert.deepEqual(parseServiceCommand({ v: 1, type, extra: 'x' }), { v: 1, type });
});

test('unknown versions, unknown types and non-objects are rejected', () => {
  for (const bad of [{ v: 2, type: 'quit' }, { type: 'quit' }, { v: 1, type: 'shutdown' }, { v: 1 }, null, undefined, 'quit', 1, [], [{ v: 1, type: 'quit' }]]) {
    assert.equal(parseServiceCommand(bad), null, JSON.stringify(bad));
  }
});

test('ready: readOnly is null or a known reason', () => {
  assert.deepEqual(parseServiceEvent({ v: 1, type: 'ready', readOnly: null }), { v: 1, type: 'ready', readOnly: null });
  assert.deepEqual(parseServiceEvent({ v: 1, type: 'ready', readOnly: 'migration-failed' }), { v: 1, type: 'ready', readOnly: 'migration-failed' });
  assert.equal(parseServiceEvent({ v: 1, type: 'ready', readOnly: 'other' }), null);
  assert.equal(parseServiceEvent({ v: 1, type: 'ready' }), null);
  assert.equal(parseServiceEvent({ v: 1, type: 'quit' }), null);
});

test('notify (P3-T11): agent name, label or null, wait state only; extra fields are stripped', () => {
  const ok = { v: 1, type: 'notify', agent: 'Claude Code', label: null, state: 'waiting-for-permission' } as const;
  assert.deepEqual(parseServiceEvent({ ...ok, cwd: '/tmp/x', prompt: 'p' }), ok);
  assert.deepEqual(parseServiceEvent({ ...ok, label: 'Alpha', state: 'needs-input' }), { ...ok, label: 'Alpha', state: 'needs-input' });
  for (const bad of [{ state: 'error' }, { state: 'idle' }, { agent: '' }, { agent: 'x'.repeat(65) }, { agent: 1 }, { label: 'x'.repeat(129) }, { label: undefined }]) {
    assert.equal(parseServiceEvent({ ...ok, ...bad }), null, JSON.stringify(bad));
  }
});

test('health: state, attempt and readOnly are checked; text is plain', () => {
  const h = { v: 1, type: 'health', state: 'restarting', attempt: 2, readOnly: null } as const;
  assert.deepEqual(parseHealth(h), h);
  assert.equal(parseHealth({ ...h, state: 'dead' }), null);
  assert.equal(parseHealth({ ...h, attempt: -1 }), null);
  assert.equal(parseHealth({ ...h, attempt: 1.5 }), null);
  assert.equal(parseHealth({ ...h, readOnly: 'x' }), null);
  assert.equal(healthText({ ...h, state: 'starting', attempt: 0 }), 'Starting');
  assert.equal(healthText({ ...h, state: 'running', attempt: 0 }), 'Running');
  assert.equal(healthText(h), 'Restarting (attempt 2)');
  assert.equal(healthText({ ...h, state: 'stopped', attempt: 0 }), 'Stopped');
  assert.equal(READ_ONLY_BANNER['migration-failed'], 'Database migration failed: read-only');
});

test('accept() hands valid messages on and counts the dropped ones', () => {
  const got: unknown[] = [];
  const onMessage = accept(parseServiceCommand, (m) => got.push(m));
  onMessage({ v: 1, type: 'wake' });
  onMessage({ v: 9, type: 'wake' });
  onMessage('junk');
  assert.deepEqual(got, [{ v: 1, type: 'wake' }]);
  assert.equal(onMessage.dropped, 2);
});

// P1-T12 (XAIBO-PROD-110): renderer <-> service port messages and the setPath command.
const row = { id: 7, agent: 'claude', entrypoint: 'cli', origin: 'CLI', interactive: true, model: 'Model unavailable', cwd: '/tmp/xaibo-fixture/a', title: null, lastActivity: 5, drift: false, compressed: false, quarantined: 0,
  live: null, contextPct: null, costUsd: null, costCoverage: 'unavailable', tokens: null, tokensComplete: true };

// P3-T10 (XAIBO-PROD-310): live status, context and cost on rows; coverage banners; delta ids for the perf trace.
const live = { lifecycle: 'busy', confidence: 'confirmed', health: 'connected', reason: 'Finishing…', outcome: null, findings: ['R2', 'R5'], since: null };
test('rows: live status, context and cost are validated field by field', () => {
  const full = { ...row, live, contextPct: 42.5, costUsd: 0.12, costCoverage: 'partial' };
  assert.deepEqual(parsePortMessage({ v: 1, type: 'sessions', rows: [full] }), { v: 1, type: 'sessions', rows: [full] });
  assert.deepEqual(parsePortMessage({ v: 1, type: 'sessions', rows: [{ ...full, live: { ...live, extra: '<b>' } }] }), { v: 1, type: 'sessions', rows: [full] });
  for (const bad of [{ live: { ...live, lifecycle: 'asleep' } }, { live: { ...live, confidence: 'sure' } }, { live: { ...live, health: 'fine' } },
    { live: { ...live, reason: 'Doing things' } }, { live: { ...live, outcome: 'exploded' } }, { live: { ...live, findings: ['R9'] } },
    { live: { ...live, findings: ['R1', 'R1'] } }, { live: { ...live, findings: 'R1' } }, { live: 'busy' }, { live: undefined },
    { contextPct: -1 }, { contextPct: 101 }, { contextPct: Number.NaN }, { contextPct: '5' }, { costUsd: -0.01 }, { costUsd: Number.POSITIVE_INFINITY },
    { costCoverage: 'some' }, { costCoverage: undefined }]) {
    assert.equal(parsePortMessage({ v: 1, type: 'sessions', rows: [{ ...full, ...bad }] }), null, JSON.stringify(bad));
  }
});

test('sessions deltas may carry a positive integer delta id (perf trace); anything else drops the message', () => {
  assert.deepEqual(parsePortMessage({ v: 1, type: 'sessions', rows: [row], delta: 9 }), { v: 1, type: 'sessions', rows: [row], delta: 9 });
  assert.deepEqual(parsePortMessage({ v: 1, type: 'sessions', rows: [row] }), { v: 1, type: 'sessions', rows: [row] });
  for (const delta of [0, -1, 1.5, '9', null]) assert.equal(parsePortMessage({ v: 1, type: 'sessions', rows: [row], delta }), null, String(delta));
});

test('coverage banners: each kind validated; one bad banner drops the message', () => {
  const banners = [
    { kind: 'hook-gap', reason: 'spool-overflow', agent: 'claude', count: 3, from: 10, to: 20 },
    { kind: 'hook-gap', reason: 'spool-saturated', agent: null, count: null, from: 10, to: null },
    { kind: 'disk-full' },
    { kind: 'hooks-blocked', agent: 'claude', state: 'blocked' },
    { kind: 'hooks-blocked', agent: 'claude', state: 'unknown' },
    { kind: 'awaiting-trust', agent: 'codex', steps: ['Open Codex', 'Approve the Xaibo hooks'] },
  ];
  assert.deepEqual(parsePortMessage({ v: 1, type: 'coverage', banners }), { v: 1, type: 'coverage', banners });
  assert.deepEqual(parsePortMessage({ v: 1, type: 'coverage', banners: [{ kind: 'disk-full', extra: 1 }] }), { v: 1, type: 'coverage', banners: [{ kind: 'disk-full' }] });
  for (const bad of [{ kind: 'meltdown' }, { ...banners[0], reason: 'gone' }, { ...banners[0], count: -1 }, { ...banners[0], agent: 'Bad Agent' },
    { ...banners[0], from: 'x' }, { ...banners[3], state: 'fine' }, { ...banners[5], steps: 'do it' }, { ...banners[5], steps: [5] },
    { ...banners[5], steps: Array(17).fill('x') }, { ...banners[5], agent: undefined }, null]) {
    assert.equal(parsePortMessage({ v: 1, type: 'coverage', banners: [banners[2], bad] }), null, JSON.stringify(bad));
  }
  assert.equal(parsePortMessage({ v: 1, type: 'coverage', banners: Array(65).fill({ kind: 'disk-full' }) }), null, 'bounded');
});

test('setPath command: agent id and an absolute path only', () => {
  assert.deepEqual(parseServiceCommand({ v: 1, type: 'setPath', agent: 'claude', path: '/tmp/x/claude', extra: 1 }), { v: 1, type: 'setPath', agent: 'claude', path: '/tmp/x/claude' });
  for (const bad of [{ agent: 'Claude!', path: '/tmp/x' }, { agent: 'claude', path: 'relative' }, { agent: 'claude' }, { path: '/tmp/x' }, { agent: 'claude', path: '/tmp/\0x' }]) {
    assert.equal(parseServiceCommand({ v: 1, type: 'setPath', ...bad }), null, JSON.stringify(bad));
  }
});

test('listSessions request: id, cursor and limit are checked', () => {
  const req = { v: 1, type: 'listSessions', id: 3, cursor: { lastActivity: null, id: 9 }, limit: 50 };
  assert.deepEqual(parsePortRequest({ ...req, extra: true }), req);
  assert.deepEqual(parsePortRequest({ ...req, cursor: null }), { ...req, cursor: null });
  for (const bad of [{ id: -1 }, { id: 1.5 }, { limit: 0 }, { limit: '50' }, { cursor: { id: 9 } }, { cursor: { lastActivity: 'x', id: 9 } }, { cursor: { lastActivity: 1, id: -2 } }, { type: 'deleteAll' }]) {
    assert.equal(parsePortRequest({ ...req, ...bad }), null, JSON.stringify(bad));
  }
});

test('port messages: page, sessions and agents validated field by field; one bad row drops the message', () => {
  const page = { v: 1, type: 'page', id: 3, rows: [row], next: { lastActivity: 5, id: 7 } };
  assert.deepEqual(parsePortMessage(page), page);
  assert.deepEqual(parsePortMessage({ v: 1, type: 'sessions', rows: [{ ...row, junk: '<b>' }] }), { v: 1, type: 'sessions', rows: [row] });
  const agents = { v: 1, type: 'agents', agents: [{ agent: 'claude', name: 'Claude Code', state: 'detected', version: '2.1.319' }] };
  assert.deepEqual(parsePortMessage(agents), agents);
  assert.deepEqual(parsePortMessage({ v: 1, type: 'agents', agents: null }), { v: 1, type: 'agents', agents: null });
  for (const bad of [{ ...row, id: '7' }, { ...row, cwd: 5 }, { ...row, drift: 'no' }, { ...row, quarantined: -1 }, { ...row, lastActivity: Number.NaN }, { ...row, agent: 'x'.repeat(65) },
    { ...row, origin: 5 }, { ...row, origin: 'x'.repeat(65) }, { ...row, origin: undefined }, { ...row, interactive: 'yes' }, { ...row, interactive: undefined }, { ...row, model: null }, { ...row, model: 5 }]) {
    assert.equal(parsePortMessage({ ...page, rows: [row, bad] }), null, JSON.stringify(bad));
  }
  assert.equal(parsePortMessage({ ...page, rows: 'all' }), null);
  assert.equal(parsePortMessage({ v: 1, type: 'agents', agents: [{ agent: 'claude', name: 'C', state: 'maybe', version: null }] }), null);
});

// XAIBO-PROD-404 (P4-T04a): state onset, session tokens and the live-set request/reply.
test('rows: since is a finite time or null; tokens a non-negative safe integer or null; tokensComplete a boolean', () => {
  const full = { ...row, live: { ...live, lifecycle: 'needs-input', since: 1234 }, tokens: 5000, tokensComplete: false };
  assert.deepEqual(parsePortMessage({ v: 1, type: 'sessions', rows: [full] }), { v: 1, type: 'sessions', rows: [full] });
  for (const bad of [{ live: { ...live, since: 'x' } }, { live: { ...live, since: Number.NaN } }, { live: { ...live, since: undefined } },
    { tokens: -1 }, { tokens: 1.5 }, { tokens: '5' }, { tokens: undefined }, { tokensComplete: 'yes' }, { tokensComplete: undefined }]) {
    assert.equal(parsePortMessage({ v: 1, type: 'sessions', rows: [{ ...full, ...bad }] }), null, JSON.stringify(bad));
  }
});

test('liveSet: request carries an id only; reply rows are validated and more is a boolean', () => {
  assert.deepEqual(parsePortRequest({ v: 1, type: 'liveSet', id: 4, extra: 1 }), { v: 1, type: 'liveSet', id: 4 });
  for (const id of [-1, 1.5, '4', undefined]) assert.equal(parsePortRequest({ v: 1, type: 'liveSet', id }), null, String(id));
  const reply = { v: 1, type: 'liveSet', id: 4, rows: [row], more: false };
  assert.deepEqual(parsePortMessage(reply), reply);
  for (const bad of [{ more: 'no' }, { more: undefined }, { id: -1 }, { rows: [{ ...row, id: 'x' }] }, { rows: 'all' }]) {
    assert.equal(parsePortMessage({ ...reply, ...bad }), null, JSON.stringify(bad));
  }
});

// XAIBO-PROD-405 (P4-T04b1): usage scopes and observed-history pages.
const scope = { scope: 4, agent: 'codex', profile: 'Default profile', verified: true, stream: 'codex:primary', windowMinutes: 300, usedPercent: 101.5,
  resetsAt: 9, plan: 'pro', credits: { hasCredits: true, unlimited: null, balance: '12.50' }, asOf: 5, firstObservedAt: 5, measuredAt: 5, unavailable: null };
const blank = { scope: null, agent: 'agy', profile: 'Default profile', verified: null, stream: null, windowMinutes: null, usedPercent: null, resetsAt: null,
  plan: null, credits: null, asOf: null, firstObservedAt: null, measuredAt: null, unavailable: 'passive' };
test('usage: request id only; reply scopes validated field by field and bounded', () => {
  assert.deepEqual(parsePortRequest({ v: 1, type: 'usage', id: 2, x: 1 }), { v: 1, type: 'usage', id: 2 });
  assert.equal(parsePortRequest({ v: 1, type: 'usage', id: -2 }), null);
  const reply = { v: 1, type: 'usage', id: 2, scopes: [scope, blank, { ...blank, agent: 'claude', unavailable: 'no-observation' }] };
  assert.deepEqual(parsePortMessage(reply), reply);
  assert.deepEqual(parsePortMessage({ ...reply, scopes: [{ ...scope, extra: '<b>', credits: { ...scope.credits, junk: 1 } }] }), { ...reply, scopes: [scope] });
  for (const bad of [{ scope: -1 }, { agent: 'Bad Agent' }, { profile: 5 }, { profile: 'x'.repeat(4098) }, { verified: 'yes' }, { stream: 'x'.repeat(81) },
    { windowMinutes: 0.5 }, { usedPercent: -1 }, { usedPercent: Number.NaN }, { resetsAt: 'x' }, { plan: 'x'.repeat(33) }, { credits: 'lots' },
    { credits: { hasCredits: 'y', unlimited: null, balance: null } }, { credits: { hasCredits: null, unlimited: null, balance: 'x'.repeat(33) } },
    { asOf: Number.NaN }, { firstObservedAt: 'x' }, { measuredAt: undefined }, { unavailable: 'later' }, { unavailable: undefined }]) {
    assert.equal(parsePortMessage({ ...reply, scopes: [bad && { ...scope, ...bad }] }), null, JSON.stringify(bad));
  }
  assert.equal(parsePortMessage({ ...reply, scopes: Array(257).fill(blank) }), null, 'bounded');
});

test('usageHistory: request fields checked; reply records and cursor validated', () => {
  const req = { v: 1, type: 'usageHistory', id: 6, scope: 4, stream: 'five_hour', from: 10, to: 20, cursor: { measuredAt: 12, id: 3 }, limit: 50 };
  assert.deepEqual(parsePortRequest({ ...req, extra: 1 }), req);
  assert.deepEqual(parsePortRequest({ ...req, cursor: null }), { ...req, cursor: null });
  for (const bad of [{ id: -1 }, { scope: -4 }, { scope: 1.5 }, { stream: '' }, { stream: 'x'.repeat(81) }, { from: 'x' }, { to: Number.NaN }, { from: 30 },
    { cursor: { measuredAt: 'x', id: 3 } }, { cursor: { measuredAt: 12 } }, { limit: 0 }, { limit: 2.5 }]) {
    assert.equal(parsePortRequest({ ...req, ...bad }), null, JSON.stringify(bad));
  }
  const rec = { id: 3, kind: 'transition', measuredAt: 12, usedPercent: 40, windowMinutes: 300, resetsAt: null, sourceTimeKnown: false };
  const reply = { v: 1, type: 'usageHistory', id: 6, records: [rec], next: { measuredAt: 12, id: 3 } };
  assert.deepEqual(parsePortMessage(reply), reply);
  assert.deepEqual(parsePortMessage({ ...reply, next: null }), { ...reply, next: null });
  for (const bad of [{ id: 'x' }, { kind: 'guess' }, { measuredAt: null }, { usedPercent: -1 }, { windowMinutes: -5 }, { resetsAt: 'x' }, { sourceTimeKnown: 1 }]) {
    assert.equal(parsePortMessage({ ...reply, records: [{ ...rec, ...bad }] }), null, JSON.stringify(bad));
  }
  assert.equal(parsePortMessage({ ...reply, records: Array(101).fill(rec) }), null, 'bounded');
});

test('review: utilization above 10,000 % (the service bound) drops the message', () => {
  assert.equal(parsePortMessage({ v: 1, type: 'usage', id: 2, scopes: [{ ...scope, usedPercent: 10_001 }] }), null);
  assert.equal(parsePortMessage({ v: 1, type: 'usageHistory', id: 6, records: [{ id: 3, kind: 'sample', measuredAt: 12, usedPercent: 10_001, windowMinutes: 300, resetsAt: null, sourceTimeKnown: false }], next: null }), null);
});

// XAIBO-PROD-410 (P4-T05b1): single-session requests and replies; every field bounded, untrusted text stays a string.
test('session, transcript and slice requests: fields checked', () => {
  assert.deepEqual(parsePortRequest({ v: 1, type: 'session', id: 3, session: 9 }), { v: 1, type: 'session', id: 3, session: 9 });
  for (const at of ['first', 'latest', { after: { seq: 4, id: 2 } }, { before: { seq: -1, id: 2 } }]) {
    const req = { v: 1, type: 'transcript', id: 3, session: 9, at, limit: 50 };
    assert.deepEqual(parsePortRequest(req), req, JSON.stringify(at));
  }
  const slice = { v: 1, type: 'slice', id: 3, session: 9, event: 12, part: 'reasoning', offset: 0 };
  assert.deepEqual(parsePortRequest(slice), slice);
  for (const bad of [
    { v: 1, type: 'session', id: 3, session: 0 }, { v: 1, type: 'session', id: 3 },
    { v: 1, type: 'transcript', id: 3, session: 9, at: 'middle', limit: 50 },
    { v: 1, type: 'transcript', id: 3, session: 9, at: { after: { seq: 1.5, id: 2 } }, limit: 50 },
    { v: 1, type: 'transcript', id: 3, session: 9, at: { after: { seq: 1, id: 2 }, before: { seq: 1, id: 2 } }, limit: 50 },
    { v: 1, type: 'transcript', id: 3, session: 9, at: 'first', limit: 0 },
    { ...slice, part: 'raw' }, { ...slice, offset: -1 }, { ...slice, offset: 1.5 }, { ...slice, event: 0 },
  ]) assert.equal(parsePortRequest(bad), null, JSON.stringify(bad));
});

test('session, transcript and slice replies: bounds and fixed codes validated', () => {
  const detail = { row, coverage: ['compressed', 'hook-gap'], context: null };
  assert.deepEqual(parsePortMessage({ v: 1, type: 'session', id: 3, detail }), { v: 1, type: 'session', id: 3, detail });
  assert.deepEqual(parsePortMessage({ v: 1, type: 'session', id: 3, detail: null }), { v: 1, type: 'session', id: 3, detail: null });
  assert.equal(parsePortMessage({ v: 1, type: 'session', id: 3, detail: { row, coverage: ['made-up'], context: null } }), null);
  assert.equal(parsePortMessage({ v: 1, type: 'session', id: 3, detail: { row, coverage: [] } }), null); // context is required
  // XAIBO-PROD-414 (P4-T06a): the newest context generation's latest reading, validated field by field.
  const context = { generation: 2, used: 40000, window: 200000, basis: 'reported', source: 'statusline', asOf: null, observedAt: 9 };
  const withCtx = { ...detail, context };
  assert.deepEqual(parsePortMessage({ v: 1, type: 'session', id: 3, detail: withCtx }), { v: 1, type: 'session', id: 3, detail: withCtx });
  const nulls = { ...context, used: null, window: null, basis: 'unavailable', source: 'compaction' };
  assert.deepEqual(parsePortMessage({ v: 1, type: 'session', id: 3, detail: { ...detail, context: nulls } })?.type, 'session');
  for (const bad of [
    { ...context, generation: -1 }, { ...context, generation: 1.5 }, { ...context, used: -1 }, { ...context, used: 1.5 },
    { ...context, window: -5 }, { ...context, basis: 'guessed' }, { ...context, source: 'model-list' }, { ...context, asOf: 'now' },
    { ...context, observedAt: null }, { ...context, extra: 1 }, 'context',
    { ...context, basis: 'unavailable' }, { ...context, window: null }, // review M1: window and basis must agree
  ]) assert.equal(parsePortMessage({ v: 1, type: 'session', id: 3, detail: { ...detail, context: bad } }), null, JSON.stringify(bad));
  const item = { event: 12, seq: 4, ts: null, kind: 'response', preview: 'Done', length: 4, reasoning: true, callId: null };
  const page = { v: 1, type: 'transcript', id: 3, items: [item, { ...item, event: 13, kind: 'tool-call', preview: null, reasoning: false, callId: 'toolu_1' }], prev: null, next: { seq: 5, id: 13 } };
  assert.deepEqual(parsePortMessage(page), page);
  for (const bad of [
    { ...page, items: Array.from({ length: 101 }, () => item) },
    { ...page, items: [{ ...item, kind: 'html' }] },
    { ...page, items: [{ ...item, preview: 'x'.repeat(4097) }] },
    { ...page, items: [{ ...item, length: -1 }] },
    { ...page, next: { seq: 5 } },
  ]) assert.equal(parsePortMessage(bad), null);
  assert.deepEqual(parsePortMessage({ v: 1, type: 'slice', id: 3, text: 'abc', next: 3 }), { v: 1, type: 'slice', id: 3, text: 'abc', next: 3 });
  assert.equal(parsePortMessage({ v: 1, type: 'slice', id: 3, text: 'x'.repeat(16 * 1024 + 1), next: null }), null);
  assert.equal(parsePortMessage({ v: 1, type: 'slice', id: 3, text: 'abc', next: -2 }), null);
});

// XAIBO-PROD-411 (P4-T05b2): tool, subagent, file and model-marker pages; fixed enums and bounds.
test('tools, subagents, files and markers requests: fields checked', () => {
  for (const type of ['tools', 'subagents', 'files']) {
    for (const cursor of [null, 7]) {
      const req = { v: 1, type, id: 3, session: 9, cursor, limit: 50 };
      assert.deepEqual(parsePortRequest(req), req);
    }
    for (const bad of [{ cursor: 0 }, { cursor: 1.5 }, { cursor: '7' }, { limit: 0 }, { session: 0 }]) {
      assert.equal(parsePortRequest({ v: 1, type, id: 3, session: 9, cursor: null, limit: 50, ...bad }), null, `${type} ${JSON.stringify(bad)}`);
    }
  }
  const mk = { v: 1, type: 'markers', id: 3, session: 9, cursor: { ts: 5, id: 2 }, limit: 50 };
  assert.deepEqual(parsePortRequest(mk), mk);
  assert.deepEqual(parsePortRequest({ ...mk, cursor: null }), { ...mk, cursor: null });
  for (const cursor of [{ ts: 5 }, { ts: 1.5, id: 2 }, { ts: 5, id: 0 }, 7]) assert.equal(parsePortRequest({ ...mk, cursor }), null, JSON.stringify(cursor));
});

test('tools, subagents, files and markers replies: bounds and fixed codes validated', () => {
  const tool = { call: 4, callId: 'toolu_1', tool: 'Read', sources: ['transcript', 'hook'], argsEvent: 12, resultEvent: null, ts: 100, durationMs: 10, approval: 'approved', error: false };
  const tools = { v: 1, type: 'tools', id: 3, calls: [tool, { ...tool, call: 5, callId: null, tool: null, sources: [], argsEvent: null, ts: null, durationMs: null, approval: null, error: null }], next: 5 };
  assert.deepEqual(parsePortMessage(tools), tools);
  for (const bad of [{ approval: 'maybe' }, { durationMs: -1 }, { sources: ['x'.repeat(33)] }, { sources: Array(9).fill('hook') }, { callId: '' }, { error: 'no' }, { argsEvent: 0 }]) {
    assert.equal(parsePortMessage({ ...tools, calls: [{ ...tool, ...bad }] }), null, JSON.stringify(bad));
  }
  assert.equal(parsePortMessage({ ...tools, calls: Array(101).fill(tool) }), null);
  assert.equal(parsePortMessage({ ...tools, next: 0 }), null);

  const sub = { id: 10, nativeId: 'agent-a', agentType: 'general-purpose', model: 'model-late', start: 1, end: 2, records: 3, lifecycle: 'ended' };
  const subs = { v: 1, type: 'subagents', id: 3, subagents: [sub, { ...sub, id: 11, agentType: null, start: null, end: null, records: 0, lifecycle: null }], next: null };
  assert.deepEqual(parsePortMessage(subs), subs);
  for (const bad of [{ lifecycle: 'zombie' }, { records: -1 }, { nativeId: '' }, { model: 'x'.repeat(4098) }]) {
    assert.equal(parsePortMessage({ ...subs, subagents: [{ ...sub, ...bad }] }), null, JSON.stringify(bad));
  }

  const touch = { path: '/w/a.ts', kind: 'write_confirmed', callId: 'toolu_1', call: 4 };
  const files = { v: 1, type: 'files', id: 3, touches: [touch, { ...touch, callId: null }], next: 4 };
  assert.deepEqual(parsePortMessage(files), files);
  for (const bad of [{ kind: 'deleted' }, { path: '' }, { path: 'x'.repeat(4097) }, { call: 0 }]) {
    assert.equal(parsePortMessage({ ...files, touches: [{ ...touch, ...bad }] }), null, JSON.stringify(bad));
  }
  assert.equal(parsePortMessage({ ...files, touches: Array(201).fill(touch) }), null);

  const marker = { turn: 3, ts: 100, model: 'model-b · low' };
  const markers = { v: 1, type: 'markers', id: 3, markers: [marker], next: { ts: 100, id: 3 } };
  assert.deepEqual(parsePortMessage(markers), markers);
  for (const bad of [{ ...markers, markers: [{ ...marker, ts: null }] }, { ...markers, markers: [{ ...marker, model: '' }] }, { ...markers, next: { ts: 100 } }]) {
    assert.equal(parsePortMessage(bad), null, JSON.stringify(bad));
  }
});

// XAIBO-PROD-417 (P4-T07a; PRD FR-48, US-18; design §6.3.2): the session cost breakdown request and reply.
test('cost request and reply: bounded groups, fixed names, finite non-negative amounts, rates and counts', () => {
  assert.deepEqual(parsePortRequest({ v: 1, type: 'cost', id: 3, session: 9 }), { v: 1, type: 'cost', id: 3, session: 9 });
  for (const bad of [{ v: 1, type: 'cost', id: 3, session: 0 }, { v: 1, type: 'cost', id: 3 }]) assert.equal(parsePortRequest(bad), null);
  const comp = { name: 'uncached_input', tokens: 10, missing: 0, unpriced: 0, rate: 4, rateVaries: false, usd: 0.00004 };
  const group = { model: 'Claude Opus 5.5', revision: 2, basis: 'token_table', requests: 2, priced: 2, from: 1, to: 2,
    components: [comp, { ...comp, name: 'cache_write_1h', tokens: null, missing: 2, unpriced: 1, rate: null, rateVaries: true, usd: null }] };
  const rev = { id: 2, label: 'bundled-1', pricesAsOf: '2026-11-01', source: 'bundled', references: ['anthropic: https://example.com/p (retrieved 2026-11-01)'] };
  const cost = { amountUsd: 0, basis: 'agent_reported', coverage: 'full', reportedUsd: 0, requests: 2, priced: 2, gaps: ['cache_write'],
    reasons: ['unpriced-model'], groups: [group], more: false, revisions: [rev] };
  const msg = { v: 1, type: 'cost', id: 3, cost };
  assert.deepEqual(parsePortMessage(msg), msg);
  assert.deepEqual(parsePortMessage({ v: 1, type: 'cost', id: 3, cost: null }), { v: 1, type: 'cost', id: 3, cost: null });
  for (const bad of [
    { ...cost, amountUsd: -1 }, { ...cost, amountUsd: Infinity }, { ...cost, basis: 'guess' }, { ...cost, coverage: 'most' },
    { ...cost, reportedUsd: NaN }, { ...cost, requests: -1 }, { ...cost, gaps: ['<b>'] }, { ...cost, reasons: Array(17).fill('x') },
    { ...cost, groups: Array(33).fill(group) }, { ...cost, more: 'no' }, { ...cost, revisions: [{ ...rev, source: 'web' }] },
    { ...cost, revisions: [{ ...rev, references: Array(9).fill('r') }] }, { ...cost, groups: [{ ...group, basis: 'agent_reported' }] },
    { ...cost, groups: [{ ...group, components: [{ ...comp, name: 'reasoning' }] }] }, { ...cost, groups: [{ ...group, components: [{ ...comp, rate: -4 }] }] },
    { ...cost, groups: [{ ...group, components: [{ ...comp, tokens: 1.5 }] }] }, { ...cost, groups: [{ ...group, revision: 0 }] },
    { ...cost, extra: 1 },
    { ...cost, groups: [{ ...group, components: [comp, comp] }] }, { ...cost, groups: [{ ...group, priced: 3 }] }, // review L7
    { ...cost, groups: [{ ...group, components: [{ ...comp, unpriced: -1 }] }] }, { ...cost, priced: 3 },
  ]) assert.equal(parsePortMessage({ v: 1, type: 'cost', id: 3, cost: bad }), null, JSON.stringify(bad));
});

test('P4-T10c1: the resync push carries nothing; extra fields are stripped', () => {
  assert.deepEqual(parsePortMessage({ v: 1, type: 'resync', rows: [1], delta: 3, extra: 'x' }), { v: 1, type: 'resync' });
  assert.equal(parsePortMessage({ v: 2, type: 'resync' }), null);
});

test('P4-T10c2: metrics carry every known key as a safe non-negative integer; anything else is stripped or rejected', () => {
  const metrics = { writerQueueAgeMs: 0, parseLagMs: 1500, walBytes: 1 << 20, watchHandles: 200, statusSessions: 500, deltaResyncs: 7, diskFull: 1 };
  assert.deepEqual(parseServiceEvent({ v: 1, type: 'metrics', metrics: { ...metrics, path: '/tmp/x' }, extra: 'x' }), { v: 1, type: 'metrics', metrics });
  for (const bad of [{ walBytes: -1 }, { walBytes: 1.5 }, { walBytes: '1' }, { walBytes: 2 ** 53 }, { diskFull: null }, { parseLagMs: undefined }]) {
    assert.equal(parseServiceEvent({ v: 1, type: 'metrics', metrics: { ...metrics, ...bad } }), null, JSON.stringify(bad));
  }
  for (const bad of [null, [], 'x']) assert.equal(parseServiceEvent({ v: 1, type: 'metrics', metrics: bad }), null);
});
