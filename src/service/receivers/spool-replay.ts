// Spool replay (P3-T04; EC-11 replay side, EC-12 gap, EC-46; security review 389). The forwarder appends envelopes it
// could not deliver to <dataDir>/spool/<date>.jsonl (D-P3-04) and, at the cap, short lines to overflow.log. On service
// start, after the socket listens: each plain spool file is renamed to a private replay name (new appends start a fresh
// file), every record is parsed with the socket's own strict parser and replayed oldest first (received_ts) through
// intake; a file is removed only after every record committed, after a grace past the forwarder's deadline, and only if
// it is the same inode at the size read (a forwarder that opened the old name writes into it; the next replay takes the
// rest, dedup by delivery_id). Records that fail to parse are torn, one gap per file. overflow.log and overflow.saturated
// become hook_gaps rows per {agent, session, time range}. Gap locators name the taken file (a UUID name kept across a
// crash), so a crash between commit and removal never counts twice and a re-read of a grown file updates its rows.
// Memory is bounded in aggregate: files past the bound wait for the next replay. Only a spool/ of our own uid that is not
// a symlink, and regular single-link files of our own, are read; nothing is followed.
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, renameSync, unlinkSync, type Stats } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseEnvelope, type Envelope } from '../../shared/hook-protocol.ts';
import type { IntakeResult } from './socket.ts';

export interface ReplayOptions {
  dataDir: string; db: DatabaseSync; deliver: (e: Envelope) => Promise<IntakeResult>; now?: () => number;
  /** Wait after a rename before a taken file may be removed (default 1 s). */
  graceMs?: number;
  /** Bytes of spool files read per replay (default 64 MiB). */
  maxBytes?: number;
  /** True once the service stops: no delivery or write after that; the files stay for the next start. */
  stopped?: () => boolean;
}
/** deferred: spool files left for the next replay by the aggregate bound. */
export interface ReplayResult { delivered: number; torn: number; skipped: number; deferred: number; complete: boolean }

const PLAIN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const TAKEN = /^\d{4}-\d{2}-\d{2}\.replay-[0-9a-f-]{36}\.jsonl$/;
const OVERFLOW_TAKEN = /^overflow\.taken-[0-9a-f-]{36}\.log$/;
const AGENT = /^[a-z0-9][a-z0-9-]{0,31}$/;
// The forwarder's 50 MiB cap plus its concurrent overshoot (N x 256 KiB); a larger file is not one it wrote. ponytail:
// a skipped file stays and counts toward the forwarder's cap until someone removes it.
const FILE_MAX = 64 << 20;
const OVERFLOW_MAX = 2 << 20; // the forwarder caps overflow.log at 1 MiB
const TOTAL_MAX = 64 << 20;
// ponytail: the forwarder's own deadline is 60 ms after entry, so a write into a renamed file comes well within this; a
// forwarder stopped (SIGSTOP, swapped out) longer than the grace between its open and its write can still lose a record.
// A lock shared with the forwarder if that is ever observed.
const GRACE_MS = 1_000;

type Gap = { reason: string; agent: string | null; session: string | null; from: number | null; to: number | null; count: number | null; locator: string };
/** A taken file to remove once its grace has passed and it is unchanged. Every file waits, a taken one from an earlier
 *  replay too: a forwarder may still hold it open if that replay renamed it moments ago. */
type Done = { file: string; ino: number; size: number; takenAt: number };

const uid = process.getuid?.();
const own = (st: Stats) => uid === undefined || st.uid === uid;
const lstat = (p: string) => { try { return lstatSync(p); } catch { return null; } };
const regularOwn = (st: Stats | null) => !!st && st.isFile() && own(st) && st.nlink === 1;

function spoolDir(dataDir: string): string | null {
  const dir = path.join(dataDir, 'spool');
  const st = lstat(dir);
  if (!st || !st.isDirectory() || !own(st)) return null;
  if (st.mode & 0o077) chmodSync(dir, 0o700);
  return dir;
}

/** The whole file if it is a regular, single-link file of our own within `max` bytes; never follows a symlink. */
function readOwn(file: string, max: number): { buf: Buffer; ino: number } | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!regularOwn(st) || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < st.size) { const r = readSync(fd, buf, n, st.size - n, n); if (r === 0) break; n += r; }
    return { buf: buf.subarray(0, n), ino: st.ino };
  } finally {
    closeSync(fd);
  }
}

/** Renames a plain file of our own to a private name; null if it is not one (left alone). */
function take(dir: string, name: string, to: string): string | null {
  const file = path.join(dir, name);
  if (!regularOwn(lstat(file))) return null;
  const taken = path.join(dir, to);
  renameSync(file, taken);
  return taken;
}

function putGaps(db: DatabaseSync, gaps: Gap[], at: number): boolean {
  if (!gaps.length) return true;
  const put = db.prepare(`INSERT INTO hook_gaps (reason, agent, native_session_id, from_ts, to_ts, count, locator, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (locator) DO UPDATE SET from_ts = excluded.from_ts, to_ts = excluded.to_ts, count = excluded.count`);
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const g of gaps) put.run(g.reason, g.agent, g.session, g.from, g.to, g.count, g.locator, at);
    db.exec('COMMIT');
    return true;
  } catch {
    if (db.isTransaction) db.exec('ROLLBACK');
    return false; // the files stay for the next replay
  }
}

