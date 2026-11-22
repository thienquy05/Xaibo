// XAIBO-PROD-515 (P5-T07; FR-11, Q-5.1, Q-5.2, research L6): purge of Xaibo's copy of one session, through the writer (so
// its disk-full state applies). XAIBO-PROD-542 (Gate 5 G5-N1): in phases, so no transaction holds the writer for long.
//  (a) One short transaction captures the files and the registrations that held its records, detaches the files, drops
//      their quarantine and writes the Suppression marker with purge phase 'settle'. From then on every reader hides the
//      session and nothing brings it back (suppression.ts).
//  (settle) Gate 5 round 2: its contributions settle (FR-52, exactly once) in bounded batches, requests, then turns, then
//      session-linked quota readings by row id, the cursor and the months and models seen stored on the marker with each
//      batch's marks; the session and per-model keys go in the last batch from those frozen rows, which flips the phase to
//      'rows'. Nothing is deleted before. The monthly side leaves out only 'rows', so totals never move meanwhile.
//  (b) Its dependent rows, then its events and their FTS rows, go in batches bounded by rows and FTS bytes, each its own
//      writer transaction with a yield between, so live writes go first.
//  (c) One idempotent sweep of every session-keyed table and the session row clears the phase.
// A stop or a failure (a full disk) between batches leaves the phase; resumePurges (service start, retention) finishes it.
// One driver per identity runs (b) and (c): a purge, retention or resume of the same session joins the run in progress,
// and phase (a) on a marker still deleting rows only upgrades retention to manual, never captures again. Only after the
// rows are gone: the session's content-chunk items are removed, closed spool files are rewritten without its records,
// migration backups that hold it are deleted (Q-5.1: reported as backupsDeleted), then the marker's pending work is
// cleared; work a crash or an error left owed is redone by resumePurges. A failure in phase (a) is rolled back and
// rethrown as it was: no marker, no file touched. Logical deletion, not forensic erasure (Q-5.2): bytes can remain in the
// main DB file, its WAL and freed pages, and in torn spool lines no parser can attribute. Native files are never touched.
import { closeSync, constants, existsSync, lstatSync, openSync, readdirSync, readSync, rmSync, unlinkSync, type Stats } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { removeItems, type ChunkKey, type ChunkStore } from '../adapters/generic/chunks.ts';
import { atomicWrite, fsyncDir } from '../fs-private.ts';
import { openRegistry, readRegistrations } from '../receivers/registrations.ts';
import { readOwn, spoolDir } from '../receivers/spool-replay.ts';
import { ftsPrefix, FTS_MAX_BYTES, type Writer } from '../store/writer.ts';
import { quotaContributions, SESSION_ROW, sessionKeys, type Contribution, type Months, type Read, type SessionRow } from '../usage/monthly.ts';
import { settleContributions } from '../usage/settle.ts';
import { errorCode } from '../../shared/crash.ts';
import { clear, suppress, type Identity, type SuppressionReason } from './suppression.ts';

export interface FileOptions {
  dataDir: string; backupDir: string; now: number;
  /** The report intake's live chunk store: items go through it (its quota freed); absent = removed on disk (no store runs). */
  chunks?: ChunkStore | undefined;
  /** G5a-2/G5Rr1-3: today's spool identities, cached per retention run by the file's (ino, size, mtime, ctime); the file
   *  is checked when the file work runs, so a record appended after any earlier read is seen. Absent = no cache. */
  today?: TodayCache;
  /** Rows and FTS bytes per batch transaction of phase (b) (tests use small ones). */
  limits?: PurgeLimits;
  /** True once the caller stops: the row phases end between batches and resume later. */
  stopped?: () => boolean;
  /** Fixed event names and error codes only (a failed batch: purge_rows_failed). */
  log?: (event: string, fields?: Record<string, string | number>) => void;
  /** The install secret: needed to settle a purge's contributions (absent: a purge still settling stays owed). */
  secret?: Buffer;
  /** G5Rr1-2: a retention marker was cleared by native activity seen while its purge ran: wake the adapters. */
  onReimport?: () => void;
}
/** rows: per batch transaction (event batches at most EVENT_ROWS); bytes: stored bytes (content + raw) per event batch,
 *  which also bounds its FTS bytes. */
export interface PurgeLimits { rows: number; bytes: number }
export interface TodayCache { key: string; ids: Set<string> | null }
/** A fresh per-run cache of today's spool identities. */
export const todayCache = (): TodayCache => ({ key: '', ids: null });
export interface PurgeOptions extends FileOptions {
  secret: Buffer; reason: SuppressionReason;
  /** P5-T09 (review H2): re-checked inside phase (a); false = the session is no longer eligible, nothing done. */
  guard?: (db: DatabaseSync, sessionId: number) => boolean;
  /** false: the caller gives freed pages back once for many purges (retention, review M2). */
  vacuum?: boolean;
  /** Called once phase (a) committed: the session is hidden (renderer resync, ledger). */
  hidden?: () => void;
}
/** rowsPending (Gate 5 second review M1): the session is hidden but its row phases did not finish (a full disk, a store
 *  error or a stop); resumePurges finishes them. */
