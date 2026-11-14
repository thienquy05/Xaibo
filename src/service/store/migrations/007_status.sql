-- 007 (P3-T08, XAIBO-PROD-308): live-status evidence. One row per observation the status engine accepted, keyed for
-- dedup by delivery id (hooks, reports) or file:offset (native files). `ev` is the normalized evidence list (kinds, ids,
-- usage numbers): never payload content. A restarted engine rebuilds each session's status from these rows in
-- (ts, rank, seq) order (PRD §5.5 causal ordering, §6.1-§6.3).
CREATE TABLE status_evidence (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  dedup TEXT NOT NULL,
  ts INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'inferred')),
  ev TEXT NOT NULL,
  UNIQUE (agent, native_session_id, dedup)
);
