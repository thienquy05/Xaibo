-- 011 (XAIBO-PROD-324, Gate 3 review c; PRD §5.5, §5.10): live-status evidence is per (agent, profile, native session id),
-- and a report row keeps its producer (`<registration>:<producer_id>`) and producer_seq, so a late event of one producer
-- reloads in causal order.
-- Rows stored before this have profile '' (no profile reads them) and no producer: derived data, rebuilt by new evidence.
-- ponytail: UNIQUE (agent, native_session_id, dedup) stays; dedup ids (hook delivery UUID, registration:delivery id, file
-- path hash:offset) are already distinct across profiles. Rebuild the table if a dedup id ever repeats across profiles.
ALTER TABLE status_evidence ADD COLUMN profile_id TEXT NOT NULL DEFAULT '';
ALTER TABLE status_evidence ADD COLUMN producer_id TEXT;
ALTER TABLE status_evidence ADD COLUMN producer_seq INTEGER;
