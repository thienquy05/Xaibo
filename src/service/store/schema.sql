CREATE INDEX context_generation ON context_snapshots (session_id, generation);
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
  as_of INTEGER, dirty INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, covered_scope)
);
CREATE INDEX cost_estimates_dirty ON cost_estimates (session_id) WHERE dirty = 1;
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
CREATE VIRTUAL TABLE event_fts USING fts5 (content, content = 'events', content_rowid = 'id', tokenize = 'unicode61');
CREATE TABLE 'event_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
CREATE TABLE 'event_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
CREATE TABLE 'event_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE 'event_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  schema_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  native_id TEXT NOT NULL,
  parent_native_id TEXT,
  message_id TEXT,
  kind TEXT NOT NULL,
  role TEXT,
  subagent_native_id TEXT,
  file_id INTEGER REFERENCES source_files(id),
  byte_offset INTEGER,
  source_seq INTEGER NOT NULL,
  source_ts INTEGER,
  file_mtime INTEGER,
  received_ts INTEGER NOT NULL,
  ingest_id TEXT,
  injected INTEGER NOT NULL DEFAULT 0,
  content TEXT,
  raw TEXT, revision_status TEXT NOT NULL DEFAULT 'current' CHECK (revision_status IN ('current', 'superseded', 'rewound')),
  UNIQUE (session_id, source, native_id)
);
CREATE INDEX events_current_seq ON events (session_id, source, source_seq) WHERE revision_status = 'current';
CREATE INDEX events_seq ON events (session_id, source_seq);
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
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  root TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('default', 'env', 'manual')),
  UNIQUE (agent, root)
);
CREATE TABLE quarantine (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES source_files(id),
  byte_offset INTEGER NOT NULL,
  reason TEXT NOT NULL,
  raw BLOB,
  received_ts INTEGER NOT NULL,
  UNIQUE (file_id, byte_offset)
);
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
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  native_session_id TEXT NOT NULL,
  cwd TEXT,
  cwd_key TEXT,
  entrypoint TEXT,
  interactive INTEGER,
  title TEXT,
  started_at INTEGER,
  last_activity INTEGER,
  native_available INTEGER NOT NULL DEFAULT 1,
  record_count INTEGER NOT NULL DEFAULT 0,
  unknown_count INTEGER NOT NULL DEFAULT 0,
  quarantined_count INTEGER NOT NULL DEFAULT 0,
  drift INTEGER NOT NULL DEFAULT 0, originator TEXT, source_kind TEXT, native_archived INTEGER NOT NULL DEFAULT 0, current_model TEXT, current_effort TEXT, current_model_ts INTEGER,
  UNIQUE (agent, profile_id, native_session_id)
);
CREATE INDEX sessions_activity ON sessions (last_activity DESC, id);
CREATE TABLE source_files (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  session_id INTEGER REFERENCES sessions(id),
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  dev INTEGER,
  ino INTEGER,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER,
  offset INTEGER NOT NULL DEFAULT 0,
  head_hash TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'compressed_not_imported', 'gone', 'oversized'))
);
CREATE TABLE subagents (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  native_id TEXT NOT NULL,
  file_id INTEGER REFERENCES source_files(id),
  agent_type TEXT, model_id TEXT,
  UNIQUE (session_id, native_id)
);
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
  duration_ms INTEGER, tool_source TEXT,
  UNIQUE (session_id, native_call_id)
);
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
CREATE INDEX turns_started ON turns (session_id, started_at);
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
