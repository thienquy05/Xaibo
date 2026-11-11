// S12 synthetic generators (P0-S12-T1). Seeded mulberry32 only; each generator has a check that compares its
// output with the DECLARED statistics (not with its own parameters), so a wrong parameter fails the check.
// Scale: the owner's PERSONAL-USAGE profile (decision 2026-11-10, overrides the plan's 10 GiB / 50 sessions /
// 200 events/s); SCALE is the one ~3x "ready to scale up" probe. All profile values are estimates (~).
//   node spikes/s12/gen.ts --self-check [--median-bytes N] [--live-mean-bytes N] [--minutes N]   exits 1 on a miss
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { mulberry32, summary } from '../shared/bench.ts';

export const SEEDS = { corpus: 12001, text: 12002, live: 12003, usage: 12004, build: 12005 } as const;
const GIB = 2 ** 30;
export const MB = 1_000_000;
export const TS_BASE = Date.UTC(2026, 0, 1); // fixed synthetic timestamp base (OQ-X5)

// Box-Muller standard normal from a uniform source.
export const normal = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const Z99 = 2.3263;

// ---- (b) historical corpus: per-session byte sizes, §6.6 shape capped at 50 MB (personal: ~1,500 sessions) ----
// minContentBytes: content alone >= 1 GiB, so the populated DB (content + FTS + indexes) lands at ~1-2+ GiB, no padding.
export const CORPUS = { sessions: 1_500, medianBytes: 200_000, p99Bytes: 20 * MB, maxBytes: 50 * MB, minContentBytes: GIB };
export interface CorpusPlan { seed: number; sizes: number[] }

// Lognormal sizes; session 0 is forced to the max (the big session T3 pages through).
export function corpusPlan(o: Partial<typeof CORPUS> & { seed?: number } = {}): CorpusPlan {
  const p = { ...CORPUS, ...o };
  const seed = o.seed ?? SEEDS.corpus;
  const r = mulberry32(seed);
  const mu = Math.log(p.medianBytes);
  const sigma = Math.log(p.p99Bytes / p.medianBytes) / Z99;
  const sizes = [p.maxBytes];
  while (sizes.length < p.sessions) sizes.push(Math.min(p.maxBytes, Math.max(1_000, Math.round(Math.exp(mu + sigma * normal(r))))));
  return { seed, sizes };
}

export function corpusStats(sizes: readonly number[]) {
  const s = summary(sizes);
  return { n: s.n, medianBytes: s.p50, p99Bytes: s.p99, maxBytes: s.max, atMax: sizes.filter((b) => b === CORPUS.maxBytes).length, totalBytes: sizes.reduce((a, b) => a + b, 0) };
}

const within = (v: number, want: number, tol: number) => Math.abs(v - want) <= want * tol;

export function checkCorpus(plan: CorpusPlan): string[] {
  const s = corpusStats(plan.sizes);
  const f: string[] = [];
  if (s.n !== CORPUS.sessions) f.push(`sessions ${s.n} != ${CORPUS.sessions}`);
  // ±15%: at n = 1,500 and sigma ~1.98 the sample median's standard error is ~6.4% (±10% was set for n >= 10,000).
  if (!within(s.medianBytes, CORPUS.medianBytes, 0.15)) f.push(`median ${s.medianBytes} not ~${CORPUS.medianBytes} (±15%)`);
  if (!within(s.p99Bytes, CORPUS.p99Bytes, 0.25)) f.push(`p99 ${s.p99Bytes} not ~${CORPUS.p99Bytes} (±25%)`);
  if (s.maxBytes !== CORPUS.maxBytes || s.atMax < 1) f.push(`max ${s.maxBytes} != ${CORPUS.maxBytes} or no session at max`);
  if (s.totalBytes < CORPUS.minContentBytes) f.push(`content ${s.totalBytes} < 1 GiB`);
  return f;
}

// Historical item sizes inside a session: lognormal, a fraction above the 64 KiB FTS prefix.
export const ITEM = { medianBytes: 2048, sigma: 1.4, maxBytes: 2 ** 20, ftsPrefixBytes: 64 * 1024 };
export const itemBytes = (r: () => number) => Math.min(ITEM.maxBytes, Math.max(64, Math.round(ITEM.medianBytes * Math.exp(ITEM.sigma * normal(r)))));

// ---- (a) live stream (M14): base rate with a burst of burstSeconds every burstEverySeconds ----
// Personal: 5 sessions ~20 events/s, bursts to ~50/s. SCALE: the one ~3x probe (15 sessions, ~60/s, bursts ~150/s).
export const LIVE = { sessions: 5, ratePerS: 20, burstPerS: 50, burstSeconds: 5, burstEverySeconds: 60, seconds: 600, meanBytes: 4096, maxBytes: 256 * 1024, sigma: 1.2, forceMaxEvery: 5_000 };
export const SCALE: typeof LIVE = { ...LIVE, sessions: 15, ratePerS: 60, burstPerS: 150, seconds: 120 };
export interface LivePlan { seed: number; bytes: number[]; session: number[]; atMs: number[] }

