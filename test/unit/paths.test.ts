// XAIBO-PROD-107 (P1-T09), EC-16: originals kept; comparison key = realpath + NFC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cwdKey } from '../../src/service/paths.ts';

const identity = (p: string) => p;

test('NFC and NFD spellings compare equal; the original string is untouched', () => {
  const nfd = '/tmp/xaibo-fixture/café project';
  const nfc = '/tmp/xaibo-fixture/café project';
  assert.notEqual(nfd, nfc);
  assert.equal(cwdKey(nfd, identity), cwdKey(nfc, identity));
  assert.equal(nfd, '/tmp/xaibo-fixture/café project');
});

test('symlinked dirs share a key; a missing path keys to itself', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'xpaths-')));
  mkdirSync(join(dir, 'real'));
  symlinkSync(join(dir, 'real'), join(dir, 'link'));
  assert.equal(cwdKey(join(dir, 'link')), cwdKey(join(dir, 'real')));
  assert.equal(cwdKey('/tmp/xaibo-fixture/does-not-exist'), '/tmp/xaibo-fixture/does-not-exist');
});
