// Agent detection and profiles (P1-T08; EC-38, EC-39, FR-01). Executables: manual path, then the login-shell PATH,
// then catalog known locations; the first regular executable whose shell-free version probe succeeds is Detected.
// Not detected is a normal state. Detection authorizes nothing beyond that probe. Profiles: the default root, login
// env overrides and manual roots that exist as directories, by realpath, with opaque stable ids (session identity
// includes the profile). Manual paths and roots live in kv.
import { randomUUID } from 'node:crypto';
import { constants, realpathSync, statSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { run, succeeded } from '../spawn.ts';
import type { LoginEnv } from './env.ts';
import type { AgentEntry, Catalog } from './validate.ts';

export type Detection =
  | { agent: string; state: 'detected'; path: string; version: string | null }
  | { agent: string; state: 'not-detected' };
export interface DetectOptions { env: LoginEnv; home: string; manualPath?: string | undefined; timeoutMs?: number }
export type Origin = 'default' | 'env' | 'manual';
export interface ProfileRoot { agent: string; root: string; origin: Origin }
export interface Profile extends ProfileRoot { id: string }

const PROBE_BYTES = 64 * 1024;
const VERSION = /\d+\.\d+\.\d+/;

/** realpath of a regular executable file, else null. */
export async function checkExecutable(p: string): Promise<string | null> {
  if (!path.isAbsolute(p)) return null;
  try {
    const real = await realpath(p);
    if (!(await stat(real)).isFile()) return null;
    await access(real, constants.X_OK);
    return real;
  } catch { return null; }
}

const expandHome = (dir: string, home: string) => (dir === '~' ? home : dir.startsWith('~/') ? path.join(home, dir.slice(2)) : dir);

export async function detectAgent(entry: AgentEntry, o: DetectOptions): Promise<Detection> {
  const dirs = [
    ...(o.env.PATH ?? '').split(':').filter((d) => path.isAbsolute(d)),
    ...(entry.detection.locations ?? []).map((d) => expandHome(d, o.home)),
  ];
  // The agent's own #! line may need the login PATH (e.g. `env node`), which the GUI PATH lacks.
  const env = { ...process.env, ...(o.env.PATH ? { PATH: o.env.PATH } : {}) };
  for (const b of entry.detection.binaries) {
    const tried = new Set<string>();
    for (const candidate of [...(o.manualPath ? [o.manualPath] : []), ...dirs.flatMap((d) => b.names.map((n) => path.join(d, n)))]) {
      const real = await checkExecutable(candidate);
      if (!real || tried.has(real)) continue;
      tried.add(real);
      const r = await run(real, b.versionArgs, { timeoutMs: o.timeoutMs ?? 3_000, maxBytes: PROBE_BYTES, env });
      if (succeeded(r)) return { agent: entry.id, state: 'detected', path: real, version: VERSION.exec(r.stdout.toString('utf8'))?.[0] ?? null };
    }
  }
  return { agent: entry.id, state: 'not-detected' };
}

const realDir = (p: string) => {
  if (!path.isAbsolute(p)) return null;
  try { return statSync(p).isDirectory() ? realpathSync(p) : null; } catch { return null; }
};

/** Existing profile roots per agent, in order default, env, manual; one entry per realpath. */
export function profileRoots(catalog: Catalog, env: LoginEnv, home: string, manual: Record<string, string[]>): ProfileRoot[] {
  const out: ProfileRoot[] = [];
  const add = (agent: string, p: string, origin: Origin) => {
    const root = realDir(p);
    if (root && !out.some((r) => r.agent === agent && r.root === root)) out.push({ agent, root, origin });
  };
  for (const a of catalog.agents) {
    for (const r of a.profileRoots) add(a.id, path.join(home, r.relative), 'default');
    for (const r of a.profileRoots) {
      const v = r.envOverride ? (env as Record<string, string | undefined>)[r.envOverride.name] : undefined;
      if (v) add(a.id, r.envOverride!.mode === 'replaces-root' ? v : path.join(v, r.relative), 'env');
    }
    for (const m of manual[a.id] ?? []) add(a.id, m, 'manual');
  }
  return out;
}

/** Upserts profiles by (agent, root); an existing row keeps its id. */
export function syncProfiles(db: DatabaseSync, roots: ProfileRoot[]): Profile[] {
  const upsert = db.prepare('INSERT INTO profiles (id, agent, root, origin) VALUES (?, ?, ?, ?) ON CONFLICT (agent, root) DO UPDATE SET origin = excluded.origin');
  const idOf = db.prepare('SELECT id FROM profiles WHERE agent = ? AND root = ?');
  return roots.map((r) => {
    upsert.run(randomUUID(), r.agent, r.root, r.origin);
    return { id: String((idOf.get(r.agent, r.root) as { id: string }).id), ...r };
  });
}

const kvGet = (db: DatabaseSync, key: string) => (db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
const kvSet = (db: DatabaseSync, key: string, value: string) =>
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);

export async function setManualPath(db: DatabaseSync, agent: string, p: string): Promise<boolean> {
  const real = await checkExecutable(p);
  if (real) kvSet(db, `agent.${agent}.path`, real);
  return real !== null;
}
export const manualPath = (db: DatabaseSync, agent: string) => kvGet(db, `agent.${agent}.path`);

export function manualRoots(db: DatabaseSync, agent: string): string[] {
  try { return JSON.parse(kvGet(db, `agent.${agent}.roots`) ?? '[]') as string[]; } catch { return []; }
}
export function addManualRoot(db: DatabaseSync, agent: string, root: string): boolean {
  const real = realDir(root);
  if (!real) return false;
  const roots = manualRoots(db, agent);
  if (!roots.includes(real)) kvSet(db, `agent.${agent}.roots`, JSON.stringify([...roots, real]));
  return true;
}
