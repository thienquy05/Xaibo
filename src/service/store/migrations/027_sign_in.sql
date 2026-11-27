-- 027 (P6-T01a slice 2, XAIBO-PROD-571; S-38, FR-54, EC-109; design .handoff/p6-t01a-design.md, security review 3636):
-- per-profile sign-in state, created on the first change (no row = Unknown, generation 0, nothing invented); the usage
-- epoch boundaries it starts (opaque fields only; at most 256 per profile, enforced in usage/sign-in-state.ts); the
-- generation of each usage scope and event. Existing scopes and events stay generation 0 with their keys unchanged.
CREATE TABLE profile_sign_in (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 256),
  boundary_method TEXT NOT NULL CHECK (boundary_method IN ('subscription', 'api-key', 'cloud-provider', 'gateway', 'mixed', 'unknown')),
  boundary_at INTEGER,
  declared_method TEXT CHECK (declared_method IN ('subscription', 'api-key', 'cloud-provider', 'gateway', 'mixed', 'unknown')),
  declared_at INTEGER,
  output_method TEXT CHECK (output_method IN ('subscription', 'api-key', 'cloud-provider', 'gateway', 'mixed')),
  output_source TEXT CHECK (output_source IN ('claude-statusline', 'claude-transcript', 'codex-rollout', 'agy-transcript')),
  output_version TEXT CHECK (length(output_version) <= 64),
  output_rule_id TEXT CHECK (length(output_rule_id) <= 64),
  output_observed_at INTEGER,
  output_source_at INTEGER,
  output_order_at INTEGER,
  output_ambiguous INTEGER CHECK (output_ambiguous IN (0, 1)),
  CHECK ((declared_method IS NULL) = (declared_at IS NULL)),
  CHECK ((output_method IS NULL) = (output_source IS NULL) AND (output_method IS NULL) = (output_version IS NULL)
    AND (output_method IS NULL) = (output_rule_id IS NULL) AND (output_method IS NULL) = (output_observed_at IS NULL)
    AND (output_method IS NULL) = (output_source_at IS NULL) AND (output_method IS NULL) = (output_order_at IS NULL)
    AND (output_method IS NULL) = (output_ambiguous IS NULL))
);
CREATE TABLE sign_in_boundaries (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 256),
  revision INTEGER NOT NULL CHECK (revision > 0),
  at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('method', 'declared-account')),
  method TEXT NOT NULL CHECK (method IN ('subscription', 'api-key', 'cloud-provider', 'gateway', 'mixed', 'unknown')),
  PRIMARY KEY (profile_id, generation)
);
CREATE INDEX sign_in_boundaries_time ON sign_in_boundaries (profile_id, at, generation);
-- review L3: adding a checked column scans the existing rows once (covered by the migration space check)
ALTER TABLE usage_scopes ADD COLUMN sign_in_generation INTEGER NOT NULL DEFAULT 0 CHECK (sign_in_generation >= 0);
ALTER TABLE events ADD COLUMN sign_in_generation INTEGER NOT NULL DEFAULT 0 CHECK (sign_in_generation >= 0);
