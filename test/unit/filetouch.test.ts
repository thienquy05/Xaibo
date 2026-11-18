// XAIBO-PROD-408 (P4-T05a, PRD FileTouch, OQ-P2-07): FileTouch records derive from stored tool-call evidence (the
// raw args and result records of one call). Only fixture-verified shapes count: Claude Read/Write/Edit with
// `file_path` and `tool_result.is_error`. A write is confirmed only by a non-error result; nothing is guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveFileTouches, type ToolEvidence } from '../../src/service/filetouch.ts';

const use = (id: string, name: string, input: unknown) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id, name, input }] } });
const result = (id: string, isError?: boolean) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(isError === undefined ? {} : { is_error: isError }) }] } });
const call = (callId: string, name: string, input: unknown, res?: boolean | 'absent'): ToolEvidence => ({
  agent: 'claude', callId, argsRaw: use(callId, name, input), ...(res === 'absent' || res === undefined ? {} : { resultRaw: result(callId, res) }),
});
const kinds = (ev: ToolEvidence[]) => deriveFileTouches(ev).map((t) => `${t.kind} ${t.path} ${t.callId}`);

test('Read gives read unless its result is an error; no result still reads', () => {
  assert.deepEqual(kinds([call('r1', 'Read', { file_path: '/w/a.txt' }, false)]), ['read /w/a.txt r1']);
  assert.deepEqual(kinds([call('r2', 'Read', { file_path: '/w/a.txt' }, 'absent')]), ['read /w/a.txt r2']);
  assert.deepEqual(kinds([call('r3', 'Read', { file_path: '/w/a.txt' }, true)]), []);
});

test('Write and Edit: attempted always; confirmed only with a non-error result for the same call id', () => {
  assert.deepEqual(kinds([call('w1', 'Write', { file_path: '/w/out.txt', content: 'c' }, false)]),
    ['write_attempted /w/out.txt w1', 'write_confirmed /w/out.txt w1']);
  assert.deepEqual(kinds([call('e1', 'Edit', { file_path: '/w/a.txt', old_string: 'x', new_string: 'y' }, 'absent')]),
    ['write_attempted /w/a.txt e1']);
  assert.deepEqual(kinds([call('e2', 'Edit', { file_path: '/w/a.txt' }, true)]), ['write_attempted /w/a.txt e2']);
  // A result for another call never confirms this one.
  assert.deepEqual(kinds([{ agent: 'claude', callId: 'w2', argsRaw: use('w2', 'Write', { file_path: '/w/b' }), resultRaw: result('zz', false) }]),
    ['write_attempted /w/b w2']);
});

test('is_error absent on a result is not proof of success', () => {
  assert.deepEqual(kinds([call('w3', 'Write', { file_path: '/w/c' }, undefined)]), ['write_attempted /w/c w3']);
  const noFlag: ToolEvidence = { agent: 'claude', callId: 'w4', argsRaw: use('w4', 'Write', { file_path: '/w/d' }), resultRaw: result('w4') };
  assert.deepEqual(kinds([noFlag]), ['write_attempted /w/d w4']);
});

test('unverified tools and agents produce nothing', () => {
  assert.deepEqual(kinds([call('m1', 'MultiEdit', { file_path: '/w/a' }, false), call('g1', 'Grep', { path: '/w' }, false)]), []);
  assert.deepEqual(kinds([{ ...call('c1', 'Write', { file_path: '/w/a' }, false), agent: 'codex' }]), []);
  assert.deepEqual(kinds([{ ...call('a1', 'Read', { file_path: '/w/a' }, false), agent: 'agy' }]), []);
});

test('several kinds per file, evidence kept per call, duplicates collapse', () => {
  const r = call('r9', 'Read', { file_path: '/w/a.txt' }, false);
  assert.deepEqual(kinds([r, r, call('w9', 'Write', { file_path: '/w/a.txt' }, false)]),
    ['read /w/a.txt r9', 'write_attempted /w/a.txt w9', 'write_confirmed /w/a.txt w9']);
});

test('bad paths and bad records are ignored', () => {
  assert.deepEqual(kinds([
    call('p1', 'Read', { file_path: '' }, false),
    call('p2', 'Read', { file_path: 42 }, false),
    call('p3', 'Read', { file_path: 'x'.repeat(4097) }, false),
    call('p4', 'Read', null, false),
    { agent: 'claude', callId: 'p5', argsRaw: '{not json' },
    { agent: 'claude', callId: 'p6' },
    { agent: 'claude', callId: 'p7', argsRaw: use('other', 'Read', { file_path: '/w/a' }) },
    { agent: 'claude', callId: 'p8', argsRaw: '[]' },
    { agent: 'claude', callId: 'p9', argsRaw: '42' },
    { agent: 'claude', callId: 'p10', argsRaw: 'null' },
    call('p11', 'Write', { file_path: '' }, false),
    call('p12', 'Edit', { file_path: 7 }, false),
  ]), []);
});

test('a non-boolean is_error ("false") never confirms a write', () => {
  const resultRaw = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w5', is_error: 'false' }] } });
  assert.deepEqual(kinds([{ agent: 'claude', callId: 'w5', argsRaw: use('w5', 'Write', { file_path: '/w/e' }), resultRaw }]), ['write_attempted /w/e w5']);
});
