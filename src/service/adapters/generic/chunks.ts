// content.upsert chunk assembly (P3-T13b; PRD §5.10, FR-08, EC-82, Q3-9; security review 872). Chunks are files under
// <dataDir>/content-chunks/<registration>/<sha256(producer, session, item, revision)>/<index>.c (dirs 0700, files 0600, written to an
// O_EXCL temp, fsynced, renamed, dir fsynced), so a chunk is durable before its delivery commits and survives a restart.
// A chunk already on disk is kept as first written (idempotent retries). An item is complete only when the final chunk
// named its count and every chunk below it is on disk; the caller stores the text and then removes the item. Quotas count
// bytes plus a per-file overhead (64 MiB per registration, 512 MiB global), pending items (256) and chunk files (20,000)
// per registration, recomputed from disk at open; a chunk past any of them makes the item incomplete, and the caller
// frees it once that state is committed (G3d-1).
// Names come only from a validated UUID and a hash, never from payload text. Same-uid swaps of these private dirs are the
// same trust domain (accepted, review 872 #8). Each item dir holds its key (JSON) so the caller can free items that the
// store already settled before a crash removed them; a write that fails removes what it wrote. ponytail: abandoned
// pending items, and items of a revoked registration, keep their quota until removed; an age reaper when retention lands
// (Phase 5).
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { UUID } from '../../../shared/hook-protocol.ts';
import { atomicWrite, fsyncDir, privateDir as sharedPrivateDir } from '../../fs-private.ts';

/** producer: two producer instances chunking one item differently never share chunks (G3d-2). */
export interface ChunkKey { registration: string; producer: string; session: string; item: string; revision: number }
export interface ChunkLimits { perRegistration: number; global: number; items?: number; files?: number }
export type PutResult =
  | { state: 'pending' | 'incomplete'; chunks: number; bytes: number }
  | { state: 'complete'; content: string; chunks: number; bytes: number };
export interface ChunkStore {
  put(key: ChunkKey, index: number, final: boolean, content: string): PutResult;
  /** Drops an item's chunks (after its completion or incompleteness is committed). */
  remove(key: ChunkKey): void;
  /** Keys of the items on disk (pending, or left by a crash after their state was committed). */
  items(): ChunkKey[];
}

export const CHUNK_LIMITS = { perRegistration: 64 << 20, global: 512 << 20, items: 256, files: 20_000 };
const MAX_INDEX = 65_535;
const OVERHEAD = 512; // per chunk file, so empty chunks still cost quota
const CHUNK = /^\d{1,5}\.c$/;
const HASH = /^[0-9a-f]{64}$/;
const FINAL = 'final';
const KEY = 'key';

interface Item { key: ChunkKey; chunks: number; bytes: number; final: number | null }
interface Account { bytes: number; files: number; items: Map<string, Item> }

// JSON keeps the parts apart whatever they contain (review H1: ids may hold NUL).
const hashOf = (k: ChunkKey) => createHash('sha256').update(JSON.stringify([k.registration, k.producer, k.session, k.item, k.revision])).digest('hex');
const parseKey = (text: string): ChunkKey | null => {
  try {
    const k = JSON.parse(text) as Partial<ChunkKey>;
    return typeof k.registration === 'string' && typeof k.producer === 'string' && typeof k.session === 'string' && typeof k.item === 'string'
      && Number.isSafeInteger(k.revision) ? { registration: k.registration, producer: k.producer, session: k.session, item: k.item, revision: k.revision! } : null;
  } catch { return null; }
};

const privateDir = (dir: string) => sharedPrivateDir(dir, () => { throw new Error('content-chunks: not a private directory'); });

function durable(file: string, data: string) {
  atomicWrite(file, data, 0o600); // a throw here removed its temp file and left the target as it was
  try { fsyncDir(path.dirname(file)); } catch (e) { // nothing half-written stays behind unaccounted (review M2/M3)
    rmSync(file, { force: true });
    throw e;
  }
}

const ownDir = (p: string) => { try { const st = lstatSync(p); return st.isDirectory() && (process.getuid === undefined || st.uid === process.getuid()); } catch { return false; } };

/** XAIBO-PROD-515 (P5-T07): removes every item (pending, interrupted or left by a crash) whose verified key matches;
 *  returns how many. Only our own dirs with valid names and a key that hashes to its dir are touched; symlinks are never
 *  followed. ponytail: a running report intake keeps counting the removed bytes against its quota until it reopens
 *  (service restart); route this through its ChunkStore if purges of large pending items ever starve other sessions. */
