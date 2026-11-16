// Nearest-rank percentiles for the perf reports (P1-T14). Infinity (a miss) sorts last and counts.
export function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? Number.NaN;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.at(-1) ?? Number.NaN, mean: s.reduce((a, b) => a + b, 0) / (s.length || 1) };
}
