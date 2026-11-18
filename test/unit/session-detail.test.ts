// XAIBO-PROD-409 (P4-T05a2): read-time derivations for the session workspace. Stored rows are not rewritten: message
// text vs available reasoning come from the raw record, durations from one source only (EC-08), approval state from
// the normalized status evidence, a subagent's model from its own records. Unknown stays null or absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callApprovals, callDuration, claudeMessageParts, subagentModel } from '../../src/service/session-detail.ts';
import type { Ev } from '../../src/service/status/engine.ts';

const msg = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content, ...extra } });

test('claudeMessageParts: text and thinking apart; tool blocks excluded; absent parts null', () => {
  assert.deepEqual(claudeMessageParts(msg([
    { type: 'thinking', thinking: 'plan A' }, { type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't', name: 'Read', input: {} },
    { type: 'thinking', thinking: 'plan B' }, { type: 'text', text: 'World' },
  ])), { text: 'Hello\nWorld', reasoning: 'plan A\nplan B' });
  assert.deepEqual(claudeMessageParts(msg([{ type: 'text', text: 'only text' }])), { text: 'only text', reasoning: null });
  assert.deepEqual(claudeMessageParts(msg([{ type: 'tool_result', tool_use_id: 't', content: 'r' }])), { text: null, reasoning: null });
  assert.deepEqual(claudeMessageParts(JSON.stringify({ type: 'user', message: { role: 'user', content: 'typed prompt' } })), { text: 'typed prompt', reasoning: null });
  assert.deepEqual(claudeMessageParts(msg([{ type: 'thinking', thinking: '' }, { type: 'text', text: 42 }])), { text: null, reasoning: null });
  for (const bad of ['{nope', '[]', 'null', '"s"', JSON.stringify({ message: 5 })]) assert.deepEqual(claudeMessageParts(bad), { text: null, reasoning: null });
});

test('callDuration: one source, both finite, never negative', () => {
  assert.equal(callDuration({ ts: 1000, source: 'transcript' }, { ts: 3500, source: 'transcript' }), 2500);
  assert.equal(callDuration({ ts: 1000, source: 'transcript' }, { ts: 1000, source: 'transcript' }), 0);
  assert.equal(callDuration({ ts: 1000, source: 'hook' }, { ts: 3500, source: 'transcript' }), null);
  assert.equal(callDuration({ ts: 3500, source: 'transcript' }, { ts: 1000, source: 'transcript' }), null);
  assert.equal(callDuration({ ts: null, source: 'transcript' }, { ts: 1000, source: 'transcript' }), null);
  assert.equal(callDuration({ ts: 1000, source: 'transcript' }, undefined), null);
  assert.equal(callDuration(undefined, undefined), null);
  assert.equal(callDuration({ ts: Number.NaN, source: 'x' }, { ts: 5, source: 'x' }), null);
});

test('callApprovals: not requested, requested, approved, denied; unseen calls absent', () => {
  const evs: Ev[] = [
    { k: 'tool.start', id: 'a' }, { k: 'tool.end', id: 'a' },
    { k: 'tool.start', id: 'b' }, { k: 'request', kind: 'permission', id: null }, { k: 'tool.end', id: 'b' },
    { k: 'tool.start', id: 'c' }, { k: 'request', kind: 'permission', id: 'c' }, { k: 'resolve', id: 'c', outcome: 'denied' },
    { k: 'tool.start', id: 'd' }, { k: 'request', kind: 'permission', id: null }, { k: 'tool.rejected', id: 'd' },
    { k: 'tool.start', id: 'e' }, { k: 'request', kind: 'permission', id: 'e' },
    { k: 'tool.start', id: 'f' }, { k: 'tool.rejected', id: 'f' },
  ];
  assert.deepEqual(Object.fromEntries(callApprovals(evs)), {
    a: 'not_requested', b: 'approved', c: 'denied', d: 'denied', e: 'requested', f: 'not_requested',
  });
  assert.equal(callApprovals(evs).get('zz'), undefined);
});

