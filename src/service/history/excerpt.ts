// XAIBO-PROD-509 (P5-T02c, EC-66) / Gate 5 round 2 A (owner decision 2026-11-20, M12/M13 at TP): an untitled session's
// first prompt, in-app only (never in notifications, logs or diagnostics). It is computed by the writer when a batch
// can change it and stored on the session (migration 025), so list, delta and live-set reads never walk events. Rule:
// among the first PROMPT_SCAN visible user records (current, not injected, not a subagent's, not chunk storage) by
// source_seq, the first the transcript classifier calls a prompt; whitespace collapsed, cut to EXCERPT_MAX code points.
// Gate 5 G5b2-3: a record over EXCERPT_RECORD_MAX bytes is skipped in the query, never loaded or parsed. ponytail: a
// session whose only prompts are that large shows no excerpt; store a bounded prompt prefix at ingest if that matters.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { classifyItem } from '../transcript.ts';

export const EXCERPT_MAX = 120;
const PROMPT_SCAN = 8;
const EXCERPT_RECORD_MAX = 128 * 1024;
/** A session's visible main-transcript records (parameter: session id). */
export const VISIBLE = `e.session_id = ? AND e.source IN ('transcript', 'rollout') AND e.subagent_native_id IS NULL AND e.revision_status = 'current' AND e.injected = 0
  AND e.kind NOT IN ('content-chunk', 'raw-chunk')`;

/** At most `max` code points, the last an ellipsis when cut. */
export const cutPoints = (s: string, max: number) => { const cp = [...s]; return cp.length <= max ? s : `${cp.slice(0, max - 1).join('')}…`; };

const statements = new WeakMap<DatabaseSync, StatementSync>(); // prepared once per connection
/** The excerpt as it follows from the stored records now; null when there is none; undefined when the store could not
 *  be read (round 2 review: unknown, so a stored excerpt is kept). */
export function computeExcerpt(db: DatabaseSync, agent: string, session: number | bigint): string | null | undefined {
  try {
    let q = statements.get(db);
    if (!q) statements.set(db, q = db.prepare(`SELECT e.kind, e.role, e.content, e.raw FROM events e WHERE ${VISIBLE} AND (e.role = 'user' OR e.kind = 'user')
      AND coalesce(octet_length(e.content), 0) <= ${EXCERPT_RECORD_MAX} AND coalesce(octet_length(e.raw), 0) <= ${EXCERPT_RECORD_MAX} ORDER BY e.source_seq, e.id LIMIT ${PROMPT_SCAN}`));
    for (const row of q.iterate(session) as Iterable<{ kind: string; role: string | null; content: string | null; raw: string | null }>) {
      const it = classifyItem({ agent, kind: row.kind, role: row.role, injected: false, content: row.content, raw: row.raw });
      if (it?.kind !== 'prompt' || !it.text) continue;
      // a bounded prefix (a prompt can be megabytes); a surrogate half left by the slice is dropped
      const t = it.text.slice(0, 8 * EXCERPT_MAX).replace(/[\uD800-\uDBFF]$/, '').replace(/\s+/g, ' ').trim();
      if (t) return cutPoints(it.text.length > 8 * EXCERPT_MAX ? `${t}…` : t, EXCERPT_MAX);
    }
  } catch { return undefined; }
  return null;
}

/** Migration 025: every existing session's excerpt, except a session an uncleared suppression marker keeps out (its purge
 *  is under way). Inside the migration's transaction. ponytail: one bounded query per session, a no-prompt session walks
 *  its records once here. */
export function backfillExcerpts(db: DatabaseSync): void {
  const set = db.prepare('UPDATE sessions SET excerpt = ? WHERE id = ?');
  const rows = db.prepare(`SELECT s.id, s.agent FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM suppressions x WHERE x.agent = s.agent
    AND x.profile_id = s.profile_id AND x.native_session_id = s.native_session_id AND x.cleared_at IS NULL)`).all() as { id: number; agent: string }[];
  for (const r of rows) { const e = computeExcerpt(db, r.agent, r.id); if (e != null) set.run(e, r.id); }
}
