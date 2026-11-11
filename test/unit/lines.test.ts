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
