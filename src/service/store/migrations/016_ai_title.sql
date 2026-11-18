-- 016 (XAIBO-PROD-507, P5-T02a; D-P5-03): Claude's generated title apart from the user's rename, so an ai-title record
-- re-appended on resume never replaces a rename. title holds the rename (custom-title.customTitle), ai_title the
-- generated title (ai-title.aiTitle); the row shows coalesce(title, ai_title). Sessions ingested before this migration
-- take their latest stored main-transcript record of each kind (non-empty text only; malformed raw is skipped).
ALTER TABLE sessions ADD COLUMN ai_title TEXT;
UPDATE sessions SET
  title = coalesce(title, (SELECT t FROM (SELECT e.id, CASE WHEN json_valid(e.raw) THEN CASE WHEN json_type(e.raw, '$.customTitle') = 'text'
      THEN json_extract(e.raw, '$.customTitle') END END AS t
    FROM events e WHERE e.session_id = sessions.id AND e.kind = 'custom-title' AND e.source = 'transcript' AND e.subagent_native_id IS NULL)
    WHERE trim(t) <> '' ORDER BY id DESC LIMIT 1)),
  ai_title = (SELECT t FROM (SELECT e.id, CASE WHEN json_valid(e.raw) THEN CASE WHEN json_type(e.raw, '$.aiTitle') = 'text'
      THEN json_extract(e.raw, '$.aiTitle') END END AS t
    FROM events e WHERE e.session_id = sessions.id AND e.kind = 'ai-title' AND e.source = 'transcript' AND e.subagent_native_id IS NULL)
    WHERE trim(t) <> '' ORDER BY id DESC LIMIT 1)
WHERE agent = 'claude';
