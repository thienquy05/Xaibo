-- 017 (XAIBO-PROD-509, P5-T02c review): Codex context fragments written as user-role messages (environment context,
-- AGENTS.md instructions, skills, user shell commands, turn aborted, subagent notifications, context window guidance,
-- rollout budget, realtime conversation; codex/parse.ts CONTEXT_PREFIXES) are injected, never prompts. New rows get the
-- flag at parse time; this marks rows stored before the rule, matched on the left-trimmed text. FTS is external content
-- and does not depend on the flag. Keep the list in step with CONTEXT_PREFIXES.
UPDATE events SET injected = 1
WHERE injected = 0 AND source = 'rollout' AND kind = 'message' AND role = 'user' AND content IS NOT NULL
  AND session_id IN (SELECT id FROM sessions WHERE agent = 'codex')
  AND EXISTS (SELECT 1 FROM (VALUES ('<environment_context>'), ('# AGENTS.md instructions'), ('<skill>'), ('<user_shell_command>'),
    ('<turn_aborted>'), ('<subagent_notification>'), ('<context_window_guidance>'), ('<rollout_budget>'), ('<realtime_conversation>')) AS p
    WHERE substr(ltrim(content, ' ' || char(9, 10, 13)), 1, length(p.column1)) = p.column1);
