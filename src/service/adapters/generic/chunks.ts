// content.upsert chunk assembly (P3-T13b; PRD §5.10, FR-08, EC-82, Q3-9; security review 872). Chunks are files under
// <dataDir>/content-chunks/<registration>/<sha256(session, item, revision)>/<index>.c (dirs 0700, files 0600, written to an
// O_EXCL temp, fsynced, renamed, dir fsynced), so a chunk is durable before its delivery commits and survives a restart.
// A chunk already on disk is kept as first written (idempotent retries). An item is complete only when the final chunk
// named its count and every chunk below it is on disk; the caller stores the text and then removes the item. Quotas count
// bytes plus a per-file overhead (64 MiB per registration, 512 MiB global), pending items (256) and chunk files (20,000)
// per registration, recomputed from disk at open; a chunk past any of them makes the item incomplete and frees it.
// Names come only from a validated UUID and a hash, never from payload text. Same-uid swaps of these private dirs are the
// same trust domain (accepted, review 872 #8). Each item dir holds its key (JSON) so the caller can free items that the
// store already settled before a crash removed them; a write that fails removes what it wrote. ponytail: abandoned
// pending items, and items of a revoked registration, keep their quota until removed; an age reaper when retention lands
// (Phase 5).
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import { UUID } from '../../../shared/hook-protocol.ts';

export interface ChunkKey { registration: string; session: string; item: string; revision: number }
export interface ChunkLimits { perRegistration: number; global: number; items?: number; files?: number }
export type PutResult =
  | { state: 'pending' | 'incomplete'; chunks: number; bytes: number }
  | { state: 'complete'; content: string; chunks: number; bytes: number };
export interface ChunkStore {
  put(key: ChunkKey, index: number, final: boolean, content: string): PutResult;
  /** Drops an item's chunks (after its completion or incompleteness is committed). */
  remove(key: ChunkKey): void;
  /** Accounted pending bytes of a registration (content plus per-file overhead). */
  pending(registration: string): number;
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

const uid = () => process.getuid?.();
// JSON keeps the parts apart whatever they contain (review H1: ids may hold NUL).
const hashOf = (k: ChunkKey) => createHash('sha256').update(JSON.stringify([k.registration, k.session, k.item, k.revision])).digest('hex');
const parseKey = (text: string): ChunkKey | null => {
  try {
    const k = JSON.parse(text) as Partial<ChunkKey>;
    return typeof k.registration === 'string' && typeof k.session === 'string' && typeof k.item === 'string' && Number.isSafeInteger(k.revision)
      ? { registration: k.registration, session: k.session, item: k.item, revision: k.revision! } : null;
  } catch { return null; }
};

function privateDir(dir: string) {
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const st = lstatSync(dir);
  if (!st.isDirectory() || (uid() !== undefined && st.uid !== uid())) throw new Error('content-chunks: not a private directory');
  if (st.mode & 0o077) chmodSync(dir, 0o700);
}

function durable(file: string, data: string) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
    renamed = true;
    const d = openSync(dir, constants.O_RDONLY);
    try { fsyncSync(d); } finally { closeSync(d); }
  } catch (e) { // nothing half-written stays behind unaccounted (review M2/M3)
    rmSync(renamed ? file : tmp, { force: true });
    throw e;
  }
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
    pending: (reg) => accounts.get(reg)?.bytes ?? 0,
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
          const r = { state: 'incomplete' as const, chunks: item?.chunks ?? 0, bytes: item?.bytes ?? 0 };
          remove(key);
          return r;
        }
        privateDir(path.join(root, key.registration));
        privateDir(dir);
        const own: ChunkKey = { registration: key.registration, session: key.session, item: key.item, revision: key.revision };
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
