// XAIBO-PROD-566 (P6-T07 part 2; EC-78, SEC5, FR-01; design .handoff/p6-t07-design.md part 2 slice, review P2-1..P2-9):
// the private catalog import store, <dataDir>/catalog/imports.json (dir 0700, file 0600, own uid, bounded O_NOFOLLOW read).
// One agent per import, validated with the shared catalogIssues against the bundled catalog plus every stored import, so
// shadow rules hold between imports too. Imported JSON never supplies roots: only approveRoot stores one, and every load
// re-derives it (declared, realpath === resolved, writable()). A corrupt or unsafe store is refused and never rewritten;
// loading is read-only and never throws. Importing authorizes nothing: imported entries never probe (part 3 adds grants).
// ponytail: synchronous and single-threaded (the service has one caller); add a queue if an async caller appears. Store
// tampering by the same user is out of scope (review R13). XAIBO-PROD-567 (part 3, review P3-1..P3-8): grantProbe stores an
// owner's grant to run one binary's version probe; every load keeps a grant only while its entry digest, declared binary
// and approved root still hold (each rescan reloads; a grants map is never reused, P3-3); grants die with their entry (P3-8).
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isObj } from '../../shared/ipc.ts';
import { writable } from '../config/bounds.ts';
import { readFile, within } from '../config/transaction.ts';
import { atomicWrite, fsyncDir, privateDir } from '../fs-private.ts';
import { probeable, type ProbeGrant } from './detect.ts';
import { catalogIssues, type AgentEntry, type Catalog, type CatalogCode } from './validate.ts';

export type ImportCode = CatalogCode | 'too-large' | 'invalid-json' | 'store-corrupt';
export interface ImportIssue { code: ImportCode; at: string }
/** Where an imported profile root may be: disposable roots only until P6-T12 (production passes allowed = []). */
export interface RootPolicy { home: string; allowed: string[]; denied: string[] | null }
/** setup (XAIBO-PROD-588): the imported agents whose setup grant still binds (current digest, setup root approved). */
export interface LoadedImports { catalog: Catalog; imported: Map<string, Record<string, string>>; grants: Map<string, ProbeGrant[]>; setup: Set<string>; issues: ImportIssue[] }
interface Entry { catalog: Catalog; roots: Record<string, string>; grants?: unknown; setup?: unknown }

const MAX_INPUT = 256 * 1024;
const MAX_STORE = 1 << 20;
const MAX_AGENTS = 16, MAX_KINDS = 64; // the schema's limits, for the merged catalog
const CORRUPT: ImportIssue[] = [{ code: 'store-corrupt', at: '/' }];
const ENTRY_KEYS = new Set(['catalog', 'roots', 'grants', 'setup']); // grants, setup optional: older stores have none
const uid = process.getuid?.();
const dirOf = (dataDir: string) => path.join(dataDir, 'catalog');

class Corrupt extends Error {}
const corrupt = (): never => { throw new Corrupt(); };

/** null = no store. Never creates anything; anything unsafe or malformed throws. */
function readStore(dataDir: string): Entry[] | null {
  const dir = dirOf(dataDir);
  let st;
  try { st = lstatSync(dir); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : corrupt(); }
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || st.mode & 0o077) corrupt();
  let f;
  try { f = readFile(path.join(dir, 'imports.json')); } catch { return corrupt(); }
  if (!f) return [];
  if (f.mode & 0o077 || f.bytes.length > MAX_STORE) corrupt();
  let doc: unknown;
  try { doc = JSON.parse(f.bytes.toString('utf8')); } catch { return corrupt(); }
  if (!isObj(doc) || Object.keys(doc).length !== 2 || doc['version'] !== 1 || !Array.isArray(doc['entries'])) return corrupt();
  for (const e of doc['entries'] as unknown[]) {
    if (!isObj(e) || Object.keys(e).some((k) => !ENTRY_KEYS.has(k)) || !Object.hasOwn(e, 'catalog') || !isObj(e['roots'])) corrupt();
    if (Object.values((e as Record<string, object>)['roots']!).some((v) => typeof v !== 'string')) corrupt();
  }
  return doc['entries'] as Entry[];
}

function writeStore(dataDir: string, entries: Entry[]): void {
  const dir = dirOf(dataDir);
  privateDir(dir);
  atomicWrite(path.join(dir, 'imports.json'), JSON.stringify({ version: 1, entries }), 0o600);
  fsyncDir(dir);
}

const merge = (a: Catalog, b: Catalog): Catalog => ({ ...a, agents: [...a.agents, ...b.agents], sessionKinds: [...a.sessionKinds, ...b.sessionKinds] });

