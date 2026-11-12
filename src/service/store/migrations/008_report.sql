-- 008 (P3-T13b, XAIBO-PROD-314): report v1 transport. One row per (registration, delivery_id) ever committed (PRD §5.10
-- dedup); an attributed one also has an events row (source 'report', native_id '<registration>:<delivery_id>').
CREATE TABLE report_delivery (
  registration_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  event TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  producer_seq INTEGER NOT NULL,
  received_ts INTEGER NOT NULL,
  committed_ts INTEGER NOT NULL,
  unattributed TEXT CHECK (unattributed IN ('unknown-profile')),
  PRIMARY KEY (registration_id, delivery_id)
);
-- Full content.upsert items (FR-08, EC-82): pending while chunks arrive (shown as incomplete), complete once every chunk
-- was durable (content set), incomplete when a quota stopped assembly (content NULL). Never downgraded once settled.
CREATE TABLE report_content (
  registration_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'incomplete')),
  chunks INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  content TEXT,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (registration_id, native_session_id, item_id, revision)
);
-- Rejected report frames as explicit coverage: one row per registration and fixed code, counted.
CREATE TABLE report_rejects (
  registration_id TEXT NOT NULL,
  code TEXT NOT NULL,
  count INTEGER NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  PRIMARY KEY (registration_id, code)
);
