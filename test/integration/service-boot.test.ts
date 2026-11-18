// XAIBO-PROD-104 (P1-T06; T08 rescan on start, D-P1-09): the service boots for real: store in the data dir, login
// env, detection, profiles synced, one Claude adapter per Claude profile; a read-only store skips ingest; wake()
// reconciles; a second boot on the same data dir resumes from committed checkpoints without duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot, parseLagOf } from '../../src/service/boot.ts';
import { loadCatalog, type Catalog } from '../../src/service/catalog/validate.ts';
import { openStore } from '../../src/service/store/db.ts';
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

test('P5-T07 (review H3): boot finishes the file work a committed purge still owed', async () => {
  const s = setup();
  const pre = await openStore({ file: join(s.dataDir, 'xaibo.db'), backupDir: join(s.dataDir, 'backups') });
  const reg = '00000000-0000-4000-8000-0000000f0703';
  pre.db.prepare("INSERT INTO suppressions (agent, profile_id, native_session_id, reason, at, pending) VALUES ('claude', 'px', 'gone-session', 'manual', 1, ?)")
    .run(JSON.stringify([reg]));
  pre.db.close();
  // an interrupted chunk assembly of the purged session, left on disk by a crash right after the purge's COMMIT
  const key = { registration: reg, producer: 'fixture-producer', session: 'gone-session', item: 'cut', revision: 1 };
  const item = join(s.dataDir, 'content-chunks', reg, createHash('sha256').update(JSON.stringify([key.registration, key.producer, key.session, key.item, key.revision])).digest('hex'));
  mkdirSync(item, { recursive: true, mode: 0o700 });
  writeFileSync(join(item, 'key'), JSON.stringify(key), { mode: 0o600 });
  writeFileSync(join(item, '0.c'), 'interrupted', { mode: 0o600 });
  const svc = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000 });
  try {
    await svc.done;
    assert.equal(existsSync(item), false);
    assert.equal(count(svc.store.db, 'SELECT count(*) FROM suppressions WHERE pending IS NOT NULL'), 0);
  } finally {
    svc.stop();
  }
});

test('P2-T03: a Codex profile gets its own adapter and its rollouts are ingested', async () => {
  const s = setup();
  const dated = join(s.home, '.codex', 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  const codexFix = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0', 'simple-turn');
  cpSync(codexFix, dated, { recursive: true, filter: (f) => !f.endsWith('expected.json') });
  const svc = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000 });
  await svc.done;
  assert.equal(svc.adapters.length, 2);
  const db = svc.store.db;
  assert.equal(count(db, "SELECT count(*) FROM sessions WHERE agent = 'codex' AND native_session_id = '00000000-0000-4000-8000-0000000c0030'"), 1);
  assert.equal(count(db, "SELECT count(*) FROM events WHERE source = 'rollout'"), 15);
  svc.stop();
});

test('boot: store in the data dir, detection, the default Claude profile ingested', async () => {
  const s = setup();
  const svc = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000 });
  assert.equal(svc.store.readOnly, false);
  await svc.done;
  assert.deepEqual(svc.detections.map((d) => [d.agent, d.state]), [['claude', 'detected'], ['codex', 'not-detected'], ['agy', 'not-detected']]);
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

test('H3: a failed detection leaves an empty agent list, not "detecting" forever', async () => {
  const s = setup();
  const broken = { schemaVersion: 1, agents: null } as unknown as Catalog;
  const announced: unknown[] = [];
  const svc = await boot({ dataDir: s.dataDir, home: s.home, catalog: broken, intervalMs: 60_000, onAgents: (a) => announced.push(a) });
  await assert.rejects(svc.done);
  assert.deepEqual(svc.agents(), []);
  assert.deepEqual(announced, [[]]);
  svc.stop();
});

// XAIBO-PROD-427 (P4-T10c2): content-free metrics from the running service (deltaResyncs is added by the service entry).
test('P4-T10c2: metrics() reports WAL size, watch handles, cached status sessions and disk full as safe integers', async () => {
  const s = setup();
  const svc = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000 });
  try { // stopped even when an assertion fails, so open watchers never keep the test file alive
    await svc.done;
    const m = svc.metrics();
    assert.deepEqual(Object.keys(m).sort(), ['diskFull', 'parseLagMs', 'statusSessions', 'walBytes', 'watchHandles', 'writerQueueAgeMs']);
    for (const [k, v] of Object.entries(m)) assert.ok(Number.isSafeInteger(v) && v >= 0, k);
    assert.ok(m.walBytes > 0, 'ingest wrote to the WAL');
    assert.equal(m.diskFull, 0);
  } finally { svc.stop(); }
});

// Review M2/L3: parse lag counts only files written within the live window; a future or old mtime is no lag.
test('P4-T10c2 review: parseLagOf is commit time minus mtime, rounded, only within 10 min; otherwise null', () => {
  const t = 1_800_000_000_000;
  assert.equal(parseLagOf(t, t - 1500.4), 1500);
  assert.equal(parseLagOf(t, t), 0);
  assert.equal(parseLagOf(t, t + 5), null, 'a future mtime (clock skew) is not lag');
  assert.equal(parseLagOf(t, t - 10 * 60_000 - 1), null, 'an older file is history import');
  assert.equal(parseLagOf(t, 0), null);
});
