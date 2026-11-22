-- 020 (XAIBO-PROD-512, P5-T04; FR-52): frozen monthly totals and the content-free markers of what they already hold.
-- Keys are opaque (HMAC with the per-install secret): no profile ids, session ids, paths, names or locators. month is the
-- local calendar month at event time ('YYYY-MM'); each settled key keeps the UTC offset used for its bucket. Rows change
-- only through settle() (and Clear usage history, P5-T16); there is no automatic expiry.
CREATE TABLE monthly_usage (
  month TEXT NOT NULL,
  agent TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  model_id TEXT NOT NULL,              -- '' = model unavailable
  sessions INTEGER NOT NULL DEFAULT 0, -- sessions that used this model in the month
  turns INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  uncached_input INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  token_gaps INTEGER NOT NULL DEFAULT 0, -- requests with a missing component (known subtotal kept)
  cost_micros INTEGER,                   -- known subtotal of per-request estimates in micro-USD (exact sums); NULL = none priced
  cost_full INTEGER NOT NULL DEFAULT 0,
  cost_partial INTEGER NOT NULL DEFAULT 0,
  cost_none INTEGER NOT NULL DEFAULT 0,
  cost_pending INTEGER NOT NULL DEFAULT 0,
  price_revisions TEXT NOT NULL DEFAULT '[]', -- price revision ids that priced the subtotal
  PRIMARY KEY (month, agent, profile_key, model_id)
) WITHOUT ROWID;
CREATE TABLE monthly_sessions (
  month TEXT NOT NULL,
  agent TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  sessions INTEGER NOT NULL DEFAULT 0, -- distinct sessions across models
  PRIMARY KEY (month, agent, profile_key)
) WITHOUT ROWID;
CREATE TABLE monthly_quota_peaks (
  month TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  limit_id TEXT NOT NULL,
  window_minutes INTEGER NOT NULL, -- -1 = window length unknown
  verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
  peak_percent REAL NOT NULL,
  observations INTEGER NOT NULL,
  PRIMARY KEY (month, scope_key, limit_id, window_minutes)
) WITHOUT ROWID;
CREATE TABLE settled_contributions (
  key TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  utc_offset INTEGER NOT NULL,
  settled_at INTEGER NOT NULL,
  cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1))
) WITHOUT ROWID;
