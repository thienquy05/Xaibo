-- 004 (P2-T14): the latest-turn model lookup (writer latestTurnModel) reads a session's turns by start time; without
-- this index each lookup sorted the session's turns (37 s of a 100 s mixed-corpus import, M3 full).
CREATE INDEX turns_started ON turns (session_id, started_at);
