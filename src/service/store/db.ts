// SQLite store on node:sqlite (S1 decision): §7.4 pragmas, 0600 files, forward-only migrations behind an
// explicit recovery path (EC-45): free-space check, online backup, migrate, else read-only; never deletes data.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export interface Migration { version: number; name: string; sql: string }
export type ReadOnlyReason = 'migration-failed' | 'insufficient-space';
export interface Store { db: DatabaseSync; readOnly: boolean; reason?: ReadOnlyReason }
export interface StoreOptions {
  file: string;
  backupDir: string;
  migrations?: Migration[];
  freeBytes?: (dir: string) => number;
  onBackupProgress?: (done: number, total: number) => void;
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
async function backupTo(db: DatabaseSync, dir: string, version: number, onProgress?: StoreOptions['onBackupProgress']) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const partial = path.join(dir, `.xaibo-v${version}.db.partial`);
  rmSync(partial, { force: true });
  closeSync(openSync(partial, 'w', 0o600));
  await backup(db, partial, { progress: ({ totalPages, remainingPages }) => onProgress?.(totalPages - remainingPages, totalPages) });
  chmodSync(partial, 0o600);
  for (const f of readdirSync(dir)) if (/^xaibo-v\d+\.db$/.test(f)) rmSync(path.join(dir, f));
  renameSync(partial, path.join(dir, `xaibo-v${version}.db`));
}

export async function openStore(o: StoreOptions): Promise<Store> {
  mkdirSync(path.dirname(o.file), { recursive: true, mode: 0o700 });
  const db = openReadWrite(o.file);
  const current = userVersion(db);
  const pending = (o.migrations ?? loadMigrations()).filter((m) => m.version > current);
  if (pending.length === 0) return { db, readOnly: false };
  if (current > 0) { // a brand-new DB holds nothing to back up
    const needed = sizeOf(o.file) + sizeOf(`${o.file}-wal`) + SPACE_MARGIN;
    if ((o.freeBytes ?? freeBytesOf)(path.dirname(o.file)) < needed) return readOnly(db, o.file, 'insufficient-space');
    await backupTo(db, o.backupDir, current, o.onBackupProgress);
  }
  for (const m of pending) {
    // A table rebuild (SQLite's documented procedure) runs with foreign keys off; the pragma only takes effect outside a
    // transaction. Every reference must still resolve before the commit, and foreign keys are back on in every case.
    const fkOff = FK_OFF.test(m.sql);
    let failed = false;
    try {
      if (fkOff) db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN IMMEDIATE');
      db.exec(m.sql);
      if (fkOff && db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('dangling reference');
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch {
      if (db.isTransaction) db.exec('ROLLBACK');
      failed = true;
    } finally {
      if (fkOff) db.exec('PRAGMA foreign_keys = ON');
    }
    if (failed) return readOnly(db, o.file, 'migration-failed');
  }
  return { db, readOnly: false };
}

/** Deterministic dump of the schema, compared with schema.sql by a test. */
export function schemaSnapshot(db: DatabaseSync): string {
  const rows = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { sql: string }[];
  return rows.map((r) => `${r.sql};`).join('\n') + '\n';
}
