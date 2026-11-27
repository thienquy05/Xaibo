// XAIBO-PROD-568 (P6-T11; PRD SEC1, design §6.6; review R1/R2): Reveal override file. The path is fixed here from the data
// dir, never taken from the renderer, and Finder is only asked to select (shell.showItemInFolder): nothing is opened, run or
// followed. A regular file is selected; a missing one, or a link, FIFO or directory at its path, selects the data folder
// instead; a data dir that is not a directory selects nothing. ponytail: lstat then select can race a swap; harmless while
// the call only selects.
import { lstatSync } from 'node:fs';
import path from 'node:path';
import type { RevealResult } from '../shared/ipc.ts';

const OVERRIDE_FILE = 'models.override.json';
const lstat = (p: string) => { try { return lstatSync(p, { throwIfNoEntry: false }); } catch { return undefined; } }; // ENOTDIR, EACCES

export function revealOverride(dataDir: string, show: (p: string) => void): RevealResult {
  const file = path.join(dataDir, OVERRIDE_FILE);
  const st = lstat(file);
  if (st?.isFile()) { show(file); return 'file'; }
  if (!lstat(dataDir)?.isDirectory()) return 'failed';
  show(dataDir);
  return st ? 'folder' : 'missing';
}

/** Only our window's main frame may ask (review R1). */
export const fromOurWindow = (e: { sender: unknown; senderFrame: unknown }, win: { webContents: { mainFrame: unknown } } | null): boolean =>
  !!win && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame;
