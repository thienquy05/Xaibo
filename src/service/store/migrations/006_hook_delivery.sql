-- 006 (P3-T04, XAIBO-PROD-304): hook delivery dedup and hook-only coverage gaps.
-- One row per delivery_id ever committed, live or replayed (EC-09, PRD §5.5). An attributed delivery also has an events
-- row (source 'hook', native_id = delivery_id); an unattributed one (unknown profile, no session id) has only this row.
CREATE TABLE hook_delivery (
  delivery_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  native_session_id TEXT,
  event TEXT NOT NULL,
  received_ts INTEGER NOT NULL,
  committed_ts INTEGER NOT NULL,
  unattributed TEXT CHECK (unattributed IN ('unknown-profile', 'no-session'))
);
-- Hook deliveries known to be missing (EC-12, EC-44): per {agent, session, time range}; NULL agent/session/time when
-- the source cannot say, NULL count when the number is unknown. The locator makes each gap idempotent.
CREATE TABLE hook_gaps (
  id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('spool-overflow', 'spool-saturated', 'spool-torn', 'disk-full')),
  agent TEXT,
  native_session_id TEXT,
  from_ts INTEGER,
  to_ts INTEGER,
  count INTEGER,
  locator TEXT NOT NULL UNIQUE,
  recorded_at INTEGER NOT NULL
);
