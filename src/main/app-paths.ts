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

/** XAIBO-PROD-558 (P6-T03 part 1b; design review M3): the service's environment. main always sets XAIBO_BIN itself, last:
 *  the packaged helpers in resources/bin, or '' (the service then uses the repo's helpers), so a value inherited from the
 *  shell or launchctl never decides which helpers agent hooks run. */
export function serviceEnv(env: Record<string, string | undefined>, o: { dataDir: string; packaged: boolean; resourcesPath: string }): Record<string, string | undefined> {
  return { ...env, XAIBO_DATA_DIR: o.dataDir, XAIBO_BIN: o.packaged ? path.join(o.resourcesPath, 'bin') : '' };
}


/** XAIBO-PROD-611 (Gate 6 second review item 5; design security review): main's only view of its environment. A packaged build
 *  without XAIBO_E2E=1 ignores every inherited XAIBO_* variable (data dir, stubs, traces, test roots) and NODE_OPTIONS /
 *  ELECTRON_RUN_AS_NODE, so a stale or leaked test variable in a shell or launchctl profile never steers it or its service.
 *  Hygiene, not a boundary: whoever controls the launch environment can set the marker too. app.isPackaged is the only
 *  packaged signal. NODE_OPTIONS and ELECTRON_RUN_AS_NODE are dropped for the service only: main has already started with them. ponytail: the Electron fuses (RunAsNode, NODE_OPTIONS) stay enabled; closing them is a P7-T12 item. */
export function trustedEnv(env: Record<string, string | undefined>, packaged: boolean): Record<string, string | undefined> {
  if (!packaged || env.XAIBO_E2E === '1') return env;
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('XAIBO_') && k !== 'NODE_OPTIONS' && k !== 'ELECTRON_RUN_AS_NODE'));
}
