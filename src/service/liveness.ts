// Liveness (P1-T11, EC-01, FR-05): a recorded process is live only if its pid exists now and both the start time and
// the executable match; anything else is stale. A pid alone never says a session ended. macOS provider: one `ps` row
// via the sanctioned spawn module. Not wired in Phase 1: Claude 2.1.319 has no pid-bearing session file (S9,
// OQ-P1-11); first used in Phase 3/7.
import path from 'node:path';
import { run, succeeded } from './spawn.ts';

export interface ProcessInfo { pid: number; startTime: number; executable: string }
export interface LiveRecord { pid: number; startTime?: number; executable?: string }
export type Liveness = 'live' | 'stale';

const START_TOLERANCE_MS = 1_000; // ps lstart has 1 s resolution

export function liveness(rec: LiveRecord, table: ReadonlyMap<number, ProcessInfo>): Liveness {
  const p = table.get(rec.pid);
  if (!p || rec.startTime === undefined || rec.executable === undefined) return 'stale';
  // ponytail: executable compared by name; compare realpaths once a source records a full path.
  const sameExe = path.basename(p.executable) === path.basename(rec.executable);
  return sameExe && Math.abs(p.startTime - rec.startTime) < START_TOLERANCE_MS ? 'live' : 'stale';
}

// `ps -o pid=,lstart=,comm=` in the C locale: "  4242 Thu Jan  1 09:30:15 2026 /path/to/exe" (local time).
const ROW = /^\s*(\d+)\s+((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(\S.*?)\s*$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parsePs(out: string): ProcessInfo | undefined {
  const m = ROW.exec(out.split('\n')[0] ?? '');
  if (!m) return undefined;
  const [, mon, day, time, year] = m[2]!.split(/\s+/) as [string, string, string, string, string];
  const [h, min, s] = time.split(':').map(Number) as [number, number, number];
  return { pid: Number(m[1]), startTime: new Date(Number(year), MONTHS.indexOf(mon), Number(day), h, min, s).getTime(), executable: m[3]! };
}

/** The process with this pid, or undefined if there is none, the pid is invalid, or ps fails. */
export async function psLookup(pid: number, o: { timeoutMs?: number; run?: typeof run } = {}): Promise<ProcessInfo | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) return undefined;
  const r = await (o.run ?? run)('/bin/ps', ['-o', 'pid=,lstart=,comm=', '-p', String(pid)],
    { timeoutMs: o.timeoutMs ?? 2_000, maxBytes: 16 * 1024, env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } });
  if (!succeeded(r)) return undefined; // ps exits 1 for a pid that does not exist
  const p = parsePs(r.stdout.toString('utf8'));
  return p?.pid === pid ? p : undefined;
}
