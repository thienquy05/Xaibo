-- XAIBO-PROD-515 (P5-T07; FR-11): a purged session's identity, so no rescan, spool replay or late hook re-imports it.
-- pending: JSON array of the registration ids whose files the purge still owes (chunks, spool, backups); NULL when done.
CREATE TABLE suppressions (
  agent TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('manual', 'retention')),
  at INTEGER NOT NULL,
  pending TEXT,
  PRIMARY KEY (agent, profile_id, native_session_id)
) WITHOUT ROWID;
CREATE INDEX suppressions_pending ON suppressions (agent) WHERE pending IS NOT NULL;
