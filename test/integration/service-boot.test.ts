// XAIBO-PROD-104 (P1-T06; T08 rescan on start, D-P1-09): the service boots for real: store in the data dir, login
// env, detection, profiles synced, one Claude adapter per Claude profile; a read-only store skips ingest; wake()
// reconciles; a second boot on the same data dir resumes from committed checkpoints without duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot } from '../../src/service/boot.ts';
import { loadCatalog, type Catalog } from '../../src/service/catalog/validate.ts';
import { count, FIXTURES, until } from '../helpers/claude-profile.ts';

const SESSION = '00000000-0000-4000-8000-000000001000';
// Known locations limited to the temp home, so no agent installed on this machine is ever probed.
const catalog: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((a) => ({ ...a, detection: { ...a.detection, locations: ['~/.local/bin'] } })) };

function setup() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xboot-')));
  const home = join(tmp, 'home');
  const project = join(home, '.claude', 'projects', '-tmp-xaibo-fixture-project');
  mkdirSync(project, { recursive: true });
  cpSync(join(FIXTURES, 'usage-basic'), project, { recursive: true, filter: (s) => !s.endsWith('expected.json') });
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "2.1.319 (Claude Code)"\n');
  chmodSync(join(bin, 'claude'), 0o755);
  return { tmp, home, dataDir: join(tmp, 'data'), transcript: join(project, `${SESSION}.jsonl`) };
}

test('boot: store in the data dir, detection, the default Claude profile ingested', async () => {
  const s = setup();
  const svc = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000 });
  assert.equal(svc.store.readOnly, false);
  await svc.done;
  assert.deepEqual(svc.detections.map((d) => [d.agent, d.state]), [['claude', 'detected'], ['codex', 'not-detected']]);
  assert.equal(svc.adapters.length, 1);
  const db = svc.store.db;
  assert.equal(count(db, "SELECT count(*) FROM profiles WHERE agent = 'claude' AND origin = 'default'"), 1);
  assert.equal(count(db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', SESSION), 1);
  assert.equal(count(db, 'SELECT count(*) FROM events'), 9);
  svc.stop();
  assert.equal(db.isOpen, false);
});

test('wake() reconciles at once; a second boot resumes without duplicates', async () => {
  const s = setup();
  const svc = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000 });
  await svc.done;
  appendFileSync(s.transcript, JSON.stringify({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000010f1',
    timestamp: '2026-01-01T00:02:00.000Z', cwd: '/tmp/xaibo-fixture/alpha', sessionId: SESSION, message: { role: 'user', content: 'more' } }) + '\n');
  await svc.wake(); // the scan starts the file's sync; the rows land when it commits
  await until(() => count(svc.store.db, 'SELECT count(*) FROM events') === 10, 2_000);
  svc.stop();

  const again = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000 });
  await again.done;
  assert.equal(count(again.store.db, 'SELECT count(*) FROM events'), 10);
  assert.equal(count(again.store.db, 'SELECT count(*) FROM profiles'), 1, 'profile id stable across boots');
  again.stop();
});

test('a read-only store (failed migration) is reported and nothing is ingested', async () => {
  const s = setup();
  mkdirSync(s.dataDir, { recursive: true });
  const pre = new DatabaseSync(join(s.dataDir, 'xaibo.db'));
  pre.exec('CREATE TABLE profiles (x)'); // makes migration 001 fail
  pre.close();
  const svc = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000 });
  assert.equal(svc.store.readOnly, true);
  assert.equal(svc.store.reason, 'migration-failed');
  await svc.done;
  assert.equal(svc.adapters.length, 0);
  assert.equal(count(svc.store.db, "SELECT count(*) FROM sqlite_master WHERE name = 'sessions'"), 0);
  svc.stop();
});
