// Replay harness (P3-T07, PRD §6.6/§6.7, M8). Loads `test/fixtures/synthetic/replay/<agent>/<version>/<case>/` and replays
// each fixture on a virtual clock under the canonical order plus 10 interleavings. The engine contract below is what the
// P3-T08 status engine implements (`src/service/status/engine.ts` exports `createEngine: EngineFactory`); the B1/B2
// baselines (replay-baselines.ts) implement it too. Observations are raw: hook/report envelopes as the intake publishes
// them, native file lines as read, OTel records as received; mapping them is the engine's job.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Envelope } from '../../src/shared/hook-protocol.ts';
import { openStore } from '../../src/service/store/db.ts';

export const LIFECYCLES = ['idle', 'busy', 'waiting-for-permission', 'needs-input', 'error', 'ended', 'unknown'] as const;
export const CONFIDENCES = ['confirmed', 'inferred', 'heuristic'] as const;
export const HEALTHS = ['connected', 'stale', 'detached'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];
export type Confidence = (typeof CONFIDENCES)[number];
export type Health = (typeof HEALTHS)[number];

export interface SessionStatus {
  lifecycle: Lifecycle; confidence: Confidence; health: Health;
  /** Displayed reason on the lifecycle: 'Finishing…', 'Background work', 'Probably waiting', or null. */
  reason: string | null;
  /** Outcome of the last turn or request: 'interrupted', 'denied', 'declined', 'cancelled', or null. */
  outcome: string | null;
  /** Active finding rule ids (R1..R5), sorted. */
  findings: string[];
  toolCalls: number; turns: number;
  /** Normalized usage totals (§5.5); null when the session has none. */
  usage: Record<string, number> | null;
  model: string | null; effort: string | null;
}

export type Observation =
  | { source: 'hook' | 'report'; envelope: Envelope }
  | { source: 'file'; agent: string; sessionId: string; file: string; offset: number; line: string; receivedTs: number }
  | { source: 'otel'; agent: string; sessionId: string; record: unknown; receivedTs: number };

export interface StatusEngine {
  ingest(o: Observation): void;
  /** Moves the virtual clock to `now` (never backwards) and fires due timers (turn settle, heuristics, rules). */
  advance(now: number): void;
  suspend(now: number): void;
  resume(now: number): void;
  status(agent: string, sessionId: string): SessionStatus | null;
  /** Releases timers; the db stays open. A new engine on the same db must continue from what this one persisted. */
  close(): void;
}
export interface EngineOptions { db: DatabaseSync; now: () => number; settleMs: number; log: (line: string) => void }
export type EngineFactory = (o: EngineOptions) => StatusEngine;

export const SETTLE_MS = 4000;
/** Past the last action the clock runs this far before the final state is read (> settle, > the 5 s heuristic). */
export const DRAIN_MS = 10_000;
export const SLEEP_GAP_MS = 2 * 3600_000;

export interface Expect {
  lifecycle: Lifecycle; confidence: Confidence; reason: string | null;
  outcome?: string | null; health?: Health; findings?: string[];
  /** Session the expectation is about; defaults to the fixture's first session. */
  session?: string;
}
export interface Stream { source: 'hook' | 'report' | 'file' | 'otel'; file: string; session?: string }
export type ObsStep = { src: string; line: number; at: number; expect: Expect };
export type Step = ObsStep | { tick: true; at: number; expect?: Expect } | { suspend: true; at: number } | { resume: true; at: number; expect?: Expect };
export interface Final { lifecycle: Lifecycle; confidence?: Confidence; toolCalls?: number; turns?: number; model?: string | null; effort?: string | null }
export interface Fixture {
  id: string; dir: string; agent: string; version: string;
  /** Not replayable: the native behaviour is unverified (owner disposition, §3.4). */
  unavailable?: string;
  /** Mapping not yet built: agy and report run once P3-T13 exists. */
  needs?: string;
  streams: Record<string, Stream>;
  lines: Record<string, string[]>;
  sessions: string[];
  steps: Step[];
  final: Record<string, Final>;
  hooksMissing?: Record<string, Final>;
  canary?: string;
  notVerified?: string[];
}

export const REPLAY_ROOT = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'replay');

export function loadFixture(dir: string, id: string): Fixture {
  const x = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  const [agent, version] = id.split('/');
  const streams: Record<string, Stream> = x.streams ?? {};
  const lines = Object.fromEntries(Object.entries(streams).map(([k, s]) => [k, readFileSync(join(dir, s.file), 'utf8').trimEnd().split('\n')]));
  return { id, dir, agent: agent!, version: version!, streams, lines, sessions: x.sessions ?? [], steps: x.steps ?? [], final: x.final ?? {},
    ...(x.unavailable ? { unavailable: x.unavailable } : {}), ...(x.needs ? { needs: x.needs } : {}),
    ...(x.hooksMissing ? { hooksMissing: x.hooksMissing } : {}), ...(x.canary ? { canary: x.canary } : {}),
    ...(x.notVerified ? { notVerified: x.notVerified } : {}) };
}

