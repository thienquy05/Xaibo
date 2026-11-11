// Data dir (P1-T04): XAIBO_DATA_DIR for tests, else <appData>/Xaibo (packaged) or Xaibo-dev (unpackaged), so dev and
// prod hold separate single-instance locks and data. Private by construction: umask 077, dir 0700. Runs before `ready`.
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface DataDirInput { env: Record<string, string | undefined>; packaged: boolean; appData: string }

export function resolveDataDir({ env, packaged, appData }: DataDirInput): string {
  const override = env.XAIBO_DATA_DIR;
  if (override !== undefined) {
    if (!path.isAbsolute(override)) throw new Error('XAIBO_DATA_DIR must be an absolute path');
    return override;
  }
  return path.join(appData, packaged ? 'Xaibo' : 'Xaibo-dev');
}

export function prepareDataDir(dir: string): void {
  process.umask(0o077);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** resolve + prepare without throwing (a top-level throw in Electron main shows an error dialog); null on failure. */
export function initDataDir(input: DataDirInput, writeErr: (s: string) => void): string | null {
  let dir;
  try { dir = resolveDataDir(input); } catch (e) {
    writeErr(`xaibo: ${(e as Error).message}\n`); // our own fixed message
    return null;
  }
  try {
    prepareDataDir(dir);
    return dir;
  } catch (e) { // fs messages carry the absolute path: print the error code only (EC-35)
    const code = (e as NodeJS.ErrnoException).code;
    writeErr(`xaibo: cannot prepare the data directory (${typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown'})\n`);
    return null;
  }
}
