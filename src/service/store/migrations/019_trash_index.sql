-- 019 (XAIBO-PROD-511, P5-T03; FR-11, FR-12): the Trash list and the Trash auto-empty query (trashed_at <= now - 30 days,
-- oldest first) read overlays by deletion time; only trashed rows are indexed.
CREATE INDEX overlays_trashed ON overlays (trashed_at) WHERE trashed_at IS NOT NULL;
