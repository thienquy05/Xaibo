// XAIBO-PROD-515 (P5-T07; FR-11, Q-5.1, Q-5.2, research L6): purge of Xaibo's copy of one session. One transaction run
// through the writer (so its disk-full state applies) settles the session's contributions (FR-52), deletes every row of
// the session and writes its Suppression marker with the file work it still owes. Only after that COMMIT returned: the
// session's content-chunk items (complete or interrupted) are removed, closed spool files are rewritten without its
// records, migration backups that hold it are deleted (Q-5.1: reported as backupsDeleted), then the marker's pending work
// is cleared; work a crash or an error left owed is redone by resumePurges (service start). Any failure up to COMMIT is
// rolled back and rethrown as it was: no marker, no file touched. Logical deletion, not forensic erasure (Q-5.2): bytes
// can remain in the main DB file, its WAL and freed pages, and in torn spool lines no parser can attribute. Native agent
// files are never touched.
import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { removeItems } from '../adapters/generic/chunks.ts';
import { atomicWrite, fsyncDir } from '../fs-private.ts';
import { openRegistry } from '../receivers/registrations.ts';
import { readOwn, spoolDir } from '../receivers/spool-replay.ts';
import { ftsPrefix, type Writer } from '../store/writer.ts';
import { settle } from '../usage/settle.ts';
import { suppress, type Identity, type SuppressionReason } from './suppression.ts';

export interface FileOptions { dataDir: string; backupDir: string; now: number }
export interface PurgeOptions extends FileOptions { secret: Buffer; reason: SuppressionReason }
export interface PurgeResult { purged: boolean; chunkItems: number; spoolFiles: number; backupsDeleted: number; filesPending: boolean }

/** Spool files no forwarder appends to: plain files of an earlier UTC day, and files a replay has taken. Today's plain
 *  file is the forwarder's; the next replay drops the session's records from it (intake refuses them). */
const CLOSED = /^(\d{4}-\d{2}-\d{2})(\.replay-[0-9a-f-]{36})?\.jsonl$/;
// review L2: a forwarder can still append to yesterday's file just after UTC midnight, and to a file a replay has just
// taken; one written or renamed (mtime or ctime) this recently before the purge's clock stays owed for resumePurges.
const QUIET_MS = 5_000;
const SPOOL_MAX = 64 << 20; // spool-replay's per-file bound
const SQLITE_CORRUPT = 11, SQLITE_NOTADB = 26;

export function purgeSession(writer: Writer, sessionId: number, o: PurgeOptions): PurgeResult {
  const listed = openRegistry(o.dataDir).all(); // the file read stays outside the transaction
  const purged = writer.transact((db) => {
    const s = db.prepare('SELECT agent, profile_id AS profile, native_session_id AS native FROM sessions WHERE id = ?').get(sessionId) as Identity | undefined;
    if (!s) return null;
    const regs = [...new Set([
      ...listed.filter((r) => r.agent === s.agent && r.profile_key === s.profile).map((r) => r.id),
      ...(db.prepare('SELECT DISTINCT registration_id AS r FROM report_delivery WHERE agent = ? AND profile_key = ? AND native_session_id = ?')
        .all(s.agent, s.profile, s.native) as { r: string }[]).map((x) => x.r),
    ])];
    deleteRows(db, sessionId, s, regs, o);
    return { who: { agent: s.agent, profile: s.profile, native: s.native }, regs };
  });
  if (!purged) return { purged: false, chunkItems: 0, spoolFiles: 0, backupsDeleted: 0, filesPending: false };
  const files = finishFiles(writer, purged.who, purged.regs, o);
  // ponytail: one unbounded incremental_vacuum on the writer; a bounded maintenance job with P5-T19 if a large purge stalls it
  try { writer.transact((db) => db.exec('PRAGMA incremental_vacuum')); } catch { /* best effort: the pages stay free for reuse */ }
  return { purged: true, ...files };
}

/** Redoes the file work of every committed purge that still owes it; returns how many finished now. */
export function resumePurges(writer: Writer, o: FileOptions): number {
  const rows = writer.transact((db) => db.prepare('SELECT agent, profile_id AS profile, native_session_id AS native, pending FROM suppressions WHERE pending IS NOT NULL')
    .all() as unknown as (Identity & { pending: string })[]);
  let n = 0;
  for (const r of rows) if (!finishFiles(writer, { agent: r.agent, profile: r.profile, native: r.native }, registrations(r.pending), o).filesPending) n++;
  return n;
}

