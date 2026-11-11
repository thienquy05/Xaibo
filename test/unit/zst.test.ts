// XAIBO-PROD-108 (P1-T10), EC-03: .jsonl.zst is stream-decompressed when the runtime has zstd, else marked
// compressed_not_imported with a coverage warning; the file is never modified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { claudeProfile, count } from '../helpers/claude-profile.ts';

async function compressedProfile() {
  const p = await claudeProfile(['usage-basic']);
  const plain = join(p.root, 'projects', '-tmp-xaibo-fixture-usage-basic', '00000000-0000-4000-8000-000000001000.jsonl');
  const zst = `${plain}.zst`;
  writeFileSync(zst, zstdCompressSync(readFileSync(plain)));
  rmSync(plain);
  const sum = () => createHash('sha256').update(readFileSync(zst)).digest('hex');
  return { ...p, zst, sum };
}

for (const zstd of [true, false]) {
  test(`zstd ${zstd ? 'available: imported' : 'missing: compressed_not_imported'}; file untouched`, async () => {
    const p = await compressedProfile();
    const before = p.sum();
    const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, zstd });
    await a.start();
    a.stop();
    assert.equal(count(p.db, 'SELECT count(*) FROM events'), zstd ? 9 : 0);
    assert.equal(count(p.db, 'SELECT count(*) FROM source_files WHERE status = ?', zstd ? 'ok' : 'compressed_not_imported'), 1);
    assert.equal(p.sum(), before);
  });
}
