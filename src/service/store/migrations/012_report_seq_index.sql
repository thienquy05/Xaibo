-- 012 (XAIBO-PROD-442, G4b-2 review M1; FR-51): report intake reads the newest producer_seq per (registration, producer,
-- native session) before committing a model frame; this makes that read one index lookup instead of a walk of every
-- delivery the registration ever stored.
CREATE INDEX report_delivery_seq ON report_delivery (registration_id, producer_id, native_session_id, producer_seq);