export interface PurgeResult { purged: boolean; chunkItems: number; spoolFiles: number; backupsDeleted: number; filesPending: boolean; rowsPending: boolean }

/** Spool files no forwarder appends to: plain files of an earlier UTC day, and files a replay has taken. Today's plain
 *  file is the forwarder's: never rewritten under it; a purge whose session it holds owes it until the day closes. */
const CLOSED = /^(\d{4}-\d{2}-\d{2})(\.replay-[0-9a-f-]{36})?\.jsonl$/;
// review L2: a forwarder can still append to yesterday's file just after UTC midnight, and to a file a replay has just
// taken; one written or renamed (mtime or ctime) this recently before the purge's clock stays owed for resumePurges.
const QUIET_MS = 5_000;
const SPOOL_MAX = 64 << 20; // spool-replay's per-file bound
const SQLITE_CORRUPT = 11, SQLITE_NOTADB = 26;
// Gate 5 TP retention probe (run 179, design review 3029): 500 rows / 1 MiB of FTS text per event batch held the service
// thread ~95% of a retention run (p95 1.3 s, max 4.2 s). Event batches are now bounded by stored bytes (deleting a row
// walks its content and raw), and every purge transaction is paced per writer (pace/timed below). ponytail: fixed
// bounds; a WAL checkpoint or FTS merge inside a commit is not bounded by them (measured by the probe).
const LIMITS: PurgeLimits = { rows: 500, bytes: 64 << 10 };
const EVENT_ROWS = 32; // tuned on the probe: 64 KiB / 32 rows with a 3x pause kept live M1 p95 at 232 ms during a purge
const VACUUM_PAGES = 2048, VACUUM_STEPS = 100_000;
const NONE: PurgeResult = { purged: false, chunkItems: 0, spoolFiles: 0, backupsDeleted: 0, filesPending: false, rowsPending: false };
const tick = () => new Promise((resolve) => setImmediate(resolve));
// Purge pacing (run 179): after a purge or retention delete transaction of `ms`, the writer's purge work waits
// min(3 × ms, 250 ms) (performance.now: a wall clock set back would stall every purge), so live intake keeps about 3/4 of the service thread; one busy-until per writer, so concurrent purge loops
// (retention, manual purges, resumes, vacuum) share it instead of each taking their own turn.
const PAUSE_MAX = 250;
export const pauseMs = (ms: number) => (ms < 1 ? 0 : Math.min(3 * ms, PAUSE_MAX));
const busyUntil = new WeakMap<object, number>();
export function paced(writer: object, ms: number, now = performance.now()): void { busyUntil.set(writer, Math.max(busyUntil.get(writer) ?? 0, now + pauseMs(ms))); }
export const paceWait = (writer: object, now = performance.now()) => Math.max(0, (busyUntil.get(writer) ?? 0) - now);
/** Waits out the writer's purge pause (a setImmediate yield at least), re-checked so concurrent loops take turns. Call it
 *  before deletesAllowed: nothing may be awaited between that gate and the transaction (G5b1-3). */
export async function pace(writer: object): Promise<void> {
  await tick();
  for (let d = paceWait(writer); d > 0; d = paceWait(writer)) await new Promise((resolve) => setTimeout(resolve, d)); // ref'd: <= 250 ms
}
/** pace, then the Clear gate, re-checked, then `f` (the caller's stop check and timed transaction) in the same continuation
 *  (Gate 5 G5Su-1): the gate wakes every waiting loop in one microtask drain, so a check that returned before the caller's
 *  transaction let the next released loop pass too; with `f` inside, it sees this loop's pause and takes its turn. The gate
 *  is checked again right before `f` (G5C2s-1): a hold taken in the microtask hop after deletesAllowed returned still wins. */
export async function turn<T>(writer: Writer, f: () => T): Promise<T> {
  for (;;) { await pace(writer); await deletesAllowed(writer); if (!gates.has(writer) && !paceWait(writer)) return f(); }
}
/** A purge transaction, timed for the writer's pause. */
export function timed<T>(writer: Writer, f: () => T): T {
  const t0 = performance.now();
  try { return f(); } finally { paced(writer, performance.now() - t0); }
}
const uid = process.getuid?.();
const own = (st: Stats) => uid === undefined || st.uid === uid;
const errno = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code;