/** Every `<agent>/<version>/<case>` with an expected.json, sorted. */
export function loadAll(root = REPLAY_ROOT): Fixture[] {
  const ls = (p: string) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  return ls(root).flatMap((a) => ls(join(root, a)).flatMap((v) => ls(join(root, a, v))
    .filter((c) => existsSync(join(root, a, v, c, 'expected.json')))
    .map((c) => loadFixture(join(root, a, v, c), `${a}/${v}/${c}`))));
}

export const isObs = (s: Step | undefined): s is ObsStep => s !== undefined && 'src' in s;

/** The observation of one stream line, delivered at `receivedTs` (a redelivered hook keeps its forwarder receive time). */
export function observation(fx: Fixture, step: ObsStep, receivedTs: number): Observation {
  const s = fx.streams[step.src]!;
  const line = fx.lines[step.src]![step.line]!;
  if (s.source === 'hook' || s.source === 'report') {
    let payload: Record<string, unknown> | null = null;
    try { payload = JSON.parse(line); } catch { /* malformed delivery */ }
    const p = payload ?? {};
    const str = (...ks: string[]) => { for (const k of ks) if (typeof p[k] === 'string') return p[k] as string; return null; };
    // A report event carries its own delivery_id, stable across retries (§5.10); a hook delivery's id is per line.
    const id = s.source === 'report' ? str('delivery_id') : null;
    return { source: s.source, envelope: {
      v: 1, delivery_id: id ?? `replay-${step.src}-${step.line}`, agent: fx.agent, profile_key: 'replay-profile',
      event: str('hook_event_name', 'hookEventName', 'event') ?? 'unknown', session_id: str('session_id', 'conversationId'),
      cwd: str('cwd'), received_ts: receivedTs, payload, ...(payload ? {} : { malformed: true }),
    } };
  }
  if (s.source === 'otel') return { source: 'otel', agent: fx.agent, sessionId: s.session!, record: JSON.parse(line), receivedTs };
  const offset = fx.lines[step.src]!.slice(0, step.line).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  return { source: 'file', agent: fx.agent, sessionId: s.session!, file: s.file, offset, line, receivedTs };
}

// ---- Schedules ----------------------------------------------------------------------------------------------------

export type Action =
  | { kind: 'obs'; step: number; at: number; receivedTs: number }
  | { kind: 'tick' | 'suspend' | 'resume'; step: number; at: number }
  | { kind: 'restart'; at: number };
export interface Schedule {
  name: string;
  actions: Action[];
  /** Final lifecycle, ToolCall count and usage totals must equal the canonical replay's (§6.6 order invariance). */
  invariant: boolean;
}
export const INTERLEAVINGS = ['hooks-first', 'files-first', 'hooks-missing', 'otel-late', 'duplicated-hooks', 'duplicate-spool-replay',
  'rapid-distinct', 'delayed-earlier', 'restart', 'sleep-gap'] as const;

/** mulberry32: a small deterministic PRNG; `int(n)` is in [0, n). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n) };
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/** Arrival times for re-ordered observations: never earlier than the step's time, strictly increasing. */
function arrive(order: number[], fx: Fixture): Extract<Action, { kind: 'obs' }>[] {
  let t = -Infinity;
  return order.map((i) => {
    t = Math.max(t + 1, fx.steps[i]!.at);
    return { kind: 'obs', step: i, at: t, receivedTs: t };
  });
}

export function canonical(fx: Fixture): Schedule {
  const actions = fx.steps.map((s, i): Action => (isObs(s) ? { kind: 'obs', step: i, at: s.at, receivedTs: s.at }
    : { kind: 'tick' in s ? 'tick' : 'suspend' in s ? 'suspend' : 'resume', step: i, at: s.at }));
  return { name: 'canonical', actions, invariant: true };
}

