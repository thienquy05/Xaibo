// FR-32 safe config transactions (P3-T01, EC-48; FR-34 engine; PRD §7.6). A change is a list of Xaibo-owned ops on one
// JSON agent config: `set` a pointer, or `append` to an array. plan() reads (no symlinks, regular file, own uid),
// parses (JSON only; BOM refused; object root), refuses `prompt`/`agent` hook types and non-async Claude command
// hooks other than Stop (S3/S4), and returns the new text, a diff that never shows replaced foreign values, and the
// pre-hash. apply() re-confines the target, rechecks file identity and hash, writes a private backup, records a pending
// manifest entry, writes a same-dir temp file (O_EXCL, original mode), fsyncs, renames, self-checks and restores the
// backup on failure. revert(): unchanged post-hash → backup bytes (verified against the pre-hash) or removal of a file
// Xaibo created; otherwise only still-unchanged owned values are removed (foreign values they replaced come back),
// changed ones are conflicts and stay. Confinement to `bounds.root` and the real-root denylist are enforced here, so
// every caller gets them. Errors carry fixed codes, never file content.
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync,
  renameSync, unlinkSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export type Route = 'claude-plugin' | 'claude-settings-fallback' | 'claude-tee' | 'codex-hooks' | 'agy-hooks';
export type Op = { op: 'set' | 'append'; pointer: string; value: unknown };
/** Realpaths: every target must resolve inside `root` and outside every `denied` root. */
export interface Bounds { root: string; denied: string[] }
export type Code =
  | 'invalid-json' | 'bom' | 'not-object' | 'symlink' | 'not-regular' | 'too-large' | 'unreadable' | 'not-owner'
  | 'parent-missing' | 'outside-root' | 'denied-root' | 'pointer' | 'ops' | 'forbidden-hook-type' | 'async-required'
  | 'changed' | 'self-check' | 'private-dir' | 'manifest' | 'backup'
  // P3-T05 (claude-plugin route, EC-09): one install per profile; plugin and settings fallback exclude each other.
  | 'duplicate' | 'exclusive' | 'not-installed' | 'cli' | 'shim-missing' | 'route';
export class ConfigError extends Error {
  readonly code: Code;
  constructor(code: Code) {
    super(`config transaction refused: ${code}`);
    this.code = code;
  }
}

interface Owned { pointer: string; value: unknown; old?: unknown }
export interface DiffLine { pointer: string; new: unknown; replaced?: { type: string; sha256: string } }
export interface Plan {
  target: string; route: Route; existed: boolean; preHash: string | null; dev: number | null; ino: number | null;
  mode: number; base: object; after: string; diff: DiffLine[]; owned: Owned[]; created: string[];
}
export interface ManifestEntry {
  id: string; target: string; route: Route; state: 'pending' | 'applied'; existed: boolean; preHash: string | null;
  postHash: string; owned: Owned[]; created: string[]; backup: string | null; at: string;
  /** Set by a structural revert that left conflicts: the backup no longer matches what may be restored. */
  partial?: true;
}
export interface RevertResult { result: 'restored' | 'removed' | 'structural' | 'unchanged'; conflicts: Array<{ pointer: string }> }

const MAX_BYTES = 4 << 20;
const NEW_FILE_MODE = 0o600;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN_HOOK_TYPES = new Set(['prompt', 'agent']);
const SYNC_CLAUDE_EVENTS = new Set(['Stop']); // S3 decision: Stop synchronous, every other event async
const BACKUP_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bak$/;
const INDEX = /^(0|[1-9]\d*)$/;