/** One agent with its own session kinds, valid and shadowing nothing in `reserved`. */
function single(value: unknown, reserved: Catalog): ImportIssue[] {
  const issues: ImportIssue[] = catalogIssues(value, reserved);
  if (issues.length) return issues;
  const c = value as Catalog;
  if (c.agents.length !== 1) return [{ code: 'schema-invalid', at: '/agents' }];
  if (reserved.agents.length >= MAX_AGENTS || reserved.sessionKinds.length + c.sessionKinds.length > MAX_KINDS) return [{ code: 'too-large', at: '/' }];
  return [];
}

/** Stored entries in file order, each checked against bundled plus the entries kept before it (a later shadow is dropped). */
function accept(entries: Entry[], bundled: Catalog): { ok: Entry[]; merged: Catalog; issues: ImportIssue[] } {
  let merged = bundled;
  const ok: Entry[] = [], issues: ImportIssue[] = [];
  entries.forEach((e, i) => {
    const found = single(e.catalog, merged);
    if (found.length) { issues.push(...found.map((x) => ({ code: x.code, at: `/entries/${i}/catalog${x.at === '/' ? '' : x.at}` }))); return; }
    ok.push(e);
    merged = merge(merged, e.catalog);
  });
  return { ok, merged, issues };
}

/** The declared root as an existing real directory (no link anywhere: realpath === resolved) inside the policy, else null. */
function rootDir(declared: AgentEntry['profileRoots'][number], o: RootPolicy): string | null {
  if (!o.denied?.length) return null; // no denylist (login env unreadable) refuses, as Connect does
  const p = path.resolve(o.home, declared.relative);
  try { if (!statSync(p).isDirectory() || realpathSync.native(p) !== p) return null; } catch { return null; }
  return writable(p, o.allowed, o.denied) ? p : null;
}

const approved = (e: Entry, o: RootPolicy): Record<string, string> => Object.fromEntries(e.catalog.agents[0]!.profileRoots.flatMap((r) =>
  (Object.hasOwn(e.roots, r.id) && rootDir(r, o) === e.roots[r.id] ? [[r.id, e.roots[r.id]!]] : [])));

const digestOf = (c: Catalog) => createHash('sha256').update(JSON.stringify(c)).digest('hex');
/** Strictly below `dir` (review P3-4), and every directory from the file up to `dir` is this user's and closed to group/world
 *  writes (code review 1: the root itself passed writable(), the folders inside it did not). */
const inside = (p: string, dir: string) => {
  if (p === dir || !within(p, dir)) return false;
  for (let d = path.dirname(p); ; d = path.dirname(d)) {
    const st = lstatSync(d, { throwIfNoEntry: false });
    if (!st?.isDirectory() || (uid !== undefined && st.uid !== uid) || st.mode & 0o022) return false;
    if (d === dir) return true;
  }
};
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isGrant = (g: unknown): g is ProbeGrant => isObj(g) && typeof g['binary'] === 'string' && typeof g['path'] === 'string'
  && path.isAbsolute(g['path']) && typeof g['digest'] === 'string' && isObj(g['id'])
  && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((k) => num((g['id'] as Record<string, unknown>)[k]));

/** The entry's grants that still bind: well formed, its current digest, a declared binary, inside an approved root. A malformed
 *  grants value, or more grants than declared binaries, drops them all, silently (review P3-2; same-user robustness, R13). */
function validGrants(e: Entry, roots: Record<string, string>): ProbeGrant[] {
  const bins = e.catalog.agents[0]!.detection.binaries;
  if (!Array.isArray(e.grants) || e.grants.length > bins.length) return [];
  const digest = digestOf(e.catalog), dirs = Object.values(roots);
  return e.grants.filter((g): g is ProbeGrant => isGrant(g) && g.digest === digest && bins.some((b) => b.id === g.binary)
    && dirs.some((d) => inside(g.path, d)));
}

/** XAIBO-PROD-588 (P6-T09a, D-P6-18, SEC5): the setup grant {digest, root} binds only to the entry it was given for (its
 *  digest) and to the root path it was given for (code review 1), while that root is still the approved one; anything else, a
 *  malformed value included, grants nothing, silently (as validGrants). ponytail: the root is matched by its realpath, not by
 *  device and inode (as approved roots, P6-T07); add an identity if a same-path swap ever matters. */
const setupBinds = (e: Entry, roots: Record<string, string>) => {
  const rs = e.catalog.agents[0]!.reportSetup, g = e.setup;
  return !!rs && isObj(g) && g['digest'] === digestOf(e.catalog) && Object.hasOwn(roots, rs.root) && g['root'] === roots[rs.root];
};

