// S9 runtime zstd probe (P0-S9-T5), run inside the packaged utilityProcess (mode s9-zstd). Synthetic data only.
import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';

import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

const BIG_LINES = 400_000;           // ~100 MB of JSONL
const LINE = JSON.stringify({ type: 'assistant', sessionId: '00000000-0000-4000-8000-000000000001', pad: 'x'.repeat(220) });

async function countLines(file: string): Promise<{ lines: number; peakRss: number }> {
  let lines = 0;
  let peakRss = process.memoryUsage().rss;
  const d = (zlib as unknown as { createZstdDecompress: () => NodeJS.ReadWriteStream }).createZstdDecompress();
  createReadStream(file).pipe(d);
  for await (const chunk of d) {
    for (const b of chunk as Buffer) if (b === 10) lines++;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  return { lines, peakRss };
}

export async function zstdProbe(dir: string) {
  mkdirSync(dir, { recursive: true });
  const z = zlib as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { node: process.versions.node, electron: process.versions.electron, createZstdDecompress: typeof z.createZstdDecompress, zstdCompressSync: typeof z.zstdCompressSync };
  if (typeof z.createZstdDecompress !== 'function') return out;
  const small = path.join(dir, 'two.jsonl.zst');
  writeFileSync(small, (z.zstdCompressSync as (b: Buffer) => Buffer)(Buffer.from(`${LINE}\n${LINE}\n`)));
  out.small = await countLines(small);
  const big = path.join(dir, 'big.jsonl.zst');
  const src = Readable.from((function* () { for (let i = 0; i < BIG_LINES; i++) yield `${LINE}\n`; })());
  await pipeline(src, (z.createZstdCompress as () => NodeJS.ReadWriteStream)(), createWriteStream(big));
  const t0 = process.hrtime.bigint();
  const r = await countLines(big);
  out.big = { expectedLines: BIG_LINES, ...r, uncompressedMB: Math.round((BIG_LINES * (LINE.length + 1)) / 2 ** 20), ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  return out;
}
