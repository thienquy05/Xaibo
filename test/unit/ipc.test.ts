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
  live: null, contextPct: null, costUsd: null, costCoverage: 'unavailable' };

// P3-T10 (XAIBO-PROD-310): live status, context and cost on rows; coverage banners; delta ids for the perf trace.
const live = { lifecycle: 'busy', confidence: 'confirmed', health: 'connected', reason: 'Finishing…', outcome: null, findings: ['R2', 'R5'] };
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
