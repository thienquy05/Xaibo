// SQLite store on node:sqlite (S1 decision): §7.4 pragmas, 0600 files, forward-only migrations behind an
// explicit recovery path (EC-45): free-space check, backup (VACUUM INTO), migrate, else read-only; never deletes data.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backfillExcerpts } from '../history/excerpt.ts';

export interface Migration { version: number; name: string; sql: string }
export type ReadOnlyReason = 'migration-failed' | 'insufficient-space' | 'newer-schema';
export interface Store { db: DatabaseSync; readOnly: boolean; reason?: ReadOnlyReason }
export interface StoreOptions {
  file: string;
  backupDir: string;
  migrations?: Migration[];
  freeBytes?: (dir: string) => number;
}

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
/** First line of a migration that must run with foreign keys off (a table rebuild, P3-T13b2). */
const FK_OFF = /^-- xaibo: foreign_keys off\r?\n/;
// ponytail: fixed headroom over the DB + WAL size; size it per migration if one ever rewrites large tables.
const SPACE_MARGIN = 64 * 1024 * 1024;

export function loadMigrations(dir: URL = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort()
    .map((f) => ({ version: Number(f.slice(0, 3)), name: f.slice(0, -4), sql: readFileSync(new URL(f, dir), 'utf8') }));
}

/** SQLITE_FULL (primary code 13) or ENOSPC: the store cannot grow (EC-44). */
/** Research L6: rolls back after a failure without replacing the caller's error (a throwing ROLLBACK is swallowed;
 *  callers that care read db.isTransaction afterwards). XAIBO-PROD-550: shared by the writer and openStore. */
export function rollback(db: DatabaseSync): void {
  try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* the original error is the one reported */ }
}

export const isDiskFull = (e: unknown) => {
  const x = e as { errcode?: unknown; code?: unknown } | null;
  return (typeof x?.errcode === 'number' && (x.errcode & 0xff) === 13) || x?.code === 'ENOSPC';
};

const userVersion = (db: DatabaseSync) => Number(Object.values(db.prepare('PRAGMA user_version').get() ?? {})[0]);
const sizeOf = (f: string) => (existsSync(f) ? statSync(f).size : 0);
const freeBytesOf = (dir: string) => { const s = statfsSync(dir); return s.bavail * s.bsize; };

function openReadWrite(file: string): DatabaseSync {
  if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600)); // SQLite creates -wal/-shm with the DB file's mode
  chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA auto_vacuum = INCREMENTAL'); // only takes effect before the first table
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY');
  return db;
}

function readOnly(db: DatabaseSync, file: string, reason: ReadOnlyReason): Store {
  db.close();
  return { db: new DatabaseSync(file, { readOnly: true }), readOnly: true, reason };
}

// Only the latest backup is kept (OQ-P1-17); it is written under a temporary name and renamed when complete.
// XAIBO-PROD-515 (P5-T07, review H2): VACUUM INTO copies live rows only; a page copy would carry a purged session's
// bytes from the freelist into the backup.
function backupTo(db: DatabaseSync, dir: string, version: number) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const partial = path.join(dir, `.xaibo-v${version}.db.partial`);
  const leftovers = () => { for (const f of [partial, `${partial}-journal`, `${partial}-wal`, `${partial}-shm`]) rmSync(f, { force: true }); };
  leftovers();
  try {
    closeSync(openSync(partial, 'w', 0o600)); // VACUUM INTO accepts an empty target, so the mode is ours
    db.exec(`VACUUM INTO '${partial.replaceAll("'", "''")}'`);
    // FTS5 deletes leave purged terms in older index segments (live pages) until they merge: the copy's index is merged
    // and compacted, so no backup carries a purged session's text (the main DB is non-forensic by design, Q-5.2).
    const copy = new DatabaseSync(partial);
    try {
      if (copy.prepare("SELECT 1 FROM sqlite_master WHERE name = 'event_fts'").get()) {
        copy.exec("INSERT INTO event_fts (event_fts) VALUES ('optimize')");
        copy.exec('VACUUM');
      }
    } finally {
      copy.close();
    }
  } catch (e) {
    leftovers(); // review: a cut-short copy (taken before the merge) never stays behind
    throw e;
  }
  chmodSync(partial, 0o600);
  for (const f of readdirSync(dir)) if (/^xaibo-v\d+\.db$/.test(f)) rmSync(path.join(dir, f));
  renameSync(partial, path.join(dir, `xaibo-v${version}.db`));
}

export async function openStore(o: StoreOptions): Promise<Store> {
  mkdirSync(path.dirname(o.file), { recursive: true, mode: 0o700 });
  const migrations = o.migrations ?? loadMigrations();
  // Research L6: a database from a newer Xaibo is read before any pragma or migration could change it.
  if (existsSync(o.file)) {
    const probe = new DatabaseSync(o.file, { readOnly: true });
    let found: number;
    try { found = userVersion(probe); } catch (e) { probe.close(); throw e; } // e.g. not a database: refused as before, not leaked
    if (found > Math.max(0, ...migrations.map((m) => m.version))) return { db: probe, readOnly: true, reason: 'newer-schema' };
    probe.close();
  }
  const db = openReadWrite(o.file);
  const current = userVersion(db);
  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return { db, readOnly: false };
  if (current > 0) { // a brand-new DB holds nothing to back up
    // the copy plus its compaction (VACUUM writes a journal about the copy's size)
    const needed = 2 * (sizeOf(o.file) + sizeOf(`${o.file}-wal`)) + SPACE_MARGIN;
    if ((o.freeBytes ?? freeBytesOf)(path.dirname(o.file)) < needed) return readOnly(db, o.file, 'insufficient-space');
    try { backupTo(db, o.backupDir, current); } catch (e) {
      if (isDiskFull(e)) return readOnly(db, o.file, 'insufficient-space');
      throw e;
    }
  }
  for (const m of pending) {
    // A table rebuild (SQLite's documented procedure) runs with foreign keys off; the pragma only takes effect outside a
    // transaction. Every reference must still resolve before the commit, and foreign keys are back on in every case.
    const fkOff = FK_OFF.test(m.sql);
    let failed: ReadOnlyReason | null = null;
    try {
      if (fkOff) db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN IMMEDIATE');
      db.exec(m.sql);
      if (m.version === 25) backfillExcerpts(db); // Gate 5 round 2 A: in the migration's own transaction
      if (fkOff && db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('dangling reference');
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (e) {
      rollback(db); // the connection is closed and reopened read-only below
      failed = isDiskFull(e) ? 'insufficient-space' : 'migration-failed'; // research L6: space is fixable by the owner
    } finally {
      if (fkOff) db.exec('PRAGMA foreign_keys = ON');
    }
    if (failed) return readOnly(db, o.file, failed);
  }
  return { db, readOnly: false };
}

/** Deterministic dump of the schema, compared with schema.sql by a test. */
export function schemaSnapshot(db: DatabaseSync): string {
  const rows = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { sql: string }[];
  return rows.map((r) => `${r.sql};`).join('\n') + '\n';
}
