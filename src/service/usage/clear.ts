// XAIBO-PROD-525 (P5-T16; FR-52, Q-5.8): Clear usage history. The frozen monthly totals are deleted and every
// contribution observed so far is marked cleared in settled_contributions (settled keys flagged, each retained unsettled
// key added flagged). liveMonthly skips any marked key and settle() never adds one again, so the cleared usage stays out
// across restarts, purge, retention and Trash expiry; a contribution first seen afterwards has a new key and counts.
// Session content, account usage snapshots and quota history are not touched.
// XAIBO-PROD-526 (owner decision on review M3): the scan of retained history (~7 µs per contribution) runs in a worker
// thread (this module started with workerData) on a read-only snapshot; the service thread then applies it in one
// writer transaction. A key settled between the snapshot and that transaction is caught by the UPDATE; a contribution
// stored after the request arrived counts (rowid watermarks taken then, XAIBO-PROD-542 G5b1-3), unless it is also settled before the
// transaction (purge or retention of a record that new: practically unreachable; the UPDATE clears it, review L4). Never
// chunked: the clear is atomic. The service thread still pays the index inserts (~0.75 s per 200k new keys measured on
// synthetic data); a row-id watermark instead of one marker per key would remove that (a different marking scheme).
// A session still active in a cleared month keeps that month's session count cleared (and its per-model counts:
// clearedSession); its later turns and requests count. "Observed" = stored: a request row updated in place afterwards
// keeps its cleared key, and batches still queued in the writer count (review L2/L3). A record with no time at all (nor
// its session) has no month and gets no marker (review L1).
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { contributions, type Watermarks } from './monthly.ts';
import { runWorker } from '../worker.ts';

export interface Mark { key: string; month: string; offset: number }
export const CLEAR_TIMEOUT_MS = 120_000;

/** XAIBO-PROD-542 G5b1-3: the newest rowids when the request arrives (on the service thread); the scan skips anything
 *  stored after them, so usage committed between the request and the worker's snapshot still counts. */
export function clearWatermarks(db: DatabaseSync): Watermarks {
  const top = (t: string) => Number((db.prepare(`SELECT coalesce(max(id), 0) AS n FROM ${t}`).get() as { n: number }).n);
  return { usage: top('usage'), turns: top('turns'), sessions: top('sessions'), history: top('usage_history') };
}

/** Every retained contribution (up to `upTo`) not yet in settled_contributions, with its bucket. */
export function clearKeys(db: DatabaseSync, secret: Buffer, upTo?: Watermarks): Mark[] {
  const settled = db.prepare('SELECT 1 FROM settled_contributions WHERE key = ?');
  const marks: Mark[] = [];
  // ponytail: the whole key list is held in memory and copied once to the service thread (~100 bytes per contribution);
  // stream it in pages if a T3-size store makes that too large.
  for (const c of contributions(db, secret, { sessions: null, quota: null }, upTo)) if (!settled.get(c.key)) marks.push({ key: c.key, month: c.at.month, offset: c.at.offset });
  return marks;
}

/** Inside the caller's transaction: frozen totals deleted, settled keys flagged cleared, `marks` added cleared. */
export function applyClear(db: DatabaseSync, marks: Mark[], now: number): { cleared: number } {
  if (!db.isTransaction) throw new Error('applyClear must run inside the caller\'s transaction');
  for (const t of ['monthly_usage', 'monthly_sessions', 'monthly_quota_peaks']) db.exec(`DELETE FROM ${t}`);
  let cleared = Number(db.prepare('UPDATE settled_contributions SET cleared = 1 WHERE cleared = 0').run().changes);
  const mark = db.prepare('INSERT INTO settled_contributions (key, month, utc_offset, settled_at, cleared) VALUES (?, ?, ?, ?, 1) ON CONFLICT (key) DO NOTHING');
  for (const m of marks) cleared += Number(mark.run(m.key, m.month, m.offset, now).changes);
  return { cleared };
}

/** Synchronous form (one connection, inside the caller's transaction): the P5-T16 tests' entry; the service uses
 *  keysInWorker + applyClear (review L5: kept as the reference the worker result is checked against). */
export function clearUsageHistory(db: DatabaseSync, secret: Buffer, now: number): { cleared: number } {
  if (!db.isTransaction) throw new Error('clearUsageHistory must run inside the caller\'s transaction');
  return applyClear(db, clearKeys(db, secret), now);
}

/** clearKeys in a worker thread on its own read-only connection, in one snapshot. Rejects with a fixed code. */
export function keysInWorker(o: { file: string; secret: Buffer; timeoutMs?: number; watermarks?: Watermarks }): Promise<Mark[]> {
  // a tight copy (a pooled Buffer would clone its whole backing slab into the worker)
  const data = { xaiboClear: { file: o.file, secret: new Uint8Array(o.secret), watermarks: o.watermarks } };
  return runWorker<{ ok: true; marks: Mark[] }>(new URL(import.meta.url), data, o.timeoutMs ?? CLEAR_TIMEOUT_MS).then((m) => m.marks);
}

const job = (workerData as { xaiboClear?: { file: string; secret: Uint8Array; watermarks?: Watermarks } } | null)?.xaiboClear;
if (!isMainThread && job) {
  try {
    const db = new DatabaseSync(job.file, { readOnly: true, timeout: 5000 });
    try {
      db.exec('BEGIN'); // one snapshot
      const marks = clearKeys(db, Buffer.from(job.secret), job.watermarks);
      db.exec('COMMIT');
      parentPort!.postMessage({ ok: true, marks });
    } finally { db.close(); }
  } catch { parentPort!.postMessage({ ok: false }); }
}
