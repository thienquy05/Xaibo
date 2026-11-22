// XAIBO-PROD-511 (P5-T03; FR-11, FR-12, EC-42): the Trash auto-empty timer. A session goes to Trash through the overlay
// (applyOverlay 'trash'); it becomes eligible for purge 30 × 24 h of elapsed time after deletion, whatever the zone or
// DST. The retention job (P5-T09, retention/job.ts) selects expired Trash (trashed_at <= now - TRASH_MS, so a clock set
// back before the deletion never expires early) and purges through the writer (P5-T07).

// ponytail: fixed 30-day Trash (design §6.9 shows it fixed until the service supports a configured policy).
export const TRASH_MS = 30 * 24 * 3600_000;
export const trashPurgeAt = (trashedAt: number): number => trashedAt + TRASH_MS;
