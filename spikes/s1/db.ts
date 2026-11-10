// S1 probe and crash writer on node:sqlite (DatabaseSync). Runs in the packaged utilityProcess and in a worker.
import { DatabaseSync } from 'node:sqlite';
import * as sqlite from 'node:sqlite';

const REUSE_N = 10_000;
const PRAGMAS = ['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout', 'auto_vacuum', 'temp_store'] as const;

export function openDb(file: string, opts: { readOnly?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(file, opts);
  if (opts.readOnly) return db;
  db.exec('PRAGMA auto_vacuum = INCREMENTAL'); // only effective before the first table
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY');
  return db;
}

const one = (db: DatabaseSync, sql: string) => Object.values(db.prepare(sql).get() ?? {})[0];

// Steps 2-5 of P0-S1-T2 (shared by the main thread and the worker).
export function probeCore(file: string) {
  const db = openDb(file);
  const out: Record<string, any> = { opened: true, pragmas: Object.fromEntries(PRAGMAS.map((p) => [p, one(db, `PRAGMA ${p}`)])) };
  db.exec(`CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT);
    CREATE VIRTUAL TABLE docs_fts USING fts5(body, content='docs', content_rowid='id', tokenize='unicode61')`);
  const ins = db.prepare('INSERT INTO docs(body) VALUES (?)');
  const insFts = db.prepare('INSERT INTO docs_fts(rowid, body) VALUES (?, ?)');
  for (const b of ['alpha beta gamma', 'delta epsilon', 'gamma ray burst']) insFts.run(Number(ins.run(b).lastInsertRowid), b);
  const hits = db.prepare(`SELECT rowid, snippet(docs_fts, 0, '[', ']', '…', 4) AS s, bm25(docs_fts) AS r FROM docs_fts WHERE docs_fts MATCH 'gamma' ORDER BY r`).all();
  let integrity = false;
  try { db.exec(`INSERT INTO docs_fts(docs_fts) VALUES('integrity-check')`); integrity = true; } catch { /* reported false */ }
  let contentlessDelete = false;
  try { db.exec(`CREATE VIRTUAL TABLE cd USING fts5(a, content='', contentless_delete=1)`); contentlessDelete = true; } catch { /* unavailable */ }
  out.fts = { match: hits.length === 2, snippet: String(hits[0]?.s ?? '').includes('[gamma]'), bm25: typeof hits[0]?.r === 'number', integrity, contentlessDelete };

  const tx: Record<string, any> = {};
  db.exec('CREATE TABLE t(v INTEGER)');
  db.exec('BEGIN IMMEDIATE'); db.exec('INSERT INTO t VALUES (1)'); db.exec('COMMIT');
  tx.commit = one(db, 'SELECT count(*) FROM t') === 1;
  db.exec('BEGIN IMMEDIATE'); db.exec('INSERT INTO t VALUES (2)'); db.exec('ROLLBACK');
  tx.rollback = one(db, 'SELECT count(*) FROM t') === 1;
  db.exec('BEGIN'); db.exec('SAVEPOINT sp'); db.exec('INSERT INTO t VALUES (3)'); db.exec('ROLLBACK TO sp'); db.exec('RELEASE sp'); db.exec('COMMIT');
  tx.savepoint = one(db, 'SELECT count(*) FROM t') === 1;
  const reuse = db.prepare('INSERT INTO t VALUES (?)');
  const t0 = process.hrtime.bigint();
  db.exec('BEGIN');
  for (let i = 0; i < REUSE_N; i++) reuse.run(i);
  db.exec('COMMIT');
  tx.reuseMs = Number(process.hrtime.bigint() - t0) / 1e6;
  tx.reuse = (one(db, 'SELECT count(*) FROM t') as number) - 1;
  out.tx = tx;

  const ro = openDb(file, { readOnly: true });
  const base = one(ro, 'SELECT count(*) FROM t') as number;
  db.exec('BEGIN IMMEDIATE'); db.exec('INSERT INTO t VALUES (-1)');
  const beforeCommit = one(ro, 'SELECT count(*) FROM t');
  db.exec('COMMIT');
  out.isolation = { base, beforeCommit, afterCommit: one(ro, 'SELECT count(*) FROM t') };
  ro.close();
  db.close();
  return out;
}

// Main-thread-only extras: version, compile options, DBSTAT, backup, incremental_vacuum.
export async function probeExtras(file: string, backupFile: string) {
  const db = openDb(file);
  const compileOptions = (db.prepare('PRAGMA compile_options').all() as { compile_options: string }[]).map((r) => r.compile_options);
  let dbstat = false;
  try { db.prepare('SELECT count(*) FROM dbstat').get(); dbstat = true; } catch { /* not compiled in */ }
  let incrementalVacuum = false;
  try { db.exec('PRAGMA incremental_vacuum'); incrementalVacuum = true; } catch { /* unavailable */ }
  let backup = false;
  const b = (sqlite as Record<string, unknown>).backup;
  if (typeof b === 'function') {
    try { await (b as (d: DatabaseSync, p: string) => Promise<number>)(db, backupFile); backup = one(new DatabaseSync(backupFile), 'PRAGMA integrity_check') === 'ok'; } catch { /* reported false */ }
  }
  const out = { sqliteVersion: one(db, 'SELECT sqlite_version()'), compileOptions, dbstat, incrementalVacuum, backup };
  db.close();
  return out;
}

// ---- P0-S1-T3 crash writer ----
const SOURCES = 3;
const MAX_BATCH = 500;
const BATCH_PAUSE_MS = 5;
const STUB_GAP_MS = 20; // widens the stub's gap between its two commits so seeded kills land in it

export function crashSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(body, content='events', content_rowid='id');
    CREATE TABLE IF NOT EXISTS checkpoints(source_id INTEGER PRIMARY KEY, offset INTEGER NOT NULL, head_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS batches(batch_seq INTEGER PRIMARY KEY)`);
}

export function invariants(db: DatabaseSync) {
  let ftsIntegrity = false;
  try { db.exec(`INSERT INTO events_fts(events_fts) VALUES('integrity-check')`); ftsIntegrity = true; } catch { /* false */ }
  const cps = db.prepare('SELECT source_id, offset FROM checkpoints').all() as { source_id: number; offset: number }[];
  const count = db.prepare('SELECT count(*) AS n FROM events WHERE source_id = ?');
  const total = one(db, 'SELECT count(*) FROM events') as number;
  const sum = cps.reduce((a, c) => a + c.offset, 0);
  const checkpointsMatch = sum === total && cps.every((c) => (count.get(c.source_id) as { n: number }).n === c.offset);
  const maxSeq = (one(db, 'SELECT coalesce(max(batch_seq), 0) FROM batches') as number);
  return {
    integrity: one(db, 'PRAGMA integrity_check'), ftsIntegrity, checkpointsMatch,
    maxSeq, contiguous: one(db, 'SELECT count(*) FROM batches') === maxSeq, journalMode: one(db, 'PRAGMA journal_mode'),
  };
}

// twoTx = the deliberately wrong stub (events and checkpoint in separate transactions) used to prove detection.
export function runWriter(file: string, post: (m: object) => void, twoTx: boolean) {
  const db = openDb(file);
  crashSchema(db);
  post({ type: 'check', check: invariants(db) });
  const offsets = new Map<number, number>();
  for (const r of db.prepare('SELECT source_id, offset FROM checkpoints').all() as { source_id: number; offset: number }[]) offsets.set(r.source_id, r.offset);
  let seq = one(db, 'SELECT coalesce(max(batch_seq), 0) FROM batches') as number;
  const insEv = db.prepare('INSERT INTO events(source_id, seq, body) VALUES (?, ?, ?)');
  const insFts = db.prepare('INSERT INTO events_fts(rowid, body) VALUES (?, ?)');
  const upCp = db.prepare('INSERT INTO checkpoints(source_id, offset, head_hash) VALUES (?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET offset = excluded.offset, head_hash = excluded.head_hash');
  const insBatch = db.prepare('INSERT INTO batches(batch_seq) VALUES (?)');
  const step = () => {
    seq++;
    const n = 1 + ((seq * 7919) % MAX_BATCH);
    const touched = new Map<number, number>();
    db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < n; i++) {
      const s = (seq + i) % SOURCES;
      const off = (touched.get(s) ?? offsets.get(s) ?? 0) + 1;
      touched.set(s, off);
      const body = `synthetic event ${seq} ${i} source ${s}`;
      insFts.run(Number(insEv.run(s, off, body).lastInsertRowid), body);
    }
    if (twoTx) { db.exec('COMMIT'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STUB_GAP_MS); db.exec('BEGIN IMMEDIATE'); }
    for (const [s, off] of touched) upCp.run(s, off, `h${seq}-${s}`);
    insBatch.run(seq);
    db.exec('COMMIT');
    for (const [s, off] of touched) offsets.set(s, off);
    post({ type: 'ack', batch_seq: seq });
    setTimeout(step, BATCH_PAUSE_MS);
  };
  step();
}
