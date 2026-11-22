// XAIBO-PROD-521 (P5-T14; PRD §5.7, design §6.4, Q-5.3, EC-58): scoped, paged search over event_fts (FTS5, unicode61).
// User text becomes quoted terms ANDed together, so no input can reach FTS query syntax. One hit per session: its
// best-ranked event (rank = bm25, lower is better), keyset-paged on (rank, session id); bounded scan, round 2 B below. Scope is the session list filter
// (scopeWhere: All leaves Trash out and keeps archived; Archived/Trash restrict); a suppressed session (uncleared marker)
// never appears; injected and non-current events never match. Snippets are plain text (no markup), at most SNIPPET_MAX
// characters. EC-58 baseline: unicode61 keeps a CJK run without spaces as one token (the whole run matches, a substring
// misses), treats emoji as separators (an emoji-only query finds nothing) and folds case and diacritics; a trigram index
// is the later option.
import type { DatabaseSync } from 'node:sqlite';
import { hasTable, pageSize } from '../api.ts';
import { needsOverlay, scopeWhere } from '../history/overlay.ts';
import { notPurging } from '../history/suppression.ts';
import { QUERY_MAX, SNIPPET_MAX, type HistoryFilter, type SearchKey } from '../../shared/ipc.ts';

export const QUERY_MAX_TERMS = 16;
// Review M1: snippet() re-tokenizes a hit's whole stored content (an event up to the 8 MiB parse cap: ~450 ms when a term
// repeats through it), so the snippet is cut from this many leading characters instead.
const SNIPPET_SCAN = 16_384, SNIPPET_LEAD = 60;

export interface SearchHit { session: number; event: number; snippet: string; rank: number }

/** The FTS5 query for user text: each whitespace-separated term as a quoted string (inner quotes doubled), at most
 *  QUERY_MAX_TERMS terms from the first QUERY_MAX characters; control characters separate terms. null = nothing to find. */
export function ftsQuery(input: string): string | null {
  const terms = termsOf(input);
  return terms.length ? terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' ') : null;
}

function termsOf(input: string): string[] {
  // review L3: bound the input before any whole-string work (2x keeps every code point of the first QUERY_MAX)
  const text = [...input.slice(0, 2 * QUERY_MAX).replace(/\p{Cc}/gu, ' ')].slice(0, QUERY_MAX).join('');
  return text.split(/\s+/u).filter(Boolean).slice(0, QUERY_MAX_TERMS);
}

/** A plain-text window of at most SNIPPET_MAX characters around the first literal (case-insensitive) occurrence of a
 *  term in `text`, whitespace collapsed; the start of the text when none is found (a folded or later match). */
export function snippetOf(text: string, terms: string[]): string {
  const t = text.replace(/\s+/gu, ' ').trim();
  const re = terms.length ? new RegExp(terms.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'iu') : null;
  let from = Math.max(0, (re?.exec(t)?.index ?? 0) - SNIPPET_LEAD);
  if (/[\uDC00-\uDFFF]/.test(t[from] ?? '')) from++; // never start inside a surrogate pair
  const lead = from > 0 ? '…' : '';
  const rest = [...t.slice(from)], room = SNIPPET_MAX - lead.length;
  return lead + (rest.length <= room ? rest.join('') : `${rest.slice(0, room - 1).join('')}…`);
}

// Gate 5 round 2 B (owner decision 2026-11-20; M13 at TP: common-term pages took seconds grouping every match): matches
// are read best rank first (FTS5 consumes ORDER BY rank: no sort, no grouping), injected and non-current events left out
// in the scan. Round 3 G5Ss1-2 (decision 3002): every match read counts toward the bounds, hidden or not, so a term whose
// matches are mostly hidden never scans the corpus; the session's visibility (scope, Trash, mode, a purge under way, an
// uncleared marker: the list's own predicates) is one prepared point query per session, remembered for the call. A page
// stops once it has `limit` visible sessions, or after SEARCH_SCAN_MAX matches past the cursor (then `capped`: results
// may be incomplete; `next` continues, even from an empty page), ties included. A match's position is (rank, event
// rowid): FTS5 returns equal ranks in rowid order (checked on 200k ties), so the cursor (rank, session, event) of the last
// match read continues exactly there (its session: the last visible one read, else 0; never a hidden id); the matches up
// to it are read again (ids only, up to SEARCH_SKIP_MAX, each counted) so a session shown on an earlier page never
// returns through a worse match. ponytail: fixed bounds; a tie seen out of rowid order flags the page capped (its
// continuation may then pass a session over); deep Load more re-reads earlier pages' matches, hidden ones included, and
// past SEARCH_SKIP_MAX ends capped with no next (matches ranked below that many are out of reach: refine the query); a
// rank shift from writes between pages can still repeat or skip a session at a page edge, and a session that becomes
// visible between pages (a marker cleared, a restore) can be passed over for that query; next.rank/event may be a hidden
// match's position (a score and a rowid, no content).
export const SEARCH_SCAN_MAX = 2000;
export const SEARCH_SKIP_MAX = 25 * SEARCH_SCAN_MAX;
/** Matches examined past the cursor by the last searchSessions call, hidden ones included (tests check the bound). */
export const searchStats = { examined: 0 };

