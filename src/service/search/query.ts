// XAIBO-PROD-521 (P5-T14; PRD §5.7, design §6.4, Q-5.3, EC-58): scoped, paged search over event_fts (FTS5, unicode61).
// User text becomes quoted terms ANDed together, so no input can reach FTS query syntax. One hit per session: its
// best-ranked event (rank = bm25, lower is better), keyset-paged on (rank, session id). Scope is the session list filter
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
export interface SearchKey { rank: number; session: number }

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

/** One page of sessions matching `input` within the filter, best match first. Reads in one short read transaction. */
export function searchSessions(db: DatabaseSync, input: string, f: HistoryFilter, cursor: SearchKey | null, limit: number): { hits: SearchHit[]; next: SearchKey | null } {
  const q = ftsQuery(input);
  const overlay = has(db, 'overlays');
  if (!q || (!overlay && (f.mode !== 'all' || f.project !== null || f.folder !== null || f.group))) return { hits: [], next: null };
  const n = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : PAGE_DEFAULT, PAGE_MAX);
  const s = scopeWhere(f, overlay);
  const where = [...s.where, "e.revision_status = 'current'", 'e.injected = 0'];
  if (has(db, 'suppressions')) where.push(`NOT EXISTS (SELECT 1 FROM suppressions x WHERE x.agent = s.agent AND x.profile_id = s.profile_id
    AND x.native_session_id = s.native_session_id AND x.cleared_at IS NULL)`);
  const joins = overlay ? 'LEFT JOIN overlays o ON o.agent = s.agent AND o.profile_id = s.profile_id AND o.native_session_id = s.native_session_id' : '';
  // ponytail: each page groups every match of the query (O(matches)); a rank shift from writes between pages can repeat or
  // skip a session at a page edge. Fine at the TP corpus; precompute per-query results if M13 shows search pages slow.
  // The bare e.id beside min() is the event of the best rank (SQLite's min/max bare-column rule).
  // review L1: min(m.rank) spelled out in HAVING (a bare `rank` would be the column, right only by the bare-column rule)
  const sql = `SELECT e.session_id AS session, e.id AS event, min(m.rank) AS best FROM (SELECT rowid AS id, rank FROM event_fts WHERE event_fts MATCH ?) m
    JOIN events e ON e.id = m.id JOIN sessions s ON s.id = e.session_id ${joins}
    WHERE ${where.join(' AND ')} GROUP BY e.session_id ${cursor ? 'HAVING min(m.rank) > ? OR (min(m.rank) = ? AND e.session_id > ?)' : ''} ORDER BY best, session LIMIT ?`;
  const args = [q, ...s.args, ...(cursor ? [cursor.rank, cursor.rank, cursor.session] : []), n];
  const terms = termsOf(input);
  const began = !db.isTransaction;
  if (began) db.exec('BEGIN'); // page and snippets from one snapshot
  try {
    const rows = db.prepare(sql).all(...args) as { session: number; event: number; best: number }[];
    const head = db.prepare(`SELECT substr(content, 1, ${SNIPPET_SCAN}) AS t FROM events WHERE id = ?`);
    const hits = rows.map((r) => ({ session: r.session, event: r.event, rank: r.best, snippet: snippetOf(String((head.get(r.event) as { t: unknown } | undefined)?.t ?? ''), terms) }));
    const last = hits.at(-1);
    return { hits, next: hits.length === n && last ? { rank: last.rank, session: last.session } : null };
  } finally { if (began && db.isTransaction) db.exec('COMMIT'); } // review L4: SQLite may have rolled back already
}
