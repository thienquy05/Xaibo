// XAIBO-PROD-108 (P1-T10), EC-18: symlinked home and project dirs group under one realpath; a failing watch
// falls back to the polling scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { discover } from '../../src/service/adapters/claude/discover.ts';
import { claudeProfile, count, until } from '../helpers/claude-profile.ts';

const SID = '00000000-0000-4000-8000-000000001000';

test('symlinked root and project dir resolve to the same realpaths; ingest via either is one set of rows', async () => {
  const p = await claudeProfile(['usage-basic']);
  const elsewhere = join(p.tmp, 'elsewhere');
  mkdirSync(elsewhere);
  const proj = join(p.root, 'projects', '-tmp-xaibo-fixture-usage-basic');
  renameSync(proj, join(elsewhere, 'proj'));
  symlinkSync(join(elsewhere, 'proj'), proj);
  symlinkSync(p.root, join(p.tmp, 'claude-link'));
  const viaLink = await discover(join(p.tmp, 'claude-link'));
  const direct = await discover(p.root);
  assert.deepEqual(viaLink.map((f) => f.path), direct.map((f) => f.path));
  assert.equal(viaLink[0]!.path, realpathSync(join(elsewhere, 'proj', `${SID}.jsonl`)));
  for (const root of [p.root, join(p.tmp, 'claude-link')]) {
    const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root, intervalMs: 60_000 });
    await a.start();
    a.stop();
  }
  assert.equal(count(p.db, 'SELECT count(*) FROM source_files'), 1);
  assert.equal(count(p.db, 'SELECT count(*) FROM events'), 9);
});

test('a watch that errors falls back to the scan', async () => {
  const p = await claudeProfile(['usage-basic']);
  const failing = () => { throw new Error('EMFILE'); };
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 200, activeMs: Number.MAX_SAFE_INTEGER, watch: failing });
  await a.start();
  const base = count(p.db, 'SELECT count(*) FROM events');
  appendFileSync(join(p.root, 'projects', '-tmp-xaibo-fixture-usage-basic', `${SID}.jsonl`),
    JSON.stringify({ type: 'user', uuid: '00000000-0000-4000-8000-000000007799', sessionId: SID, message: { role: 'user', content: 'x' } }) + '\n');
  await until(() => count(p.db, 'SELECT count(*) FROM events') === base + 1, 1200);
  a.stop();
});
