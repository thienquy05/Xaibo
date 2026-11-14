-- xaibo: foreign_keys off
-- 009 (P3-T13b2, XAIBO-PROD-315): a report registration for an agent outside the catalog gets its own profile (origin
-- 'registration', root 'registration:<registration id>', a label that is never dereferenced). SQLite cannot change a
-- CHECK in place, so profiles is rebuilt by the documented procedure: the runner turns foreign keys off for this
-- migration and verifies every reference with foreign_key_check before the commit.
CREATE TABLE profiles_new (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  root TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('default', 'env', 'manual', 'registration')),
  UNIQUE (agent, root)
);
INSERT INTO profiles_new (id, agent, root, origin) SELECT id, agent, root, origin FROM profiles;
DROP TABLE profiles;
ALTER TABLE profiles_new RENAME TO profiles;
