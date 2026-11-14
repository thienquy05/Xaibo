// XAIBO-PROD-105 (P1-T07), EC-45: a failed or refused migration never loses data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadMigrations, openStore } from '../../src/service/store/db.ts';

const one = (db: DatabaseSync, sql: string) => Object.values(db.prepare(sql).get() ?? {})[0];
const next = loadMigrations().at(-1)!.version + 1; // injected migrations sit after the real ones
const bad = { version: next, name: 'bad', sql: 'CREATE TABLE t2(x); INSERT INTO no_such_table VALUES (1);' };

async function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'xmig-'));
  const opts = { file: join(dir, 'xaibo.db'), backupDir: join(dir, 'backups') };
  const s = await openStore(opts);
  s.db.prepare("INSERT INTO kv(key, value) VALUES ('k', 'v')").run();
  s.db.close();
  return { dir, opts };
}

test('EC-45: failing migration keeps a backup, user_version, every row; DB read-only with the banner reason', async () => {
  const { dir, opts } = await seeded();
  const s = await openStore({ ...opts, migrations: [...loadMigrations(), bad] });
  assert.equal(s.readOnly, true);
  assert.equal(s.reason, 'migration-failed');
  assert.equal(one(s.db, 'PRAGMA user_version'), next - 1);
  assert.equal(one(s.db, "SELECT value FROM kv WHERE key = 'k'"), 'v');
  assert.equal(one(s.db, "SELECT count(*) FROM sqlite_master WHERE name = 't2'"), 0, 'partial migration rolled back');
  assert.throws(() => s.db.prepare("INSERT INTO kv(key, value) VALUES ('x', 'y')").run(), /readonly/i);
  const backups = readdirSync(join(dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(statSync(join(dir, 'backups', backups[0]!)).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'backups')).mode & 0o777, 0o700);
});

test('T13b2: a foreign_keys-off migration that leaves a dangling reference is rolled back (read-only, migration-failed)', async () => {
  const { opts } = await seeded();
  const dangling = { version: next, name: 'fk-off', sql: '-- xaibo: foreign_keys off\nCREATE TABLE t2(x); INSERT INTO sessions (agent, profile_id, native_session_id) VALUES (\'claude\', \'no-such-profile\', \'s\');' };
  const s = await openStore({ ...opts, migrations: [...loadMigrations(), dangling] });
  assert.equal(s.readOnly, true);
  assert.equal(s.reason, 'migration-failed');
  assert.equal(one(s.db, "SELECT count(*) FROM sqlite_master WHERE name = 't2'"), 0, 'rolled back');
  assert.equal(one(s.db, 'SELECT count(*) FROM sessions'), 0, 'the dangling row was never committed');
});

test('T13b2: migration 009 keeps every profile and session, allows registration profiles, and still enforces foreign keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xmig-'));
  const opts = { file: join(dir, 'xaibo.db'), backupDir: join(dir, 'backups') };
  const before = await openStore({ ...opts, migrations: loadMigrations().filter((m) => m.version < 9) });
  before.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/claude', 'default')").run();
  before.db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id) VALUES ('claude', 'p1', 's1')").run();
  before.db.close();
  const s = await openStore(opts);
  assert.equal(s.readOnly, false);
  assert.ok(Number(one(s.db, 'PRAGMA user_version')) >= 9);
  assert.equal(one(s.db, "SELECT count(*) FROM sessions WHERE profile_id = 'p1'"), 1);
  assert.equal(one(s.db, "SELECT origin FROM profiles WHERE id = 'p1'"), 'default');
  s.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('acme-1', 'acme-agent', 'registration:x', 'registration')").run();
  assert.throws(() => s.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('q', 'x', 'r', 'bogus')").run(), /CHECK/);
  assert.throws(() => s.db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id) VALUES ('x', 'missing', 's')").run(), /FOREIGN KEY/);
  assert.equal(one(s.db, 'PRAGMA foreign_keys'), 1);
});

test('EC-45: insufficient space refuses the migration with the same outcome', async () => {
  const { dir, opts } = await seeded();
  const s = await openStore({ ...opts, migrations: [...loadMigrations(), { ...bad, sql: 'CREATE TABLE t2(x);' }], freeBytes: () => 0 });
  assert.equal(s.readOnly, true);
  assert.equal(s.reason, 'insufficient-space');
  assert.equal(one(s.db, 'PRAGMA user_version'), next - 1);
  assert.equal(one(s.db, "SELECT value FROM kv WHERE key = 'k'"), 'v');
  assert.equal(existsSync(join(dir, 'backups')) ? readdirSync(join(dir, 'backups')).length : 0, 0);
});

test('only the latest backup is kept', async () => {
  const { dir, opts } = await seeded();
  const ok2 = { version: next, name: 'ok2', sql: 'CREATE TABLE t2(x);' };
  (await openStore({ ...opts, migrations: [...loadMigrations(), ok2] })).db.close();
  (await openStore({ ...opts, migrations: [...loadMigrations(), ok2, { version: next + 1, name: 'ok3', sql: 'CREATE TABLE t3(x);' }] })).db.close();
  assert.equal(readdirSync(join(dir, 'backups')).length, 1);
});
