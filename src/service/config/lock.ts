// XAIBO-PROD-559 (P6-T03 part 2a; Codex part 2 design §7 and its review, .handoff/p6-t03-design.md): one exclusive lock for
// every writer of agent config and the FR-32 manifest (service Connect/Disconnect/Uninstall, dev CLI write commands, Codex
// status 'seen' writes). <dataDir>/integrations/operation.lock is created O_EXCL|O_NOFOLLOW, 0600, holding {pid, token, at};
// a second acquire, from this process or another, is `busy`; a lock whose holder pid is gone is `stale-lock`. A lock is never
// taken over (a stale one needs P6-T04 reconcile or an owner-confirmed clear: a P6-T12 prerequisite). Release removes only a
// lock holding our token. Take it only at entry points, never inside apply/revert/recordEntry/installPlugin/deployShim.
import { randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, privateDirs, readFile } from './transaction.ts';

export interface Lock { release(): void }
const lockFile = (dataDir: string) => path.join(dataDir, 'integrations', 'operation.lock');
const contentOf = (f: string): Record<string, unknown> | null => { const cur = readFile(f); return cur ? (JSON.parse(cur.bytes.toString('utf8')) as Record<string, unknown>) : null; };

/** Who holds it: a live (or unknown) holder is busy; only a pid that is provably gone is stale. Unreadable = busy. */
function holder(f: string): 'busy' | 'stale-lock' {
  let pid: unknown;
  try { pid = contentOf(f)?.['pid']; } catch { return 'busy'; }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return 'busy';
  try { process.kill(pid, 0); return 'busy'; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'stale-lock' : 'busy'; }
}

export function acquireLock(dataDir: string): Lock {
  privateDirs(dataDir); // 0700, own uid, no symlink
  const f = lockFile(dataDir), token = randomUUID();
  let fd: number;
  try { fd = openSync(f, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ELOOP') throw new ConfigError(holder(f));
    throw e;
  }
  try { writeSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() })); } catch (e) {
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

/** A synchronous, non-throwing attempt (Codex status): null when held or stale. */
export function tryLock(dataDir: string): Lock | null {
  try { return acquireLock(dataDir); } catch (e) { if (e instanceof ConfigError) return null; throw e; }
}

/** The lock's state without taking it (a preview made while it is held would fail at apply): free, busy or stale-lock. */
export function lockState(dataDir: string): 'free' | 'busy' | 'stale-lock' {
  const f = lockFile(dataDir);
  try { lstatSync(f); } catch { return 'free'; }
  return holder(f);
}