export function importCatalog(dataDir: string, bytes: Uint8Array, bundled: Catalog): { status: 'imported'; agent: string } | { status: 'rejected'; issues: ImportIssue[] } {
  const rejected = (issues: ImportIssue[]) => ({ status: 'rejected' as const, issues });
  if (bytes.byteLength > MAX_INPUT) return rejected([{ code: 'too-large', at: '/' }]); // before decoding
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return rejected([{ code: 'invalid-json', at: '/' }]); }
  let entries: Entry[];
  try { entries = readStore(dataDir) ?? []; } catch { return rejected(CORRUPT); }
  const issues = single(value, accept(entries, bundled).merged);
  if (issues.length) return rejected(issues);
  try { writeStore(dataDir, [...entries, { catalog: value as Catalog, roots: {} }]); } catch { return rejected(CORRUPT); }
  return { status: 'imported', agent: (value as Catalog).agents[0]!.id };
}

/** The bundled catalog plus every valid import, and each import's approved roots. Read-only; never throws. */
export function loadImports(dataDir: string, bundled: Catalog, o: RootPolicy): LoadedImports {
  try {
    const entries = readStore(dataDir);
    if (!entries) return { catalog: bundled, imported: new Map(), grants: new Map(), setup: new Set(), issues: [] };
    const { ok, merged, issues } = accept(entries, bundled);
    const roots = ok.map((e) => [e.catalog.agents[0]!.id, approved(e, o)] as const);
    return {
      catalog: merged, imported: new Map(roots), grants: new Map(roots.map(([id, r], i) => [id, validGrants(ok[i]!, r)])),
      setup: new Set(roots.filter(([, r], i) => setupBinds(ok[i]!, r)).map(([id]) => id)), issues,
    };
  } catch {
    return { catalog: bundled, imported: new Map(), grants: new Map(), setup: new Set(), issues: CORRUPT };
  }
}

/** Stores a declared root of an imported agent once it is a real directory inside the policy (trusted service callers only). */
export function approveRoot(dataDir: string, bundled: Catalog, agentId: string, rootId: string, o: RootPolicy): boolean {
  try {
    const entries = readStore(dataDir);
    if (!entries) return false;
    const e = accept(entries, bundled).ok.find((x) => x.catalog.agents[0]!.id === agentId);
    const declared = e?.catalog.agents[0]!.profileRoots.find((r) => r.id === rootId);
    const dir = declared ? rootDir(declared, o) : null;
    if (!e || !dir) return false;
    e.roots = { ...e.roots, [rootId]: dir };
    writeStore(dataDir, entries);
    return true;
  } catch {
    return false;
  }
}

/** Grants the owner's choice of executable for one declared binary of an imported agent (trusted service callers only, as
 *  approveRoot; review R6: no renderer object, no confirmed flag). `file` must be exactly a private regular executable
 *  (probeable), named as the binary declares, strictly inside a root approved under this policy. Replaces that binary's
 *  earlier grant; runs nothing (detection probes at the next load). */
export function grantProbe(dataDir: string, bundled: Catalog, agentId: string, binaryId: string, file: string, o: RootPolicy): boolean {
  try {
    const entries = readStore(dataDir);
    if (!entries) return false;
    const e = accept(entries, bundled).ok.find((x) => x.catalog.agents[0]!.id === agentId);
    const b = e?.catalog.agents[0]!.detection.binaries.find((x) => x.id === binaryId);
    if (!e || !b || !path.isAbsolute(file) || !b.names.includes(path.basename(file))) return false;
    if (!Object.values(approved(e, o)).some((d) => inside(file, d))) return false;
    const id = probeable(file);
    if (!id) return false;
    const others = Array.isArray(e.grants) ? e.grants.filter((g) => isGrant(g) && g.binary !== binaryId) : [];
    e.grants = [...others, { binary: binaryId, path: file, id, digest: digestOf(e.catalog) }];
    writeStore(dataDir, entries);
    return true;
  } catch {
    return false;
  }
}

/** XAIBO-PROD-588 (P6-T09a, D-P6-18, SEC5): the owner's authorization for an imported agent's declared reportSetup writes
 *  (trusted service callers only, as approveRoot; no renderer object, no confirmed flag). Needs an accepted entry with a
 *  reportSetup whose root is approved under this policy; stores the entry digest and that root, so any later change to the
 *  entry, or another root approved later, voids it.
 *  Separate from root approval and probe grants: it implies neither, and neither implies it. Writes no agent config and runs
 *  nothing (the Connect preview and apply do the writing, P6-T09a slice B). */
export function grantSetup(dataDir: string, bundled: Catalog, agentId: string, o: RootPolicy): boolean {
  try {
    const entries = readStore(dataDir);
    if (!entries) return false;
    const e = accept(entries, bundled).ok.find((x) => x.catalog.agents[0]!.id === agentId);
    const rs = e?.catalog.agents[0]!.reportSetup;
    const roots = e ? approved(e, o) : {};
    if (!e || !rs || !Object.hasOwn(roots, rs.root)) return false;
    e.setup = { digest: digestOf(e.catalog), root: roots[rs.root] };
    writeStore(dataDir, entries);
    return true;
  } catch {
    return false;
  }
}