const rateAt = (p: typeof LIVE, sec: number) => (sec % p.burstEverySeconds < p.burstSeconds ? p.burstPerS : p.ratePerS);
const liveEvents = (p: typeof LIVE) => { let n = 0; for (let s = 0; s < p.seconds; s++) n += rateAt(p, s); return n; };

export function liveSizes(o: Partial<typeof LIVE> & { seed?: number } = {}): LivePlan {
  const p = { ...LIVE, ...o };
  const seed = o.seed ?? SEEDS.live;
  const r = mulberry32(seed);
  const median = p.meanBytes / Math.exp((p.sigma * p.sigma) / 2);
  const out: LivePlan = { seed, bytes: [], session: [], atMs: [] };
  let i = 0;
  for (let sec = 0; sec < p.seconds; sec++) {
    const rate = rateAt(p, sec);
    for (let k = 0; k < rate; k++, i++) {
      out.bytes.push(i % p.forceMaxEvery === p.forceMaxEvery - 1 ? p.maxBytes : Math.min(p.maxBytes, Math.max(256, Math.round(median * Math.exp(p.sigma * normal(r))))));
      out.session.push(Math.floor(r() * p.sessions));
      out.atMs.push(sec * 1000 + (k * 1000) / rate);
    }
  }
  return out;
}

export function checkLive(plan: LivePlan, d: typeof LIVE): string[] {
  const s = summary(plan.bytes);
  const perSec = new Map<number, number>();
  for (const t of plan.atMs) perSec.set(Math.floor(t / 1000), (perSec.get(Math.floor(t / 1000)) ?? 0) + 1);
  const rates = [...perSec.values()];
  const f: string[] = [];
  if (s.n !== liveEvents(d)) f.push(`events ${s.n} != ${liveEvents(d)}`);
  if (new Set(plan.session).size !== d.sessions) f.push(`sessions ${new Set(plan.session).size} != ${d.sessions}`);
  if (Math.min(...rates) !== d.ratePerS || Math.max(...rates) !== d.burstPerS) f.push(`rate ${Math.min(...rates)}..${Math.max(...rates)}/s != ${d.ratePerS}..${d.burstPerS}/s`);
  if (!within(s.mean, d.meanBytes, 0.05)) f.push(`mean ${s.mean.toFixed(0)} not ~${d.meanBytes} (±5%)`);
  if (s.p99 > d.maxBytes) f.push(`p99 ${s.p99} > 256 KiB`);
  if (s.max !== d.maxBytes) f.push(`max ${s.max} != 256 KiB`);
  return f;
}

// ---- (c) usage tables (personal: 1 scope x 2 windows = 2 quota streams, 45 days of minutes, 1% transitions) ----
export const USAGE = { agents: 1, profiles: 1, limits: ['5h', '7d'], minutes: 64_800, transitionRate: 0.01, contextGenerationsMax: 3, priceModels: 8, priceComponents: ['input', 'output', 'cache_read', 'cache_write'], priceRevisions: 6 };
export interface UsageStream { scope: number; limit: string; samples: number; transitions: number }
export interface UsagePlan { seed: number; minutes: number; streams: UsageStream[] }

export function usagePlan(o: { seed?: number; minutes?: number } = {}): UsagePlan {
  const minutes = o.minutes ?? USAGE.minutes;
  const streams: UsageStream[] = [];
  for (let scope = 0; scope < USAGE.agents * USAGE.profiles; scope++) {
    for (const limit of USAGE.limits) streams.push({ scope, limit, samples: minutes, transitions: Math.round(minutes * USAGE.transitionRate) });
  }
  return { seed: o.seed ?? SEEDS.usage, minutes, streams };
}

export function checkUsage(plan: UsagePlan): string[] {
  const want = USAGE.agents * USAGE.profiles * USAGE.limits.length;
  const f: string[] = [];
  if (plan.streams.length !== want) f.push(`streams ${plan.streams.length} != ${want}`);
  for (const s of plan.streams) {
    if (s.samples !== 45 * 24 * 60) f.push(`stream ${s.scope}/${s.limit}: ${s.samples} samples != 64800`);
    if (s.transitions !== 648) f.push(`stream ${s.scope}/${s.limit}: ${s.transitions} transitions != 648`);
  }
  return f;
}

// Rows: [scope, limit, as_of ms, used_percent, resets_at ms, kind]. Samples every minute; transitions at evenly
// jittered minutes (a window reset: used_percent drops, resets_at moves).
export function* usageRows(plan: UsagePlan): Generator<[number, string, number, number, number, string]> {
  const r = mulberry32(plan.seed);
  for (const s of plan.streams) {
    const windowMs = (s.limit === '5h' ? 300 : 10_080) * 60_000;
    const at = new Set(Array.from({ length: s.transitions }, (_, k) => Math.floor(((k + r()) * plan.minutes) / s.transitions)));
    let used = 0;
    let resets = TS_BASE + windowMs;
    for (let m = 0; m < plan.minutes; m++) {
      const t = TS_BASE + m * 60_000;
      used = Math.min(100, used + r() * 0.2);
      yield [s.scope, s.limit, t, Math.round(used * 100) / 100, resets, 'sample'];
      if (at.has(m)) { used = 0; resets = t + windowMs; yield [s.scope, s.limit, t, 0, resets, 'transition']; }
    }
  }
}

