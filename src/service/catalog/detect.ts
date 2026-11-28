// Agent detection and profiles (P1-T08; EC-38, EC-39, FR-01). Executables: manual path, then the login-shell PATH,
// then catalog known locations; the first regular executable whose shell-free version probe succeeds is Detected.
// Not detected is a normal state. Detection authorizes nothing beyond that probe. Profiles: the default root, login
// env overrides and manual roots that exist as directories, by realpath, with opaque stable ids (session identity
// includes the profile). Manual paths and roots live in kv.
import { randomUUID } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../../shared/log.ts';
import { run, succeeded } from '../spawn.ts';
import type { LoginEnv } from './env.ts';
import type { AgentEntry, Catalog } from './validate.ts';

export type Detection =
  /** id: the probed realpath's stat identity (P6-T03 part 2b, review H1), so Connect can refuse a binary replaced since. */
  /** manual: found through the stored manual path ("Set path…", renderer-chosen); part 2c review H1: never run as the plugin CLI.
   *  The manual path is tried first, so a manual path naming the PATH's own binary is still manual (fails safe: fallback). */
  /** found (XAIBO-PROD-621): the path the executable was found at, when it differs from its realpath (a launch keeps the name
   *  the catalog lists; a native install's realpath is a version file). */
  | { agent: string; state: 'detected'; path: string; found?: string; version: string | null; id: FileId; manual: boolean }
  | { agent: string; state: 'not-detected'; reason?: 'probe-not-granted' | 'probe-grant-stale' };