export async function purgeSession(writer: Writer, sessionId: number, o: PurgeOptions): Promise<PurgeResult> {
  const listed = openRegistry(o.dataDir).all(); // the file read stays outside the transaction
  const who = writer.transact((db) => begin(db, sessionId, listed, o));
  if (!who) return NONE;
  o.hidden?.();
  // ponytail: owed rows wait for the next resumePurges (boot, UTC midnight + 10 s, each retention run) and finish only once
  // the disk has space; a near-term resume needs a single-flight rerunner with a minimum interval (design review 3014 L4)
  if (!(await drive(writer, who, o))) return { ...NONE, purged: true, filesPending: true, rowsPending: true };
  // round 4 review L2: the rows are gone; a failing file check (a closed store) leaves the files owed, not the rows
  let files: Omit<PurgeResult, 'purged' | 'rowsPending'>;
  try { files = owed(writer, who, o); } catch { files = { ...NONE, filesPending: true }; }
  if (o.vacuum !== false) await vacuum(writer, o.stopped);
  return { ...files, purged: true, rowsPending: false }; // G5Su-3: last, so a fallback built from NONE cannot reset them
}

/** Phase (a). Null when there is no such session or it is no longer eligible. */
function begin(db: DatabaseSync, id: number, listed: { id: string; agent: string; profile_key: string }[], o: PurgeOptions): Identity | null {
  const s = db.prepare('SELECT agent, profile_id AS profile, native_session_id AS native FROM sessions WHERE id = ?').get(id) as Identity | undefined;
  if (!s) return null;
  const who: Identity = { agent: s.agent, profile: s.profile, native: s.native };
  const key = [who.agent, who.profile, who.native] as const;
  const phase = (db.prepare('SELECT purge_phase AS p FROM suppressions WHERE agent = ? AND profile_id = ? AND native_session_id = ?').get(...key) as { p: string | null } | undefined)?.p;
  if (phase) { // still deleting rows: nothing is captured or settled again
    if (o.reason === 'manual') db.prepare("UPDATE suppressions SET reason = 'manual' WHERE agent = ? AND profile_id = ? AND native_session_id = ?").run(...key);
    return who;
  }
  if (o.guard && !o.guard(db, id)) return null;
  const regs = [...new Set([
    ...listed.filter((r) => r.agent === who.agent && r.profile_key === who.profile).map((r) => r.id),
    ...(db.prepare('SELECT DISTINCT registration_id AS r FROM report_delivery WHERE agent = ? AND profile_key = ? AND native_session_id = ?')
      .all(...key) as { r: string }[]).map((x) => x.r),
  ])];
  // P5-T08 (review M2): the files that held its records, for a re-import: its own rows and any file its events came from
  const files = (db.prepare('SELECT id FROM source_files WHERE session_id = ?1 UNION SELECT file_id FROM events WHERE session_id = ?1 AND file_id IS NOT NULL')
    .all(id) as { id: number }[]).map((r) => r.id);
  // quarantined lines of the session's files may hold its content; the checkpoints stay, so a rescan resumes at its offset
  db.prepare('DELETE FROM quarantine WHERE file_id IN (SELECT id FROM source_files WHERE session_id = ?)').run(id);
  db.prepare('UPDATE source_files SET session_id = NULL WHERE session_id = ?').run(id);
  suppress(db, who, o.reason, o.now, regs, files);
  return who;
}

const runs = new WeakMap<Writer, Map<string, Promise<boolean>>>();
/** Phases (b) and (c), one run per identity: a second caller joins the run in progress. True once the rows are gone. */
function drive(writer: Writer, who: Identity, o: FileOptions): Promise<boolean> {
  let m = runs.get(writer);
  if (!m) runs.set(writer, m = new Map());
  const k = JSON.stringify([who.agent, who.profile, who.native]);
  const running = m.get(k);
  if (running) return running;
  const p = rowPhases(writer, who, o).finally(() => m.delete(k));
  m.set(k, p);
  return p;
}

// XAIBO-PROD-542 (review L, G5b1-3): row deletions wait while Clear usage history runs, so no record stored meanwhile can
// take a rowid at or below its watermarks (the tables reuse the top rowids freed by a delete). ponytail: one gate per
// writer; deletions wait at most as long as the clear (its worker times out after CLEAR_TIMEOUT_MS).
const gates = new WeakMap<Writer, { holds: number; open: Promise<void>; release: () => void }>();
/** Holds the purge and retention row deletions of `writer` until the returned release runs (once). */
export function holdDeletes(writer: Writer): () => void {
  let g = gates.get(writer);
  if (!g) { let release = () => {}; const open = new Promise<void>((resolve) => { release = resolve; }); gates.set(writer, g = { holds: 0, open, release }); }
  g.holds++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--g.holds === 0) { gates.delete(writer); g.release(); }
  };
}
/** Resolves once no clear holds the deletions of `writer`. */
export async function deletesAllowed(writer: Writer): Promise<void> {
  for (let g = gates.get(writer); g; g = gates.get(writer)) await g.open;
}

