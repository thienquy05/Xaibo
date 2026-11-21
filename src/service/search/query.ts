// XAIBO-PROD-521 (P5-T14; PRD §5.7, design §6.4, Q-5.3, EC-58): scoped, paged search over event_fts (FTS5, unicode61).
// User text becomes quoted terms ANDed together, so no input can reach FTS query syntax. One hit per session: its
// best-ranked event (rank = bm25, lower is better), keyset-paged on (rank, session id); bounded scan, round 2 B below. Scope is the session list filter
// (scopeWhere: All leaves Trash out and keeps archived; Archived/Trash restrict); a suppressed session (uncleared marker)
// never appears; injected and non-current events never match. Snippets are plain text (no markup), at most SNIPPET_MAX
// characters. EC-58 baseline: unicode61 keeps a CJK run without spaces as one token (the whole run matches, a substring
// misses), treats emoji as separators (an emoji-only query finds nothing) and folds case and diacritics; a trigram index
// is the later option.
import type { DatabaseSync } from 'node:sqlite';
import { PAGE_DEFAULT, PAGE_MAX } from '../api.ts';
import { scopeWhere } from '../history/overlay.ts';
import { FTS_MAX_BYTES } from '../store/writer.ts';
import type { HistoryFilter } from '../../shared/ipc.ts';

export const QUERY_MAX_CHARS = 256, QUERY_MAX_TERMS = 16, SNIPPET_MAX = 200;
// Review M1: snippet() re-tokenizes a hit's whole stored content (an event up to the 8 MiB parse cap: ~450 ms when a term
// repeats through it), so the snippet is cut from this many leading characters instead.
const SNIPPET_SCAN = 16_384, SNIPPET_LEAD = 60;
/** Design §6.4, shown below results. */
export const SEARCH_COVERAGE = 'Search covers retained indexed content; incomplete sources may have gaps';
/** PRD §5.7: the per-item index bound the UI states. */
export const SEARCH_ITEM_LIMIT = `Only the first ${FTS_MAX_BYTES / 1024} KiB of each item is searchable`;

export interface SearchHit { session: number; event: number; snippet: string; rank: number }
/** Gate 5 round 2 review: `event` = the rowid of the last match read (exact continuation inside equal-rank ties). */
export interface SearchKey { rank: number; session: number; event: number }

/** The FTS5 query for user text: each whitespace-separated term as a quoted string (inner quotes doubled), at most
 *  QUERY_MAX_TERMS terms from the first QUERY_MAX_CHARS characters; control characters separate terms. null = nothing to find. */
export function ftsQuery(input: string): string | null {
  const terms = termsOf(input);
  return terms.length ? terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' ') : null;
}

