// XAIBO-PROD-112 (P1-T14, EC-15, FR-08, OQ-P1-06): a record above the parse cap is read as a stream. Its readable fields
// become content chunks (bounded UTF-8 bytes, never a split code point), its raw bytes raw chunks, plus a head row with
// the small fields; a syntax error leaves a gap only for the rest; ids are deterministic for any input chunking (the key hashes the line's first 4 KiB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OversizedRecord } from '../../src/service/adapters/claude/oversized.ts';
import type { ClaudeRecord } from '../../src/service/adapters/claude/parse.ts';

const ctx = { offset: 1000, fileMtime: 5, receivedTs: 6 };
function run(line: string, step: number, o: { contentBytes?: number; rawBytes?: number } = {}) {
  const r = new OversizedRecord({ ...ctx, contentBytes: o.contentBytes ?? 8, rawBytes: o.rawBytes ?? 32 });
  const bytes = Buffer.from(line, 'utf8');
  const records: ClaudeRecord[] = [];
  for (let i = 0; i < bytes.length; i += step) records.push(...r.feed(bytes.subarray(i, i + step)));
  const end = r.end();
  records.push(...end.records);
  return { records, unreadable: end.unreadable, chunks: records.filter((x) => x.kind === 'content-chunk'), raws: records.filter((x) => x.kind === 'raw-chunk'), head: records.at(-1)! };
}

const LINE = '{"parentUuid":"P0","isSidechain":false,"type":"user","uuid":"U1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/xaibo-fixture/a",'
  + '"sessionId":"S1","message":{"role":"user","content":[{"type":"text","text":"caf\\u00e9 \\ud83d\\ude00 \\"q\\" line\\nnext"},'
  + '{"type":"tool_use","name":"Bash","input":{"command":"ls -la","opts":{"cwd":"x"},"n":3}},{"type":"tool_result","content":"out put"},'
  + '{"type":"tool_result","content":[{"type":"text","text":"nested"}]},{"type":"thinking","thinking":"hmm"}]},"extra":{"big":"not readable"},"n":[1,2.5e3,true,null]}';
const TEXT = 'café \u{1F600} "q" line\nnext\nls -la\nx\nout put\nnested\nhmm';

test('readable fields across tiny input pieces: escapes and surrogate pairs intact, chunks bounded', () => {
  for (const step of [1, 3, 5, 64, 10_000]) {
    const r = run(LINE, step);
    assert.equal(r.unreadable, false);
    assert.equal(r.chunks.map((c) => c.content).join(''), TEXT, `step ${step}`);
    for (const c of r.chunks) {
      assert.ok(Buffer.byteLength(c.content!, 'utf8') <= 8, 'bounded UTF-8 bytes');
      assert.ok(!c.content!.includes('�'), 'no split code point');
      assert.equal(c.parentNativeId, r.head.ingestId, 'chunks link to their head by the content key');
    }
    assert.equal(r.raws.map((c) => c.raw).join(''), LINE, 'raw bytes kept in full');
    for (const c of r.raws) assert.ok(Buffer.byteLength(c.raw, 'utf8') <= 32);
  }
});

test('head row: small fields, kind, no content of its own; the same ids for any chunking', () => {
  const a = run(LINE, 3);
  const b = run(LINE, 4096);
  assert.deepEqual(a.records.map((r) => r.nativeId), b.records.map((r) => r.nativeId));
  assert.equal(new Set(a.records.map((r) => r.nativeId)).size, a.records.length);
  const h = a.head;
  assert.deepEqual({ nativeId: h.nativeId, kind: h.kind, type: h.type, parent: h.parentNativeId, session: h.sessionId, cwd: h.cwd, role: h.role, ts: h.sourceTs, injected: h.injected, side: h.isSidechain, content: h.content },
    { nativeId: 'U1', kind: 'message', type: 'user', parent: 'P0', session: 'S1', cwd: '/tmp/xaibo-fixture/a', role: 'user', ts: Date.parse('2026-01-01T00:00:00.000Z'), injected: false, side: false, content: undefined });
  for (const r of a.records) assert.ok(r.sourceSeq >= ctx.offset);
});

test('chunk keys come from the first 4 KiB of the line, so a uuid after the content changes nothing', () => {
  const r = run('{"type":"assistant","message":{"role":"assistant","content":"' + 'z'.repeat(40) + '"},"uuid":"U2"}', 7);
  assert.equal(r.head.nativeId, 'U2');
  assert.match(r.chunks[0]!.parentNativeId!, /^x:[0-9a-f]{16}$/);
  assert.equal(r.head.ingestId, r.chunks[0]!.parentNativeId);
  assert.equal(r.chunks.map((c) => c.content).join(''), 'z'.repeat(40));
});