type Step = (db: DatabaseSync, id: number, regs: string, lim: PurgeLimits) => number;
const BY_SESSION = ['tool_calls', 'usage', 'cost_estimates', 'context_snapshots', 'usage_snapshots', 'cwd_history', 'subagents', 'turns'];
/** Each step deletes up to `lim.rows` rows of one table in the order dependents first; the identity tables carry `who`. */
function steps(who: Identity): Step[] {
  const run = (db: DatabaseSync, sql: string, ...a: (string | number)[]) => Number(db.prepare(sql).run(...a).changes);
  const limited = (t: string, where: string) => `DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE ${where} LIMIT ?)`;
  return [
    ...BY_SESSION.map((t): Step => (db, id, _r, lim) => run(db, limited(t, 'session_id = ?'), id, lim.rows)),
    (db, id, _r, lim) => run(db, limited('session_links', 'from_session_id = ?1 OR to_session_id = ?1'), id, lim.rows),
    (db, id, _r, lim) => run(db, limited('usage_history', 'usage_scope_id IN (SELECT id FROM usage_scopes WHERE session_id = ?)'), id, lim.rows), // EC-99
    // ponytail: report content is bounded by rows only (an item is at most one assembled content.upsert)
    ...['report_content', 'report_delivery'].map((t): Step => (db, _id, regs, lim) =>
      run(db, limited(t, 'registration_id IN (SELECT value FROM json_each(?)) AND native_session_id = ?'), regs, who.native, lim.rows)),
    (db, _id, _r, lim) => run(db, limited('hook_delivery', 'agent = ? AND profile_key = ? AND native_session_id = ?'), who.agent, who.profile, who.native, lim.rows),
    (db, _id, _r, lim) => run(db, limited('hook_gaps', 'agent = ? AND native_session_id = ?'), who.agent, who.native, lim.rows), // gaps carry no profile
    // review M4: evidence stored before migration 011 has profile ''
    (db, _id, _r, lim) => run(db, limited('status_evidence', "agent = ? AND profile_id IN (?, '') AND native_session_id = ?"), who.agent, who.profile, who.native, lim.rows),
    eventBatch,
  ];
}

/** One batch of a session's events, in index order (review H: no sort, no scan of the rest). Parameters: session id, rows. */
// run 179: octet_length reads a value's size without loading it; IS NOT NULL, <> '' and CAST(.. AS BLOB) load the whole
// value (measured on the bundled SQLite 3.53), so every candidate row cost its full read
export const EVENT_BATCH = `SELECT id, revision_status = 'current' AND coalesce(octet_length(content), 0) > 0 AS indexed,
  coalesce(octet_length(content), 0) + coalesce(octet_length(raw), 0) AS b FROM events WHERE session_id = ? LIMIT ?`;
/** Events until min(lim.rows, EVENT_ROWS) rows or `lim.bytes` stored (at least one row). FTS (external content) holds
 *  exactly the rows the writer indexed: current, non-empty, under its prefix; a 'delete' names those rows with that text
 *  (review M5). FTS_MAX_BYTES caps what was indexed, so the stored bytes bound the FTS bytes too. */
