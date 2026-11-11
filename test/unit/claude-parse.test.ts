// XAIBO-PROD-107 (P1-T09): Claude transcript parser on Claude 2.1.319 synthetic fixtures and inline lines.
// EC-04 drift, EC-08 clock skew, EC-14 partial/malformed lines, EC-16 paths; message.id collapse; injected content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collapseByMessageId, drift, durationMs, parseLine, type ClaudeRecord } from '../../src/service/adapters/claude/parse.ts';
import { LineSplitter } from '../../src/service/lines.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'claude', '2.1.319');
const ctx = { fileMtime: 5, receivedTs: 7 };

function parseFile(rel: string, extra: { subagentNativeId?: string } = {}) {
  const s = new LineSplitter();
  const records: ClaudeRecord[] = [];
  const malformed: number[] = [];
  for (const line of s.push(readFileSync(join(FIX, rel)))) {
    const r = parseLine(line.bytes, { ...ctx, ...extra, offset: line.offset });
    if (r === null) continue;
    if (r.ok) records.push(r.record);
    else malformed.push(line.offset);
  }
  return { records, malformed, pending: s.pendingBytes };
}

const SID = '00000000-0000-4000-8000-000000009999';
const line = (o: Record<string, unknown>) => Buffer.from(JSON.stringify({ sessionId: SID, ...o }));

test('simple turn: identifiers, roles, content, entrypoint, cwd and sequence', () => {
  const { records, malformed } = parseFile('usage-basic/00000000-0000-4000-8000-000000001000.jsonl');
  assert.deepEqual(malformed, []);
  assert.equal(records.length, 9);
  const user = records.find((r) => r.type === 'user')!;
  assert.equal(user.kind, 'message');
  assert.equal(user.role, 'user');
  assert.equal(user.content, 'fixture prompt');
  assert.equal(user.injected, false);
  assert.equal(user.sessionId, '00000000-0000-4000-8000-000000001000');
  assert.equal(user.nativeId, '00000000-0000-4000-8000-000000001001');
  assert.equal(user.parentNativeId, undefined);
  assert.equal(user.cwd, '/tmp/xaibo-fixture/alpha');
  assert.equal(user.entrypoint, 'sdk-cli');
  assert.equal(user.sourceTs, Date.parse('2026-01-01T00:00:01.000Z'));
  const seqs = records.map((r) => r.sourceSeq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  const assistant = records.find((r) => r.type === 'assistant')!;
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.messageId, 'msg_fixture_0001');
  assert.equal(assistant.model, 'claude-opus-5-5');
  assert.ok(assistant.raw.startsWith('{'));
});

test('partial updates of one message.id collapse to the latest line', () => {
  const { records } = parseFile('usage-basic/00000000-0000-4000-8000-000000001000.jsonl');
  const byId = collapseByMessageId(records);
  assert.deepEqual([...byId.keys()], ['msg_fixture_0001', 'msg_fixture_0002']);
  assert.equal(byId.get('msg_fixture_0001')!.nativeId, '00000000-0000-4000-8000-000000001004');
});

test('records without a uuid get a stable content key, independent of their offset', () => {
  const raw = line({ type: 'queue-operation', operation: 'enqueue', content: 'x' });
  const a = parseLine(raw, { ...ctx, offset: 0 });
  const b = parseLine(raw, { ...ctx, offset: 900 });
  assert.ok(a?.ok && b?.ok);
  assert.match(a.record.nativeId, /^h:[0-9a-f]{16}$/);
  assert.equal(a.record.nativeId, b.record.nativeId);
});

test('EC-04: unknown types are stored raw and counted; drift above 5% only', () => {
  const above = parseFile('unknown-records/00000000-0000-4000-8000-000000003000.jsonl').records;
  const below = parseFile('unknown-records/00000000-0000-4000-8000-000000003100.jsonl').records;
  const unknown = (rs: ClaudeRecord[]) => rs.filter((r) => r.kind === 'unknown');
  assert.equal(unknown(above).length, 1);
  assert.equal(unknown(above)[0]!.type, 'fixture-unknown-type');
  assert.ok(unknown(above)[0]!.raw.includes('fixture-unknown-type'));
  assert.equal(drift(above.length, unknown(above).length), true);
  assert.equal(drift(below.length, unknown(below).length), false);
  assert.equal(drift(20, 1), false, 'exactly 5% is not drift');
  assert.equal(drift(0, 0), false);
});

