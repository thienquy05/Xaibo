// P4-T11 live-load analysis (EC-57; TP now, T2 in the scale-up stage): joins every emitted event to its commit, delta
// and paint from the XAIBO_PERF_TRACE=1 lines (service and main stamp process.hrtime, one monotonic clock), after the
// run. A restarted service numbers its deltas from 1 again, so a delta is the first one carrying the id at or after its
// commit, and a paint the first with that number at or after the delta. Samples emitted inside the restart window are
// reported apart; an event never painted is a miss (Infinity) in its bucket. IDs and timings only.
import { stats } from './stats.ts';

export type TraceLine = { ev: string; ids?: string[]; delta?: number; t: string; writerQueueAgeMs?: number; deltaResyncs?: number };
/** id null: a hook with no stored delivery when its forwarder exited (spooled; it reaches the store only by replay). */
export interface Emitted { kind: 'hook' | 'file'; id: string | null; t0: bigint; exit?: bigint }
export interface Window { from: bigint; to: bigint }

const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;

export function analyze(o: { emitted: Emitted[]; service: TraceLine[]; main: TraceLine[]; restart: Window | null; loadEnd: bigint }) {
  // Indexes built once: per id its commits and deltas, per delta number its paints, each in time order.
  const by = <K>(lines: TraceLine[], keys: (l: TraceLine) => K[]) => {
    const m = new Map<K, bigint[]>();
    for (const l of lines) for (const k of keys(l)) { const a = m.get(k); if (a) a.push(BigInt(l.t)); else m.set(k, [BigInt(l.t)]); }
    for (const a of m.values()) a.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    return m;
  };
  const commits = by(o.service.filter((l) => l.ev === 'commit'), (l) => l.ids ?? []);
  const deltaLines = o.service.filter((l) => l.ev === 'delta');
  const deltas = new Map<string, { n: number; t: bigint }[]>();
  for (const l of deltaLines) for (const id of l.ids ?? []) (deltas.get(id) ?? deltas.set(id, []).get(id)!).push({ n: l.delta!, t: BigInt(l.t) });
  for (const a of deltas.values()) a.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
  const paints = by(o.main.filter((l) => l.ev === 'paint'), (l) => (l.delta === undefined ? [] : [l.delta]));
  const firstAtOrAfter = (xs: bigint[] | undefined, t: bigint) => xs?.find((x) => x >= t);

  type Joined = { commit: bigint; delta: bigint; paint: bigint } | null;
  type Stage = 'id' | 'commit' | 'delta' | 'paint'; // the first hop missing
  let missingAt: Stage = 'id';
  const join = (e: Emitted): Joined => {
    missingAt = 'id';
    if (e.id === null) return null;
    missingAt = 'commit';
    const c = firstAtOrAfter(commits.get(e.id), e.t0); // an earlier commit cannot be this event's
    if (c === undefined) return null;
    missingAt = 'delta';
    const d = deltas.get(e.id)?.find((x) => x.t >= c);
    if (!d) return null;
    missingAt = 'paint';
    const p = firstAtOrAfter(paints.get(d.n), d.t);
    return p === undefined ? null : { commit: c, delta: d.t, paint: p };
  };
  // Steady misses, for diagnosis: kind, the missing hop, and when (ms after the first emit). IDs never leave this.
  const t00 = o.emitted.reduce((m, e) => (m === null || e.t0 < m ? e.t0 : m), null as bigint | null) ?? 0n;
  const steadyMisses: { kind: Emitted['kind']; missing: Stage; atMs: number }[] = [];

  const inRestart = (e: Emitted) => o.restart !== null && e.t0 >= o.restart.from && e.t0 <= o.restart.to;
  const buckets = { m1: { steady: [] as number[], restartWindow: [] as number[] }, m2: { steady: [] as number[], restartWindow: [] as number[] } };
  const hops = { dispatch: [] as number[], toCommit: [] as number[], commitToDelta: [] as number[], deltaToPaint: [] as number[] };
  const unpainted = { steady: 0, restart: 0 };
  // emit -> commit, steady painted events: the time a change waits to be stored (a committed but unpainted event is a miss
  // in M1/M2 and in drain, so leaving it out here never lets a run pass; review L2)
  const ingestLag: number[] = [];
  let lastPaint: bigint | null = null;
  let missing = false; // a steady event never painted (a restart-window miss reaches the UI by replay, reported apart)
  for (const e of o.emitted) {
    const j = join(e);
    const restart = inRestart(e);
    (e.kind === 'hook' ? buckets.m1 : buckets.m2)[restart ? 'restartWindow' : 'steady'].push(j ? ms(e.t0, j.paint) : Number.POSITIVE_INFINITY);
    if (!j) {
      unpainted[restart ? 'restart' : 'steady']++;
      if (!restart) { missing = true; if (steadyMisses.length < 50) steadyMisses.push({ kind: e.kind, missing: missingAt, atMs: Math.round(ms(t00, e.t0)) }); }
      continue;
    }
    if (restart) continue;
    if (lastPaint === null || j.paint > lastPaint) lastPaint = j.paint;
    ingestLag.push(ms(e.t0, j.commit));
    if (e.kind === 'hook') {
      if (e.exit !== undefined) hops.dispatch.push(ms(e.t0, e.exit));
      hops.toCommit.push(ms(e.t0, j.commit)); hops.commitToDelta.push(ms(j.commit, j.delta)); hops.deltaToPaint.push(ms(j.delta, j.paint));
    }
  }
  const p95 = (xs: number[]) => stats(xs).p95;

  // The writer's 5 s queue-age peaks. The resync counter restarts with the service: the total is the last report before
  // the kill plus the last one after it (review L1; reports after the last one before a kill are lost with it).
  const metrics = o.service.filter((l) => l.ev === 'metrics');
  const lastOf = (xs: TraceLine[]) => xs.at(-1)?.deltaResyncs ?? 0;
  const kill = o.restart?.from;
  const resyncs = kill === undefined ? lastOf(metrics) : lastOf(metrics.filter((m) => BigInt(m.t) < kill)) + lastOf(metrics.filter((m) => BigInt(m.t) >= kill));

  return {
    m1: { steady: stats(buckets.m1.steady), restartWindow: stats(buckets.m1.restartWindow) },
    m2: { steady: stats(buckets.m2.steady), restartWindow: stats(buckets.m2.restartWindow) },
    hops: { m1: { dispatch: p95(hops.dispatch), toCommit: p95(hops.toCommit), commitToDelta: p95(hops.commitToDelta), deltaToPaint: p95(hops.deltaToPaint) } },
    unpainted, steadyMisses,
    drainMs: missing ? Number.POSITIVE_INFINITY : lastPaint === null ? 0 : Math.max(0, ms(o.loadEnd, lastPaint)),
    ingestLagMs: stats(ingestLag),
    // The writer's own queue: file syncs flush right after they enqueue (tail-adapter), so this is about 0 by design.
    queueAgeMs: stats(metrics.map((m) => m.writerQueueAgeMs ?? 0)),
    deltaResyncs: resyncs,
  };
}