test('callApprovals: an id-less request joins the latest started call still in flight; input requests are not approvals', () => {
  const evs: Ev[] = [
    { k: 'tool.start', id: 'x' }, { k: 'tool.start', id: 'y' }, { k: 'tool.end', id: 'y' },
    { k: 'request', kind: 'permission', id: null }, { k: 'tool.end', id: 'x' },
    { k: 'tool.start', id: 'z' }, { k: 'request', kind: 'input', id: 'z' }, { k: 'tool.end', id: 'z' },
  ];
  assert.deepEqual(Object.fromEntries(callApprovals(evs)), { x: 'approved', y: 'not_requested', z: 'not_requested' });
  assert.equal(callApprovals([{ k: 'request', kind: 'permission', id: null }]).size, 0);
  assert.equal(callApprovals([{ k: 'request', kind: 'permission', id: 'q' }]).get('q'), undefined);
});

test('review M1: only a call still in flight changes state; duplicate and late starts are ignored', () => {
  // A duplicate start does not leave a stale in-flight copy for an id-less request to join.
  assert.deepEqual(Object.fromEntries(callApprovals([{ k: 'tool.start', id: 'a' }, { k: 'tool.start', id: 'a' }, { k: 'tool.end', id: 'a' },
    { k: 'request', kind: 'permission', id: null }])), { a: 'not_requested' });
  // A request after the call ended, by id or id-less, never reopens it.
  assert.deepEqual(Object.fromEntries(callApprovals([{ k: 'tool.start', id: 'b' }, { k: 'request', kind: 'permission', id: 'b' }, { k: 'tool.end', id: 'b' },
    { k: 'request', kind: 'permission', id: 'b' }, { k: 'request', kind: 'permission', id: null }])), { b: 'approved' });
  // A start for an id that already ended is not a new call.
  assert.deepEqual(Object.fromEntries(callApprovals([{ k: 'tool.start', id: 'c' }, { k: 'tool.end', id: 'c' }, { k: 'tool.start', id: 'c' },
    { k: 'request', kind: 'permission', id: null }])), { c: 'not_requested' });
  // A resolve that is not a denial leaves the request pending.
  assert.deepEqual(Object.fromEntries(callApprovals([{ k: 'tool.start', id: 'd' }, { k: 'request', kind: 'permission', id: 'd' },
    { k: 'resolve', id: 'd', outcome: 'granted' }])), { d: 'requested' });
});

test('review L1: an id-less request never joins a subagent (child) call', () => {
  assert.deepEqual(Object.fromEntries(callApprovals([{ k: 'tool.start', id: 'p' }, { k: 'tool.start', id: 'ch', child: true },
    { k: 'request', kind: 'permission', id: null }])), { p: 'requested', ch: 'not_requested' });
});

test('re-review N1/N2: an end before its start stays ended; a child takes an explicit-id request but is never joined', () => {
  assert.deepEqual(Object.fromEntries(callApprovals([{ k: 'tool.end', id: 'a' }, { k: 'tool.start', id: 'a' },
    { k: 'request', kind: 'permission', id: null }])), { a: 'not_requested' });
  assert.deepEqual(Object.fromEntries(callApprovals([{ k: 'tool.start', id: 'c', child: true }, { k: 'request', kind: 'permission', id: 'c' },
    { k: 'tool.end', id: 'c' }])), { c: 'approved' });
});