/** The canonical schedule plus the 10 interleavings, deterministic for (fixture id, seed). */
export function schedules(fx: Fixture, seed = 1): Schedule[] {
  const r = rng(seed ^ hash(fx.id));
  const obs = fx.steps.flatMap((s, i) => (isObs(s) ? [i] : []));
  const src = (i: number) => fx.streams[(fx.steps[i] as ObsStep).src]!.source;
  const hookish = (i: number) => src(i) === 'hook' || src(i) === 'report';
  const base = arrive(obs, fx);
  const end = base.at(-1)?.at ?? 0;
  const out: Schedule[] = [canonical(fx)];
  const add = (name: string, actions: Action[], invariant = true) => out.push({ name, actions, invariant });

  add('hooks-first', arrive([...obs.filter(hookish), ...obs.filter((i) => !hookish(i))], fx));
  add('files-first', arrive([...obs.filter((i) => !hookish(i)), ...obs.filter(hookish)], fx));
  add('hooks-missing', arrive(obs.filter((i) => !hookish(i)), fx), false);
  add('otel-late', arrive([...obs.filter((i) => src(i) !== 'otel'), ...obs.filter((i) => src(i) === 'otel')], fx));
  add('duplicated-hooks', base.flatMap((a) => (hookish(a.step) ? [a, { ...a, at: a.at + 0.5 }] : [a])));
  // Each spool redelivery lands on a later second than the last, keeping the original forwarder receive time.
  add('duplicate-spool-replay', [...base, ...base.filter((a) => hookish(a.step))
    .map((a, k) => ({ ...a, at: (Math.floor(end / 1000) + 1 + k) * 1000 + 1 }))]);
  const t0 = base[0]?.at ?? 0;
  add('rapid-distinct', obs.map((i, k) => ({ kind: 'obs' as const, step: i, at: t0 + k, receivedTs: t0 + k })));
  {
    const order = [...obs];
    const cands = order.map((i, k) => [i, k] as const).filter(([i, k]) => k > 0 && k < order.length - 1 && hookish(i));
    if (cands.length) {
      const [i, k] = cands[r.int(cands.length)]!;
      const by = 1 + r.int(Math.min(3, order.length - 1 - k));
      order.splice(k, 1);
      order.splice(k + by, 0, i);
    }
    // The delayed observation keeps its original receive time, so only source order can place it.
    add('delayed-earlier', arrive(order, fx).map((a) => ({ ...a, receivedTs: fx.steps[a.step]!.at })));
  }
  {
    const k = base.length > 1 ? 1 + r.int(base.length - 1) : 0;
    add('restart', [...base.slice(0, k), { kind: 'restart', at: base[k - 1]?.at ?? 0 }, ...base.slice(k)]);
  }
  {
    const k = base.length > 1 ? 1 + r.int(base.length - 1) : 0;
    const t = (base[k - 1]?.at ?? 0) + 1;
    const gap = SLEEP_GAP_MS + 1;
    add('sleep-gap', [...base.slice(0, k), { kind: 'suspend', step: -1, at: t }, { kind: 'resume', step: -1, at: t + SLEEP_GAP_MS },
      ...base.slice(k).map((a) => ({ ...a, at: a.at + gap, receivedTs: a.receivedTs + gap }))]);
  }
  return out;
}

// ---- Replay -------------------------------------------------------------------------------------------------------

export interface ReplayResult {
  /** Status after each step that has an expectation, by step index (meaningful for the canonical schedule). */
  perStep: Map<number, SessionStatus | null>;
  final: Record<string, SessionStatus | null>;
  logs: string[];
}

export async function replay(factory: EngineFactory, fx: Fixture, sched: Schedule): Promise<ReplayResult> {
  const dir = mkdtempSync(join(tmpdir(), 'xaibo-replay-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'backups') });
  let now = sched.actions[0]?.at ?? 0;
  const logs: string[] = [];
  const make = () => factory({ db, now: () => now, settleMs: SETTLE_MS, log: (l) => logs.push(l) });
  let engine = make();
  const perStep = new Map<number, SessionStatus | null>();
  const record = (i: number) => {
    const e = (fx.steps[i] as { expect?: Expect } | undefined)?.expect;
    if (e) perStep.set(i, engine.status(fx.agent, e.session ?? fx.sessions[0]!));
  };
  for (const a of sched.actions) {
    now = Math.max(now, a.at);
    engine.advance(now);
    if (a.kind === 'obs') { engine.ingest(observation(fx, fx.steps[a.step] as ObsStep, a.receivedTs)); record(a.step); }
    else if (a.kind === 'tick') record(a.step);
    else if (a.kind === 'suspend') engine.suspend(now);
    else if (a.kind === 'resume') { engine.resume(now); record(a.step); }
    else { engine.close(); engine = make(); engine.advance(now); }
  }
  now += DRAIN_MS;
  engine.advance(now);
  const final = Object.fromEntries(fx.sessions.map((s) => [s, engine.status(fx.agent, s)]));
  engine.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  return { perStep, final, logs };
}
