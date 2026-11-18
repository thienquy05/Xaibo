// XAIBO-PROD-505 (P5-T01a; FR-53, S-37): a session cwd resolved to its repository's verified common git directory from
// git metadata files only (lstat/stat, a bounded read of small pointer files, realpath): no process, no repository content.
// Any missing, unreadable or inconsistent step, or a failed back-pointer check, keeps cwd grouping with its reason.
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export type CwdReason = 'no-git' | 'unreadable' | 'inconsistent' | 'back-pointer' | 'not-repository';
export type Grouping = { kind: 'repository'; key: string; worktree: string } | { kind: 'cwd'; reason: CwdReason };

const POINTER_MAX = 4096; // git's .git, gitdir and commondir files hold one path
const cwdOnly = (reason: CwdReason): Grouping => ({ kind: 'cwd', reason });
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
const missing = (e: unknown) => code(e) === 'ENOENT' || code(e) === 'ENOTDIR';

/** realpath for I/O (NFC is applied only to the returned key and worktree, so an NFD name still opens); null when missing. */
function real(p: string): string | null {
  try { return realpathSync.native(p); } catch (e) { if (missing(e)) return null; throw e; }
}
/** What sits at `p`: null when nothing does; 'other' for a dangling symlink, FIFO, socket or device. */
function entry(p: string): 'dir' | 'file' | 'other' | null {
  try { lstatSync(p); } catch (e) { if (missing(e)) return null; throw e; }
  try { const s = statSync(p); return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other'; } catch (e) { if (missing(e)) return 'other'; throw e; }
}
/** One pointer line, trailing whitespace (and CRLF) trimmed as git does; null when missing; false when it is not a regular
 *  file (never opened, so a FIFO cannot block) or larger than POINTER_MAX; throws when unreadable. */
function pointer(p: string): string | null | false {
  const k = entry(p);
  if (k !== 'file') return k === null ? null : false;
  const fd = openSync(p, 'r');
  try {
    const buf = Buffer.alloc(POINTER_MAX + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return n > POINTER_MAX ? false : buf.toString('utf8', 0, n).replace(/\s+$/, '');
  } finally { closeSync(fd); }
}
const isRepository = (dir: string) => entry(path.join(dir, 'HEAD')) === 'file' && entry(path.join(dir, 'objects')) === 'dir' && entry(path.join(dir, 'refs')) === 'dir';

export function resolveRepository(cwd: string): Grouping {
  try { return resolve(cwd); } catch { return cwdOnly('unreadable'); } // EACCES and other read errors
}

function resolve(cwd: string): Grouping {
  const start = real(cwd);
  if (start === null) return cwdOnly('unreadable');
  let worktree = start;
  let kind = entry(path.join(worktree, '.git'));
  while (kind === null) {
    const up = path.dirname(worktree);
    if (up === worktree) return cwdOnly('no-git');
    worktree = up;
    kind = entry(path.join(worktree, '.git'));
  }
  if (kind === 'other') return cwdOnly('inconsistent'); // the first .git decides: never walk past it to an outer repository
  const dotGit = path.join(worktree, '.git');
  let common: string | null;
  if (kind === 'dir') common = real(dotGit);
  else {
    const line = pointer(dotGit);
    const m = typeof line === 'string' ? /^gitdir: (.+)$/.exec(line) : null;
    const target = m ? real(path.resolve(worktree, m[1]!)) : null; // relative to the file that holds it
    if (target === null || entry(target) !== 'dir') return cwdOnly('inconsistent');
    const commondir = pointer(path.join(target, 'commondir'));
    if (commondir === false) return cwdOnly('inconsistent');
    if (commondir === null) common = target; // a separate git directory: no back-pointer needed
    else {
      const back = pointer(path.join(target, 'gitdir'));
      if (typeof back !== 'string' || real(path.resolve(target, back)) !== real(dotGit)) return cwdOnly('back-pointer');
      common = real(path.resolve(target, commondir));
      if (common === null) return cwdOnly('inconsistent');
    }
  }
  if (common === null || !isRepository(common)) return cwdOnly('not-repository');
  return { kind: 'repository', key: common.normalize('NFC'), worktree: worktree.normalize('NFC') };
}
