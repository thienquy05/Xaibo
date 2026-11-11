// XAIBO-PROD-105 (P1-T07): the FTS prefix is at most 64 KiB and never splits a UTF-8 sequence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ftsPrefix } from '../../src/service/store/writer.ts';

test('short text is unchanged', () => assert.equal(ftsPrefix('héllo'), 'héllo'));

test('cuts at a code-point boundary for 1- to 4-byte characters', () => {
  for (const ch of ['a', 'é', '€', '😀']) {
    for (let pad = 0; pad < 4; pad++) {
      const s = 'x'.repeat(pad) + ch.repeat(20);
      const out = ftsPrefix(s, 10);
      assert.ok(Buffer.byteLength(out) <= 10, `${ch}/${pad}`);
      assert.ok(s.startsWith(out), `${ch}/${pad}: not a prefix`);
      assert.ok(!out.includes('�'));
      assert.ok(Buffer.byteLength(out) > 10 - Buffer.byteLength(ch), `${ch}/${pad}: cut too early`);
    }
  }
});

test('default bound is 64 KiB', () => {
  assert.equal(Buffer.byteLength(ftsPrefix('a'.repeat(70_000))), 65_536);
});
