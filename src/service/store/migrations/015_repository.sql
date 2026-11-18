-- 015 (XAIBO-PROD-506, P5-T01b; FR-53, S-37): a session's repository grouping, set once by the writer when the session's cwd
-- is first stored (resolveRepository, git metadata only) and never regrouped. repo_key is the canonical common git
-- directory, worktree the canonical worktree root; repo_reason says why a stored cwd has no key (no-git, unreadable,
-- inconsistent, back-pointer, not-repository). No backfill: sessions stored before this migration stay ungrouped (Q24).
ALTER TABLE sessions ADD COLUMN repo_key TEXT;
ALTER TABLE sessions ADD COLUMN worktree TEXT;
ALTER TABLE sessions ADD COLUMN repo_reason TEXT;
CREATE INDEX sessions_repo ON sessions (repo_key, worktree);