const unlink = (f: string) => { try { unlinkSync(f); } catch { /* already gone */ } };

/** One overflow line, strictly: {ts, agent, session_id, event} as the forwarder writes it; else null. */
function overflowLine(line: string): { ts: number; agent: string; session: string | null } | null {
  let x: unknown;
  try { x = JSON.parse(line); } catch { return null; }
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const s = o['session_id'];
  const ok = typeof o['ts'] === 'number' && Number.isFinite(o['ts']) && o['ts'] >= 0 && typeof o['agent'] === 'string' && AGENT.test(o['agent'])
    && (s === null || (typeof s === 'string' && s.length > 0 && s.length <= 256)) && typeof o['event'] === 'string' && o['event'].length <= 128;
  return ok ? { ts: o['ts'] as number, agent: o['agent'] as string, session: s as string | null } : null;
}

function overflowGaps(dir: string, db: DatabaseSync, now: number, done: Done[]) {
  for (const name of readdirSync(dir).sort()) {
    const fresh = name === 'overflow.log';
    const file = fresh ? take(dir, name, `overflow.taken-${randomUUID()}.log`) : OVERFLOW_TAKEN.test(name) ? path.join(dir, name) : null;
    const got = file && readOwn(file, OVERFLOW_MAX);
    if (!got) continue;
    const { buf } = got;
    const id = path.basename(file!);
    const groups = new Map<string, Gap>();
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue;
      const x = overflowLine(line);
      const key = JSON.stringify(x ? [x.agent, x.session] : null);
      const g = groups.get(key);
      if (!g) groups.set(key, { reason: 'spool-overflow', agent: x?.agent ?? null, session: x?.session ?? null, from: x?.ts ?? null, to: x?.ts ?? null, count: 1, locator: `overflow:${id}:${key}` });
      else {
        g.count!++;
        if (x) { g.from = Math.min(g.from!, x.ts); g.to = Math.max(g.to!, x.ts); }
      }
    }
    if (putGaps(db, [...groups.values()], now)) done.push({ file: file!, ino: got.ino, size: buf.length, takenAt: Date.now() });
  }
  // Saturated: overflow lines stopped at the log's own cap, so from the flag's time until now the number is unknown.
  const flag = path.join(dir, 'overflow.saturated');
  const st = lstat(flag);
  if (regularOwn(st) && putGaps(db, [{ reason: 'spool-saturated', agent: null, session: null, from: Math.floor(st!.mtimeMs), to: now, count: null,
    locator: `saturated:${st!.ino}:${st!.mtimeMs}` }], now)) unlink(flag);
}

export async function replaySpool(o: ReplayOptions): Promise<ReplayResult> {
  const r: ReplayResult = { delivered: 0, torn: 0, skipped: 0, deferred: 0, complete: true };
  const dir = spoolDir(o.dataDir);
  if (!dir) return r;
  const now = o.now ?? Date.now;
  const maxBytes = o.maxBytes ?? TOTAL_MAX;
  const files: Done[] = [];
  const torn: Gap[] = [];
  const records: Envelope[] = [];
  let bytes = 0;
  for (const name of readdirSync(dir).sort()) {
    const plain = PLAIN.exec(name);
    if (!plain && !TAKEN.test(name)) continue;
    const size = lstat(path.join(dir, name))?.size ?? 0;
    if (bytes > 0 && bytes + size > maxBytes) { r.deferred++; continue; } // not renamed: the next replay takes it
    const file = plain ? take(dir, name, `${plain[1]}.replay-${randomUUID()}.jsonl`) : path.join(dir, name);
    const got = file && readOwn(file, FILE_MAX);
    if (!got) { r.skipped++; continue; }
    bytes += got.buf.length;
    files.push({ file: file!, ino: got.ino, size: got.buf.length, takenAt: Date.now() });
    let bad = 0;
    for (const line of got.buf.toString('utf8').split('\n')) {
      if (!line) continue;
      let p: ReturnType<typeof parseEnvelope>;
      try { p = parseEnvelope(JSON.parse(line)); } catch { p = { ok: false, code: 'shape' }; }
      if (p.ok) records.push(p.envelope);
      else bad++;
    }
    r.torn += bad;
    if (bad) torn.push({ reason: 'spool-torn', agent: null, session: null, from: null, to: null, count: bad, locator: `torn:${path.basename(file!)}` });
  }
  records.sort((a, b) => a.received_ts - b.received_ts); // stable: same-ms records keep file order
  for (const e of records) {
    if (o.stopped?.()) { r.complete = false; break; }
    const res = await o.deliver(e);
    if (res.status !== 'accepted') { r.complete = false; break; }
    if (res.code !== 'duplicate') r.delivered++;
  }
  if (o.stopped?.()) return r;
  if (r.complete) r.complete = putGaps(o.db, torn, now());
  const done = r.complete ? files : [];
  overflowGaps(dir, o.db, now(), done);
  const wait = Math.max(0, ...done.map((d) => d.takenAt)) + (o.graceMs ?? GRACE_MS) - Date.now();
  if (done.length && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  if (o.stopped?.()) { r.complete = false; return r; } // stopped during the grace: the next start removes them
  for (const d of done) {
    const st = lstat(d.file);
    if (st && st.ino === d.ino && st.size === d.size) unlink(d.file);
  }
  return r;
}
