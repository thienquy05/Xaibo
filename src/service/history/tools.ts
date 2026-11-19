// XAIBO-PROD-527 (P5-T18 part 1; design §6.4, §6.6, US-5, US-6, FR-11, FR-12): the service side of the Session history
// tools and the Settings retention section. Search hits carry their history rows read in the same snapshot; suppressed
// (purged) sessions are listed newest first and addressed only by an opaque domain-separated HMAC key, so no profile id
// or native session id reaches the renderer; manual purge is capped per minute (D-P5-07: the in-app confirmation can be
// skipped by a compromised renderer; this cap and no batch form bound the damage); a successful Re-import sets Keep so
// retention does not purge the returning session again (D-P5-08). Purge and Re-import are synchronous on the service
// thread, so they never overlap; moving either to a worker needs a per-identity lock (design review L7).
import { createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MAX_ITEMS, PURGE_RESULTS, REIMPORT_RESULTS, SAVE_RESULTS, parseRetentionSetting, type HistoryFilter, type RetentionSetting, type SearchHit, type SearchKey,
  type SuppressedCursor, type SuppressedRow } from '../../shared/ipc.ts';
import { profileLabel, type LiveOf } from '../api.ts';
import type { SessionKind } from '../catalog/validate.ts';
import { LAST_RUN_KEY, retentionOf, setRetention } from '../retention/policy.ts';
import { searchSessions } from '../search/query.ts';
import { isDiskFull } from '../store/db.ts';
import type { Writer } from '../store/writer.ts';
import type { ModelEntry } from '../usage/models.ts';
import { historyRows } from './overlay.ts';
import { purgeSession } from './purge.ts';
import { reimport } from './reimport.ts';
import type { Identity } from './suppression.ts';

type Purge = (typeof PURGE_RESULTS)[number];
type Reimport = (typeof REIMPORT_RESULTS)[number];
type Save = (typeof SAVE_RESULTS)[number];
interface Files { dataDir: string; backupDir: string; secret: Buffer; now: number }

/** One search page; hits whose session is gone by the time its row is read are dropped (design review L4). */
export function answerSearch(db: DatabaseSync, q: { query: string; filter: HistoryFilter; cursor: SearchKey | null; limit: number },
  kinds: SessionKind[] = [], models: ModelEntry[] = [], live?: LiveOf): { hits: SearchHit[]; next: SearchKey | null } {
  const began = !db.isTransaction;
  if (began) db.exec('BEGIN'); // hits and rows from one snapshot
  try {
    const r = searchSessions(db, q.query, q.filter, q.cursor, q.limit);
    const rows = historyRows(db, r.hits.map((h) => h.session), kinds, models, live);
    return { hits: r.hits.flatMap((h) => { const row = rows.get(h.session); return row ? [{ row, event: h.event, snippet: h.snippet }] : []; }), next: r.next };
  } finally { if (began && db.isTransaction) db.exec('COMMIT'); }
}

/** The opaque handle of a suppression (design review L2: domain-separated, full HMAC-SHA256). Never logged. */
export const suppressionKey = (secret: Buffer, who: Identity) =>
  createHmac('sha256', secret).update(JSON.stringify(['xaibo-suppression', who.agent, who.profile, who.native])).digest('hex');

type Marker = { agent: string; profile_id: string; native_session_id: string; reason: 'manual' | 'retention'; at: number; pending: string | null; origin: string | null; root: string | null };
const SEL = `SELECT s.agent, s.profile_id, s.native_session_id, s.reason, s.at, s.pending, p.origin, p.root FROM suppressions s
  LEFT JOIN profiles p ON p.id = s.profile_id WHERE s.cleared_at IS NULL`;

/** Uncleared suppressions, newest first, ties by key; the cursor is the last row's {at, key} (design review M2: a key
 *  gone between pages still positions correctly). ponytail: one `at` group is read whole (a retention run stamps its
 *  purges with one time) and there is no index on `at`; add one if the Suppressed list pages slowly. */
