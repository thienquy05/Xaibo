-- 010 (P3-T15, XAIBO-PROD-319; PRD §5.11, EC-91, EC-92): usage scopes and the minute-capped quota history.
-- account_epoch: the Codex account marker (HMAC under the install's secret salt, never the raw id; review M1/M2).
ALTER TABLE sessions ADD COLUMN account_epoch TEXT;

-- One scope per (profile, agent, marker) when a Codex marker exists, else per (profile, agent, session), unverified.
-- scope_key = JSON [profile_id, agent, epoch|null, native session|null]; profiles never merge.
CREATE TABLE usage_scopes (
  id INTEGER PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  agent TEXT NOT NULL,
  epoch TEXT,
  session_id INTEGER REFERENCES sessions(id),
  verified INTEGER NOT NULL CHECK (verified IN (0, 1))
);

-- limit_id = the stream ('five_hour', 'seven_day', '<codex limit id>:primary|secondary'). as_of = source time (NULL =
-- unknown: Claude); measured_at = as_of, else the first observation (age and retention basis); minute = its UTC minute.
-- Ordinary samples: at most one per minute per scope and stream (latest measured kept); transitions (reset, window or
-- plan change) are kept apart, capped at one per minute too (review H1). No interpolated rows.
CREATE TABLE usage_history (
  id INTEGER PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  usage_scope_id INTEGER NOT NULL REFERENCES usage_scopes(id),
  limit_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sample', 'transition')),
  minute INTEGER NOT NULL,
  used_percent REAL,
  window_minutes INTEGER,
  resets_at INTEGER,
  plan TEXT,
  credits TEXT,
  as_of INTEGER,
  first_observed_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  measured_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_locator TEXT NOT NULL
);
CREATE UNIQUE INDEX usage_history_minute ON usage_history (usage_scope_id, limit_id, kind, minute);
CREATE INDEX usage_history_stream ON usage_history (usage_scope_id, limit_id, measured_at);
