-- 014 (XAIBO-PROD-504, P5-T01; FR-10, US-5): history overlay. Overlay state lives only here, keyed by the session
-- identity (agent, profile, native_session_id), never by path; native agent files are never touched. Names are checked
-- again by the service (NFC, no control or format characters); these CHECKs are the backstop.
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 200),
  created_at INTEGER NOT NULL
);
CREATE TABLE folders (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  UNIQUE (project_id, name)
);
CREATE TABLE overlays (
  agent TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived_at INTEGER,
  trashed_at INTEGER,
  keep INTEGER NOT NULL DEFAULT 0 CHECK (keep IN (0, 1)),
  PRIMARY KEY (agent, profile_id, native_session_id)
) WITHOUT ROWID;
CREATE INDEX overlays_project ON overlays (project_id, folder_id);
CREATE INDEX sessions_agent_activity ON sessions (agent, last_activity DESC, id);
