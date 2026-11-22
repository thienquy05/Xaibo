// XAIBO-PROD-104 (P1-T06; T08 rescan on start, D-P1-09): the service boots for real: store in the data dir, login
// env, detection, profiles synced, one Claude adapter per Claude profile; a read-only store skips ingest; wake()
// reconciles; a second boot on the same data dir resumes from committed checkpoints without duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot, parseLagOf } from '../../src/service/boot.ts';
import { loadCatalog, type Catalog } from '../../src/service/catalog/validate.ts';
import { openStore } from '../../src/service/store/db.ts';
import { suppressedPage } from '../../src/service/history/tools.ts';
import { loadInstallSecret } from '../../src/shared/log.ts';
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

test('XAIBO-PROD-526 (review M1/L2): clearUsage runs through the worker; overlapping calls share one run; a stop before it applies gives failed and writes nothing', async () => {
  const settled = (dataDir: string) => {
    const d = new DatabaseSync(join(dataDir, 'xaibo.db'), { readOnly: true });
    try { return d.prepare('SELECT count(*) AS n, sum(cleared = 0) AS open FROM settled_contributions').get() as { n: number; open: number | null }; } finally { d.close(); }
  };
  const s = setup();
  const svc = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000 });
  try {
    await svc.done;
    assert.ok(count(svc.store.db, "SELECT count(*) FROM usage WHERE scope = 'message'") > 0, 'the fixture has usage');
    const a = svc.clearUsage(), b = svc.clearUsage();
    assert.equal(a, b, 'one run for both');
    assert.equal(await a, 'cleared');
  } finally {
    svc.stop();
  }
  const done = settled(s.dataDir);
  assert.ok(done.n > 0);
  assert.equal(done.open, 0, 'every marker cleared');

  const t = setup();
  const other = await boot({ dataDir: t.dataDir, home: t.home, catalog, intervalMs: 60_000 });
  await other.done;
  const p = other.clearUsage();
  other.stop(); // while the worker scans
  assert.equal(await p, 'failed');
  assert.equal(settled(t.dataDir).n, 0, 'nothing written');
});