test('S9 large-payload fields and top-level content are readable; other strings and long small fields are not', () => {
  const r = run(JSON.stringify({ type: 'attachment', uuid: 'U3', cwd: 'c'.repeat(5000), attachment: { content: 'att' }, rendered: [{ content: 'ren' }],
    shape: { system: [{ text: 'sys' }] }, content: 'top', other: 'skip me' }), 9);
  assert.equal(r.chunks.map((c) => c.content).join(''), 'att\nren\nsys\ntop');
  assert.equal(r.head.cwd, undefined, 'small fields above 4 KiB are dropped');
  assert.equal(r.head.kind, 'attachment');
});

test('injected content is flagged on the head', () => {
  assert.equal(run('{"type":"user","uuid":"U4","message":{"role":"user","content":"<command-name>/x</command-name> rest"}}', 4).head.injected, true);
});

test('a syntax error leaves a gap: content read before it is kept, raw is kept in full', () => {
  const bad = '{"type":"user","uuid":"U5","message":{"role":"user","content":"good part"}, oops "more":"lost"}';
  const r = run(bad, 6);
  assert.equal(r.unreadable, true);
  assert.equal(r.chunks.map((c) => c.content).join(''), 'good part');
  assert.equal(r.raws.map((c) => c.raw).join(''), bad);
  assert.equal(r.head.nativeId, 'U5');
  assert.equal(run('{"type":"user","uuid":"U6","message":{"content":"cut', 6).unreadable, true, 'a record that never closes');
});

test('two oversized records with the same first 4 KiB at different offsets keep separate ids', () => {
  const line = '{"type":"user","message":{"role":"user","content":"' + 'q'.repeat(5000) + '"},"uuid":"U7"}';
  const at = (offset: number) => {
    const r = new OversizedRecord({ ...ctx, offset, contentBytes: 1024 });
    return [...r.feed(Buffer.from(line)), ...r.end().records].map((x) => x.nativeId);
  };
  const a = at(0);
  const b = at(10_000);
  assert.equal(a.filter((id) => b.includes(id) && id !== 'U7').length, 0);
});

test('H2: an escaped surrogate pair at a chunk boundary stays whole', () => {
  for (const pad of ['aaaaa', 'aaaa', 'aaaaaa', 'a'.repeat(7)]) {
    const r = run(`{"type":"user","uuid":"U8","message":{"role":"user","content":"${pad}\\uD83D\\uDE00z"}}`, 3);
    const text = r.chunks.map((c) => c.content).join('');
    assert.equal(text, `${pad}\u{1F600}z`, pad);
    for (const c of r.chunks) assert.ok(!c.content!.includes('�') && !/[\uD800-\uDBFF]$/.test(c.content!) && !/^[\uDC00-\uDFFF]/.test(c.content!), pad);
  }
});

test('H2: the source option namespaces chunk ids', () => {
  const line = '{"type":"user","message":{"role":"user","content":"' + 'q'.repeat(3000) + '"}}';
  const ids = (source: string) => { const r = new OversizedRecord({ ...ctx, source, contentBytes: 1024 }); return [...r.feed(Buffer.from(line)), ...r.end().records].map((x) => x.nativeId); };
  const a = ids('file-a');
  assert.equal(a.filter((id) => ids('file-b').includes(id)).length, 0);
  assert.deepEqual(ids('file-a'), a, 'still deterministic');
});

test('H6: a lone escaped high surrogate followed by another character never exceeds the chunk bound', () => {
  for (const pad of ['aaaaa', 'aaaa', 'aaaaaa', 'a'.repeat(7)]) {
    const r = run(`{"type":"user","uuid":"U9","message":{"role":"user","content":"${pad}\\uD800éz"}}`, 3);
    for (const c of r.chunks) assert.ok(Buffer.byteLength(c.content!) <= 8, `${pad}: ${Buffer.byteLength(c.content!)} bytes`);
    assert.ok(r.chunks.map((c) => c.content).join('').endsWith('éz'), pad);
  }
  // Codex N1 at the default 64 KiB bound
  const big = new OversizedRecord({ ...ctx, contentBytes: 64 * 1024 });
  const recs = [...big.feed(Buffer.from(`{"type":"user","message":{"role":"user","content":"${'a'.repeat(65532)}\\ud800é"}}`)), ...big.end().records];
  const chunks = recs.filter((x) => x.kind === 'content-chunk');
  for (const c of chunks) assert.ok(Buffer.byteLength(c.content!) <= 64 * 1024);
  assert.ok(chunks.at(-1)!.content!.endsWith('é'));
});
