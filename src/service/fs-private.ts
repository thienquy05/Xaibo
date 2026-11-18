// Private-directory and atomic-write helpers shared by the service (XAIBO-PROD-329, D-P3-23). The SEA mains
// (forwarder, statusline-tee) keep their own copies: they must stay self-contained.
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const uid = () => process.getuid?.();

/** Non-recursive 0700 mkdir (an existing dir is fine); a symlink, a non-directory or another uid's dir goes to
 * `onFail`; group/other bits are cleared. Other mkdir errors are rethrown. Path-based checks: same-uid races only. */
export function privateDir(dir: string, onFail: () => never = () => { throw new Error('not a private directory'); }): void {
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const st = lstatSync(dir);
  if (!st.isDirectory() || (uid() !== undefined && st.uid !== uid())) onFail();
  if (st.mode & 0o077) chmodSync(dir, 0o700);
}

export function fsyncDir(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** New file only: O_EXCL + O_NOFOLLOW, created 0600, then `mode`, fsynced. */
export function writeExclusive(file: string, data: Buffer | string, mode: number): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, data); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Same-dir temp file with an unpredictable name (`.<base>.<uuid>.tmp`), then rename. `beforeRename` runs last, so
 * a throw leaves the target as it was and no temp file behind. The directory is NOT fsynced: callers call
 * `fsyncDir` afterwards when the rename itself must be durable. */
export function atomicWrite(file: string, data: Buffer | string, mode: number, beforeRename?: () => void): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    writeExclusive(tmp, data, mode);
    beforeRename?.();
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}
