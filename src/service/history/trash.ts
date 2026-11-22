// XAIBO-PROD-511 (P5-T03; FR-11, FR-12, EC-42): the Trash auto-empty timer. A session goes to Trash through the overlay
// (applyOverlay 'trash'); it becomes eligible for purge 30 × 24 h of elapsed time after deletion, whatever the zone or
// DST. The retention job (P5-T09) takes expiredTrash and purges through the writer (P5-T07).
import type { DatabaseSync } from 'node:sqlite';

// ponytail: fixed 30-day Trash (design §6.9 shows it fixed until the service supports a configured policy).
export const TRASH_MS = 30 * 24 * 3600_000;
export const trashPurgeAt = (trashedAt: number): number => trashedAt + TRASH_MS;
/** Elapsed time only; a clock set back before the deletion never expires early. */
export const trashExpired = (trashedAt: number, now: number): boolean => now - trashedAt >= TRASH_MS;

/** Session row ids whose Trash time has expired, oldest deletion first, at most `limit`. */
export function expiredTrash(db: DatabaseSync, now: number, limit: number): number[] {
  return (db.prepare(`SELECT s.id FROM overlays o JOIN sessions s ON s.agent = o.agent AND s.profile_id = o.profile_id AND s.native_session_id = o.native_session_id
    WHERE o.trashed_at <= ? ORDER BY o.trashed_at, s.id LIMIT ?`).all(now - TRASH_MS, limit) as { id: number }[]).map((r) => r.id);
}
