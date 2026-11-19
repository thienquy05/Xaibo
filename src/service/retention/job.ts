// XAIBO-PROD-517 (P5-T09; FR-12, §5.11, EC-22, FR-52): the retention job. One run: finishes purge file work still owed,
// purges sessions past the retention setting (reason retention), empties Trash older than 30 days (reason manual: the
// owner deleted it; Keep does not protect Trash), and expires account-level usage history 45 days after measurement
// whatever the setting or Keep. Every deletion is settled into the monthly totals in its own transaction first. Each
// purge re-checks eligibility inside its transaction; the run yields to the event loop between transactions so live
// commits go first, stops on a full disk or service stop, and refuses to run on a clock behind its last run.
import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { purgeSession, resumePurges, vacuum } from '../history/purge.ts';
import { TRASH_MS } from '../history/trash.ts';
import { LIVE_WINDOW_MS } from '../status/feed.ts';
import type { Writer } from '../store/writer.ts';
import { settle } from '../usage/settle.ts';
import { clockJumped, DAY, eligible, LAST_RUN_KEY, QUOTA_MS, RECENT_MS, retentionOf } from './policy.ts';

export interface RetentionOptions {
  dataDir: string; backupDir: string; secret: Buffer; now: number;
  /** The status engine's view: the session is busy, waiting for permission or needs input. */
  active: (agent: string, profile: string, native: string) => boolean;
  /** Rows read per page (default 100). */
  batch?: number;
  stopped?: () => boolean;
  log?: (event: string, fields?: Record<string, string | number>) => void;
}
export interface RetentionResult { sessions: number; trash: number; quota: number; skipped: null | 'clock-behind' | 'invalid-setting' }

const LAST_RUN = LAST_RUN_KEY;
const QUOTA_BATCH = 500;
/** P5-T11 (EC-99): the next stream of an account scope after `limit_id`, one seek on usage_history_stream (stream ids are
 *  never empty, so '' starts the walk). */
export const QUOTA_STREAM = 'SELECT min(limit_id) AS l FROM usage_history WHERE usage_scope_id = ? AND limit_id > ?';
/** One stream's expired rows, oldest first, a range on usage_history_stream. */
export const QUOTA_EXPIRED = `SELECT id FROM usage_history WHERE usage_scope_id = ? AND limit_id = ? AND measured_at <= ? ORDER BY measured_at LIMIT ${QUOTA_BATCH}`;
type Row = { id: number; agent: string; profile: string; native: string; last: number | null; k: number };
const tick = () => new Promise((resolve) => setImmediate(resolve));

