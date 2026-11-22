-- XAIBO-PROD-516 (P5-T08; FR-11, EC-21/22): clearing a suppression and re-importing.
-- files: JSON array of source_files ids holding the session's records (re-read when the marker clears).
-- cleared_at: when Re-import or new native activity cleared the marker (the re-import notice); NULL = still suppressing.
ALTER TABLE suppressions ADD COLUMN files TEXT;
ALTER TABLE suppressions ADD COLUMN cleared_at INTEGER;
-- epoch: bumped when a checkpoint is reset for a re-import; a checkpoint written with an older epoch (an ingest that
-- read the checkpoint before the reset) does not move it.
ALTER TABLE source_files ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0;