// ---- text: fixed vocabulary (Zipf) plus a CJK and emoji fraction, as one seeded UTF-8 pool ----
export const TEXT = { poolBytes: 16 * 2 ** 20, vocab: 5_000, cjkWords: 200, cjkFraction: 0.08, emojiFraction: 0.02, rareMarker: 'zqxrare' };
const SYL = ['ka', 'lo', 'mi', 'ne', 'ru', 'sa', 'ti', 'vo', 'pe', 'da', 'go', 'zu', 'ri', 'xa', 'fe', 'hu'];
const EMOJI = ['😀', '🚀', '✅', '🔥', '🐛', '📦', '⚠️', '🎉', '💡', '🧪', '🔧', '📝', '👀', '🙂', '❌', '⏳'];

export class TextPool {
  readonly buf: Buffer;
  readonly vocab: string[] = [];
  readonly cjk: string[] = [];
  readonly counts = { tokens: 0, cjk: 0, emoji: 0 };
  constructor(seed: number = SEEDS.text, bytes = TEXT.poolBytes) {
    const r = mulberry32(seed);
    const words = new Set<string>();
    while (words.size < TEXT.vocab) words.add(Array.from({ length: 2 + Math.floor(r() * 3) }, () => SYL[Math.floor(r() * SYL.length)]).join(''));
    this.vocab = [...words];
    const cj = new Set<string>();
    while (cj.size < TEXT.cjkWords) cj.add(String.fromCodePoint(0x4e00 + Math.floor(r() * 0x51a0), 0x4e00 + Math.floor(r() * 0x51a0)));
    this.cjk = [...cj];
    const cdf: number[] = [];
    let acc = 0;
    for (let i = 1; i <= TEXT.vocab; i++) cdf.push((acc += 1 / i));
    const zipf = () => { const x = r() * acc; let lo = 0, hi = cdf.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < x) lo = m + 1; else hi = m; } return lo; };
    const parts: string[] = [];
    let len = 0;
    while (len < bytes) {
      const x = r();
      const tok = x < TEXT.cjkFraction ? (this.counts.cjk++, this.cjk[Math.floor(r() * this.cjk.length)])
        : x < TEXT.cjkFraction + TEXT.emojiFraction ? (this.counts.emoji++, EMOJI[Math.floor(r() * EMOJI.length)])
        : this.vocab[zipf()];
      this.counts.tokens++;
      const piece = tok + (this.counts.tokens % 16 === 0 ? '\n' : ' ');
      parts.push(piece);
      len += Buffer.byteLength(piece);
    }
    this.buf = Buffer.from(parts.join(''));
  }
  check(): string[] {
    const f: string[] = [];
    const c = this.counts.cjk / this.counts.tokens, e = this.counts.emoji / this.counts.tokens;
    if (!within(c, TEXT.cjkFraction, 0.1)) f.push(`CJK fraction ${c.toFixed(4)} not ~${TEXT.cjkFraction}`);
    if (!within(e, TEXT.emojiFraction, 0.1)) f.push(`emoji fraction ${e.toFixed(4)} not ~${TEXT.emojiFraction}`);
    return f;
  }
  // A UTF-8 string of n bytes minus at most 3 (cut at character boundaries) from a random pool offset.
  slice(r: () => number, n: number): string {
    const b = this.buf;
    let s = Math.floor(r() * (b.length - n - 4));
    while ((b[s] & 0xc0) === 0x80) s++;
    let e = s + n;
    while (e > s && (b[e] & 0xc0) === 0x80) e--;
    return b.toString('utf8', s, e);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({ options: { 'self-check': { type: 'boolean' }, 'median-bytes': { type: 'string' }, 'live-mean-bytes': { type: 'string' }, minutes: { type: 'string' } } });
  if (!v['self-check']) { console.log('usage: gen.ts --self-check [--median-bytes N] [--live-mean-bytes N] [--minutes N]'); process.exit(2); }
  const corpus = corpusPlan(v['median-bytes'] ? { medianBytes: Number(v['median-bytes']) } : {});
  const live = liveSizes(v['live-mean-bytes'] ? { meanBytes: Number(v['live-mean-bytes']) } : {});
  const scale = liveSizes(SCALE);
  const usage = usagePlan(v.minutes ? { minutes: Number(v.minutes) } : {});
  const pool = new TextPool();
  const fails = [...checkCorpus(corpus), ...checkLive(live, LIVE), ...checkLive(scale, SCALE).map((x) => `scale: ${x}`), ...checkUsage(usage), ...pool.check()];
  console.log(JSON.stringify({ tag: 'spike, not gate evidence', seeds: SEEDS, corpus: corpusStats(corpus.sizes), live: summary(live.bytes), scale: summary(scale.bytes), usageStreams: usage.streams.length, text: pool.counts, fails }, null, 1));
  process.exit(fails.length ? 1 : 0);
}