test('EC-08: file order wins over timestamps; all three timestamps kept; bad durations are null', () => {
  const stamps = ['2026-01-01T00:00:03.000Z', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'];
  const recs = stamps.map((t, i) => {
    const r = parseLine(line({ type: 'user', uuid: `00000000-0000-4000-8000-00000000990${i}`, timestamp: t, message: { role: 'user', content: 'p' } }), { ...ctx, offset: i * 100 });
    assert.ok(r?.ok);
    return r.record;
  }).sort((a, b) => a.sourceSeq - b.sourceSeq);
  assert.deepEqual(recs.map((r) => r.sourceTs), stamps.map((t) => Date.parse(t)));
  assert.ok(recs.every((r) => r.fileMtime === 5 && r.receivedTs === 7));
  assert.equal(durationMs(recs[0]!.sourceTs, recs[1]!.sourceTs), null, 'negative');
  assert.equal(durationMs(recs[1]!.sourceTs, recs[2]!.sourceTs), 1000);
  assert.equal(durationMs(undefined, 5), null);
  const noTs = parseLine(line({ type: 'user', uuid: '00000000-0000-4000-8000-000000009910', timestamp: 'not a date' }), { ...ctx, offset: 0 });
  assert.ok(noTs?.ok);
  assert.equal(noTs.record.sourceTs, undefined);
});

test('EC-14: a malformed complete line is reported; a trailing partial line stays pending', () => {
  const { records, malformed, pending } = parseFile('partial-line/00000000-0000-4000-8000-000000004000.jsonl');
  assert.equal(records.length, 3);
  assert.equal(malformed.length, 1);
  assert.ok(pending > 0);
  assert.equal(parseLine(Buffer.from('[1,2]'), { ...ctx, offset: 0 })?.ok, false, 'not an object');
  assert.equal(parseLine(Buffer.from(''), { ...ctx, offset: 0 }), null, 'blank line ignored');
});

test('EC-16: cwd comes only from records and keeps Unicode, spaces and length', () => {
  const cwd = `/tmp/xaibo-fixture/café ${'long-segment-'.repeat(20)}`;
  const r = parseLine(line({ type: 'user', uuid: '00000000-0000-4000-8000-000000009920', cwd }), { ...ctx, offset: 0 });
  assert.ok(r?.ok);
  assert.equal(r.record.cwd, cwd);
  const none = parseLine(line({ type: 'mode', mode: 'default' }), { ...ctx, offset: 0 });
  assert.ok(none?.ok);
  assert.equal(none.record.cwd, undefined);
});

test('injected content is flagged and never a prompt', () => {
  for (const content of ['<command-name>/clear</command-name>', [{ type: 'text', text: '<local-command-stdout>ok</local-command-stdout>' }]]) {
    const r = parseLine(line({ type: 'user', uuid: '00000000-0000-4000-8000-000000009930', message: { role: 'user', content } }), { ...ctx, offset: 0 });
    assert.ok(r?.ok);
    assert.equal(r.record.injected, true);
  }
});

test('content from text, tool_use, tool_result and thinking blocks', () => {
  const r = parseLine(line({ type: 'assistant', uuid: '00000000-0000-4000-8000-000000009940', message: { role: 'assistant', id: 'm', content: [
    { type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
    { type: 'tool_result', content: [{ type: 'text', text: 'file body' }] },
  ] } }), { ...ctx, offset: 0 });
  assert.ok(r?.ok);
  assert.equal(r.record.content, 'hmm\nhello\nRead {"file_path":"a.ts"}\nfile body');
});

test('subagent records carry the subagent id and sidechain flag', () => {
  const { records } = parseFile('identifiers/00000000-0000-4000-8000-000000002000/subagents/agent-00000000-0000-4000-8000-000000002100.jsonl',
    { subagentNativeId: '00000000-0000-4000-8000-000000002100' });
  assert.ok(records.every((r) => r.isSidechain && r.subagentNativeId === '00000000-0000-4000-8000-000000002100'));
  assert.ok(records.every((r) => r.sessionId === '00000000-0000-4000-8000-000000002000'));
});
