-- 018 (XAIBO-PROD-510, P5-T01c; design §6.5.1): cwd-fallback map groups are sessions without a repository key, grouped
-- and paged by cwd; this index serves that keyset (repo_key IS NULL AND cwd > ? ORDER BY cwd) without a scan or sort.
CREATE INDEX sessions_cwd ON sessions (repo_key, cwd);