export async function runRetention(writer: Writer, db: DatabaseSync, o: RetentionOptions): Promise<RetentionResult> {
  const r: RetentionResult = { sessions: 0, trash: 0, quota: 0, skipped: null };
  const lastRun = Number((db.prepare('SELECT value FROM kv WHERE key = ?').get(LAST_RUN) as { value: string } | undefined)?.value ?? -Infinity);
  // review H3: a clock behind the last run (set back after running ahead) purges nothing until it catches up. ponytail: a
  // clock already ahead at the first run after boot is not detected here; the daily timer compares wall and monotonic time.
  if (o.now < lastRun) { o.log?.('retention_skipped', { reason: 'clock-behind' }); return { ...r, skipped: 'clock-behind' }; }
  const files = { dataDir: o.dataDir, backupDir: o.backupDir, now: o.now };
  resumePurges(writer, files); // review M3: owed file work keeps a marker blocking, so it is finished first
  const halt = () => writer.diskFull || !!o.stopped?.() || !db.isOpen;
  const n = o.batch ?? 100;
  let backups = 0;
  const live = (row: Row) => o.active(row.agent, row.profile, row.native) && row.last !== null && row.last >= o.now - LIVE_WINDOW_MS; // review L1
  const purge = (row: Row, reason: 'retention' | 'manual', guard: (db: DatabaseSync, id: number) => boolean) => {
    try {
      const p = purgeSession(writer, row.id, { ...files, secret: o.secret, reason, guard, vacuum: false });
      backups += p.backupsDeleted;
      return p.purged;
    } catch (e) { // review L4: one bad session never blocks the rest; a full disk stops the run (halt)
      o.log?.('retention_purge_failed', { error: e instanceof Error ? e.name : 'unknown' });
      return false;
    }
  };
  const SESSION = `SELECT s.id, s.agent, s.profile_id AS profile, s.native_session_id AS native, coalesce(s.last_activity, s.started_at) AS last,
    coalesce(o.keep, 0) AS keep, o.trashed_at FROM sessions s
    LEFT JOIN overlays o ON o.agent = s.agent AND o.profile_id = s.profile_id AND o.native_session_id = s.native_session_id`;

  // 1. Session retention, oldest first by keyset (review L2: no last activity -> its start; neither -> never)
  const policy = retentionOf(db);
  if (policy === null) { r.skipped = 'invalid-setting'; o.log?.('retention_skipped', { reason: 'invalid-setting' }); }
  if (policy && policy !== 'never') {
    const cutoff = o.now - Math.max(policy.days * DAY, RECENT_MS);
    // ponytail: the coalesce key scans sessions per page (no index on it); an expression index if retention pages show up in M13
    const page = db.prepare(`SELECT id, agent, profile, native, last, last AS k FROM (${SESSION}) WHERE last <= ? AND keep = 0 AND trashed_at IS NULL
      AND (last > ? OR (last = ? AND id > ?)) ORDER BY last, id LIMIT ?`);
    const recheck = db.prepare(`${SESSION} WHERE s.id = ?`);
    const fileTimes = db.prepare('SELECT path FROM source_files WHERE session_id = ?');
    // review H1: a native file written after the cutoff means the session may have continued while Xaibo was off
    const changed = (id: number) => (fileTimes.all(id) as { path: string }[]).some((f) => { try { return statSync(f.path).mtimeMs > cutoff; } catch { return false; } });
    const guard = (gdb: DatabaseSync, id: number) => {
      const s = recheck.get(id) as { last: number | null; keep: number; trashed_at: number | null } | undefined;
      // XAIBO-PROD-527 (design review H1): eligible under the setting as stored now, so a change during a long run (Never,
      // a longer period, unreadable) stops purges under the old one
      const current = retentionOf(gdb);
      return !!s && gdb.isOpen && current !== null && eligible({ lastActivity: s.last, keep: s.keep === 1, trashed: s.trashed_at !== null, active: false }, current, o.now);
    };
    let at = -Infinity, id = 0;
    for (;;) {
      if (halt()) return finish(); // diff review L2: a stop between pages ends the run, not a failed query
      const rows = page.all(cutoff, at, at, id, n) as unknown as Row[];
      if (!rows.length) break;
      for (const row of rows) {
        if (halt()) return finish();
        at = row.k; id = row.id;
        if (live(row) || changed(row.id)) continue;
        if (purge(row, 'retention', guard)) r.sessions++;
        await tick();
      }
    }
  }

  // 2. Trash auto-empty, oldest deletion first (Keep does not protect Trash; review L3: activity under 24 h waits)
  const trashCut = o.now - TRASH_MS;
  const trashPage = db.prepare(`SELECT id, agent, profile, native, last, trashed_at AS k FROM (${SESSION}) WHERE trashed_at <= ?
    AND (trashed_at > ? OR (trashed_at = ? AND id > ?)) ORDER BY trashed_at, id LIMIT ?`);
  // diff review L1: restored meanwhile, or active within 24 h meanwhile: it waits
  const stillTrashed = db.prepare(`${SESSION} WHERE s.id = ? AND o.trashed_at <= ? AND (coalesce(s.last_activity, s.started_at) IS NULL
    OR coalesce(s.last_activity, s.started_at) <= ?)`);
  let tAt = -Infinity, tId = 0;
  for (;;) {
    if (halt()) return finish();
    const rows = trashPage.all(trashCut, tAt, tAt, tId, n) as unknown as Row[];
    if (!rows.length) break;
    for (const row of rows) {
      if (halt()) return finish();
      tAt = row.k; tId = row.id;
      if (live(row) || (row.last !== null && o.now - row.last < RECENT_MS)) continue;
      if (purge(row, 'manual', (_db, sid) => stillTrashed.get(sid, trashCut, o.now - RECENT_MS) !== undefined)) r.trash++;
      await tick();
    }
  }

  // 3. Account-level usage history: samples and snapshots without a session, 45 days after measurement (§5.11). Session-
  // linked ones follow their session (Keep, Trash, purge). P5-T11: walked per account scope and stream on the
  // usage_history_stream index (no scan of the history); the writer keeps readings expired here from coming back.
  // ponytail: the account scopes come from a scan of usage_scopes (one row per account plus one per unverified session).
  const quotaCut = o.now - QUOTA_MS;
  const streamAfter = db.prepare(QUOTA_STREAM);
  const expired = db.prepare(QUOTA_EXPIRED);
  for (const { id: scope } of db.prepare('SELECT id FROM usage_scopes WHERE session_id IS NULL ORDER BY id').all() as { id: number }[]) {
    for (let l = (streamAfter.get(scope, '') as { l: string | null }).l; l !== null; l = (streamAfter.get(scope, l) as { l: string | null }).l) {
      for (;;) {
        if (halt()) return finish();
        const ids = (expired.all(scope, l, quotaCut) as { id: number }[]).map((x) => x.id);
        if (!ids.length) break;
        const gone = Number(writer.transact((tdb) => {
          settle(tdb, { sessions: [], quota: ids }, o.secret, o.now); // FR-52: before the rows go
          return tdb.prepare('DELETE FROM usage_history WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids)).changes;
        }));
        r.quota += gone;
        if (!gone || ids.length < QUOTA_BATCH) break; // diff review L3: never the same rows again
        await tick();
      }
    }
  }
  for (;;) {
    if (halt()) return finish();
    const gone = Number(writer.transact((tdb) => tdb.prepare(`DELETE FROM usage_snapshots WHERE id IN (SELECT id FROM usage_snapshots
      WHERE session_id IS NULL AND coalesce(as_of, observed_at) <= ? LIMIT ${QUOTA_BATCH})`).run(quotaCut).changes));
    if (!gone) break;
    r.quota += gone;
    await tick();
  }
  writer.transact((tdb) => tdb.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(LAST_RUN, String(o.now)));
  return finish();

  function finish(): RetentionResult {
    if (r.sessions || r.trash) vacuum(writer); // review M2: once per run
    if (backups) o.log?.('retention_backups_deleted', { count: backups }); // Q-5.1 notice
    o.log?.('retention_run', { sessions: r.sessions, trash: r.trash, quota: r.quota });
    return r;
  }
}

export interface SchedulerOptions {
  run: () => void; delayMs: number; wall: () => number; mono: () => number;
  setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (t: unknown) => void;
  log?: (event: string, fields?: Record<string, string | number>) => void;
}
/** P5-T09: the first run `delayMs` after start, then daily. A run whose wall clock moved more than 1 h further than the
 *  monotonic clock is skipped (review H3) and retried after `delayMs`, not a day later. The monotonic clock stops while
 *  the machine sleeps (diff review H1), so the service's wake() re-baselines both clocks. */
export function retentionScheduler(o: SchedulerOptions): { start(): void; wake(): void; stop(): void } {
  let from = { wall: 0, mono: 0 };
  let timer: unknown;
  const baseline = () => { from = { wall: o.wall(), mono: o.mono() }; };
  const arm = (ms: number) => { baseline(); timer = o.setTimer(fire, ms); };
  function fire() {
    if (clockJumped(from, { wall: o.wall(), mono: o.mono() })) { o.log?.('retention_skipped', { reason: 'clock-jump' }); arm(o.delayMs); return; }
    o.run();
    arm(DAY);
  }
  return { start: () => arm(o.delayMs), wake: baseline, stop: () => o.clearTimer(timer) };
}