// XAIBO-PROD-444 (G4a-2): as the engine, only a confirmed end closes a call, and a rejection counts only in flight.
test('XAIBO-PROD-444: an inferred end or a rejection outside flight never closes a call; a confirmed end before its start does', () => {
  assert.deepEqual(Object.fromEntries(callApprovals([{ k: 'tool.end', id: 'a', conf: 'inferred' }, { k: 'tool.start', id: 'a' },
    { k: 'request', kind: 'permission', id: null }])), { a: 'requested' });
  assert.deepEqual(Object.fromEntries(callApprovals([{ k: 'tool.rejected', id: 'b' }, { k: 'tool.start', id: 'b' },
    { k: 'request', kind: 'permission', id: null }])), { b: 'requested' });
  assert.deepEqual(Object.fromEntries(callApprovals([{ k: 'tool.end', id: 'c', conf: 'confirmed' }, { k: 'tool.start', id: 'c' },
    { k: 'request', kind: 'permission', id: null }])), { c: 'not_requested' });
  // an inferred end still ends the flight: a later id-less request does not join it
  assert.deepEqual(Object.fromEntries(callApprovals([{ k: 'tool.start', id: 'd' }, { k: 'tool.end', id: 'd', conf: 'inferred' },
    { k: 'request', kind: 'permission', id: null }])), { d: 'not_requested' });
});

test('prototype-like call ids stay ordinary keys', () => {
  const m = callApprovals([{ k: 'tool.start', id: '__proto__' }, { k: 'tool.start', id: 'constructor' }, { k: 'request', kind: 'permission', id: null }]);
  assert.equal(m.get('__proto__'), 'not_requested');
  assert.equal(m.get('constructor'), 'requested');
});

test('review M2: linear work on a large adversarial stream', () => {
  const n = 60_000;
  const evs: Ev[] = [];
  for (let i = 0; i < n; i++) evs.push({ k: 'tool.start', id: `s${i}` });
  for (let i = 0; i < n; i++) evs.push({ k: 'tool.end', id: `s${i}` }, { k: 'tool.end', id: `unseen${i}` }, { k: 'request', kind: 'permission', id: null });
  const t = performance.now();
  const m = callApprovals(evs);
  assert.equal(m.size, n);
  assert.ok(performance.now() - t < 1000, 'callApprovals must stay near-linear');
});

test('subagentModel: latest reported model in the subagent records, else null', () => {
  assert.equal(subagentModel([msg([], { model: 'model-a' }), '{bad', msg([], { model: 'model-b' }), msg([])]), 'model-b');
  assert.equal(subagentModel([msg([]), JSON.stringify({ type: 'user' })]), null);
  assert.equal(subagentModel([msg([], { model: '' }), msg([], { model: 'x'.repeat(201) }), msg([], { model: 7 })]), null);
  assert.equal(subagentModel([]), null);
});

// XAIBO-PROD-455 (G4a-2 follow-up): as the status engine (CONFIRMED_ONLY), inferred request and resolve evidence never
// changes a call's approval.
test('callApprovals: an inferred permission request or an inferred denial changes nothing', () => {
  const ev = (e: Ev, conf?: 'inferred' | 'confirmed') => (conf ? { ...e, conf } : e);
  assert.deepEqual(Object.fromEntries(callApprovals([ev({ k: 'tool.start', id: 'a' }), ev({ k: 'request', kind: 'permission', id: 'a' }, 'inferred'),
    ev({ k: 'tool.start', id: 'b' }), ev({ k: 'request', kind: 'permission', id: null }, 'inferred')])), { a: 'not_requested', b: 'not_requested' });
  assert.deepEqual(Object.fromEntries(callApprovals([ev({ k: 'tool.start', id: 'c' }), ev({ k: 'request', kind: 'permission', id: 'c' }, 'confirmed'),
    ev({ k: 'resolve', id: 'c', outcome: 'denied' }, 'inferred'), ev({ k: 'tool.end', id: 'c' })])), { c: 'approved' });
  assert.deepEqual(Object.fromEntries(callApprovals([ev({ k: 'tool.start', id: 'd' }), ev({ k: 'request', kind: 'permission', id: 'd' }, 'confirmed'),
    ev({ k: 'resolve', id: 'd', outcome: 'denied' }, 'confirmed')])), { d: 'denied' });
});
