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
  raw TEXT,
  UNIQUE (session_id, source, native_id)
);
CREATE INDEX events_seq ON events (session_id, source_seq);
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
  drift INTEGER NOT NULL DEFAULT 0,
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
  agent_type TEXT,
  UNIQUE (session_id, native_id)
);
