// E2E audit checks (P1-T05; EC-60, EC-61, M6), used by fixtures.ts after every test: NetLog non-loopback hosts,
// unexpected process deaths (the S10 profile SIGKILLs a process on its first non-loopback or DNS attempt), repo
// status and agent-store checksums.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface NetLogResult { parsed: boolean; events: number; nonLocal: number; types: string[] }
export interface Gone { type: string; reason: string; name: string }

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)(:\d+)?$/;
const HOSTS = /(?:https?|wss?):\/\/([^/"\\]+)|"(?:host|hostname|dns_query_name)":"([^"]+)"|"address":"([^"]+)"/g;
const UNPARSED: NetLogResult = { parsed: false, events: 0, nonLocal: 0, types: [] };

/** Counts NetLog events naming a non-loopback host or address. A log cut off by a killed process is closed first. */
export function parseNetLog(text: string): NetLogResult {
  let j: { constants: { logEventTypes: Record<string, number> }; events: { type: number; params?: unknown }[] };
  try { j = JSON.parse(text); } catch {
    try { j = JSON.parse(`${text.replace(/,\s*$/, '')}]}`); } catch { return UNPARSED; }
  }
  if (!j?.constants?.logEventTypes || !Array.isArray(j.events)) return UNPARSED;
  const names = new Map(Object.entries(j.constants.logEventTypes).map(([k, v]) => [v, k]));
  const types = new Set<string>();
  let nonLocal = 0;
  for (const e of j.events) {
    const hosts = [...JSON.stringify(e.params ?? {}).matchAll(HOSTS)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
    if (hosts.some((h) => !LOCAL.test(h))) { nonLocal++; types.add(names.get(e.type) ?? String(e.type)); }
  }
  return { parsed: true, events: j.events.length, nonLocal, types: [...types].sort() };
}

/** Every child death except a clean exit is unexpected, minus the service kills a test caused itself. */
export function unexpectedDeaths(gone: Gone[], allowed: { serviceKills?: number } = {}): number {
  const bad = gone.filter((g) => g.reason !== 'clean-exit');
  const svc = bad.filter((g) => g.type === 'Utility' && g.name === 'xaibo-service').length;
  return bad.length - Math.min(svc, allowed.serviceKills ?? 0);
}

export const gitStatus = (cwd: string) => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });

/** sha256 of every file under root, keyed by relative path. */
export function treeHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const f = path.join(e.parentPath, e.name);
    out[path.relative(root, f)] = createHash('sha256').update(readFileSync(f)).digest('hex');
  }
  return out;
}
