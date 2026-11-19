// XAIBO-PROD-525 (P5-T16; FR-52, Q-5.8): Clear usage history. Inside the caller's transaction: the frozen monthly totals
// are deleted and every contribution observed so far is marked cleared in settled_contributions (settled keys flagged,
// each retained unsettled key added flagged). liveMonthly skips any marked key and settle() never adds one again, so the
// cleared usage stays out across restarts, purge, retention and Trash expiry; a contribution first seen afterwards has a
// new key and counts. Session content, account usage snapshots and quota history are not touched.
import type { DatabaseSync } from 'node:sqlite';
import { quotaContributions, sessionContributions } from './monthly.ts';

export function clearUsageHistory(db: DatabaseSync, secret: Buffer, now: number): { cleared: number } {
  if (!db.isTransaction) throw new Error('clearUsageHistory must run inside the caller\'s transaction');
  for (const t of ['monthly_usage', 'monthly_sessions', 'monthly_quota_peaks']) db.exec(`DELETE FROM ${t}`);
  let cleared = Number(db.prepare('UPDATE settled_contributions SET cleared = 1 WHERE cleared = 0').run().changes);
  const mark = db.prepare('INSERT INTO settled_contributions (key, month, utc_offset, settled_at, cleared) VALUES (?, ?, ?, ?, 1) ON CONFLICT (key) DO NOTHING');
  // ponytail: one pass over all retained history in one transaction (as liveMonthly); batch it if a T3-size store makes
  // the writer wait too long. A session still active in a cleared month keeps that month's session count cleared (and
  // its per-model counts: clearedSession); its later turns and requests count. "Observed" = stored at commit: a request
  // row updated in place afterwards keeps its cleared key, and batches still queued in the writer count (review L2/L3).
  // A record with no time at all (nor its session) has no month and gets no marker (review L1).
  for (const gen of [sessionContributions(db, secret, null), quotaContributions(db, secret, null)]) {
    for (const c of gen) cleared += Number(mark.run(c.key, c.at.month, c.at.offset, now).changes);
  }
  return { cleared };
}
