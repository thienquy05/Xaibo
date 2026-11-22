-- 021 (XAIBO-PROD-514, P5-T06; FR-52, US-20): the agent of a frozen quota peak (from its usage scope), so the monthly
-- agent filter reaches quota as it does usage. An agent id is a catalog name, not an identifier. A model filter never
-- applies to quota (peaks are not attributed to models). Rows frozen before this migration keep agent '' (their scope
-- key is opaque, so no backfill); 020 and 021 ship together, so a released store has none.
ALTER TABLE monthly_quota_peaks ADD COLUMN agent TEXT NOT NULL DEFAULT '';