export interface FileId { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
export const fileId = (st: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): FileId =>
  ({ dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
/** XAIBO-PROD-567 (P6-T07 part 3): an owner's grant to run one imported binary's version probe: that exact executable (a
 *  realpath inside an approved root), its file identity and the entry digest (sha256 of the stored catalog entry). */
export interface ProbeGrant { binary: string; path: string; id: FileId; digest: string }
/** XAIBO-PROD-565 (P6-T07 part 1; FR-01, SEC5): where the entry came from. Bundled entries may run the bounded probe; an
 *  imported entry runs only its granted executables (part 3). Required, so a missing provenance never defaults to bundled. */
export type ProbeAccess = { origin: 'bundled' } | { origin: 'imported'; grants: readonly ProbeGrant[] };
export interface DetectOptions {
  env: LoginEnv; home: string; manualPath?: string | undefined; timeoutMs?: number; log?: Logger;
  access: ProbeAccess;
  /** Test seam for the probe runner. ponytail (code review 5): on the production options too; the gate returns before it is
   *  read, so it never widens who may probe; move it to a test-only factory if a caller ever sets it. */
  run?: typeof run;
}
export type Origin = 'default' | 'env' | 'manual';
export interface ProfileRoot { agent: string; root: string; origin: Origin }
export interface Profile extends ProfileRoot { id: string }

const PROBE_BYTES = 64 * 1024;
const PROBE_MS = 3_000;
const IMPORTED_PATH = '/usr/bin:/bin'; // review R5: built in code, never process.env
const VERSION = /\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?/; // a prerelease suffix is kept, never read as the release (part 2b H1)

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

const sameId = (a: FileId, b: FileId) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** XAIBO-PROD-567 (review P3-1): `p` is exactly a private regular executable of this user (no link anywhere: realpath === p;
 *  no group/world write, no setuid/setgid) and, given `id`, still that file. Its FileId, else null. Metadata only, never
 *  opened, so a FIFO cannot block. ponytail: a same-user swap between this check and the spawn is the documented TOCTOU
 *  limit (no executable hash, review R4). */
export function probeable(p: string, id?: FileId): FileId | null {
  try {
    if (!path.isAbsolute(p) || realpathSync.native(p) !== p) return null;
    const st = statSync(p);
    if (!st.isFile() || (st.mode & 0o6022) !== 0 || (process.getuid && st.uid !== process.getuid())) return null;
    accessSync(p, constants.X_OK);
    const now = fileId(st);
    return id && !sameId(id, now) ? null : now;
  } catch { return null; }
}

/** Imported entries (P6-T07 part 3): only granted executables, rechecked right before the spawn; any change skips that grant
 *  (no fall-through to another candidate). No PATH search, manual path or process.env; cwd / (review P3-5). The granted
 *  program still runs with the owner's access (HOME is the real home): the grant is not a sandbox and not M6 evidence (P3-6).
 *  manual: true, a user-supplied executable is never run as the plugin CLI (part 2c H1; review P3-7). */
async function detectGranted(entry: AgentEntry, grants: readonly ProbeGrant[], o: DetectOptions): Promise<Detection> {
  const probe = o.run ?? run;
  let granted = false, ran = false;
  for (const b of entry.detection.binaries) {
    const g = grants.find((x) => x.binary === b.id);
    if (!g) continue;
    granted = true;
    const id = probeable(g.path, g.id);
    if (!id) continue;
    ran = true;
    const r = await probe(g.path, b.versionArgs, { timeoutMs: PROBE_MS, maxBytes: PROBE_BYTES, env: { HOME: o.home, PATH: IMPORTED_PATH }, cwd: '/', ...(o.log ? { log: o.log } : {}) });
    if (succeeded(r)) return { agent: entry.id, state: 'detected', path: g.path, version: VERSION.exec(r.stdout.toString('utf8'))?.[0] ?? null, id, manual: true };
  }
  // ponytail (code review 3): a probe that ran and failed carries no reason; add one when P6-T08 needs to tell it apart.
  if (ran) return { agent: entry.id, state: 'not-detected' };
  return { agent: entry.id, state: 'not-detected', reason: granted ? 'probe-grant-stale' : 'probe-not-granted' };
}

export async function detectAgent(entry: AgentEntry, o: DetectOptions): Promise<Detection> {
  if (o.access?.origin === 'imported' && Array.isArray(o.access.grants)) return detectGranted(entry, o.access.grants, o);
  // fail closed: anything but an explicit bundled provenance runs nothing (no PATH search, no stat, no spawn)
  if (o.access?.origin !== 'bundled') return { agent: entry.id, state: 'not-detected', reason: 'probe-not-granted' };
  const probe = o.run ?? run;
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
      const r = await probe(real, b.versionArgs, { timeoutMs: o.timeoutMs ?? PROBE_MS, maxBytes: PROBE_BYTES, env, ...(o.log ? { log: o.log } : {}) });
      if (!succeeded(r)) continue;
      let id: FileId;
      try { id = fileId(await stat(real)); } catch { continue; }
      return { agent: entry.id, state: 'detected', path: real, ...(candidate !== real ? { found: candidate } : {}), version: VERSION.exec(r.stdout.toString('utf8'))?.[0] ?? null, id, manual: candidate === o.manualPath };
    }
  }
  return { agent: entry.id, state: 'not-detected' };
}

const realDir = (p: string) => {
  if (!path.isAbsolute(p)) return null;
  try { return statSync(p).isDirectory() ? realpathSync(p) : null; } catch { return null; }
};

/** Existing profile roots per agent, in order default, env, manual; one entry per realpath. XAIBO-PROD-566 (P6-T07 part 2,
 *  review P2-1/P2-3): an imported agent (a key of `imported`) gets only its approved roots, still real directories, never
 *  default, env override or manual ones. ponytail: env overrides of imported entries need their own grant. */
export function profileRoots(catalog: Catalog, env: LoginEnv, home: string, manual: Record<string, string[]>,
  imported: ReadonlyMap<string, Record<string, string>> = new Map()): ProfileRoot[] {
  const out: ProfileRoot[] = [];
  const add = (agent: string, p: string, origin: Origin) => {
    const root = realDir(p);
    if (root && !out.some((r) => r.agent === agent && r.root === root)) out.push({ agent, root, origin });
  };
  for (const a of catalog.agents) {
    const approved = imported.get(a.id);
    if (approved) {
      for (const p of Object.values(approved)) if (realDir(p) === p) add(a.id, p, 'default');
      continue;
    }
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
