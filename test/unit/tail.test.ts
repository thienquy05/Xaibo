// XAIBO-PROD-108 (P1-T10), EC-13: truncation, rotation and same-size replacement force a reparse from 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headHash, startOffset, type Checkpoint } from '../../src/service/tail.ts';

async function setup() {
  const f = join(mkdtempSync(join(tmpdir(), 'xtail-')), 't.jsonl');
  writeFileSync(f, 'a\nb\n');
  const st = statSync(f);
  const cp: Checkpoint = { dev: st.dev, ino: st.ino, size: st.size, mtime: st.mtimeMs, offset: 4, headHash: await headHash(f, 4) };
  return { f, cp };
}

test('append continues from the checkpoint', async () => {
  const { f, cp } = await setup();
  appendFileSync(f, 'c\n');
  assert.deepEqual(await startOffset(f, statSync(f), cp), { offset: 4, reset: false });
});

test('no checkpoint starts at 0 without a reset', async () => {
  const { f } = await setup();
  assert.deepEqual(await startOffset(f, statSync(f), undefined), { offset: 0, reset: false });
});

test('truncated below the offset resets', async () => {
  const { f, cp } = await setup();
  writeFileSync(f, 'a\n');
  assert.deepEqual(await startOffset(f, statSync(f), cp), { offset: 0, reset: true });
});

test('rotated (new inode) resets', async () => {
  const { f, cp } = await setup();
  renameSync(f, `${f}.1`);
  writeFileSync(f, 'a\nb\nc\n');
  assert.deepEqual(await startOffset(f, statSync(f), cp), { offset: 0, reset: true });
});

test('replaced in place with the same size but a different head resets', async () => {
  const { f, cp } = await setup();
  writeFileSync(f, 'x\ny\n');
  assert.equal(statSync(f).ino, cp.ino);
  assert.deepEqual(await startOffset(f, statSync(f), cp), { offset: 0, reset: true });
});