const fail = (code: Code): never => { throw new ConfigError(code); };
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const uid = () => process.getuid?.();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function within(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// --- files ---------------------------------------------------------------------------------------------------

/**
 * The target's realpath (real parent + basename), confined to bounds. The denylist is checked first; a missing parent
 * is refused (agent config dirs are never created here). The file itself may still be a symlink: reads refuse it.
 */
export function resolveTarget(target: string, bounds: Bounds): string {
  if (!path.isAbsolute(target)) fail('outside-root');
  const dir = path.dirname(target);
  let anc = dir;
  while (!exists(anc)) anc = path.dirname(anc);
  const resolved = path.join(realpathSync.native(anc), path.relative(anc, dir), path.basename(target));
  if (bounds.denied.some((d) => within(resolved, d))) fail('denied-root');
  if (!within(resolved, bounds.root)) fail('outside-root');
  if (anc !== dir) fail('parent-missing');
  return resolved;
}

function exists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

interface FileState { bytes: Buffer; dev: number; ino: number; mode: number }

/** null = absent. Never follows a symlink, never blocks on a FIFO, bounded, own uid only. */
function readFile(file: string): FileState | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    return fail(code === 'ELOOP' ? 'symlink' : 'unreadable');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) fail('not-regular');
    if (uid() !== undefined && st.uid !== uid()) fail('not-owner');
    if (st.size > MAX_BYTES) fail('too-large');
    const buf = Buffer.alloc(MAX_BYTES + 1); // bounded even if the file grows after fstat
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r) r = readSync(fd, buf, n, buf.length - n, null);
    if (n > MAX_BYTES) fail('too-large');
    return { bytes: buf.subarray(0, n), dev: st.dev, ino: st.ino, mode: st.mode & 0o7777 };
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, data: Buffer | string) {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  for (let n = 0; n < buf.length;) n += writeSync(fd, buf, n, buf.length - n);
}

