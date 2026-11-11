// Shared spike helpers: timing, nearest-rank summaries, seeded PRNG, privacy-safe env record.
import { execFileSync } from 'node:child_process';
import os from 'node:os';

export const hr = (): bigint => process.hrtime.bigint();

export interface Summary { n: number; mean: number; p50: number; p95: number; p99: number; max: number }

// Nearest-rank: the value at rank ceil(q/100 * n), 1-based, on the sorted samples.
export function summary(samples: readonly number[]): Summary {
  if (samples.length === 0) throw new Error('summary: no samples');
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const rank = (q: number) => s[Math.max(1, Math.ceil((q * n) / 100)) - 1];
  return { n, mean: s.reduce((a, b) => a + b, 0) / n, p50: rank(50), p95: rank(95), p99: rank(99), max: s[n - 1] };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// No hostname, username or paths. Agent versions are passed in by the caller.
export function envRecord(agents: Record<string, string> = {}): Record<string, unknown> {
  const v = process.versions as Record<string, string | undefined>;
  return {
    cpu: os.cpus()[0]?.model ?? 'unknown',
    macos: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
    ramGiB: Math.round(os.totalmem() / 2 ** 30),
    electron: v.electron ?? null,
    node: v.node,
    sqlite: v.sqlite ?? null,
    agents,
  };
}