/** One page of sessions matching `input` within the filter, best match first. Reads in one short read transaction. */
export function searchSessions(db: DatabaseSync, input: string, f: HistoryFilter, cursor: SearchKey | null, limit: number): { hits: SearchHit[]; next: SearchKey | null; capped?: true } {
  searchStats.examined = 0;
  const q = ftsQuery(input);
  const overlay = hasTable(db, 'overlays');
  if (!q || (!overlay && needsOverlay(f))) return { hits: [], next: null };
  const n = pageSize(limit);
  const s = scopeWhere(f, overlay);
  const where = [...s.where, notPurging(db)];
  if (hasTable(db, 'suppressions')) where.push(`NOT EXISTS (SELECT 1 FROM suppressions x WHERE x.agent = s.agent AND x.profile_id = s.profile_id
    AND x.native_session_id = s.native_session_id AND x.cleared_at IS NULL)`);
  const joins = overlay ? 'LEFT JOIN overlays o ON o.agent = s.agent AND o.profile_id = s.profile_id AND o.native_session_id = s.native_session_id' : '';
  const sql = `SELECT e.session_id AS session, m.rowid AS event, m.rank AS rank FROM event_fts m JOIN events e ON e.id = m.rowid
    WHERE event_fts MATCH ? AND e.revision_status = 'current' AND e.injected = 0 ORDER BY m.rank`;
  const terms = termsOf(input);
  const began = !db.isTransaction;
  if (began) db.exec('BEGIN'); // page and snippets from one snapshot
  try {
    const visibleQ = db.prepare(`SELECT 1 FROM sessions s ${joins} WHERE s.id = ? AND ${where.join(' AND ')}`);
    const known = new Map<number, boolean>();
    const visible = (session: number) => {
      let v = known.get(session);
      if (v === undefined) known.set(session, v = visibleQ.get(session, ...s.args) !== undefined);
      return v;
    };
    const shown = new Set<number>(); // visible sessions at or before the cursor: on an earlier page
    const page = new Map<number, { event: number; rank: number }>(); // in scan order: best position first
    type M = { session: number; event: number; rank: number };
    let skipped = 0, capped = false, last: M | null = null, lastVisible = 0;
    for (const r of db.prepare(sql).iterate(q) as Iterable<M>) {
      if (cursor && (r.rank < cursor.rank || (r.rank === cursor.rank && r.event <= cursor.event))) {
        if (++skipped > SEARCH_SKIP_MAX) return { hits: [], next: null, capped: true };
        if (visible(r.session)) shown.add(r.session);
        continue;
      }
      if (page.size >= n) break;
      if (searchStats.examined >= SEARCH_SCAN_MAX) { capped = true; break; }
      if (last && r.rank === last.rank && r.event < last.event) capped = true; // ties out of rowid order: may be incomplete
      searchStats.examined++;
      last = r;
      if (!visible(r.session)) continue;
      lastVisible = r.session;
      if (shown.has(r.session) || page.has(r.session)) continue;
      page.set(r.session, { event: r.event, rank: r.rank });
    }
    const best = [...page].map(([session, x]) => ({ session, ...x }));
    const head = db.prepare(`SELECT substr(content, 1, ${SNIPPET_SCAN}) AS t FROM events WHERE id = ?`);
    const hits = best.map((r) => ({ session: r.session, event: r.event, rank: r.rank, snippet: snippetOf(String((head.get(r.event) as { t: unknown } | undefined)?.t ?? ''), terms) }));
    // every match up to the last one read is on this page or an earlier one
    const next = (hits.length === n || capped) && last ? { rank: last.rank, session: lastVisible, event: last.event } : null;
    return { hits, next, ...(capped ? { capped: true as const } : {}) };
  } finally { if (began && db.isTransaction) db.exec('COMMIT'); } // review L4: SQLite may have rolled back already
}
