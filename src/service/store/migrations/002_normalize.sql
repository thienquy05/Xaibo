-- 002: normalized model (P2-T01; PRD §5.4-§5.6, §5.11, §5.12). Every new table carries its source identity and
-- schema_version; a missing value is NULL, never 0 (§5.6). Timestamps are integer milliseconds since the epoch.

ALTER TABLE sessions ADD COLUMN originator TEXT;
ALTER TABLE sessions ADD COLUMN source_kind TEXT;
ALTER TABLE sessions ADD COLUMN native_archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN current_model TEXT;
ALTER TABLE sessions ADD COLUMN current_effort TEXT;
ALTER TABLE subagents ADD COLUMN model_id TEXT;
-- Projection membership for revised or rewound content (EC-80); every Phase 1 row is current.
ALTER TABLE events ADD COLUMN revision_status TEXT NOT NULL DEFAULT 'current' CHECK (revision_status IN ('current', 'superseded', 'rewound'));

CREATE TABLE turns (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  schema_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  native_turn_id TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  outcome TEXT,
  model_id TEXT,
  effort TEXT,
  UNIQUE (session_id, native_turn_id)
);

-- One row per native call id (tool_use_id / call_id); sources = every source that reported it (EC-10).
CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  schema_version INTEGER NOT NULL,
  sources TEXT NOT NULL,
  native_call_id TEXT NOT NULL,
  tool TEXT,
  server TEXT,
  args_event_id INTEGER REFERENCES events(id),
  result_event_id INTEGER REFERENCES events(id),
  approval_state TEXT,
  duration_ms INTEGER,
  UNIQUE (session_id, native_call_id)
);

-- identity = request/counter identity (Claude message.id; Codex counter segment and position); token columns are
-- normalized components, raw keeps the original fields, completeness is per component (JSON).
CREATE TABLE usage (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  schema_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  identity TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('message', 'turn', 'session')),
  segment INTEGER,
  event_id INTEGER REFERENCES events(id),
  model_id TEXT,
  uncached_input INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  cache_write_classes TEXT,
  output INTEGER,
  raw TEXT,
  completeness TEXT,
  source_ts INTEGER,
  UNIQUE (session_id, source, scope, identity)
);

CREATE TABLE context_snapshots (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  schema_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  generation INTEGER NOT NULL,
  model_id TEXT,
  used_tokens INTEGER,
  window_tokens INTEGER,
  window_basis TEXT NOT NULL CHECK (window_basis IN ('reported', 'inferred', 'unavailable')),
  percentage REAL,
  source_locator TEXT,
  as_of INTEGER,
  observed_at INTEGER NOT NULL
);
CREATE INDEX context_generation ON context_snapshots (session_id, generation);

-- Accepted price tables are immutable calculation provenance (§5.12); referenced rows are also held by the FK.
CREATE TABLE price_revisions (
  id INTEGER PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('bundled', 'override')),
  revision TEXT NOT NULL,
  prices_as_of TEXT,
  content_hash TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  accepted_at INTEGER NOT NULL
);
CREATE TRIGGER price_revisions_immutable BEFORE UPDATE ON price_revisions
BEGIN SELECT RAISE(ABORT, 'price_revisions is immutable'); END;

-- One estimate per disjoint covered scope; amount_usd NULL = unavailable (a valid reported zero stays 0).
CREATE TABLE cost_estimates (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  schema_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  covered_scope TEXT NOT NULL,
  amount_usd REAL,
  basis TEXT NOT NULL CHECK (basis IN ('agent_reported', 'token_table', 'owner_fallback')),
  coverage TEXT,
  price_revision_id INTEGER REFERENCES price_revisions(id),
  applied_rates TEXT,
  unavailable_reason TEXT,
  as_of INTEGER,
  UNIQUE (session_id, covered_scope)
);

-- Raw Codex rate-limit observations only (OQ-P2-01); usage-scope/epoch attribution, minute sampling and staleness
-- are Phase 3. session_id is the originating session: provenance, not ownership of a shared quota.
CREATE TABLE usage_snapshots (
  id INTEGER PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  agent TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  session_id INTEGER REFERENCES sessions(id),
  source TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  limit_id TEXT,
  plan TEXT,
  credits TEXT,
  windows TEXT,
  quality TEXT,
  as_of INTEGER,
  observed_at INTEGER NOT NULL,
  UNIQUE (profile_id, source, source_locator)
);
CREATE INDEX usage_snapshots_limit ON usage_snapshots (profile_id, limit_id, as_of);

-- evidence = the correlating native id (e.g. the matching tool call id, EC-74).
CREATE TABLE session_links (
  id INTEGER PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  from_session_id INTEGER NOT NULL REFERENCES sessions(id),
  to_session_id INTEGER NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL,
  evidence TEXT,
  UNIQUE (from_session_id, to_session_id, kind)
);

-- ponytail: one row per distinct cwd per session (a return to an earlier cwd is not a new row); add a sequence if
-- the history view needs every move.
CREATE TABLE cwd_history (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  schema_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  cwd TEXT NOT NULL,
  cwd_key TEXT,
  first_seen INTEGER,
  UNIQUE (session_id, cwd)
);
