// XAIBO-PROD-107 (P1-T09), EC-14: split on byte 0x0A before decoding; carry partial bytes across chunks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineSplitter } from '../../src/service/lines.ts';

test('a line split across chunks, including mid-code-point, comes out once and intact', () => {
  const bytes = Buffer.from('a😀é\nsecond\nthi', 'utf8');
  const s = new LineSplitter(100);
  const lines = [...bytes].flatMap((b) => s.push(Buffer.from([b])));
  assert.deepEqual(lines.map((l) => [l.bytes.toString('utf8'), l.offset]), [['a😀é', 100], ['second', 108]]);
  assert.equal(s.committedOffset, 115, 'checkpoint stops at the last complete newline');
  assert.equal(s.pendingBytes, 3);
});

test('several lines in one chunk, empty lines kept as empty, CR stripped', () => {
  const s = new LineSplitter();
  const lines = s.push(Buffer.from('x\r\n\ny\n'));
  assert.deepEqual(lines.map((l) => [l.bytes.toString(), l.offset]), [['x', 0], ['', 3], ['y', 4]]);
  assert.equal(s.committedOffset, 6);
  assert.equal(s.pendingBytes, 0);
});

// P1-T14 (XAIBO-PROD-112, EC-15, OQ-P1-06): a line above the cap is streamed as pieces, never held in memory.
test('pushPieces: a line above the cap streams as start/data/end; the checkpoint stays at its start', () => {
  const s = new LineSplitter(10, { maxLine: 8 });
  const pieces = [Buffer.from('ab\ncdefgh'), Buffer.from('ijklmn'), Buffer.from('opq\nrs\n')].flatMap((c) => s.pushPieces(c).map((p) => {
    if ('big' in p) return p.big === 'data' ? `data:${p.bytes}` : p.big === 'start' ? `start@${p.offset}` : `end@${p.offset}+${p.length}`;
    return `line@${p.offset}:${p.bytes}`;
  }));
  assert.deepEqual(pieces, ['line@10:ab', 'start@13', 'data:cdefgh', 'data:ijklmn', 'data:opq', 'end@13+15', 'line@29:rs']);
  assert.equal(s.committedOffset, 32);
  assert.equal(s.pendingBytes, 0);
});

test('pushPieces: during a big line the committed offset stays before it and nothing is buffered', () => {
  const s = new LineSplitter(0, { maxLine: 4 });
  s.pushPieces(Buffer.from('ok\n'));
  const p = s.pushPieces(Buffer.from('0123456789'));
  assert.deepEqual(p.map((x) => ('big' in x ? x.big : 'line')), ['start', 'data']);
  assert.equal(s.committedOffset, 3);
  assert.equal(s.pendingBytes, 0);
  const done = s.pushPieces(Buffer.from('\n'));
  assert.deepEqual(done.map((x) => ('big' in x ? x.big : 'line')), ['end']);
  assert.equal(s.committedOffset, 14);
});

test('a complete line above the cap in one chunk is streamed too; push() keeps its old contract without a cap', () => {
  const s = new LineSplitter(0, { maxLine: 4 });
  assert.deepEqual(s.pushPieces(Buffer.from('0123456\nab\n')).map((x) => ('big' in x ? x.big : `line:${x.bytes}`)), ['start', 'data', 'end', 'line:ab']);
  assert.deepEqual(new LineSplitter().push(Buffer.from('a'.repeat(1 << 16) + '\n')).map((l) => l.bytes.length), [1 << 16]);
});
