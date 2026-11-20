-- XAIBO-PROD-542 (Gate 5 U1, G5-N1; FR-11): a purge runs in phases. purge_phase: 'rows' while the purge still deletes
-- the session's rows (phases b and c); the session is hidden and kept out meanwhile; NULL when the rows are gone.
ALTER TABLE suppressions ADD COLUMN purge_phase TEXT;
-- XAIBO-PROD-542 (Gate 5 U2, G5b1-4; FR-52): the UTC offset (minutes) at the record's time when it was first observed;
-- its month is bucketed with it, so a later time-zone change moves nothing. NULL (rows stored before) = the process zone.
ALTER TABLE usage ADD COLUMN utc_offset INTEGER;
ALTER TABLE turns ADD COLUMN utc_offset INTEGER;
ALTER TABLE usage_history ADD COLUMN utc_offset INTEGER;
