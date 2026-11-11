// P2-T13 (EC-54, OQ-P2-04 default: no state-DB enrichment): rollout ingest never opens, changes or copies Codex state
// DBs or session_index.jsonl, even with one DB exclusively locked and another holding a garbage schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { count } from '../helpers/claude-profile.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0', 'simple-turn');
const NATIVE = ['state_5.sqlite', 'thread_history_3.sqlite', 'session_index.jsonl'];
const fingerprint = (dir: string) => Object.fromEntries(NATIVE.map((f) => {
  const p = join(dir, f);
  return [f, `${createHash('sha256').update(readFileSync(p)).digest('hex')}:${statSync(p).mtimeMs}`];
}));
/** Any file under the data dir whose bytes equal a native state file: a copy. */
const copies = (dataDir: string, nativeDir: string) => {
  const native = new Set(NATIVE.map((f) => createHash('sha256').update(readFileSync(join(nativeDir, f))).digest('hex')));
  return readdirSync(dataDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .filter((e) => native.has(createHash('sha256').update(readFileSync(join(e.parentPath, e.name))).digest('hex'))).length;
};

test('EC-54: a locked state DB and a garbage-schema DB never stop rollout ingest and are never opened, changed or copied', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xcodex-db-'));
  const root = join(tmp, 'codex');
  const dated = join(root, 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  const rollout = readdirSync(FIX).find((f) => f.startsWith('rollout-'))!;
  copyFileSync(join(FIX, rollout), join(dated, rollout));
  const state = new DatabaseSync(join(root, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT); INSERT INTO threads VALUES (\'synthetic\', \'synthetic title\')');
  state.exec('BEGIN EXCLUSIVE'); // held for the whole ingest
  writeFileSync(join(root, 'thread_history_3.sqlite'), 'not a database, synthetic garbage');
  writeFileSync(join(root, 'session_index.jsonl'), '{"id":"00000000-0000-4000-8000-0000000c0030","thread_name":"synthetic","updated_at":"2026-01-01T00:00:00.000Z"}\n');
  const before = fingerprint(root);

  const dataDir = join(tmp, 'data');
  const { db } = await openStore({ file: join(dataDir, 'xaibo.db'), backupDir: join(dataDir, 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'codex', ?, 'default')").run(root);
  const a = new CodexAdapter({ db, writer: new Writer(db), profileId: 'p1', root, intervalMs: 60_000 });
  await a.start();
  a.stop();

  assert.equal(count(db, 'SELECT count(*) FROM events'), readFileSync(join(FIX, rollout), 'utf8').split('\n').filter(Boolean).length, 'rollout ingest completed');
  assert.deepEqual(fingerprint(root), before, 'state files unchanged (content and mtime)');
  assert.equal(count(db, "SELECT count(*) FROM source_files WHERE path LIKE '%.sqlite' OR path LIKE '%session_index%'"), 0, 'never discovered');
  assert.equal(copies(dataDir, root), 0, 'no copy under the data dir');
  state.exec('ROLLBACK');
  state.close();

  copyFileSync(join(root, 'thread_history_3.sqlite'), join(dataDir, 'planted-copy')); // positive control for the copy check
  assert.equal(copies(dataDir, root), 1, 'the copy check detects a copy');
});
