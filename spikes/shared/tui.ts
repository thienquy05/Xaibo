// Drives an interactive agent TUI in a detached `screen` session: a real terminal emulator, which the TUIs need
// (expect alone could not drive them). Raw output goes to a local log (git-ignored dir) and is read back with the
// escape sequences stripped, so callers can wait for marker text. Keys are sent with `screen -p 0 -X stuff` (without
// `-p 0` a detached session has no current window and the keys go nowhere).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface Tui { text(): string; send(s: string): void; waitFor(re: RegExp, ms?: number): Promise<boolean>; quit(): void }
export const ENTER = '\r';
export const ESC = '\x1b';
export const CTRL_C = '\x03';

export function stripAnsi(raw: string): string {
  return raw.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ' ').replace(/\x1b\[[0-9;?>=]*[ -/]*[@-~]/g, ' ').replace(/\x1b[=>]/g, ' ').replace(/\s+/g, ' ');
}

export function tui(name: string, cwd: string, logDir: string, argv: string[]): Tui {
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `${name}.screenlog`);
  const rc = join(logDir, `${name}.screenrc`);
  rmSync(log, { force: true });
  writeFileSync(rc, `logfile ${log}\nlogfile flush 1\ndeflog on\n`);
  execFileSync('/usr/bin/screen', ['-c', rc, '-dmS', name, ...argv], { cwd });
  const text = () => (existsSync(log) ? stripAnsi(readFileSync(log, 'latin1')) : '');
  return {
    text,
    send: (s) => { spawnSync('/usr/bin/screen', ['-S', name, '-p', '0', '-X', 'stuff', s]); },
    async waitFor(re, ms = 60_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (re.test(text())) return true; await sleep(500); }
      return false;
    },
    quit: () => { spawnSync('/usr/bin/screen', ['-S', name, '-X', 'quit']); },
  };
}
