// XAIBO-PROD-559 (P6-T03 part 2a; Codex part 2 design §7 and its review, .handoff/p6-t03-design.md): one exclusive lock for
// every writer of agent config and the FR-32 manifest (service Connect/Disconnect/Uninstall, dev CLI write commands, Codex
// status 'seen' writes). <dataDir>/integrations/operation.lock is created O_EXCL|O_NOFOLLOW, 0600. A lock is never taken over;
// release removes only a lock holding our token. Take it only at entry points, never inside apply/revert/recordEntry/
// installPlugin/deployShim.
// XAIBO-PROD-612 (Phase 7 cleanup item 1, run 1; Codex design, D-P7-03): record v2 {v, pid, token, at, start, writer}: start is
// the holder's process-start stamp (ps lstart, C locale, UTC; null when our own probe failed), writer 'service' (in-process
// writes) or 'external' (an external CLI runs under it, or the dev CLI holds it). A holder is stale only when its pid is gone
// (ESRCH) or alive with a different stamp (pid reused); the same stamp is busy; anything Xaibo can't verify (EPERM, a failed
// probe, a legacy or unstamped record of a live pid, an empty, malformed, linked, non-regular, foreign or unreadable file, an fs
// error other than ENOENT) is lock-unknown. No age threshold. busy, stale-lock and lock-unknown all refuse an acquire.
import { randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { runSync } from '../spawn.ts';
import { ConfigError, privateDirs, readFile } from './transaction.ts';

export interface Lock { release(): void }
export type Writer = 'service' | 'external';
export type Held = 'busy' | 'stale-lock' | 'lock-unknown';
const lockFile = (dataDir: string) => path.join(dataDir, 'integrations', 'operation.lock');
const contentOf = (f: string): Record<string, unknown> | null => { const cur = readFile(f); return cur ? (JSON.parse(cur.bytes.toString('utf8')) as Record<string, unknown>) : null; };

// ponytail: trusted because macOS keeps a process's start time fixed at fork; procps (Linux) derives lstart from boot time and
// can shift a second across clock steps, so re-check before any non-macOS build.
const STAMP = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d\d:\d\d:\d\d \d{4}$/;
/** The process-start stamp of `pid` (fixed argv, LC_ALL=C TZ=UTC0, 500 ms, 256 bytes), whitespace collapsed; null on any failure. */
function startStamp(pid: number): string | null {
  const out = runSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 500, maxBytes: 256, env: { LC_ALL: 'C', TZ: 'UTC0', PATH: '/usr/bin:/bin' } });
  const s = out?.toString('utf8').trim().replace(/\s+/g, ' ') ?? '';
  return STAMP.test(s) ? s : null;
}
let own: string | null = null; // cached once known; a failed probe is retried at the next acquire
const ownStamp = () => (own ??= startStamp(process.pid));

/** Who holds a lock record (exported for tests): see the header. `probe` reads a live pid's start stamp. */
export function judge(rec: unknown, probe: (pid: number) => string | null = startStamp): Held {
  const r = typeof rec === 'object' && rec !== null ? (rec as Record<string, unknown>) : {};
  const pid = r['pid'];
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return 'lock-unknown';
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'stale-lock' : 'lock-unknown'; }
  const start = r['v'] === 2 && typeof r['start'] === 'string' && STAMP.test(r['start']) ? r['start'] : null;
  if (!start) return 'lock-unknown'; // legacy, or a holder that could not stamp itself: only ESRCH proves staleness
  const now = pid === process.pid ? ownStamp() : probe(pid); // our own pid: the cached stamp, no ps per refresh (review LOW)
  return now === null ? 'lock-unknown' : now === start ? 'busy' : 'stale-lock';
}

function holder(f: string): Held {
  let rec: unknown;
  try {
    const cur = readFile(f); // symlink, not regular, not ours, too large, unreadable: a ConfigError
    if (!cur) return 'busy'; // released between our look and our read: check again
    rec = JSON.parse(cur.bytes.toString('utf8'));
  } catch { return 'lock-unknown'; }
  return judge(rec);
}

/** `writer` defaults to 'external', the class an in-app clear never touches. */
export function acquireLock(dataDir: string, writer: Writer = 'external'): Lock {
  privateDirs(dataDir); // 0700, own uid, no symlink
  const f = lockFile(dataDir), token = randomUUID(), start = ownStamp();
  let fd: number;
  try { fd = openSync(f, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ELOOP') throw new ConfigError(holder(f));
    throw e;
  }
  try { writeSync(fd, JSON.stringify({ v: 2, pid: process.pid, token, at: Date.now(), start, writer })); } catch (e) {
    closeSync(fd);
    try { unlinkSync(f); } catch { /* nothing more to do */ }
    throw e;
  }
  closeSync(fd);
  return {
    release() {
      try { if (contentOf(f)?.['token'] === token) unlinkSync(f); } catch { /* left in place */ }
    },
  };
}

/** A synchronous, non-throwing attempt (Codex status): null when held, stale or unknown. */
export function tryLock(dataDir: string, writer: Writer = 'external'): Lock | null {
  try { return acquireLock(dataDir, writer); } catch (e) { if (e instanceof ConfigError) return null; throw e; }
}

/** The lock's state without taking it (a preview made while it is held would fail at apply): only a missing file is free. */
export function lockState(dataDir: string): 'free' | Held {
  const f = lockFile(dataDir);
  try { lstatSync(f); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'free' : 'lock-unknown'; }
  return holder(f);
}
