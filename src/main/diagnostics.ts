// Diagnostics bundle (P1-T13; EC-33, EC-35, M9): versions, health, counters and the tail of the content-free logs,
// with every string (keys included) through sanitize(), written 0600 to the file the user picks. No Electron import.
import { chmodSync, closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Health } from '../shared/ipc.ts';
import { sanitize } from '../shared/sanitize.ts';

export interface BundleInput {
  app: Record<string, string>;
  os: Record<string, string>;
  health: Health;
  counters: Record<string, number>;
  logTail: string[];
}

function sanitizeDeep(v: unknown): unknown {
  if (typeof v === 'string') return sanitize(v);
  if (Array.isArray(v)) return v.map(sanitizeDeep);
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [sanitize(k), sanitizeDeep(x)]));
  return v;
}

export const buildBundle = (input: BundleInput): string =>
  JSON.stringify({ format: 'xaibo-diagnostics-1', ...(sanitizeDeep(input) as object) }, null, 2);

export function writeBundle(file: string, json: string): void {
  writeFileSync(file, json, { mode: 0o600 });
  chmodSync(file, 0o600); // an existing file keeps its old mode otherwise
}

function tail(file: string, lines: number, bytes: number): string[] {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return []; }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const parts = buf.toString('utf8').split('\n');
    return (start > 0 ? parts.slice(1) : parts).filter(Boolean).slice(-lines); // drop a line cut by the byte bound
  } finally { closeSync(fd); }
}

/** The last lines of the current app log, then of the service log; each file read is bounded by `bytes`. */
export const readLogTail = (dir: string, o: { lines: number; bytes: number }): string[] =>
  [path.join(dir, 'xaibo.log'), path.join(dir, 'service', 'xaibo.log')].flatMap((f) => tail(f, o.lines, o.bytes));
