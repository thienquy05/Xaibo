-- 003: source time of the session's current model evidence (P2-T08, FR-51, EC-101). The current model/effort change
-- only for evidence at least as new as this; a delayed older record never reverts newer state. NULL = no timed evidence.
ALTER TABLE sessions ADD COLUMN current_model_ts INTEGER;