export function suppressedPage(db: DatabaseSync, secret: Buffer, home: string, cursor: SuppressedCursor | null, limit: number): { rows: SuppressedRow[]; next: SuppressedCursor | null } {
  const n = Math.min(Math.max(1, Math.trunc(limit) || 1), MAX_ITEMS);
  const group = db.prepare(`${SEL} AND s.at = ?`);
  const below = db.prepare('SELECT max(at) AS at FROM suppressions WHERE cleared_at IS NULL AND at < ?');
  let at = cursor ? cursor.at : (db.prepare('SELECT max(at) AS at FROM suppressions WHERE cleared_at IS NULL').get() as { at: number | null }).at;
  let after = cursor?.key ?? null;
  const out: SuppressedRow[] = [];
  while (at !== null && out.length <= n) {
    const rows = (group.all(at) as Marker[]).map((m): SuppressedRow => ({
      key: suppressionKey(secret, { agent: m.agent, profile: m.profile_id, native: m.native_session_id }), agent: m.agent,
      profile: m.origin !== null && m.root !== null ? profileLabel(m.origin, m.root, home) : 'Unavailable', // design review L3
      reason: m.reason, at: m.at, filesPending: m.pending !== null,
    })).sort((a, b) => (a.key < b.key ? -1 : 1));
    out.push(...rows.filter((r) => after === null || r.key > after));
    after = null;
    at = (below.get(at) as { at: number | null }).at;
  }
  const rows = out.slice(0, n), last = rows.at(-1);
  return { rows, next: out.length > n && last ? { at: last.at, key: last.key } : null };
}

/** The identity behind a key, among uncleared suppressions. ponytail: one HMAC per marker (a rare owner action). */
export function findSuppressed(db: DatabaseSync, secret: Buffer, key: string): Identity | null {
  for (const m of db.prepare('SELECT agent, profile_id, native_session_id FROM suppressions WHERE cleared_at IS NULL').iterate() as Iterable<Marker>) {
    const who = { agent: m.agent, profile: m.profile_id, native: m.native_session_id };
    if (suppressionKey(secret, who) === key) return who;
  }
  return null;
}

/** At most `max` manual purges per `windowMs` (D-P5-07). */
export class PurgeLimit {
  #times: number[] = [];
  readonly #now: () => number;
  readonly #max: number;
  readonly #windowMs: number;
  constructor(now: () => number, max = 10, windowMs = 60_000) { this.#now = now; this.#max = max; this.#windowMs = windowMs; }
  take(): boolean {
    const t = this.#now();
    this.#times = this.#times.filter((x) => t - x < this.#windowMs && x <= t);
    if (this.#times.length >= this.#max) return false;
    this.#times.push(t);
    return true;
  }
}

/** A purge the owner confirmed (reason manual, P5-T07 engine through the writer). An unknown session is not counted. */
export function purgeManual(writer: Writer, session: number, o: Files & { limit: PurgeLimit }): Purge {
  try {
    if (!writer.transact((db) => db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(session) !== undefined)) return 'not-found';
    if (!o.limit.take()) return 'busy';
    return purgeSession(writer, session, { dataDir: o.dataDir, backupDir: o.backupDir, now: o.now, secret: o.secret, reason: 'manual' }).purged ? 'purged' : 'not-found';
  } catch (e) { return isDiskFull(e) ? 'disk-full' : 'failed'; }
}

/** Re-import by key; on ok the returning session is kept (D-P5-08). The caller triggers the reconcile. */
export function reimportKey(writer: Writer, db: DatabaseSync, key: string, o: Files): Reimport {
  try {
    const who = findSuppressed(db, o.secret, key);
    if (!who) return 'not-found';
    return reimport(writer, who, { dataDir: o.dataDir, backupDir: o.backupDir, now: o.now, keep: true }); // Keep in the same transaction (review M1)
  } catch (e) { return isDiskFull(e) ? 'disk-full' : 'failed'; }
}

/** The stored setting (null = unreadable) and the last completed run. */
export function retentionState(db: DatabaseSync): { setting: RetentionSetting | null; lastRunAt: number | null } {
  const v = (db.prepare('SELECT value FROM kv WHERE key = ?').get(LAST_RUN_KEY) as { value: string } | undefined)?.value;
  const last = v === undefined ? null : Number(v);
  return { setting: retentionOf(db), lastRunAt: last !== null && Number.isFinite(last) ? last : null };
}

/** Validates with the shared schema and saves through the writer (design review L5). */
export function saveRetention(writer: Writer, value: unknown): Save {
  const v = parseRetentionSetting(value);
  if (!v) return 'invalid';
  try { writer.transact((db) => setRetention(db, v === 'never' ? 'never' : v.days)); return 'saved'; }
  catch (e) { return isDiskFull(e) ? 'disk-full' : 'failed'; }
}

/** XAIBO-PROD-527 re-review M1: `run` one at a time; calls during a run merge into one more run after it (a Re-import
 *  landing mid-sweep is not missed, and sweeps never stack). */
export function rerunner(run: () => Promise<void>): () => void {
  let running = false, again = false;
  const start = (): void => {
    running = true;
    again = false;
    void run().catch(() => undefined).finally(() => { running = false; if (again) start(); });
  };
  return () => { if (running) again = true; else start(); };
}
