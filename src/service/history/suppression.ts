// XAIBO-PROD-515/516 (P5-T07/T08; FR-11, EC-21/22): the Suppression marker. A purge leaves the session's identity with
// its reason, the files that held its records and any file work still owed. One rule for every path in:
//  - writer (blocks): an uncleared marker keeps the session out when it is manual, owes file work, or the batch carries
//    no demonstrably new native activity; a retention marker with new activity is cleared and the session re-imported.
//  - hook/report intake (refuses): additionally refuses any delivery timed at or before the purge, cleared or not (a copy
//    the purge removed), and one with no readable time.
// New native activity = a record whose own time and whose file's mtime are both after the purge (a clock that ran ahead
// in an unchanged file is not; a clock stepped back fails closed: no re-import), or a hook/report the intake let through.
import type { DatabaseSync } from 'node:sqlite';

export type SuppressionReason = 'manual' | 'retention';
export interface Identity { agent: string; profile: string; native: string }
export interface Marker { reason: SuppressionReason; at: number; pending: string | null; cleared_at: number | null; files: string | null }

/** Parameters: agent, profile id, native session id. */
export const MARKER = 'SELECT reason, at, pending, cleared_at, files FROM suppressions WHERE agent = ? AND profile_id = ? AND native_session_id = ?';

/** Writer side: true while the marker keeps the session out of a batch with (or without) new native activity. */
export const blocks = (m: Marker | undefined, newActivity: boolean): boolean =>
  !!m && m.cleared_at === null && (m.reason === 'manual' || m.pending !== null || !newActivity);

/** Intake side: true when a delivery timed `ts` (null = no readable time) must be refused. */
export const refuses = (m: Marker | undefined, ts: number | null): boolean =>
  !!m && (ts === null || !Number.isFinite(ts) || ts <= m.at || blocks(m, true));

/** Writes the marker inside the purge transaction: `pending` = registration ids whose files are still owed, `files` =
 *  source_files ids that held the session's records. A purge after an earlier clear suppresses again. */
export function suppress(db: DatabaseSync, s: Identity, reason: SuppressionReason, at: number, pending: string[], files: number[]): void {
  db.prepare(`INSERT INTO suppressions (agent, profile_id, native_session_id, reason, at, pending, files) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET reason = excluded.reason, at = excluded.at, pending = excluded.pending, files = excluded.files, cleared_at = NULL`)
    .run(s.agent, s.profile, s.native, reason, at, JSON.stringify(pending), JSON.stringify(files));
}

/** Clears the marker (Re-import, or new native activity) and resets its files' checkpoints so the next scan reads them
 *  from the start (size -1 and no mtime: an unchanged file is synced again; epoch + 1: an ingest that read the old
 *  checkpoint cannot move it past the reset). Inside the caller's transaction. */
export function clear(db: DatabaseSync, s: Identity, at: number): void {
  db.prepare(`UPDATE source_files SET offset = 0, size = -1, mtime = NULL, head_hash = '', epoch = epoch + 1
    WHERE id IN (SELECT value FROM json_each(coalesce((SELECT files FROM suppressions WHERE agent = ? AND profile_id = ? AND native_session_id = ?), '[]')))`)
    .run(s.agent, s.profile, s.native);
  db.prepare('UPDATE suppressions SET cleared_at = ? WHERE agent = ? AND profile_id = ? AND native_session_id = ?').run(at, s.agent, s.profile, s.native);
}

/** Adds a file that held records of a suppressed session to its marker (e.g. a rollout moved to a new path). */
export function noteFile(db: DatabaseSync, s: Identity, fileId: number): void {
  db.prepare(`UPDATE suppressions SET files = (SELECT json_group_array(v) FROM (SELECT value AS v FROM json_each(coalesce(files, '[]')) UNION SELECT ?))
    WHERE agent = ? AND profile_id = ? AND native_session_id = ?`).run(fileId, s.agent, s.profile, s.native);
}