test('XAIBO-PROD-527 (review H2/M1): manual purge, then Re-import by key through the service: the session comes back from its native file, with Keep', async () => {
  const s = setup();
  const svc = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000 });
  try {
    await svc.done;
    const db = svc.store.db;
    const id = (db.prepare('SELECT id FROM sessions WHERE native_session_id = ?').get(SESSION) as { id: number }).id;
    assert.equal(await svc.purge(id), 'purged');
    assert.equal(count(db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', SESSION), 0);
    const { rows } = suppressedPage(db, loadInstallSecret(s.dataDir), s.home, null, 10);
    assert.equal(rows.length, 1);
    assert.equal(svc.reimport(rows[0]!.key), 'ok');
    await until(() => count(db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', SESSION) === 1, 10_000); // no restart needed
    assert.equal(count(db, 'SELECT keep FROM overlays WHERE native_session_id = ?', SESSION), 1, 'kept (D-P5-08)');
  } finally {
    svc.stop();
  }
});

test('P5-T09: boot runs retention after the backfill (review H1); a session past 45 days is purged and stays out', async () => {
  const s = setup();
  let removed = 0; // G5b2-2: a run that removed anything tells the service entry (renderer resync, ledger invalidate)
  const svc = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000, retentionDelayMs: 0, onRemoved: () => { removed++; } });
  try {
    await svc.done;
    const db = svc.store.db;
    // the fixture's last activity is January 2026, but its file was copied just now: a native file changed since the
    // cutoff (the session may have continued while Xaibo was off) keeps it in the deferred run
    await until(() => count(db, "SELECT count(*) FROM kv WHERE key = 'retention.lastRunAt'") === 1, 5_000);
    assert.equal(count(db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', SESSION), 1, 'file changed since the cutoff: kept');
    assert.equal(removed, 0, 'a run that removed nothing sends nothing');
    utimesSync(s.transcript, new Date(Date.UTC(2026, 0, 2)), new Date(Date.UTC(2026, 0, 2)));
    await svc.retention();
    assert.equal(count(db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', SESSION), 0);
    assert.equal(removed, 1, 'the run that purged it tells the service entry once');
    assert.equal(count(db, "SELECT count(*) FROM suppressions WHERE native_session_id = ? AND reason = 'retention'", SESSION), 1);
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

test('review M (code): boot resumes an interrupted purge off readiness; ingest does not wait for its row batches', async () => {
  const s = setup();
  const pre = await openStore({ file: join(s.dataDir, 'xaibo.db'), backupDir: join(s.dataDir, 'backups') });
  pre.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('px', 'claude', '/tmp/xaibo-fixture/px', 'manual')").run();
  const big = Number(pre.db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id) VALUES ('claude', 'px', 'big-purge')").run().lastInsertRowid);
  pre.db.exec('BEGIN');
  const put = pre.db.prepare("INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, source_seq, received_ts) VALUES (?, 1, 'transcript', 'confirmed', ?, 'user', ?, 1)");
  for (let i = 0; i < 20_000; i++) put.run(big, `e-${i}`, i);
  pre.db.exec('COMMIT');
  pre.db.prepare("INSERT INTO suppressions (agent, profile_id, native_session_id, reason, at, pending, purge_phase) VALUES ('claude', 'px', 'big-purge', 'manual', 1, '[]', 'rows')").run();
  pre.db.close();
  let left: number | undefined; // by identity: the purged session's rowid is free for the next session
  const BIG_EVENTS = "SELECT count(*) FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.native_session_id = 'big-purge'";
  const svc = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000,
    onCommit: (b) => { if (left === undefined && b.sessions.some((x) => x.nativeSessionId === SESSION)) left = count(svc.store.db, BIG_EVENTS); } });
  try {
    await svc.done;
    assert.ok(left !== undefined && left > 0, `the fixture session was ingested while the resumed purge still had rows (${left})`);
    await until(() => count(svc.store.db, "SELECT count(*) FROM suppressions WHERE native_session_id = 'big-purge' AND purge_phase IS NULL AND pending IS NULL") === 1, 10_000);
    assert.equal(count(svc.store.db, "SELECT count(*) FROM sessions WHERE native_session_id = 'big-purge'"), 0);
  } finally {
    svc.stop();
  }
});

test('review M (code): stopping the service during a manual purge ends it between batches; the next boot finishes it', async () => {
  const s = setup();
  const events: string[] = [];
  const log = { log: (e: string) => { events.push(e); } };
  const svc = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000, log });
  await svc.done;
  const db = svc.store.db;
  const id = count(db, 'SELECT id FROM sessions WHERE native_session_id = ?', SESSION);
  db.exec('BEGIN');
  const put = db.prepare("INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, source_seq, received_ts) VALUES (?, 1, 'hook', 'confirmed', ?, 'user', ?, 1)");
  for (let i = 0; i < 5_000; i++) put.run(id, `pad-${i}`, i);
  db.exec('COMMIT');
  const purged = svc.purge(id);
  svc.stop();
  assert.equal(await purged, 'pending', 'hidden and suppressed: the rest is owed (Gate 5 second review M1: pending, not purged)');
  assert.ok(!events.includes('purge_rows_failed'), 'a stop is no failure (the store was not used after it closed)');
  const again = await boot({ dataDir: s.dataDir, home: s.home, catalog, intervalMs: 60_000 });
  try {
    await again.done;
    await until(() => count(again.store.db, 'SELECT count(*) FROM suppressions WHERE purge_phase IS NULL AND pending IS NULL') === 1, 10_000);
    assert.equal(count(again.store.db, 'SELECT count(*) FROM sessions WHERE native_session_id = ?', SESSION), 0);
  } finally {
    again.stop();
  }
});
