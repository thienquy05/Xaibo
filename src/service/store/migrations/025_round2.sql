-- Gate 5 round 2 (decision 2990). G5Rr1-2: fresh_at, the latest time a batch refused while the marker blocked carried new
-- native activity (a retention marker with it clears once no purge work is owed). G5-N1: settle_cursor, the purge's
-- settlement progress while purge_phase = 'settle' (JSON {"u": usage id, "t": turn id}, the last rows settled).
ALTER TABLE suppressions ADD COLUMN fresh_at INTEGER;
ALTER TABLE suppressions ADD COLUMN settle_cursor TEXT;
-- A (owner decision 2026-11-20): the untitled-session excerpt, stored by the writer (history/excerpt.ts); existing rows
-- are filled by the migration step in db.ts (backfillExcerpts) in this migration's transaction.
ALTER TABLE sessions ADD COLUMN excerpt TEXT;