function deleteRows(db: DatabaseSync, id: number, s: Identity, regs: string[], o: PurgeOptions) {
  const scopes = 'SELECT id FROM usage_scopes WHERE session_id = ?';
  const quota = (db.prepare(`SELECT id FROM usage_history WHERE usage_scope_id IN (${scopes})`).all(id) as { id: number }[]).map((r) => r.id);
  settle(db, { sessions: [id], quota }, o.secret, o.now); // FR-52: before anything it counts is deleted
  // FTS (external content) holds exactly the rows the writer indexed: current, with non-empty content, under its prefix;
  // a 'delete' must name those rows with that text (review M5)
  const unindex = db.prepare("INSERT INTO event_fts (event_fts, rowid, content) VALUES ('delete', ?, ?)");
  for (const r of db.prepare("SELECT id, content FROM events WHERE session_id = ? AND revision_status = 'current' AND content IS NOT NULL AND content <> ''")
    .iterate(id) as Iterable<{ id: number; content: string }>) unindex.run(r.id, ftsPrefix(r.content));
  const run = (sql: string, ...a: (string | number)[]) => db.prepare(sql).run(...a);
  for (const t of ['tool_calls', 'usage', 'cost_estimates', 'context_snapshots', 'usage_snapshots', 'cwd_history', 'subagents', 'turns']) run(`DELETE FROM ${t} WHERE session_id = ?`, id);
  run('DELETE FROM session_links WHERE from_session_id = ?1 OR to_session_id = ?1', id);
  run(`DELETE FROM usage_history WHERE usage_scope_id IN (${scopes})`, id); // session-linked quota (EC-99); account scopes stay
  run('DELETE FROM usage_scopes WHERE session_id = ?', id);
  // P5-T08 (review M2): the files that held its records, for a re-import: its own rows and any file its events came from
  const files = (db.prepare('SELECT id FROM source_files WHERE session_id = ?1 UNION SELECT file_id FROM events WHERE session_id = ?1 AND file_id IS NOT NULL')
    .all(id) as { id: number }[]).map((r) => r.id);
  // quarantined lines of the session's files may hold its content; the checkpoints stay, so a rescan resumes at its offset
  run('DELETE FROM quarantine WHERE file_id IN (SELECT id FROM source_files WHERE session_id = ?)', id);
  run('UPDATE source_files SET session_id = NULL WHERE session_id = ?', id);
  run('DELETE FROM events WHERE session_id = ?', id);
  for (const r of regs) {
    run('DELETE FROM report_content WHERE registration_id = ? AND native_session_id = ?', r, s.native);
    run('DELETE FROM report_delivery WHERE registration_id = ? AND native_session_id = ?', r, s.native);
  }
  run('DELETE FROM hook_delivery WHERE agent = ? AND profile_key = ? AND native_session_id = ?', s.agent, s.profile, s.native);
  run('DELETE FROM hook_gaps WHERE agent = ? AND native_session_id = ?', s.agent, s.native); // gaps carry no profile
  // review M4: evidence stored before migration 011 has profile ''
  run("DELETE FROM status_evidence WHERE agent = ? AND profile_id IN (?, '') AND native_session_id = ?", s.agent, s.profile, s.native);
  run('DELETE FROM overlays WHERE agent = ? AND profile_id = ? AND native_session_id = ?', s.agent, s.profile, s.native);
  run('DELETE FROM sessions WHERE id = ?', id);
  suppress(db, s, o.reason, o.now, regs, files);
}

/** P5-T08 (review M1): finishes the file work one marker still owes; true when none is owed any more. */
export function finishPending(writer: Writer, who: Identity, o: FileOptions): boolean {
  const row = writer.transact((db) => db.prepare('SELECT pending FROM suppressions WHERE agent = ? AND profile_id = ? AND native_session_id = ?')
    .get(who.agent, who.profile, who.native) as { pending: string | null } | undefined);
  if (!row || row.pending === null) return true;
  return !finishFiles(writer, who, registrations(row.pending), o).filesPending;
}

