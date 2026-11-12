-- 005 (Gate 2 review fixes, XAIBO-PROD-215).
-- G2-5: revisions read only current rows of a session in source order, so an agy replay stays linear.
CREATE INDEX events_current_seq ON events (session_id, source, source_seq) WHERE revision_status = 'current';
-- G2-6: which source supplied the stored tool name, so merging never depends on arrival order (EC-10).
ALTER TABLE tool_calls ADD COLUMN tool_source TEXT;
-- G2-2: an estimate whose evidence changed after pricing (usage values, a Codex tier) is re-priced with its own revision.
ALTER TABLE cost_estimates ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
CREATE INDEX cost_estimates_dirty ON cost_estimates (session_id) WHERE dirty = 1;