function eventBatch(db: DatabaseSync, id: number, _regs: string, lim: PurgeLimits): number {
  // iterated, stopping at the bound: revision_status is the row's last column, so each row read walks its overflow pages
  const rows = db.prepare(EVENT_BATCH).iterate(id, Math.min(lim.rows, EVENT_ROWS)) as Iterable<{ id: number; indexed: number; b: number }>;
  const content = db.prepare('SELECT content FROM events WHERE id = ?');
  const unindex = db.prepare("INSERT INTO event_fts (event_fts, rowid, content) VALUES ('delete', ?, ?)");
  const ids: number[] = [];
  let bytes = 0;
  for (const r of rows) {
    if (ids.length && bytes + r.b > lim.bytes) break;
    bytes += r.b;
    ids.push(r.id);
    if (r.indexed) unindex.run(r.id, ftsPrefix((content.get(r.id) as { content: string }).content));
  }
  return Number(db.prepare('DELETE FROM events WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids)).changes);
}

const SESSION_OF = 'SELECT id FROM sessions WHERE agent = ? AND profile_id = ? AND native_session_id = ?';
async function rowPhases(writer: Writer, who: Identity, o: FileOptions): Promise<boolean> {
  const lim = o.limits ?? LIMITS;
  const key = [who.agent, who.profile, who.native] as const;
  let regs = '[]';
  try {
    for (;;) { // the settlement, before any deletion
      const settled = await turn(writer, () => {
        if (o.stopped?.() || writer.diskFull) return 'stop';
        if (!o.secret) { // cannot settle without the install secret: a purge still settling stays owed
          const phase = writer.transact((db) => (db.prepare('SELECT purge_phase AS p FROM suppressions WHERE agent = ? AND profile_id = ? AND native_session_id = ?')
            .get(...key) as { p: string | null } | undefined)?.p ?? null);
          return phase === 'settle' ? 'stop' : 'done';
        }
        const secret = o.secret, now = o.now;
        return timed(writer, () => writer.transact((db) => settleStep(db, who, lim, secret, now))) ? 'done' : 'more';
      });
      if (settled === 'stop') return false;
      if (settled === 'done') break;
    }
    for (const step of steps(who)) {
      for (;;) {
        const n = await turn(writer, () => (o.stopped?.() || writer.diskFull ? -1 : timed(writer, () => writer.transact((db) => { // live commits go first
          regs = (db.prepare('SELECT pending FROM suppressions WHERE agent = ? AND profile_id = ? AND native_session_id = ?').get(...key) as { pending: string | null } | undefined)?.pending ?? '[]';
          const s = db.prepare(SESSION_OF).get(...key) as { id: number } | undefined;
          return s ? step(db, s.id, regs, lim) : 0;
        }))));
        if (n < 0) return false;
        // review L: a row-bounded step that deleted fewer than its bound is done; the byte-bounded event step is done
        // only when nothing was left
        if (n === 0 || (step !== eventBatch && n < lim.rows)) break;
      }
    }
    return await turn(writer, () => {
      if (o.stopped?.()) return false;
      timed(writer, () => writer.transact((db) => sweep(db, who, regs))); // (c)
      return true;
    });
  } catch (e) { // a full disk or a failing store: the phase stays for resume, never counted as done
    if (!o.stopped?.()) o.log?.('purge_rows_failed', { error: errorCode(e) });
    return false;
  }
}

type SettleCursor = { u: number; t: number; q: number; m: Record<string, { month: string; offset: number; ts: number; models: string[] }> };
const SETTLED = -1; // a cursor field whose table is done
const num = (x: unknown) => (typeof x === 'number' && Number.isSafeInteger(x) ? x : 0);
/** The stored cursor; an unreadable one starts over (settle() skips keys already settled, so a restart only repeats reads). */
function readCursor(v: string | null): SettleCursor {
  try {
    const c = JSON.parse(v ?? 'null') as Partial<SettleCursor> | null;
    if (c && typeof c === 'object') return { u: num(c.u), t: num(c.t), q: num(c.q), m: c.m && typeof c.m === 'object' ? c.m : {} };
  } catch { /* starts over */ }
  return { u: 0, t: 0, q: 0, m: {} };
}
/** One settlement batch of the session: at most `lim.rows` rows read (requests, then turns, then quota readings); the
 *  last also settles its session and per-model keys and flips the phase to 'rows'. True once settled. Inside the
 *  writer's transaction, with the cursor saved alongside the marks. ponytail (Gate 5 round 3 G5Ss1-1): the last batch
 *  settles every accumulated session/month/model key at once (~months x (models + 1)) and the accumulator is saved each
 *  batch; measured: 3 months x 10 models 63 keys in ~3 ms (cursor 391 B), 12 x 30 432 keys ~10 ms (2.9 KB), 24 x 50 1424
 *  keys ~32 ms (8.7 KB). Batch the key settlement if sessions ever span far more months or models. */
function settleStep(db: DatabaseSync, who: Identity, lim: PurgeLimits, secret: Buffer, now: number): boolean {
  const key = [who.agent, who.profile, who.native] as const;
  const m = db.prepare('SELECT purge_phase, settle_cursor FROM suppressions WHERE agent = ? AND profile_id = ? AND native_session_id = ?').get(...key) as
    { purge_phase: string | null; settle_cursor: string | null } | undefined;
  if (m?.purge_phase !== 'settle') return true;
  const s = db.prepare(`${SESSION_ROW} WHERE agent = ? AND profile_id = ? AND native_session_id = ?`).get(...key) as SessionRow | undefined;
  const c = readCursor(m.settle_cursor);
  const out: Contribution[] = [];
  if (s) {
    const k = sessionKeys(db, secret);
    const months: Months = new Map(Object.entries(c.m).map(([mo, x]) => [mo, { at: { month: x.month, offset: x.offset }, ts: x.ts, models: new Set(x.models) }]));
    const quota = db.prepare('SELECT id FROM usage_history WHERE usage_scope_id IN (SELECT id FROM usage_scopes WHERE session_id = ?) AND id > ? ORDER BY id LIMIT ?');
    let budget = lim.rows;
    const stage = (field: 'u' | 't' | 'q', run: (after: number, n: number, read: Read) => Iterable<Contribution>) => {
      if (budget <= 0 || c[field] === SETTLED) return;
      const n = budget, read: Read = { rows: 0, last: c[field] };
      for (const x of run(c[field], n, read)) out.push(x);
      budget -= read.rows;
      c[field] = read.rows < n ? SETTLED : read.last;
    };
    stage('u', (after, n, read) => k.usage(s, months, after, Number.MAX_SAFE_INTEGER, n, read));
    stage('t', (after, n, read) => k.turns(s, months, after, Number.MAX_SAFE_INTEGER, n, read));
    stage('q', (after, n, read) => {
      const ids = (quota.all(s.id, after, n) as { id: number }[]).map((r) => r.id);
      read.rows = ids.length;
      read.last = ids.at(-1) ?? after;
      return quotaContributions(db, secret, ids);
    });
    c.m = Object.fromEntries([...months].map(([mo, x]) => [mo, { month: x.at.month, offset: x.at.offset, ts: x.ts, models: [...x.models] }]));
    if (c.u === SETTLED && c.t === SETTLED && c.q === SETTLED) out.push(...k.session(s, months)); // from the frozen rows
  }
  settleContributions(db, out, now);
  const done = !s || (c.u === SETTLED && c.t === SETTLED && c.q === SETTLED);
  db.prepare('UPDATE suppressions SET purge_phase = ?, settle_cursor = ? WHERE agent = ? AND profile_id = ? AND native_session_id = ?')
    .run(done ? 'rows' : 'settle', done ? null : JSON.stringify(c), ...key);
  return done;
}

/** Phase (c): every session-keyed row left (normally none: written meanwhile, or by an older purge), then the session. */
function sweep(db: DatabaseSync, who: Identity, regs: string): void {
  const s = db.prepare(SESSION_OF).get(who.agent, who.profile, who.native) as { id: number } | undefined;
  if (s) {
    const all: PurgeLimits = { rows: -1, bytes: Number.MAX_SAFE_INTEGER }; // LIMIT -1: no limit (min(-1, EVENT_ROWS) stays -1)
    for (const step of steps(who)) step(db, s.id, regs, all);
    db.prepare('DELETE FROM usage_scopes WHERE session_id = ?').run(s.id);
  }
  db.prepare('DELETE FROM overlays WHERE agent = ? AND profile_id = ? AND native_session_id = ?').run(who.agent, who.profile, who.native);
  if (s) db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
  db.prepare('UPDATE suppressions SET purge_phase = NULL WHERE agent = ? AND profile_id = ? AND native_session_id = ?').run(who.agent, who.profile, who.native);
}

/** Gives freed pages back, best effort, VACUUM_PAGES per writer transaction with a yield between, while any are freed. */
export async function vacuum(writer: Writer, stopped?: () => boolean): Promise<void> {
  const free = (db: DatabaseSync) => Number((db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count);
  for (let i = 0; i < VACUUM_STEPS; i++) {
    await pace(writer);
    if (stopped?.()) return; // design review 3029 L10: never on a store the stop is closing
    let more: boolean;
    try {
      more = timed(writer, () => writer.transact((db) => { const before = free(db); db.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`); const after = free(db); return after > 0 && after < before; }));
    } catch { return; } // the pages stay free for reuse
    if (!more) return;
  }
}

/** Finishes the row phases and then the file work of every purge that still owes either; returns how many finished now. */
export async function resumePurges(writer: Writer, o: FileOptions): Promise<number> {
  const rows = writer.transact((db) => db.prepare(`SELECT agent, profile_id AS profile, native_session_id AS native, purge_phase FROM suppressions
    WHERE pending IS NOT NULL OR purge_phase IS NOT NULL`).all() as unknown as (Identity & { purge_phase: string | null })[]);
  let n = 0;
  for (const r of rows) {
    if (o.stopped?.()) break; // re-review L: the store closes right after a stop
    const who = { agent: r.agent, profile: r.profile, native: r.native };
    if (r.purge_phase !== null && !(await drive(writer, who, o))) continue;
    if (!owed(writer, who, o).filesPending) n++;
  }
  return n;
}

/** G5a-2: the next run for today's spool file: shortly after the next UTC midnight, past the quiet window. Accepted: a
 *  forwarder append within QUIET_MS after midnight leaves that (yesterday's) file owed until the daily retention run. */
export function spoolResumeDelay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + QUIET_MS + 5_000 - now;
}

/** P5-T08 (review M1): finishes the file work one marker still owes; true when none is owed any more (never while its
 *  rows are still being deleted: a Re-import then waits). */
export function finishPending(writer: Writer, who: Identity, o: FileOptions): boolean {
  return !owed(writer, who, o).filesPending;
}

function owed(writer: Writer, who: Identity, o: FileOptions): Omit<PurgeResult, 'purged' | 'rowsPending'> {
  const row = writer.transact((db) => db.prepare('SELECT pending, purge_phase FROM suppressions WHERE agent = ? AND profile_id = ? AND native_session_id = ?')
    .get(who.agent, who.profile, who.native) as { pending: string | null; purge_phase: string | null } | undefined);
  const none = { chunkItems: 0, spoolFiles: 0, backupsDeleted: 0 };
  if (!row || (row.pending === null && row.purge_phase === null)) return { ...none, filesPending: false };
  if (row.purge_phase !== null) return { ...none, filesPending: true };
  return finishFiles(writer, who, registrations(row.pending!), o);
}

function registrations(pending: string): string[] {
  try { const v = JSON.parse(pending) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}

/** The file work after the rows are gone; clears the marker's pending work once every step is done. Never throws. */
function finishFiles(writer: Writer, who: Identity, regs: string[], o: FileOptions): Omit<PurgeResult, 'purged' | 'rowsPending'> {
  const set = new Set(regs);
  let done = true;
  const step = <T>(f: () => T, none: T): T => { try { return f(); } catch { done = false; return none; } };
  // G5a-4: also items of the session under a registration no longer registered (an unreadable registry: only its own)
  const listed = readRegistrations(o.dataDir);
  const registered = listed && new Set(listed.map((r) => r.id));
  const match = (k: ChunkKey) => k.session === who.native && (set.has(k.registration) || (registered !== null && !registered.has(k.registration)));
  const chunkItems = step(() => {
    if (!o.chunks) return removeItems(path.join(o.dataDir, 'content-chunks'), match);
    const items = o.chunks.items().filter(match);
    for (const k of items) o.chunks.remove(k);
    return items.length;
  }, 0);
  const spool = step(() => rewriteSpool(o, who, set), { files: 0, done: false });
  const backups = step(() => dropBackups(o.backupDir, who), { deleted: 0, done: false });
  done &&= spool.done && backups.done;
  if (done) {
    // G5Rr1-2: once nothing is owed, a retention marker that saw new native activity meanwhile (fresh_at) clears and resets
    // its files (epoch + 1: the G5f-1 reread), so the next scan re-imports the whole session; a manual one stays
    const key = [who.agent, who.profile, who.native] as const;
    const reimported = step(() => writer.transact((db) => {
      db.prepare('UPDATE suppressions SET pending = NULL WHERE agent = ? AND profile_id = ? AND native_session_id = ? AND purge_phase IS NULL').run(...key);
      const m = db.prepare('SELECT reason, fresh_at, cleared_at, pending, purge_phase FROM suppressions WHERE agent = ? AND profile_id = ? AND native_session_id = ?')
        .get(...key) as { reason: string; fresh_at: number | null; cleared_at: number | null; pending: string | null; purge_phase: string | null } | undefined;
      if (m?.reason !== 'retention' || m.fresh_at === null || m.cleared_at !== null || m.pending !== null || m.purge_phase !== null) return false;
      clear(db, who, o.now); // round 2 review: cleared at the service clock, not the native record's time
      return true;
    }), false);
    if (reimported) o.onReimport?.();
  }
  return { chunkItems, spoolFiles: spool.files, backupsDeleted: backups.deleted, filesPending: !done };
}

/** True for a spooled hook envelope or report record of the session. */
function ofSession(line: string, who: Identity, regs: Set<string>): boolean {
  const k = identityOf(line);
  return k !== null && (k === hookKey(who) || [...regs].some((r) => k === reportKey(r, who.native)));
}
const hookKey = (who: Identity) => JSON.stringify(['h', who.agent, who.profile, who.native]);
const reportKey = (registration: string, native: string) => JSON.stringify(['r', registration, native]);
/** The identity a spooled record names, or null (a torn line is nobody's record, Q-5.2 non-forensic). */
function identityOf(line: string): string | null {
  let x: unknown;
  try { x = JSON.parse(line); } catch { return null; }
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  if (r['kind'] === 'report') {
    const frame = r['frame'];
    const sid = typeof frame === 'object' && frame !== null ? (frame as Record<string, unknown>)['session_id'] : undefined;
    return typeof r['registration'] === 'string' && typeof sid === 'string' ? reportKey(r['registration'], sid) : null;
  }
  return typeof r['agent'] === 'string' && typeof r['profile_key'] === 'string' && typeof r['session_id'] === 'string'
    ? hookKey({ agent: r['agent'], profile: r['profile_key'], native: r['session_id'] }) : null;
}

/** G5a-2: the identities today's spool file holds, read once per retention run; empty when it is absent or not ours
 *  (never read), null when it cannot be read now. */
export function spoolToday(dataDir: string, now: number): Set<string> | null {
  let dir: string | null;
  try { dir = spoolDir(dataDir); } catch { return null; } // G5a-3: only a missing spool dir is "none"
  if (!dir) return new Set();
  return todayIds(path.join(dir, `${new Date(now).toISOString().slice(0, 10)}.jsonl`));
}

/** G5Rr1-3: the identities `file` holds now; read again whenever its (ino, size, mtime, ctime) differs from the cached
 *  read (the key is taken before the read, so an append during it only causes another read). Empty when absent or not
 *  ours (never read), null when it cannot be read now. */
function todayIds(file: string, cache?: TodayCache): Set<string> | null {
  let st: Stats;
  try { st = lstatSync(file); } catch (e) { return errno(e) === 'ENOENT' ? new Set() : null; }
  if (!st.isFile() || st.nlink !== 1 || !own(st)) return new Set();
  const key = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  if (cache?.ids && cache.key === key) return cache.ids;
  const got = readOwn(file, SPOOL_MAX);
  if (!got) return null;
  const ids = new Set(got.buf.toString('utf8').split('\n').map(identityOf).filter((k): k is string => k !== null));
  if (cache) { cache.key = key; cache.ids = ids; }
  return ids;
}

/** G5a-3: true when the file's bytes name the session id (a JSON string), read in 1 MiB steps. */
function mentions(file: string, native: string): boolean {
  const needle = Buffer.from(JSON.stringify(native));
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buf = Buffer.alloc((1 << 20) + needle.length);
    let carry = 0;
    for (;;) {
      const got = readSync(fd, buf, carry, buf.length - carry, null);
      if (!got) return false;
      const end = carry + got;
      if (buf.subarray(0, end).includes(needle)) return true;
      carry = Math.min(needle.length - 1, end);
      buf.copy(buf, 0, end - carry, end);
    }
  } finally { closeSync(fd); }
}

/** A stat or listing error of the spool dir (EACCES, EMFILE, ...) throws: the work stays owed; no spool dir is done. */
function rewriteSpool(o: FileOptions, who: Identity, regs: Set<string>): { files: number; done: boolean } {
  const dir = spoolDir(o.dataDir);
  if (!dir) return { files: 0, done: true };
  const today = new Date(o.now).toISOString().slice(0, 10);
  let files = 0, done = true;
  for (const name of readdirSync(dir)) {
    const m = CLOSED.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    if (!m[2] && m[1]! >= today) { // G5a-2: the forwarder's file; its records of the session keep the work owed
      const ids = todayIds(file, o.today);
      if (ids === null || ids.has(hookKey(who)) || [...regs].some((r) => ids.has(reportKey(r, who.native)))) done = false;
      continue;
    }
    let st: Stats;
    try { st = lstatSync(file); } catch (e) { if (errno(e) !== 'ENOENT') done = false; continue; }
    if (!st.isFile() || st.nlink !== 1 || !own(st)) continue; // a symlink or a file not ours: never read, never ours to rewrite (review L2)
    // review: a forwarder that wrote after the read changed the file; it is left for a later pass, never overwritten
    const unchanged = (ino: number, size: number) => () => { const x = lstatSync(file); if (x.ino !== ino || x.size !== size) throw new Error('spool file changed'); };
    // a replay rename keeps the mtime and sets the ctime (review)
    const recent = (x: { mtimeMs: number; ctimeMs: number }) => o.now - Math.max(x.mtimeMs, x.ctimeMs) < QUIET_MS;
    if (st.size > SPOOL_MAX) { // G5a-3: past the replay's bound (never replayed): removed when it names the session
      let holds: boolean;
      try { holds = mentions(file, who.native); } catch { done = false; continue; }
      if (!holds) continue;
      if (recent(st)) { done = false; continue; }
      try { unchanged(st.ino, st.size)(); unlinkSync(file); } catch { done = false; continue; }
      fsyncDir(dir);
      files++;
      continue;
    }
    const got = readOwn(file, SPOOL_MAX); // null: busy, out of handles, unreadable or changed meanwhile: owed (G5a-3)
    if (!got) { done = false; continue; }
    const lines = got.buf.toString('utf8').split('\n');
    const keep = lines.filter((l) => l === '' || !ofSession(l, who, regs)); // other lines byte for byte
    if (keep.length === lines.length) continue;
    if (recent(got)) { done = false; continue; }
    const text = keep.join('\n');
    const same = unchanged(got.ino, got.buf.length);
    try {
      if (text.replaceAll('\n', '') === '') { same(); unlinkSync(file); } else atomicWrite(file, text, 0o600, same);
    } catch { done = false; continue; }
    fsyncDir(dir);
    files++;
  }
  return { files, done };
}

/** Q-5.1: deletes each backup that holds the session (a corrupt one cannot prove it does not). A backup dir that cannot
 *  be listed, or a backup that cannot be read for another reason (busy, out of handles), keeps the work owed (review L1,
 *  G5a-3); no backup dir is done. */
function dropBackups(dir: string, who: Identity): { deleted: number; done: boolean } {
  let names: string[];
  try { names = readdirSync(dir); } catch (e) { return { deleted: 0, done: errno(e) === 'ENOENT' }; }
  let deleted = 0, done = true;
  // a backup run cut short leaves a full copy taken before its FTS merge: never a recovery point, always removed (review)
  for (const name of names.filter((f) => /^\.xaibo-v\d+\.db\.partial(-journal|-wal|-shm)?$/.test(f))) {
    const st = lstatSync(path.join(dir, name));
    if (st.isFile() && own(st)) rmSync(path.join(dir, name), { force: true });
  }
  for (const name of names.filter((f) => /^xaibo-v\d+\.db$/.test(f))) {
    const file = path.join(dir, name);
    const st = lstatSync(file);
    if (!st.isFile() || !own(st)) continue;
    const sidecars = [`${file}-wal`, `${file}-shm`].filter((f) => !existsSync(f)); // the ones opening it may create
    let holds: boolean;
    try {
      const b = new DatabaseSync(file, { readOnly: true });
      try { holds = b.prepare('SELECT 1 FROM sessions WHERE agent = ? AND profile_id = ? AND native_session_id = ?').get(who.agent, who.profile, who.native) !== undefined; }
      finally { b.close(); }
    } catch (e) {
      const code = ((e as { errcode?: number }).errcode ?? 0) & 0xff;
      if (code !== SQLITE_CORRUPT && code !== SQLITE_NOTADB) { done = false; continue; }
      holds = true;
    } finally {
      for (const f of sidecars) rmSync(f, { force: true });
    }
    if (holds) {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
      deleted++;
    }
  }
  return { deleted, done };
}