function registrations(pending: string): string[] {
  try { const v = JSON.parse(pending) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}

/** The post-commit file work; clears the marker's pending work once every step is done. Never throws. */
function finishFiles(writer: Writer, who: Identity, regs: string[], o: FileOptions): Omit<PurgeResult, 'purged'> {
  const set = new Set(regs);
  let done = true;
  const step = <T>(f: () => T, none: T): T => { try { return f(); } catch { done = false; return none; } };
  const chunkItems = step(() => removeItems(path.join(o.dataDir, 'content-chunks'), (k) => set.has(k.registration) && k.session === who.native), 0);
  const spool = step(() => rewriteSpool(o.dataDir, who, set, o.now), { files: 0, done: false });
  const backups = step(() => dropBackups(o.backupDir, who), { deleted: 0, done: false });
  done &&= spool.done && backups.done;
  if (done) {
    step(() => writer.transact((db) => db.prepare('UPDATE suppressions SET pending = NULL WHERE agent = ? AND profile_id = ? AND native_session_id = ?')
      .run(who.agent, who.profile, who.native)), undefined);
  }
  return { chunkItems, spoolFiles: spool.files, backupsDeleted: backups.deleted, filesPending: !done };
}

/** True for a spooled hook envelope or report record of the session. */
function ofSession(line: string, who: Identity, regs: Set<string>): boolean {
  let x: unknown;
  try { x = JSON.parse(line); } catch { return false; } // a torn line is nobody's record (Q-5.2 non-forensic)
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  if (r['kind'] === 'report') {
    const frame = r['frame'];
    return typeof r['registration'] === 'string' && regs.has(r['registration']) && typeof frame === 'object' && frame !== null
      && (frame as Record<string, unknown>)['session_id'] === who.native;
  }
  return r['agent'] === who.agent && r['profile_key'] === who.profile && r['session_id'] === who.native;
}

function rewriteSpool(dataDir: string, who: Identity, regs: Set<string>, now: number): { files: number; done: boolean } {
  const dir = spoolDir(dataDir);
  if (!dir) return { files: 0, done: true };
  const today = new Date(now).toISOString().slice(0, 10);
  let files = 0, done = true;
  for (const name of readdirSync(dir)) {
    const m = CLOSED.exec(name);
    if (!m || (!m[2] && m[1]! >= today)) continue;
    const file = path.join(dir, name);
    const got = readOwn(file, SPOOL_MAX); // own regular single-link file, never a symlink (review L2)
    if (!got) continue;
    const lines = got.buf.toString('utf8').split('\n');
    const keep = lines.filter((l) => l === '' || !ofSession(l, who, regs)); // other lines byte for byte
    if (keep.length === lines.length) continue;
    // a replay rename keeps the mtime and sets the ctime (review)
    if (now - Math.max(got.mtimeMs, got.ctimeMs) < QUIET_MS) { done = false; continue; }
    const text = keep.join('\n');
    // review: a forwarder that wrote after the read changed the file; it is left for a later pass, never overwritten
    const unchanged = () => { const st = lstatSync(file); if (st.ino !== got.ino || st.size !== got.buf.length) throw new Error('spool file changed'); };
    try {
      if (text.replaceAll('\n', '') === '') { unchanged(); unlinkSync(file); } else atomicWrite(file, text, 0o600, unchanged);
    } catch { done = false; continue; }
    fsyncDir(dir);
    files++;
  }
  return { files, done };
}

/** Q-5.1: deletes each backup that holds the session (a corrupt one cannot prove it does not). A backup that cannot be
 *  read for another reason (busy, out of handles) is kept and the work stays owed (review L1). */
function dropBackups(dir: string, who: Identity): { deleted: number; done: boolean } {
  let names: string[];
  try { names = readdirSync(dir); } catch { return { deleted: 0, done: true }; }
  const uid = process.getuid?.();
  let deleted = 0, done = true;
  // a backup run cut short leaves a full copy taken before its FTS merge: never a recovery point, always removed (review)
  for (const name of names.filter((f) => /^\.xaibo-v\d+\.db\.partial(-journal|-wal|-shm)?$/.test(f))) {
    const st = lstatSync(path.join(dir, name));
    if (st.isFile() && (uid === undefined || st.uid === uid)) rmSync(path.join(dir, name), { force: true });
  }
  for (const name of names.filter((f) => /^xaibo-v\d+\.db$/.test(f))) {
    const file = path.join(dir, name);
    const st = lstatSync(file);
    if (!st.isFile() || (uid !== undefined && st.uid !== uid)) continue;
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
