// XAIBO-PROD-201 (P2-T01): 001 -> 002 through the EC-45 recovery path; schema.sql; injected failure; constraints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { loadMigrations, openStore, schemaSnapshot } from '../../src/service/store/db.ts';
import { claudeProfile, count } from '../helpers/claude-profile.ts';

const SCHEMA = new URL('../../src/service/store/schema.sql', import.meta.url);
const PHASE1_TABLES = ['profiles', 'sessions', 'source_files', 'subagents', 'events', 'quarantine', 'kv'];
const NEW_TABLES = ['turns', 'tool_calls', 'usage', 'context_snapshots', 'cost_estimates', 'price_revisions', 'usage_snapshots', 'session_links', 'cwd_history'];

const columns = (db: DatabaseSync, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
const tableCount = (db: DatabaseSync, names: string[]) =>
  count(db, `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN (${names.map(() => '?').join(', ')})`, ...names);

// Every Phase 1 row, read through the Phase 1 column lists so 002's added columns do not hide a change.
function dump(db: DatabaseSync, cols: Record<string, string[]>) {
  return Object.fromEntries(PHASE1_TABLES.map((t) =>
    [t, db.prepare(`SELECT ${cols[t]!.join(', ')} FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))]));
}

// A v1 DB holding what the Claude adapter ingests from the synthetic 2.1.319 fixtures, then closed. The current writer
// targets the latest schema, so ingest runs into a current DB and the Phase 1 columns are copied into a fresh v1 DB.
async function phase1Db() {
  const p = await claudeProfile(['identifiers', 'usage-basic']);
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start();
  a.stop();
  p.db.close();
  const opts = { file: join(p.tmp, 'v1', 'xaibo.db'), backupDir: join(p.tmp, 'v1', 'backups') };
  const { db } = await openStore({ ...opts, migrations: loadMigrations().filter((m) => m.version === 1) });
  db.exec(`ATTACH DATABASE '${join(p.tmp, 'data', 'xaibo.db')}' AS cur`);
  for (const t of PHASE1_TABLES) { const c = columns(db, t).join(', '); db.exec(`INSERT INTO main.${t} (${c}) SELECT ${c} FROM cur.${t}`); }
  db.exec("DETACH DATABASE cur; INSERT INTO event_fts (event_fts) VALUES ('rebuild')");
  const cols = Object.fromEntries(PHASE1_TABLES.map((t) => [t, columns(db, t)]));
  const rows = dump(db, cols);
  const content = (db.prepare('SELECT content FROM events WHERE content IS NOT NULL ORDER BY id').get() as { content: string }).content;
  const word = /[A-Za-z]{3,}/.exec(content)![0];
  const hits = count(db, 'SELECT count(*) FROM event_fts WHERE event_fts MATCH ?', word);
  db.close();
  return { opts, cols, rows, word, hits };
}

test('001 -> 002: backup taken, every Phase 1 row kept, FTS intact, defaults set, schema.sql matches', async () => {
  const before = await phase1Db();
  assert.ok((before.rows.events as unknown[]).length > 0 && before.hits > 0, 'fixture populated the v1 DB');
  const s = await openStore(before.opts);
  assert.equal(s.readOnly, false);
  assert.equal(count(s.db, 'PRAGMA user_version'), 2);
  assert.deepEqual(readdirSync(before.opts.backupDir), ['xaibo-v1.db']);
  assert.deepEqual(dump(s.db, before.cols), before.rows);
  assert.equal(count(s.db, 'SELECT count(*) FROM event_fts WHERE event_fts MATCH ?', before.word), before.hits);
  s.db.exec("INSERT INTO event_fts (event_fts) VALUES ('integrity-check')");
  assert.equal(count(s.db, "SELECT count(*) FROM events WHERE revision_status <> 'current'"), 0);
  assert.equal(count(s.db, 'SELECT count(*) FROM sessions WHERE native_archived <> 0 OR originator IS NOT NULL OR source_kind IS NOT NULL OR current_model IS NOT NULL OR current_effort IS NOT NULL'), 0);
  assert.equal(count(s.db, 'SELECT count(*) FROM subagents WHERE model_id IS NOT NULL'), 0);
  for (const t of NEW_TABLES) {
    const c = columns(s.db, t);
    assert.ok(c.includes('schema_version') && c.some((n) => n === 'source' || n === 'sources'), `${t} carries source identity and schema_version`);
    assert.equal(count(s.db, `SELECT count(*) FROM ${t}`), 0);
  }
  assert.equal(schemaSnapshot(s.db), readFileSync(SCHEMA, 'utf8'), 'migrated schema differs from schema.sql');
});

test('EC-45 regression: a failure inside 002 leaves v1, no partial 002 tables, every row, a backup, read-only', async () => {
  const before = await phase1Db();
  const broken = loadMigrations().map((m) => (m.version === 2 ? { ...m, sql: `${m.sql}\nINSERT INTO no_such_table VALUES (1);` } : m));
  assert.ok(broken.some((m) => m.version === 2), 'migration 002 exists');
  const s = await openStore({ ...before.opts, migrations: broken });
  assert.equal(s.readOnly, true);
  assert.equal(s.reason, 'migration-failed');
  assert.equal(count(s.db, 'PRAGMA user_version'), 1);
  assert.equal(tableCount(s.db, NEW_TABLES), 0, 'partial 002 rolled back');
  assert.ok(!columns(s.db, 'events').includes('revision_status'), 'ALTERs rolled back');
  assert.deepEqual(dump(s.db, before.cols), before.rows);
  assert.deepEqual(readdirSync(before.opts.backupDir), ['xaibo-v1.db']);
});

test('002 constraints: missing values stay NULL, enums checked, price revisions immutable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xmig2-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'backups') });
  db.exec(`INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'codex', '~/.codex', 'default');
    INSERT INTO sessions (id, agent, profile_id, native_session_id) VALUES (1, 'codex', 'p1', '00000000-0000-4000-8000-000000000001');
    INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, source_seq, received_ts)
      VALUES (1, 1, 'rollout', 'confirmed', 'e1', 'message', 0, 1)`);
  assert.throws(() => db.exec("UPDATE events SET revision_status = 'deleted'"), /CHECK/);

  db.exec("INSERT INTO usage (session_id, schema_version, source, identity, scope) VALUES (1, 1, 'rollout', 'seg0:1', 'message')");
  assert.equal(count(db, 'SELECT count(*) FROM usage WHERE uncached_input IS NULL AND cache_read IS NULL AND cache_write IS NULL AND output IS NULL'), 1, 'missing is NULL, never 0');
  assert.throws(() => db.exec("INSERT INTO usage (session_id, schema_version, source, identity, scope) VALUES (1, 1, 'rollout', 'x', 'request')"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO usage (session_id, schema_version, source, identity, scope) VALUES (1, 1, 'rollout', 'seg0:1', 'message')"), /UNIQUE/);
  assert.throws(() => db.exec("INSERT INTO context_snapshots (session_id, schema_version, source, generation, window_basis, observed_at) VALUES (1, 1, 'rollout', 0, 'guessed', 1)"), /CHECK/);
  assert.throws(() => db.exec("INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, basis) VALUES (1, 1, 'calc', 's', 'family_guess')"), /CHECK/);
  db.exec("INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, basis) VALUES (1, 1, 'calc', 'session', 'token_table')");
  assert.equal(count(db, 'SELECT count(*) FROM cost_estimates WHERE amount_usd IS NULL'), 1, 'unavailable cost is NULL, never 0');

  db.exec("INSERT INTO price_revisions (schema_version, source, revision, content_hash, body, accepted_at) VALUES (1, 'bundled', 'r1', 'h1', '{}', 1)");
  assert.throws(() => db.exec("UPDATE price_revisions SET body = '{\"x\":1}'"), /immutable/);
  assert.throws(() => db.exec("INSERT INTO price_revisions (schema_version, source, revision, content_hash, body, accepted_at) VALUES (1, 'web', 'r2', 'h2', '{}', 1)"), /CHECK/);
});
