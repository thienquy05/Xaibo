// File tailing (P1-T10, EC-13): checkpoints (dev, ino, size, mtime, offset, head hash) decide whether to continue
// from the offset or reparse from 0; reads stream in bounded chunks; .jsonl.zst is stream-decompressed (EC-03).
import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import * as zlib from 'node:zlib';

export const HEAD_BYTES = 4096;
export interface Checkpoint { dev: number; ino: number; size: number; mtime: number; offset: number; headHash: string }

/** True when this runtime can stream-decompress zstd (Electron 45's Node 24 can, S9). */
export const zstdAvailable = typeof (zlib as { createZstdDecompress?: unknown }).createZstdDecompress === 'function';

/** sha256 of the first `length` bytes (length is min(HEAD_BYTES, checkpoint offset)). */
export async function headHash(path: string, length: number): Promise<string> {
  const n = Math.min(length, HEAD_BYTES);
  const buf = Buffer.alloc(n);
  if (n > 0) {
    const fh = await open(path, 'r');
    try { await fh.read(buf, 0, n, 0); } finally { await fh.close(); }
  }
  return createHash('sha256').update(buf).digest('hex');
}

/** Where to resume: the checkpoint offset, or 0 with reset=true when the file was truncated, rotated or replaced. */
export async function startOffset(path: string, st: Pick<Stats, 'dev' | 'ino' | 'size'>, cp: Checkpoint | undefined): Promise<{ offset: number; reset: boolean }> {
  if (!cp) return { offset: 0, reset: false };
  const reset = st.dev !== cp.dev || st.ino !== cp.ino || st.size < cp.offset || (await headHash(path, cp.offset)) !== cp.headHash;
  return reset ? { offset: 0, reset: true } : { offset: cp.offset, reset: false };
}

/** Plain file bytes [from, end) in chunks of at most chunkBytes. */
export function readRange(path: string, from: number, end: number, chunkBytes: number): Readable {
  return createReadStream(path, { start: from, end: end - 1, highWaterMark: chunkBytes });
}

/** Whole .jsonl.zst file, decompressed as a stream (offsets are positions in the decompressed text). */
export function readZstd(path: string, chunkBytes: number): Readable {
  const decompress = (zlib as unknown as { createZstdDecompress: (o: object) => NodeJS.ReadWriteStream }).createZstdDecompress({ chunkSize: chunkBytes });
  return createReadStream(path, { highWaterMark: chunkBytes }).pipe(decompress) as unknown as Readable;
}
