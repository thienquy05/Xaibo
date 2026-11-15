// XAIBO-PROD-410 (P4-T05b1; design §5.2, §6.3): the transcript classifier turns a stored record into a workspace item
// (prompt, response, tool-call, tool-result, compaction, interrupted) or skips it; Claude reasoning never mixes into
// text. utf8Slice cuts at most N bytes of UTF-8 from a code-unit offset without splitting a code point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyItem, utf8Slice, type StoredRecord } from '../../src/service/transcript.ts';

const rec = (o: Partial<StoredRecord>): StoredRecord => ({ agent: 'claude', kind: 'message', role: null, injected: false, content: null, raw: null, ...o });
const claude = (type: string, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, ...extra, message: { role: type, content } });

test('Claude: prompt, response with reasoning apart, tool call, tool result, compaction; other system and unknown skipped', () => {
  assert.deepEqual(classifyItem(rec({ role: 'user', raw: claude('user', 'Fix the parser') })), { kind: 'prompt', text: 'Fix the parser', reasoning: null });
  assert.deepEqual(classifyItem(rec({ role: 'assistant', raw: claude('assistant', [{ type: 'thinking', thinking: 'consider' }, { type: 'text', text: 'Done' }]) })),
    { kind: 'response', text: 'Done', reasoning: 'consider' });
  assert.deepEqual(classifyItem(rec({ role: 'assistant', content: 'Read {"file_path":"/w/a"}', raw: claude('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a' } }]) })),
    { kind: 'tool-call', text: 'Read {"file_path":"/w/a"}', reasoning: null });
  assert.deepEqual(classifyItem(rec({ role: 'user', content: 'file body', raw: claude('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }]) })),
    { kind: 'tool-result', text: 'file body', reasoning: null });
  // An assistant record with both text and a tool call is a response; the call appears in the tool ledger.
  assert.equal(classifyItem(rec({ role: 'assistant', raw: claude('assistant', [{ type: 'text', text: 'Reading' }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }]) }))?.kind, 'response');
  assert.deepEqual(classifyItem(rec({ kind: 'system', raw: JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) })), { kind: 'compaction', text: null, reasoning: null });
  assert.equal(classifyItem(rec({ kind: 'system', raw: JSON.stringify({ type: 'system', subtype: 'informational' }) })), null);
  assert.equal(classifyItem(rec({ kind: 'unknown', raw: '{}' })), null);
  assert.equal(classifyItem(rec({ role: 'assistant', raw: claude('assistant', [{ type: 'thinking', thinking: '' }]) })), null);
  assert.equal(classifyItem(rec({ role: 'user', raw: '{broken' })), null);
});

test('review 2: Claude meta records are not prompts; a compact summary is compaction', () => {
  assert.equal(classifyItem(rec({ role: 'user', raw: JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'caveat text' } }) })), null);
  assert.deepEqual(classifyItem(rec({ role: 'user', raw: JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued' } }) })),
    { kind: 'compaction', text: 'This session is being continued', reasoning: null });
});

test('Codex: messages, tools, compaction and aborted turns; injected and bookkeeping kinds skipped', () => {
  const c = (o: Partial<StoredRecord>) => classifyItem(rec({ agent: 'codex', ...o }));
  assert.deepEqual(c({ role: 'user', content: 'run tests' }), { kind: 'prompt', text: 'run tests', reasoning: null });
  assert.deepEqual(c({ role: 'assistant', content: 'All green' }), { kind: 'response', text: 'All green', reasoning: null });
  assert.equal(c({ role: 'developer', content: 'instructions', injected: true }), null);
  assert.deepEqual(c({ kind: 'tool_call', content: 'exec_command npm test' }), { kind: 'tool-call', text: 'exec_command npm test', reasoning: null });
  assert.deepEqual(c({ kind: 'tool_result', content: 'ok' }), { kind: 'tool-result', text: 'ok', reasoning: null });
  assert.deepEqual(c({ kind: 'compaction', content: 'summary' }), { kind: 'compaction', text: 'summary', reasoning: null });
  assert.deepEqual(c({ kind: 'turn_aborted' }), { kind: 'interrupted', text: null, reasoning: null });
  for (const kind of ['token_usage', 'token_count', 'settings', 'turn_context', 'world_state', 'mirror', 'other', 'session', 'unknown']) assert.equal(c({ kind }), null, kind);
  assert.equal(c({ role: 'assistant', content: '' }), null);
});

test('agy: user, assistant, tool output; injected system skipped; unknown agents skipped', () => {
  const a = (o: Partial<StoredRecord>) => classifyItem(rec({ agent: 'agy', ...o }));
  assert.deepEqual(a({ kind: 'user', content: 'hi' }), { kind: 'prompt', text: 'hi', reasoning: null });
  assert.deepEqual(a({ kind: 'assistant', content: 'hello' }), { kind: 'response', text: 'hello', reasoning: null });
  assert.deepEqual(a({ kind: 'tool_output', content: 'out' }), { kind: 'tool-result', text: 'out', reasoning: null });
  assert.equal(a({ kind: 'system', content: 'sys', injected: true }), null);
  assert.equal(classifyItem(rec({ agent: 'mystery', role: 'user', content: 'x' })), null);
});

test('utf8Slice: byte bound, code points never split, always progresses, offsets checked', () => {
  assert.deepEqual(utf8Slice('abcdef', 0, 4), { text: 'abcd', next: 4 });
  assert.deepEqual(utf8Slice('abcdef', 4, 4), { text: 'ef', next: null });
  assert.deepEqual(utf8Slice('a€b', 0, 3), { text: 'a', next: 1 }); // € is 3 bytes
  assert.deepEqual(utf8Slice('a€b', 1, 4), { text: '€b', next: null });
  assert.deepEqual(utf8Slice('x😀y', 0, 4), { text: 'x', next: 1 }); // the emoji is 4 bytes and 2 code units
  assert.deepEqual(utf8Slice('x😀y', 0, 5), { text: 'x😀', next: 3 });
  assert.deepEqual(utf8Slice('€', 0, 2), { text: '€', next: null }); // progress guaranteed
  assert.deepEqual(utf8Slice('abc', 3, 4), { text: '', next: null });
  assert.equal(utf8Slice('x😀y', 2, 4), null); // inside a surrogate pair
  assert.equal(utf8Slice('abc', 4, 4), null);
  assert.equal(utf8Slice('abc', -1, 4), null);
  assert.equal(utf8Slice('abc', 1.5, 4), null);
  const big = 'é'.repeat(20_000); // 2 bytes each
  const s = utf8Slice(big, 0, 16 * 1024)!;
  assert.equal(Buffer.byteLength(s.text, 'utf8'), 16 * 1024);
  assert.equal(s.next, 8192);
});