export function removeItems(root: string, match: (k: ChunkKey) => boolean): number {
  if (!ownDir(root)) return 0;
  let n = 0;
  for (const reg of readdirSync(root).filter((x) => UUID.test(x) && ownDir(path.join(root, x)))) {
    for (const h of readdirSync(path.join(root, reg)).filter((x) => HASH.test(x) && ownDir(path.join(root, reg, x)))) {
      const dir = path.join(root, reg, h);
      let key: ChunkKey | null = null;
      try { if (lstatSync(path.join(dir, KEY)).isFile()) key = parseKey(readFileSync(path.join(dir, KEY), 'utf8')); } catch { /* no key file: not ours to judge */ }
      if (!key || key.registration !== reg || hashOf(key) !== h || !match(key)) continue;
      rmSync(dir, { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

export function openChunks(root: string, limits: ChunkLimits = CHUNK_LIMITS): ChunkStore {
  const cap = { ...CHUNK_LIMITS, ...limits };
  privateDir(root);
  const accounts = new Map<string, Account>();
  let total = 0;
  const account = (reg: string) => accounts.get(reg) ?? accounts.set(reg, { bytes: 0, files: 0, items: new Map() }).get(reg)!;

  // Recount what an earlier run left: chunks written before a crash or a failed commit still hold quota.
  for (const reg of readdirSync(root).filter((n) => UUID.test(n) && lstatSync(path.join(root, n)).isDirectory())) {
    const a = account(reg);
    for (const h of readdirSync(path.join(root, reg)).filter((n) => HASH.test(n) && lstatSync(path.join(root, reg, n)).isDirectory())) {
      const dir = path.join(root, reg, h);
      let key: ChunkKey | null = null;
      try { key = parseKey(readFileSync(path.join(dir, KEY), 'utf8')); } catch { /* no key file */ }
      if (!key || key.registration !== reg || hashOf(key) !== h) { rmSync(dir, { recursive: true, force: true }); continue; } // not ours to assemble
      const item: Item = { key, chunks: 0, bytes: 0, final: null };
      for (const f of readdirSync(dir)) {
        const st = lstatSync(path.join(dir, f));
        if (st.isFile() && f.endsWith('.tmp')) { rmSync(path.join(dir, f), { force: true }); continue; } // a write a crash cut short
        if (!st.isFile()) continue;
        if (f === FINAL) { const n = Number(readFileSync(path.join(dir, f), 'utf8')); if (Number.isSafeInteger(n) && n > 0) item.final = n; continue; }
        if (!CHUNK.test(f)) continue;
        item.chunks++; item.bytes += st.size; a.files++; a.bytes += st.size + OVERHEAD; total += st.size + OVERHEAD;
      }
      a.items.set(h, item);
    }
  }

  const remove = (key: ChunkKey) => {
    if (!UUID.test(key.registration)) return;
    const a = accounts.get(key.registration);
    const h = hashOf(key);
    const item = a?.items.get(h);
    if (a && item) {
      const cost = item.bytes + item.chunks * OVERHEAD;
      a.bytes -= cost; a.files -= item.chunks; total -= cost; a.items.delete(h);
    }
    rmSync(path.join(root, key.registration, h), { recursive: true, force: true });
  };

  return {
    remove,
    items: () => [...accounts.values()].flatMap((a) => [...a.items.values()].map((i) => i.key)),
    put(key, index, final, content) {
      if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) throw new RangeError('chunk index out of range');
      if (!UUID.test(key.registration)) throw new RangeError('registration id');
      const a = account(key.registration);
      const h = hashOf(key);
      const dir = path.join(root, key.registration, h);
      const file = path.join(dir, `${index}.c`);
      let item = a.items.get(h);
      if (!item || !existsSync(file)) {
        const len = Buffer.byteLength(content);
        const cost = len + OVERHEAD;
        if ((!item && a.items.size >= cap.items) || a.files + 1 > cap.files || a.bytes + cost > cap.perRegistration || total + cost > cap.global) {
          // kept until the caller commits the state and removes it: a failed commit must find the item on retry (G3d-1)
          return { state: 'incomplete', chunks: item?.chunks ?? 0, bytes: item?.bytes ?? 0 };
        }
        privateDir(path.join(root, key.registration));
        privateDir(dir);
        const own: ChunkKey = { registration: key.registration, producer: key.producer, session: key.session, item: key.item, revision: key.revision };
        if (!item) durable(path.join(dir, KEY), JSON.stringify(own));
        durable(file, content);
        if (!item) a.items.set(h, item = { key: own, chunks: 0, bytes: 0, final: null });
        item.chunks++; item.bytes += len; a.files++; a.bytes += cost; total += cost;
      }
      if (final && item.final === null) { durable(path.join(dir, FINAL), String(index + 1)); item.final = index + 1; }
      const n = item.final;
      if (n !== null && item.chunks >= n && Array.from({ length: n }, (_, i) => existsSync(path.join(dir, `${i}.c`))).every(Boolean)) {
        const text = Buffer.concat(Array.from({ length: n }, (_, i) => readFileSync(path.join(dir, `${i}.c`)))).toString('utf8');
        return { state: 'complete', content: text, chunks: n, bytes: Buffer.byteLength(text) };
      }
      return { state: 'pending', chunks: item.chunks, bytes: item.bytes };
    },
  };
}
