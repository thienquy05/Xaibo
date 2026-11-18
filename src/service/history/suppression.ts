// XAIBO-PROD-515 (P5-T07; FR-11): the Suppression marker. A purge leaves the session's identity (agent, profile, native
// id) with its reason; hook and report intake refuse it before publishing or writing anything, and the writer drops it
// from every batch (rescans, spool replay, late hooks). Clearing (Re-import, new native activity after a retention purge)
// is P5-T08.
import type { DatabaseSync } from 'node:sqlite';

export type SuppressionReason = 'manual' | 'retention';
export interface Identity { agent: string; profile: string; native: string }

/** Parameters: agent, profile id, native session id. */
export const SUPPRESSED = 'SELECT 1 FROM suppressions WHERE agent = ? AND profile_id = ? AND native_session_id = ?';

/** Writes the marker inside the purge transaction; `pending` = registration ids whose files are still owed. */
export function suppress(db: DatabaseSync, s: Identity, reason: SuppressionReason, at: number, pending: string[]): void {
  db.prepare(`INSERT INTO suppressions (agent, profile_id, native_session_id, reason, at, pending) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET reason = excluded.reason, at = excluded.at, pending = excluded.pending`)
    .run(s.agent, s.profile, s.native, reason, at, JSON.stringify(pending));
}
