-- 013 (XAIBO-PROD-453, G4b-2 follow-up; FR-51): report model evidence is stale only against a newer stored delivery that
-- carried a model; a newer frame without one says nothing about the model. has_model marks those deliveries (backfilled
-- from the stored report events, whose raw keeps the frame's model) and report_delivery_seq becomes a partial index over
-- them, so the read stays one index lookup. CASE fixes the order: other sources' raw (an oversized record's raw chunk) is not
-- always JSON, and AND terms have no guaranteed evaluation order.
-- ponytail: the backfill reads events once (no index leads with source); fine under the upgrade's backup and space check.
ALTER TABLE report_delivery ADD COLUMN has_model INTEGER NOT NULL DEFAULT 0 CHECK (has_model IN (0, 1));
UPDATE report_delivery SET has_model = 1 WHERE registration_id || ':' || delivery_id IN
  (SELECT native_id FROM events WHERE CASE WHEN source = 'report' THEN json_extract(raw, '$.model.id') END IS NOT NULL);
DROP INDEX report_delivery_seq;
CREATE INDEX report_delivery_seq ON report_delivery (registration_id, producer_id, native_session_id, producer_seq) WHERE has_model = 1;