function termsOf(input: string): string[] {
  // review L3: bound the input before any whole-string work (2x keeps every code point of the first QUERY_MAX_CHARS)
  const text = [...input.slice(0, 2 * QUERY_MAX_CHARS).replace(/\p{Cc}/gu, ' ')].slice(0, QUERY_MAX_CHARS).join('');
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

const has = (db: DatabaseSync, table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;

// Gate 5 round 2 B (owner decision 2026-11-20; M13 at TP: common-term pages took seconds grouping every match): matches
// are read best rank first (FTS5 consumes ORDER BY rank: no sort, no grouping) with the scope, suppression and mode filters
// inside the scan, so filtered matches never count. A page stops once it has `limit` sessions, or after SEARCH_SCAN_MAX
// matches past the cursor (then `capped`: results may be incomplete; `next` continues), ties included. A match's position
// is (rank, event rowid): FTS5 returns equal ranks in rowid order (checked on 200k ties), so the cursor (rank, session,
// event) of the last match read continues exactly there; the rows up to it are read again (ids only, up to
// SEARCH_SKIP_MAX) so a session shown on an earlier page never returns through a worse match. ponytail: fixed bounds;
// a tie seen out of rowid order flags the page capped (its continuation may then pass a session over); deep Load more
// re-reads earlier pages' matches (bounded by SEARCH_SKIP_MAX, then capped with no next); a rank shift from writes
// between pages can still repeat or skip a session at a page edge.
export const SEARCH_SCAN_MAX = 2000;
const SEARCH_SKIP_MAX = 25 * SEARCH_SCAN_MAX;
/** Matches examined past the cursor by the last searchSessions call (tests check the bound). */
export const searchStats = { examined: 0 };

/** One page of sessions matching `input` within the filter, best match first. Reads in one short read transaction. */
export function searchSessions(db: DatabaseSync, input: string, f: HistoryFilter, cursor: SearchKey | null, limit: number): { hits: SearchHit[]; next: SearchKey | null; capped?: true } {
  searchStats.examined = 0;
  const q = ftsQuery(input);
  const overlay = has(db, 'overlays');
  if (!q || (!overlay && (f.mode !== 'all' || f.project !== null || f.folder !== null || f.group))) return { hits: [], next: null };
  const n = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : PAGE_DEFAULT, PAGE_MAX);
  const s = scopeWhere(f, overlay);
  const where = [...s.where, "e.revision_status = 'current'", 'e.injected = 0'];
  if (has(db, 'suppressions')) where.push(`NOT EXISTS (SELECT 1 FROM suppressions x WHERE x.agent = s.agent AND x.profile_id = s.profile_id
    AND x.native_session_id = s.native_session_id AND x.cleared_at IS NULL)`);
  const joins = overlay ? 'LEFT JOIN overlays o ON o.agent = s.agent AND o.profile_id = s.profile_id AND o.native_session_id = s.native_session_id' : '';
  const sql = `SELECT e.session_id AS session, m.rowid AS event, m.rank AS rank FROM event_fts m JOIN events e ON e.id = m.rowid JOIN sessions s ON s.id = e.session_id
    ${joins} WHERE event_fts MATCH ? AND ${where.join(' AND ')} ORDER BY m.rank`;
  const terms = termsOf(input);
  const began = !db.isTransaction;
  if (began) db.exec('BEGIN'); // page and snippets from one snapshot
  try {
    const shown = new Set<number>(); // sessions at or before the cursor: on an earlier page
    const page = new Map<number, { event: number; rank: number }>(); // in scan order: best position first
    type M = { session: number; event: number; rank: number };
    let skipped = 0, capped = false, last: M | null = null;
    for (const r of db.prepare(sql).iterate(q, ...s.args) as Iterable<M>) {
      if (cursor && (r.rank < cursor.rank || (r.rank === cursor.rank && r.event <= cursor.event))) {
        shown.add(r.session);
        if (++skipped > SEARCH_SKIP_MAX) return { hits: [], next: null, capped: true };
        continue;
      }
      if (page.size >= n) break;
      if (searchStats.examined >= SEARCH_SCAN_MAX) { capped = true; break; }
      if (last && r.rank === last.rank && r.event < last.event) capped = true; // ties out of rowid order: may be incomplete
      searchStats.examined++;
      last = r;
      if (shown.has(r.session) || page.has(r.session)) continue;
      page.set(r.session, { event: r.event, rank: r.rank });
    }
    const best = [...page].map(([session, x]) => ({ session, ...x }));
    const head = db.prepare(`SELECT substr(content, 1, ${SNIPPET_SCAN}) AS t FROM events WHERE id = ?`);
    const hits = best.map((r) => ({ session: r.session, event: r.event, rank: r.rank, snippet: snippetOf(String((head.get(r.event) as { t: unknown } | undefined)?.t ?? ''), terms) }));
    // every match up to the last one read is on this page or an earlier one
    const next = (hits.length === n || capped) && last ? { rank: last.rank, session: last.session, event: last.event } : null;
    return { hits, next, ...(capped ? { capped: true as const } : {}) };
  } finally { if (began && db.isTransaction) db.exec('COMMIT'); } // review L4: SQLite may have rolled back already
}
