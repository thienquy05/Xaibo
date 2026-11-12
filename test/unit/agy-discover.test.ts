// XAIBO-PROD-211 (P2-T11, SEC5): agy discovery lists only brain/<uuid>/.system_generated/logs/transcript_full.jsonl,
// from real conversation directories, when the transcript is a regular file inside the profile root. transcript.jsonl
// and chunk copies are never listed (D-P2-02 (1)); symlinks, FIFOs and escapes are never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover } from '../../src/service/adapters/agy/discover.ts';

const id = (n: number) => `00000000-0000-4000-8000-0000000a${String(n).padStart(4, '0')}`;
function root() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xagy-disc-')));
  const r = join(tmp, 'antigravity-cli');
  const logs = (conv: string, base = r) => { const d = join(base, 'brain', conv, '.system_generated', 'logs'); mkdirSync(d, { recursive: true }); return d; };
  return { tmp, r, logs };
}

test('only transcript_full.jsonl of a UUID conversation directory is listed, with the folder id as session', async () => {
  const { r, logs } = root();
  const d = logs(id(1));
  writeFileSync(join(d, 'transcript_full.jsonl'), '{}\n');
  writeFileSync(join(d, 'transcript.jsonl'), '{}\n');
  mkdirSync(join(d, 'chunks', 'transcript_full'), { recursive: true });
  writeFileSync(join(d, 'chunks', 'transcript_full', '00000001.jsonl'), '{}\n');
  logs(id(2)); // a conversation created at launch without a transcript
  writeFileSync(join(logs('not-a-uuid'), 'transcript_full.jsonl'), '{}\n');
  const files = await discover(r);
  assert.deepEqual(files, [{ path: join(d, 'transcript_full.jsonl'), kind: 'agy-transcript', sessionId: id(1), compressed: false }]);
});

test('SEC5: symlinked conversation dirs or transcripts, escapes and special files are never listed', async () => {
  const { tmp, r, logs } = root();
  const outside = join(tmp, 'outside');
  const od = logs(id(9), outside);
  writeFileSync(join(od, 'transcript_full.jsonl'), '{}\n');
  mkdirSync(join(r, 'brain'), { recursive: true });
  symlinkSync(join(outside, 'brain', id(9)), join(r, 'brain', id(3))); // conversation dir is a symlink
  symlinkSync(join(od, 'transcript_full.jsonl'), join(logs(id(4)), 'transcript_full.jsonl')); // transcript is a symlink
  mkdirSync(join(r, 'brain', id(5), '.system_generated'), { recursive: true });
  symlinkSync(od, join(r, 'brain', id(5), '.system_generated', 'logs')); // an intermediate dir escapes the root
  execFileSync('mkfifo', [join(logs(id(6)), 'transcript_full.jsonl')]); // FIFO
  mkdirSync(join(logs(id(7)), 'transcript_full.jsonl')); // directory
  assert.deepEqual(await discover(r), []);
});

test('a missing or unreadable root lists nothing', async () => {
  const { tmp } = root();
  assert.deepEqual(await discover(join(tmp, 'none')), []);
});
