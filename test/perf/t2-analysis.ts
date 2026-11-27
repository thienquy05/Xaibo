// P4-T11 live-load analysis (EC-57; TP now, T2 in the scale-up stage): joins every emitted event to its commit, delta
// and paint from the XAIBO_PERF_TRACE=1 lines (service and main stamp process.hrtime, one monotonic clock), after the
// run. A restarted service numbers its deltas from 1 again, so a delta is the first one carrying the id at or after its
// commit, and a paint the first with that number at or after the delta. Samples emitted inside the restart window are
// reported apart; an event never painted is a miss (Infinity) in its bucket. IDs and timings only.
import type { DatabaseSync } from 'node:sqlite';
import { stats } from './stats.ts';

export type TraceLine = { ev: string; ids?: string[]; delta?: number; t: string; writerQueueAgeMs?: number; deltaResyncs?: number };
/** id null: a hook with no stored delivery when its forwarder exited (spooled; it reaches the store only by replay). */
export interface Emitted { kind: 'hook' | 'file'; id: string | null; t0: bigint; exit?: bigint }
export interface Window { from: bigint; to: bigint }

const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;

/** Gate 5 disk-full: a hook's own stored delivery, by the synthetic key the emitter makes unique (session, event,
 *  tool_use_id), read from the hook event's stored envelope. null while it is not stored (or never: rejected while the
 *  disk was full); never another hook's row, which the old rowid-order match handed out after ENOSPC holes. */
export function hookLookup(db: DatabaseSync) {
  // the session row once per native id (the unique index only narrows by agent), then that session's hook events by index
  const session = db.prepare('SELECT id FROM sessions WHERE agent = ? AND native_session_id = ?');
  const q = db.prepare(`SELECT native_id AS id FROM events WHERE session_id = ? AND source = 'hook'
    AND json_extract(raw, '$.event') = ? AND json_extract(raw, '$.payload.tool_use_id') = ?`);
  const ids = new Map<string, number>();
  return (agent: string, sid: string, event: string, toolUseId: string): string | null => {
    let id = ids.get(`${agent}\0${sid}`);
    if (id === undefined) {
      const s = session.get(agent, sid) as { id: number } | undefined;
      if (!s) return null; // not stored yet: looked up again next time
      ids.set(`${agent}\0${sid}`, id = s.id);
    }
    const rows = q.all(id, event, toolUseId) as { id: string }[];
    if (rows.length > 1) throw new Error(`hook key matches ${rows.length} deliveries`);
    return rows[0]?.id ?? null;
  };
}

/** `faults` (P4-T12b): further windows (disk full) kept apart like the restart window; their samples join its bucket. */
/** G4f-2: events a full profile run emits (steady rate plus the bursts' extra), so an underloaded run cannot pass. */
export function expectedEvents(p: { rate: number; burstRate: number; burstEverySec: number; burstSec: number; seconds: number }): number {
  const bursts = p.burstEverySec > 0 ? Math.floor(p.seconds / p.burstEverySec) : 0;
  return p.seconds * p.rate + bursts * p.burstSec * (p.burstRate - p.rate);
}
/** Load qualifies at >= 95 % of the expected events (serial emit loops drop slots after a stall). */
export const loadQualifies = (emitted: number, p: Parameters<typeof expectedEvents>[0]) => emitted >= 0.95 * expectedEvents(p);

export function analyze(o: { emitted: Emitted[]; service: TraceLine[]; main: TraceLine[]; restart: Window | null; faults?: Window[]; loadEnd: bigint;
  /** D-P5-20 (Codex plan): named time windows; each gets its own hop p95s over every painted event emitted in it. */
  phases?: { name: string; from: bigint; to: bigint }[] }) {
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

  const windows = [...(o.restart ? [o.restart] : []), ...(o.faults ?? [])];
  const inRestart = (e: Emitted) => windows.some((w) => e.t0 >= w.from && e.t0 <= w.to);
  const buckets = { m1: { steady: [] as number[], restartWindow: [] as number[] }, m2: { steady: [] as number[], restartWindow: [] as number[] } };
  const hops = { dispatch: [] as number[], toCommit: [] as number[], commitToDelta: [] as number[], deltaToPaint: [] as number[] };
  const fileHops = { toCommit: [] as number[], commitToDelta: [] as number[], deltaToPaint: [] as number[] }; // Gate 5: where M2 waits
  const unpainted = { steady: 0, restart: 0 };
  // emit -> commit, steady painted events: the time a change waits to be stored (a committed but unpainted event is a miss
  // in M1/M2 and in drain, so leaving it out here never lets a run pass; review L2)
  const ingestLag: number[] = [];
  const byPhase = (o.phases ?? []).map((w) => ({ ...w, hook: [] as number[], file: [] as number[], hookToCommit: [] as number[], fileToCommit: [] as number[], commitToDelta: [] as number[], deltaToPaint: [] as number[], unpainted: 0 }));
  let lastPaint: bigint | null = null;
  let missing = false; // a steady event never painted (a restart-window miss reaches the UI by replay, reported apart)
  for (const e of o.emitted) {
    const j = join(e);
    const restart = inRestart(e);
    for (const w of byPhase) {
      if (e.t0 < w.from || e.t0 >= w.to) continue;
      if (!j) { w.unpainted++; continue; }
      (e.kind === 'hook' ? w.hook : w.file).push(ms(e.t0, j.paint));
      (e.kind === 'hook' ? w.hookToCommit : w.fileToCommit).push(ms(e.t0, j.commit));
      w.commitToDelta.push(ms(j.commit, j.delta)); w.deltaToPaint.push(ms(j.delta, j.paint));
    }
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
    } else {
      fileHops.toCommit.push(ms(e.t0, j.commit)); fileHops.commitToDelta.push(ms(j.commit, j.delta)); fileHops.deltaToPaint.push(ms(j.delta, j.paint));
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
    hops: { m1: { dispatch: p95(hops.dispatch), toCommit: p95(hops.toCommit), commitToDelta: p95(hops.commitToDelta), deltaToPaint: p95(hops.deltaToPaint) },
      m2: { toCommit: p95(fileHops.toCommit), commitToDelta: p95(fileHops.commitToDelta), deltaToPaint: p95(fileHops.deltaToPaint) } },
    unpainted, steadyMisses,
    drainMs: missing ? Number.POSITIVE_INFINITY : lastPaint === null ? 0 : Math.max(0, ms(o.loadEnd, lastPaint)),
    ingestLagMs: stats(ingestLag),
    // The writer's own queue: file syncs flush right after they enqueue (tail-adapter), so this is about 0 by design.
    queueAgeMs: stats(metrics.map((m) => m.writerQueueAgeMs ?? 0)),
    deltaResyncs: resyncs,
    phases: Object.fromEntries(byPhase.map((w) => [w.name, { seconds: Math.round(ms(w.from, w.to) / 1000), hooks: w.hook.length, files: w.file.length, unpainted: w.unpainted,
      m1: p95(w.hook), m2: p95(w.file), hookToCommit: p95(w.hookToCommit), fileToCommit: p95(w.fileToCommit), commitToDelta: p95(w.commitToDelta), deltaToPaint: p95(w.deltaToPaint) }])),
  };
}