function fsyncDir(dir: string) {
  const fd = openSync(dir, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** New file only: O_EXCL + O_NOFOLLOW, fsynced. */
function writeExclusive(file: string, data: Buffer | string, mode: number) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, NEW_FILE_MODE);
  try { writeAll(fd, data); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Same-dir temp file with an unpredictable name, then rename. `beforeRename` runs last, so a throw leaves the file.
 * A throw from here means the target was not replaced; callers fsync the directory afterwards. */
function atomicWrite(file: string, data: Buffer | string, mode: number, beforeRename?: () => void) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    writeExclusive(tmp, data, mode);
    beforeRename?.();
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}

function removeFile(file: string) {
  unlinkSync(file);
  fsyncDir(path.dirname(file));
}

/** <dataDir>/integrations and its backups/: 0700, own uid, never a symlink. */
export function privateDirs(dataDir: string) {
  const integrations = path.join(dataDir, 'integrations');
  const backups = path.join(integrations, 'backups');
  for (const d of [integrations, backups]) {
    try { mkdirSync(d, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const st = lstatSync(d);
    if (!st.isDirectory() || (uid() !== undefined && st.uid !== uid())) fail('private-dir');
    if (st.mode & 0o077) chmodSync(d, 0o700);
  }
  return { manifest: path.join(integrations, 'manifest.json'), backups };
}

// --- JSON documents ------------------------------------------------------------------------------------------

interface Style { indent: string; eol: string; trailing: boolean }
const DEFAULT_STYLE: Style = { indent: '  ', eol: '\n', trailing: true };

function decode(bytes: Buffer): { doc: Record<string, unknown>; style: Style } {
  const text = bytes.toString('utf8');
  if (text.startsWith('﻿')) fail('bom');
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return fail('invalid-json'); } // V8's message can quote content
  if (!isObject(doc)) fail('not-object');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // ponytail: re-serialization keeps indent/EOL/trailing newline (Q3-3), not inline layout; numbers beyond float64
  // precision would be rounded. Text-splice edits if Gate 6 round-trip tests need them.
  return { doc: doc as Record<string, unknown>, style: { indent: /^([ \t]+)\S/m.exec(text)?.[1] ?? '', eol, trailing: /\n$/.test(text) } };
}

function encode(doc: unknown, s: Style): string {
  const text = JSON.stringify(doc, null, s.indent);
  return (s.eol === '\n' ? text : text.replaceAll('\n', s.eol)) + (s.trailing ? s.eol : '');
}

function segments(pointer: string): string[] {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) fail('pointer');
  const segs = pointer.slice(1).split('/').map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (segs.some((s) => s === '' || s === '-' || FORBIDDEN_SEGMENTS.has(s))) fail('pointer');
  return segs;
}
const join = (segs: string[]) => segs.map((s) => `/${s.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');

function child(node: unknown, key: string): unknown {
  if (Array.isArray(node)) return INDEX.test(key) ? node[Number(key)] : undefined;
  return isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined;
}
const get = (doc: unknown, segs: string[]) => segs.reduce<unknown>((n, k) => child(n, k), doc);

/** The parent container of `segs`, creating missing objects (recorded in `created`). */
function parentFor(doc: Record<string, unknown>, segs: string[], created: string[]): Record<string, unknown> {
  let node: Record<string, unknown> = doc;
  segs.slice(0, -1).forEach((k, i) => {
    if (!Object.hasOwn(node, k)) {
      node[k] = {};
      created.push(join(segs.slice(0, i + 1)));
    }
    const next = node[k];
    if (!isObject(next)) fail('pointer');
    node = next as Record<string, unknown>;
  });
  return node;
}

function remove(doc: unknown, segs: string[]) {
  const parent = get(doc, segs.slice(0, -1));
  const key = segs.at(-1)!;
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else if (isObject(parent)) delete parent[key];
}

/** Undo owned values on a copy: unchanged ones are removed (or their replaced foreign value restored), changed ones
 * are conflicts; then Xaibo-created containers are dropped if empty. */
function strip(doc: Record<string, unknown>, owned: Owned[], created: string[]) {
  const out = structuredClone(doc);
  const conflicts: Array<{ pointer: string }> = [];
  for (const o of [...owned].reverse()) {
    const segs = segments(o.pointer);
    if (!isDeepStrictEqual(get(out, segs), o.value)) { conflicts.push({ pointer: o.pointer }); continue; }
    if ('old' in o) (get(out, segs.slice(0, -1)) as Record<string, unknown>)[segs.at(-1)!] = o.old;
    else remove(out, segs);
  }
  for (const c of [...created].reverse()) {
    const v = get(out, segments(c));
    if ((Array.isArray(v) && !v.length) || (isObject(v) && !Object.keys(v).length)) remove(out, segments(c));
  }
  return { doc: out, conflicts };
}

// --- policy ----------------------------------------------------------------------------------------------------

function walk(v: unknown, visit: (o: Record<string, unknown>) => void) {
  if (Array.isArray(v)) v.forEach((x) => walk(x, visit));
  else if (isObject(v)) { visit(v); Object.values(v).forEach((x) => walk(x, visit)); }
}

function checkHooks(route: Route, segs: string[], value: unknown) {
  walk(value, (o) => { if (FORBIDDEN_HOOK_TYPES.has(o['type'] as string)) fail('forbidden-hook-type'); });
  if (!route.startsWith('claude-') || segs[0] !== 'hooks') return; // both Claude routes write the same settings.json
  const byEvent: Array<[string, unknown]> = segs.length >= 2 ? [[segs[1]!, value]] : Object.entries(isObject(value) ? value : {});
  for (const [event, v] of byEvent) {
    if (SYNC_CLAUDE_EVENTS.has(event)) continue;
    walk(v, (o) => { if (o['type'] === 'command' && o['async'] !== true) fail('async-required'); });
  }
}

/** Strict op list (untrusted input from the dev CLI). */
export function validateOps(x: unknown): Op[] {
  if (!Array.isArray(x) || !x.length) return fail('ops');
  return x.map((o: unknown) => {
    if (!isObject(o) || (o['op'] !== 'set' && o['op'] !== 'append') || typeof o['pointer'] !== 'string' || !('value' in o)
      || Object.keys(o).length !== 3) fail('ops');
    return o as Op;
  });
}

// --- transactions ------------------------------------------------------------------------------------------------

export function plan(target: string, route: Route, ops: Op[], bounds: Bounds): Plan {
  validateOps(ops);
  const file = resolveTarget(target, bounds);
  const cur = readFile(file);
  const { doc: base, style } = cur ? decode(cur.bytes) : { doc: {}, style: DEFAULT_STYLE };
  const doc = structuredClone(base);
  const owned: Owned[] = [];
  const created: string[] = [];
  const diff: DiffLine[] = [];
  for (const { op, pointer, value } of ops) {
    const segs = segments(pointer);
    checkHooks(route, segs, value);
    const parent = parentFor(doc, segs, created);
    const key = segs.at(-1)!;
    if (op === 'set') {
      const had = Object.hasOwn(parent, key);
      const old = parent[key];
      parent[key] = structuredClone(value);
      owned.push({ pointer, value, ...(had ? { old } : {}) });
      diff.push({ pointer, new: value, ...(had ? { replaced: { type: Array.isArray(old) ? 'array' : old === null ? 'null' : typeof old, sha256: sha256(JSON.stringify(old)).slice(0, 12) } } : {}) });
      continue;
    }
    if (!Object.hasOwn(parent, key)) { parent[key] = []; created.push(pointer); }
    const arr = parent[key];
    if (!Array.isArray(arr)) return fail('pointer');
    const at = `${pointer}/${arr.push(structuredClone(value)) - 1}`;
    owned.push({ pointer: at, value });
    diff.push({ pointer: at, new: value });
  }
  const after = encode(doc, style);
  if (Buffer.byteLength(after) > MAX_BYTES) fail('too-large');
  return {
    target: file, route, existed: !!cur, preHash: cur ? sha256(cur.bytes) : null, dev: cur?.dev ?? null, ino: cur?.ino ?? null,
    mode: cur?.mode ?? NEW_FILE_MODE, base, after, diff, owned, created,
  };
}

const MANIFEST_VERSION = 1;

export function readManifest(dataDir: string): ManifestEntry[] {
  const cur = readFile(path.join(dataDir, 'integrations', 'manifest.json'));
  if (!cur) return [];
  if (cur.mode & 0o077) fail('manifest');
  let m: unknown;
  try { m = JSON.parse(cur.bytes.toString('utf8')); } catch { return fail('manifest'); }
  if (!isObject(m) || m['v'] !== MANIFEST_VERSION || !Array.isArray(m['entries'])) return fail('manifest');
  return m['entries'] as ManifestEntry[];
}

/** Adds or replaces (by id) an entry written outside apply(): the claude-plugin route (P3-T05). */
export function recordEntry(dataDir: string, entry: ManifestEntry): void {
  writeManifest(dataDir, [...readManifest(dataDir).filter((e) => e.id !== entry.id), entry]);
}
export function dropEntry(dataDir: string, id: string): void {
  writeManifest(dataDir, readManifest(dataDir).filter((e) => e.id !== id));
}

/** EC-09 (S4-C4): plugin and settings fallback each deliver every event, so one profile has at most one of them. */
export function assertExclusive(entries: ManifestEntry[], target: string, route: Route): void {
  const other = route === 'claude-plugin' ? 'claude-settings-fallback' : route === 'claude-settings-fallback' ? 'claude-plugin' : null;
  if (other && entries.some((e) => e.target === target && e.route === other)) fail('exclusive');
}

function writeManifest(dataDir: string, entries: ManifestEntry[]) {
  const file = privateDirs(dataDir).manifest;
  atomicWrite(file, `${JSON.stringify({ v: MANIFEST_VERSION, entries }, null, 2)}\n`, 0o600);
  fsyncDir(path.dirname(file));
}

const sameFile = (p: Plan, cur: FileState | null) =>
  p.existed ? !!cur && sha256(cur.bytes) === p.preHash && cur.dev === p.dev && cur.ino === p.ino && cur.mode === p.mode : cur === null;

/** Any read, parse or size failure counts as a failed check, so it always reaches the rollback. */
function selfCheck(file: string, p: Plan): boolean {
  try {
    const cur = readFile(file);
    if (!cur) return false;
    const stripped = strip(decode(cur.bytes).doc, p.owned, p.created);
    return !stripped.conflicts.length && isDeepStrictEqual(stripped.doc, p.base);
  } catch {
    return false;
  }
}

export interface ApplyOptions { dataDir: string; bounds: Bounds; afterRename?: (file: string) => void }

export function apply(p: Plan, o: ApplyOptions): ManifestEntry {
  if (resolveTarget(p.target, o.bounds) !== p.target) fail('changed');
  const dirs = privateDirs(o.dataDir);
  if (p.route === 'claude-plugin') fail('route'); // installs through `claude plugin` (adapters/claude/setup.ts)
  assertExclusive(readManifest(o.dataDir), p.target, p.route);
  const before = readFile(p.target);
  if (!sameFile(p, before)) fail('changed');
  const backup = before ? `${randomUUID()}.bak` : null;
  if (before && backup) writeExclusive(path.join(dirs.backups, backup), before.bytes, 0o600);
  const entry: ManifestEntry = {
    id: randomUUID(), target: p.target, route: p.route, state: 'pending', existed: p.existed, preHash: p.preHash,
    postHash: sha256(p.after), owned: p.owned, created: p.created, backup, at: new Date().toISOString(),
  };
  const others = readManifest(o.dataDir);
  writeManifest(o.dataDir, [...others, entry]); // pending first: a crash after the rename still leaves a revertable entry
  const drop = () => {
    writeManifest(o.dataDir, others);
    if (backup) unlinkSync(path.join(dirs.backups, backup));
  };
  try {
    // ponytail: an agent write between this recheck and the rename is lost; one rename cannot close that window.
    // A lock file serializes Xaibo's own writers once the service owns writes (Phase 6).
    atomicWrite(p.target, p.after, p.mode, () => { if (!sameFile(p, readFile(p.target))) fail('changed'); });
  } catch (e) {
    drop();
    throw e;
  }
  // From here the target may hold the change: any failure keeps the pending entry and backup for revert.
  fsyncDir(path.dirname(p.target));
  o.afterRename?.(p.target);
  if (!selfCheck(p.target, p)) {
    if (before) { atomicWrite(p.target, before.bytes, before.mode); fsyncDir(path.dirname(p.target)); }
    else removeFile(p.target);
    drop();
    fail('self-check');
  }
  const applied = { ...entry, state: 'applied' as const };
  writeManifest(o.dataDir, [...others, applied]);
  return applied;
}

function checkEntry(e: ManifestEntry) {
  if (e.backup !== null && !BACKUP_NAME.test(e.backup)) fail('manifest');
  [...e.owned.map((x) => x.pointer), ...e.created].forEach(segments);
}

export function revert(entry: ManifestEntry, o: { dataDir: string; bounds: Bounds }): RevertResult {
  if (entry.route === 'claude-plugin') fail('route'); // uninstalls through `claude plugin`
  checkEntry(entry);
  if (resolveTarget(entry.target, o.bounds) !== entry.target) fail('outside-root');
  const dirs = privateDirs(o.dataDir);
  const others = readManifest(o.dataDir).filter((e) => e.id !== entry.id);
  const backupFile = entry.backup ? path.join(dirs.backups, entry.backup) : null;
  const done = (result: RevertResult['result']): RevertResult => {
    writeManifest(o.dataDir, others);
    if (backupFile) unlinkSync(backupFile);
    return { result, conflicts: [] };
  };
  const cur = readFile(entry.target);
  const hash = cur ? sha256(cur.bytes) : null;
  const unchangedSince = () => {
    const now = readFile(entry.target);
    if (!now || sha256(now.bytes) !== hash) fail('changed');
  };
  if (!cur || hash === entry.preHash) return done('unchanged'); // never applied, or the file is gone (and with it Xaibo's values)
  if (hash === entry.postHash && !entry.partial) {
    if (!entry.existed) { removeFile(entry.target); return done('removed'); }
    const b = backupFile ? readFile(backupFile) : null;
    if (!b || sha256(b.bytes) !== entry.preHash) fail('backup');
    atomicWrite(entry.target, b!.bytes, cur.mode, unchangedSince);
    fsyncDir(path.dirname(entry.target));
    return done('restored');
  }
  const { doc, style } = decode(cur.bytes);
  const { doc: stripped, conflicts } = strip(doc, entry.owned, entry.created);
  const text = encode(stripped, style);
  if (!isDeepStrictEqual(stripped, doc)) {
    atomicWrite(entry.target, text, cur.mode, unchangedSince);
    fsyncDir(path.dirname(entry.target));
  }
  if (!conflicts.length) return done('structural');
  const left = new Set(conflicts.map((c) => c.pointer));
  writeManifest(o.dataDir, [...others, { ...entry, owned: entry.owned.filter((x) => left.has(x.pointer)), postHash: sha256(text), partial: true }]);
  return { result: 'structural', conflicts };
}
