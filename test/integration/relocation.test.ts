// XAIBO-PROD-205 (P2-T05, EC-06, PRD §5.5): identity is (agent, profile, native_session_id), never path or cwd. A Claude
// session continuing under a second encoded-cwd directory and a Codex session whose cwd changes each stay one session,
// with one cwd_history row per distinct cwd (first_seen = its earliest record).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { claudeProfile, count } from '../helpers/claude-profile.ts';

const history = (db: DatabaseSync) => db.prepare('SELECT cwd, cwd_key AS key, source, first_seen AS seen FROM cwd_history ORDER BY first_seen')
  .all().map((r) => ({ ...r }));

test('EC-06: a Claude session under a second encoded-cwd dir is one session with a two-entry cwd history', async () => {
  const p = await claudeProfile(['usage-basic']);
  const sid = '00000000-0000-4000-8000-000000001000';
  const moved = join(p.root, 'projects', '-tmp-xaibo-fixture-beta');
  mkdirSync(moved, { recursive: true });
  writeFileSync(join(moved, `${sid}.jsonl`), JSON.stringify({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-000000001100',
    timestamp: '2026-01-01T00:01:00.000Z', cwd: '/tmp/xaibo-fixture/beta', sessionId: sid, entrypoint: 'cli', message: { role: 'user', content: 'x' } }) + '\n');
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start();
  a.stop();
  assert.equal(count(p.db, 'SELECT count(*) FROM sessions'), 1);
  assert.deepEqual(history(p.db), [
    { cwd: '/tmp/xaibo-fixture/alpha', key: '/tmp/xaibo-fixture/alpha', source: 'transcript', seen: Date.parse('2026-01-01T00:00:01.000Z') },
    { cwd: '/tmp/xaibo-fixture/beta', key: '/tmp/xaibo-fixture/beta', source: 'transcript', seen: Date.parse('2026-01-01T00:01:00.000Z') },
  ]);
});

test('EC-06: a Codex cwd change (turn_context) is one session with a two-entry cwd history', async () => {
  const fix = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0', 'simple-turn');
  const name = readdirSync(fix).find((f) => f.startsWith('rollout-'))!;
  const lines = readFileSync(join(fix, name), 'utf8').split('\n').map((l) => (l.includes('"type":"turn_context"') ? l.replace('/tmp/xaibo-fixture/alpha', '/tmp/xaibo-fixture/beta') : l));
  const tmp = mkdtempSync(join(tmpdir(), 'xreloc-'));
  const root = join(tmp, 'codex');
  const dated = join(root, 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  writeFileSync(join(dated, name), lines.join('\n'));
  const { db } = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'codex', ?, 'default')").run(root);
  const a = new CodexAdapter({ db, writer: new Writer(db), profileId: 'p1', root, intervalMs: 60_000 });
  await a.start();
  a.stop();
  assert.equal(count(db, 'SELECT count(*) FROM sessions'), 1);
  assert.deepEqual(history(db), [
    { cwd: '/tmp/xaibo-fixture/alpha', key: '/tmp/xaibo-fixture/alpha', source: 'rollout', seen: Date.parse('2026-01-01T00:00:00.000Z') },
    { cwd: '/tmp/xaibo-fixture/beta', key: '/tmp/xaibo-fixture/beta', source: 'rollout', seen: Date.parse('2026-01-01T00:00:01.000Z') },
  ]);
});
