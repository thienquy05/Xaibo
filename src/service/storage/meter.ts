// XAIBO-PROD-522 (P5-T15; S-10, US-6, PRD §5.11, design Storage row, Q-5.6): the storage meter. Measured in a worker thread
// (this same module, started with workerData) with its own read-only connection, because DBSTAT walks every page (S12:
// 3.3 s on its 2.8 GB corpus); the result is cached and never computed on readiness. File-level totals do not overlap
// and add up to the total; any unmeasurable part leaves the total unavailable (a missing directory is 0; a missing
// database is unavailable). DBSTAT (S1: ENABLE_DBSTAT_VTAB) breaks the database bytes down by category; that breakdown
// is part of the database file and WAL, never added to the total. Directory walks count regular files only (lstat):
// symlinks are neither followed nor counted.
import { lstatSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { StorageCategory, StorageReport } from '../../shared/ipc.ts';
export type { StorageCategory }; // XAIBO-PROD-527: shared with the renderer

const USAGE = new Set(['usage', 'usage_history', 'usage_scopes', 'usage_snapshots', 'context_snapshots', 'cost_estimates', 'monthly_quota_peaks',
  'monthly_sessions', 'monthly_usage', 'settled_contributions']);
const CONTENT = new Set(['sessions', 'events', 'turns', 'tool_calls', 'subagents', 'session_links', 'cwd_history', 'source_files', 'quarantine',
  'report_content', 'status_evidence', 'hook_gaps']);
/** A table's category (indexes count with their table). */
export const categoryOf = (table: string): StorageCategory => (table === 'event_fts' || table.startsWith('event_fts_') ? 'search' : USAGE.has(table) ? 'usage'
  : table === 'price_revisions' ? 'prices' : CONTENT.has(table) ? 'content' : 'other');

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

function fileSize(p: string, missing: number | null): number | null {
  try { return statSync(p).size; } catch (e) { return code(e) === 'ENOENT' ? missing : null; }
}

function dirSize(root: string): number | null {
  // Own walk: readdirSync's recursive option descends into symlinked directories. Dirent types are lstat types.
  try { if (!lstatSync(root).isDirectory()) return 0; } catch (e) { return code(e) === 'ENOENT' ? 0 : null; } // review L2: a symlinked root is not followed
  let n = 0;
  for (const stack = [root]; stack.length;) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { if (code(e) === 'ENOENT') continue; return null; } // the root or a subdir gone: 0 / skipped
    for (const d of entries) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) stack.push(p);
      else if (d.isFile()) { try { n += lstatSync(p).size; } catch (e) { if (code(e) !== 'ENOENT') return null; } } // gone mid-walk: not counted
      // symlinks, sockets and other types are neither followed nor counted
    }
  }
  return n;
}

function breakdown(file: string): StorageReport['database'] {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 5000 }); // review L1: wait out a transient lock instead of reading unavailable
    const one = (sql: string) => Number(Object.values(db!.prepare(sql).get() ?? {})[0]);
    db.exec('BEGIN'); // one snapshot for the page count and the walk
    const size = one('PRAGMA page_size');
    const tables = new Map((db.prepare('SELECT name, tbl_name FROM sqlite_master').all() as { name: string; tbl_name: string }[]).map((r) => [r.name, r.tbl_name]));
    const categories: Record<StorageCategory, number> = { content: 0, search: 0, usage: 0, prices: 0, other: 0, free: one('PRAGMA freelist_count') * size };
    for (const r of db.prepare('SELECT name, pgsize FROM dbstat WHERE aggregate = TRUE').all() as { name: string; pgsize: number }[]) {
      categories[categoryOf(tables.get(r.name) ?? r.name)] += Number(r.pgsize);
    }
    const bytes = one('PRAGMA page_count') * size;
    db.exec('COMMIT');
    return { bytes, categories };
  } catch { return null; } finally { try { db?.close(); } catch { /* closed */ } }
}

/** One measurement of a data dir (the worker's job; synchronous, never on the service loop). */
export function measure(dataDir: string): StorageReport {
  const file = path.join(dataDir, 'xaibo.db');
  const files = {
    database: fileSize(file, null), wal: fileSize(`${file}-wal`, 0),
    contentChunks: dirSize(path.join(dataDir, 'content-chunks')), spool: dirSize(path.join(dataDir, 'spool')), backups: dirSize(path.join(dataDir, 'backups')),
  };
  const parts = Object.values(files);
  return {
    measuredAt: Date.now(), files,
    total: parts.every((x) => x !== null) ? parts.reduce<number>((a, b) => a + b!, 0) : null,
    database: files.database === null ? null : breakdown(file),
  };
}

/** The cached meter: latest() never computes; refresh() runs one worker at a time and concurrent callers share it. */
export class StorageMeter {
  readonly #dataDir: string;
  #last: StorageReport | null = null;
  #running: Promise<StorageReport> | null = null;
  constructor(dataDir: string) { this.#dataDir = dataDir; }

  latest(): StorageReport | null { return this.#last; }

  refresh(): Promise<StorageReport> {
    this.#running ??= new Promise<StorageReport>((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { storageMeter: this.#dataDir } });
      w.once('message', (r: StorageReport) => { this.#last = r; resolve(r); });
      w.once('error', reject);
      w.once('exit', (c) => reject(new Error(`storage meter worker exited (${c})`))); // after a message this is a no-op
    }).finally(() => { this.#running = null; });
    return this.#running;
  }
}

if (!isMainThread && typeof (workerData as { storageMeter?: unknown } | null)?.storageMeter === 'string') {
  parentPort!.postMessage(measure((workerData as { storageMeter: string }).storageMeter));
}
