// Service boot (P1-T06; T08 rescan on start, D-P1-09): opens the store in the data dir, then in the background reads
// the login-shell env, detects agents, syncs profiles and starts one adapter per Claude or Codex profile (P2-T03).
// A read-only store (EC-45) is reported and skips ingest. P1-T12: commit and agent-status hooks for the renderer, and
// a manual executable path ("Set path…") that re-detects that agent. P3-T04: once profiles are synced, the hook socket
// listens and the spool replays, before the file backfill; a full disk is logged and its hook-only gap written on recovery.
import { statSync } from 'node:fs';
import path from 'node:path';
import { isActive, OUTCOMES, REASONS, RULES, type AgentStatus, type Banner, type ClearUsageResult, type PurgeResult, type ReimportResult, type RetentionSetting, type SaveRetentionResult, type LiveStatus, type NotifyState, type PriceCheck, type RescanResult, type ServiceMetrics } from '../shared/ipc.ts';
import type { Logger } from '../shared/log.ts';
import { AgyAdapter } from './adapters/agy/index.ts';
import { ClaudeAdapter } from './adapters/claude/index.ts';
import { CodexAdapter } from './adapters/codex/index.ts';
import type { Ingester } from './adapters/tail-adapter.ts';
import { detectAgent, manualPath, manualRoots, profileRoots, setManualPath, syncProfiles, type Detection, type ProbeGrant, type Profile } from './catalog/detect.ts';
import { coverageBanners } from './status/coverage.ts';
import { createEngine, type StatusEngine } from './status/engine.ts';
import { fileObservations } from './status/feed.ts';
import { readLoginEnv, type LoginEnv } from './catalog/env.ts';
import { loadCatalog, type Catalog, type SessionKind } from './catalog/validate.ts';
import { loadImports } from './catalog/import.ts';
import { setupAccess, type SetupAccess } from './catalog/setup-plans.ts';
import { deniedRootsFrom } from './config/bounds.ts';
import type { ModelEntry } from './usage/models.ts';
import { priceUsage } from './usage/cost.ts';
import { checkOverride, loadPrices, type Prices } from './usage/prices.ts';
import { errorCode } from '../shared/crash.ts';
import { approvedLabel } from './history/overlay.ts';
import { holdDeletes, resumePurges, spoolResumeDelay } from './history/purge.ts';
import { retentionScheduler, runRetention, type RetentionResult } from './retention/job.ts';
import { loadInstallSecret } from '../shared/log.ts';
import { openStore, type Store } from './store/db.ts';
import { startHooks, type Hooks } from './receivers/intake.ts';
import { Writer, type Batch } from './store/writer.ts';
import { loadScopeSalt } from './usage/snapshots.ts';
import { answerSignIn, mutationGate } from './usage/sign-in-state.ts';
import type { SignInReplyCode, SignInRequest, SignInView } from '../shared/ipc.ts';
import { applyClear, clearWatermarks, keysInWorker } from './usage/clear.ts';
import { purgeLimit, purgeManual, reimportKey, rerunner, saveRetention } from './history/tools.ts';

export interface BootOptions {
  dataDir: string; home: string; shell?: string | undefined; catalog?: Catalog; intervalMs?: number; log?: Logger;
  /** XAIBO-PROD-566 (P6-T07 part 2): disposable roots an approved imported profile root must stay inside (bounds.ts
   *  writable()). None by default, so production drops every imported root until P6-T12. */
  allowedRoots?: string[];
  /** XAIBO-PROD-590 (P6-T08 slice A): least time between rescans (monotonic ms; default 5 s). Tests only lower it. */
  rescanCooldownMs?: number;
  /** Status clock (tests); Date.now by default. */
  now?: () => number;
  onCommit?: (batch: Batch) => void;
  onAgents?: (agents: AgentStatus[]) => void;
  /** P3-T11: a confirmed wait newly pending (agent display name, approved label, state). */
  onNotify?: (n: { agent: string; label: string | null; state: NotifyState }) => void;
  /** P3-T16e: watched sessions whose status changed at a settle deadline (the service also re-reads on its tick). */
  onTick?: (keys: string[]) => void;
  /** XAIBO-PROD-445: a pricing job that ran in more than one slice, or had a rerun queued, finished: commits it overlapped
   *  went out before their usage was priced, so open rows need one re-read. */
  onPriced?: () => void;
  /** XAIBO-PROD-542 G5b2-2: sessions, Trash or usage history were removed (a retention run, or a manual purge's session
   *  hidden): open windows resync and the monthly ledger recomputes. */
  onRemoved?: () => void;
  /** P5-T09: wait after the backfill before the first retention run (default 10 min); then daily. */
  retentionDelayMs?: number;
}
export interface Service {
  store: Store;
  detections: Detection[];
  adapters: Ingester[];
  /** Settles when detection, profile sync and the initial backfill are done. */
  done: Promise<void>;
  /** Agent status for the renderer; null until detection has run. */
  agents(): AgentStatus[] | null;
  /** XAIBO-PROD-558 (P6-T03 part 1b): the synced profiles, null until profile sync ran (never on a read-only store). */
  profiles(): Profile[] | null;
  /** XAIBO-PROD-589 (P6-T09a slice B): a report agent's declared setup and access, read fresh from the import store per call;
   *  null before the catalog loaded or when the agent declares none. */
  setupAccess(agent: string): SetupAccess | null;
  /** The login-shell environment read at start; null until read or when it could not be read (no PATH). */
  loginEnv(): LoginEnv | null;
  /** Catalog session kinds for list badges (P2-T04); empty if the catalog failed to load. */
  kinds(): SessionKind[];
  /** XAIBO-PROD-560 (P6-T03 part 2b): the loaded catalog for Connect route selection; null if it failed to load. */
  catalog(): Catalog | null;
  /** Model list for display names (P2-T08; with the owner override, P2-T09); empty if the bundled list failed to load. */
  models(): ModelEntry[];
  /** Current prices (P2-T09): accepted revision, or the last valid one with an error code; null if the bundled list is invalid. */
  prices(): Prices | null;
  /** Re-reads <dataDir>/models.override.json (the reloadPrices command). */
  reloadPrices(): Prices | null;
  /** XAIBO-PROD-568 (P6-T11 Validate): the override as Reload would read it; writes and switches nothing. */
  checkPrices(): PriceCheck;
  /** P3-T10: live status of a session by agent, native id and profile (§5.5); null without evidence (or a read-only store). */
  status(agent: string, nativeSessionId: string, profileId: string): LiveStatus | null;
  /** Session keys (`agent\0profile\0native id`) whose status changed with time alone since the last call (settle,
   *  heuristic wait, R1/R5); called on a timer. */
  ticking(): string[];
  /** Current coverage banners (hook-only gaps, disk full, hooks blocked, awaiting trust). */
  coverage(): Banner[];
  /** P4-T10c2: content-free metrics; the `*Ms` peaks reset on each call (the service entry adds deltaResyncs). */
  metrics(): Omit<ServiceMetrics, 'deltaResyncs'>;
  /** Validates and stores a manual executable path, then re-detects that agent; false if refused. */
  setPath(agent: string, file: string): Promise<boolean>;
  /** XAIBO-PROD-590 (P6-T08 slice A; EC-79, FR-01): re-detects agents and re-syncs profiles without a restart. */
  rescan(): Promise<RescanResult>;
  /** P3-T12: the machine sleeps from `at` (main's clock); the status engine excludes the gap from R1/R5. */
  suspend(at?: number): void;
  /** Resumes the status engine now, then reconciles every adapter at once (FR-02, bounded scans). */
  wake(): Promise<void>;
  /** P5-T09: one retention run now (joins a run in progress); null for a read-only or stopped store. */
  retention(): Promise<RetentionResult | null>;
  /** P5-T16 (FR-52, Q-5.8): Clear usage history in one writer transaction; read-only when the store refuses writes. */
  clearUsage(): Promise<ClearUsageResult>;
  /** XAIBO-PROD-527 (P5-T18 part 1): a confirmed manual purge (capped per minute), Re-import by opaque key (sets Keep,
   *  then reconciles), and the retention setting saved through the writer. */
  purge(session: number): Promise<PurgeResult>;
  reimport(key: string): ReimportResult;
  saveRetention(value: RetentionSetting): SaveRetentionResult;
  /** XAIBO-PROD-572 (P6-T01a slice 3): the owner's sign-in declaration for a synced profile (read, set, clear, account change). */
  signIn(req: SignInRequest): { code: SignInReplyCode; view: SignInView | null; changed: boolean };
  stop(): void;
}


/** The turn-settle interval (PRD §6.2/§6.3, Q8 default; a setting with the Settings screen after Gate D, Q3-14). */
const SETTLE_MS = 4000;
// XAIBO-PROD-565/566/567 (P6-T07): bundled entries probe; imported ones run only their granted executables (part 3).
const BUNDLED = { origin: 'bundled' } as const;
// XAIBO-PROD-590: natively ingested agents (out of start, so a rescan can start an adapter for a new profile)
const ADAPTERS: Record<string, typeof ClaudeAdapter | typeof CodexAdapter | typeof AgyAdapter> = { claude: ClaudeAdapter, codex: CodexAdapter, agy: AgyAdapter };
const RESCAN_MS = 5_000;
/** P5-T09: the first retention run waits this long after the backfill, off readiness and behind start-up work. */
const RETENTION_DELAY_MS = 10 * 60_000;
/** Gate 5 (perf probes): XAIBO_RETENTION_DELAY_MS overrides that wait, only under XAIBO_PERF_TRACE=1 (test only) and only
 *  as a positive integer of milliseconds up to 2^31 - 1; anything else keeps the default. */
export function retentionDelayFromEnv(env: Record<string, string | undefined>): number | undefined {
  const v = env.XAIBO_RETENTION_DELAY_MS;
  if (env.XAIBO_PERF_TRACE !== '1' || v === undefined || !/^[1-9]\d*$/.test(v)) return undefined;
  const n = Number(v);
  return n <= 2_147_483_647 ? n : undefined; // review L: setTimeout clamps a larger delay to 1 ms
}
/** XAIBO-PROD-553 (D-P5-22 diagnostic): XAIBO_TEMP_STORE=file puts SQLite temp storage on disk, only under
 *  XAIBO_PERF_TRACE=1 (test only); anything else keeps the shipped MEMORY default. */
export const tempStoreFromEnv = (env: Record<string, string | undefined>): 'file' | undefined =>
  (env.XAIBO_PERF_TRACE === '1' && env.XAIBO_TEMP_STORE === 'file' ? 'file' : undefined);

// P4-T10c2 parse lag: commit time minus a file's last write (its mtime at sync), for files written within LIVE_LAG_MS;
// older files are history import and a future mtime is clock skew, so neither is lag. ponytail: mtime has the file
// system's resolution and is the write time only for append-only transcripts; a backfill of files written while the
// service was down counts as lag (review L3).
const LIVE_LAG_MS = 10 * 60_000;
export function parseLagOf(now: number, mtime: number): number | null {
  const lag = now - mtime;
  return mtime > 0 && lag >= 0 && lag <= LIVE_LAG_MS ? Math.round(lag) : null;
}

export async function boot(o: BootOptions): Promise<Service> {
  const temp = tempStoreFromEnv(process.env);
  const store = await openStore({ file: path.join(o.dataDir, 'xaibo.db'), backupDir: path.join(o.dataDir, 'backups'), ...(temp ? { tempStore: temp } : {}) });
  const { db, readOnly } = store;
  let prices: Prices | null = null;
  // P2-T10/T14: after each commit price only usage rows above the high-water mark; after a price load, every pending row.
  let pricedUpTo = 0;
  const topUsage = readOnly ? undefined : db.prepare('SELECT coalesce(max(id), 0) AS id FROM usage');
  // P4-T12a (EC-100): pricing runs in slices of PRICE_SLICE rows, the first now (a small store prices at once) and the
  // rest on later event-loop turns, so a large reprice (an owner price added for a common model) never holds live
  // dispatch (one pass of 100,000 rows held the loop ~1 s). One job at a time: a request during a job reruns after it
  // from the lowest cursor asked for. ponytail: a fixed slice, ~20 ms at the measured ~10 us/row; give each slice a time
  // budget if rows get costlier.
  const PRICE_SLICE = 2000;
  let pricing = false;
  let rerunFrom: number | null = null;
  // XAIBO-PROD-455 (G4a-3): notify = an explicit price reload, which always ends with one onPriced (a quiet mounted view
  // still shows the old cost otherwise); commit-driven and boot pricing notify only for a sliced job or a rerun.
  const priceFrom = (from: number, notify: boolean) => {
    pricing = true;
    let slices = 0;
    let top = from;
    try { top = Number((topUsage!.get() as { id: number }).id); } catch { /* the slice below logs the store error */ }
    const step = (cursor: number) => {
      if (!db.isOpen || !prices) { pricing = false; return; } // stop() closes the store (the first slice runs before `stopped` exists)
      let next: number | null = null;
      slices++;
      try {
        const r = priceUsage(db, prices, { afterUsageId: cursor, limit: PRICE_SLICE });
        if (r.more) next = r.lastId;
        else pricedUpTo = Math.max(pricedUpTo, top, r.lastId);
      } catch (e) { o.log?.log('pricing_failed', { error: errorCode(e) }); }
      if (next !== null) { const at = next; setImmediate(() => step(at)); return; }
      pricing = false;
      const resync = notify || slices > 1 || rerunFrom !== null; // a rerun (an explicit reload during a job too) is covered here
      if (rerunFrom !== null) { const f = rerunFrom; rerunFrom = null; priceFrom(f, false); } // a one-slice rerun is done before the resync
      if (resync) o.onPriced?.();
    };
    step(from);
  };
  const price = (full = false, notify = false) => {
    if (readOnly || !prices) return;
    const from = full ? 0 : pricedUpTo;
    if (pricing) { rerunFrom = Math.min(rerunFrom ?? from, from); return; }
    priceFrom(from, notify);
  };
  let hooks: Hooks | undefined;
  // P3-T10: the status engine (P3-T08/T09) over durable hook deliveries and live-window file records.
  const clock = o.now ?? Date.now;
  // P3-T11: the approved project label (FR-10, D-P3-10): the session's overlay project name (XAIBO-PROD-504), else null.
  const onWait = (agent: string, profile: string, sid: string, state: NotifyState) =>
    o.onNotify?.({ agent: catalog?.agents.find((a) => a.id === agent)?.displayName ?? agent, label: approvedLabel(db, agent, profile, sid), state });
  const engine: StatusEngine | null = readOnly ? null : createEngine({ db, now: clock, settleMs: SETTLE_MS, log: (l) => o.log?.log(l.split(' ')[0]!), onWait });
  const read = (agent: string, profile: string, sid: string): LiveStatus | null => {
    const s = engine?.status(agent, profile, sid);
    if (!s) return null;
    const known = <T extends string>(xs: readonly T[], x: string | null): T | null => (x !== null && (xs as readonly string[]).includes(x) ? x as T : null);
    return { lifecycle: s.lifecycle, confidence: s.confidence, health: s.health, reason: known(REASONS, s.reason), outcome: known(OUTCOMES, s.outcome),
      findings: s.findings.filter((r): r is LiveStatus['findings'][number] => (RULES as readonly string[]).includes(r)), since: s.since };
  };
  // Sessions whose status can change with time alone (busy: settle, R1/R5; heuristic waits), with the last status seen.
  // Keyed `agent\0profile\0native id`, the session identity (§5.5).
  type Watched = { agent: string; profile: string; sid: string };
  const watched = new Map<string, Watched & { last: string }>();
  const watch = (agent: string, profile: string, sid: string) => {
    watched.set(`${agent}\0${profile}\0${sid}`, { agent, profile, sid, last: JSON.stringify(read(agent, profile, sid)) });
    arm({ agent, profile, sid });
  };
  // P3-T16e: one timer at the earliest settle deadline among watched sessions, so a settle lands at its deadline and
  // not up to one status tick (250 ms) later; the tick still covers the other time-based changes. A newly watched
  // session only moves the timer earlier (review M1: a rescan per watch was O(n²), 5,000 rows ~2-4 s); the tick and the
  // timer itself rescan, so a deadline that moved later is dropped there.
  let due: { at: number; timer: NodeJS.Timeout } | undefined;
  const arm = (only?: Watched) => {
    if (!o.onTick || stopped) return;
    let next = Infinity;
    if (only) {
      next = engine?.status(only.agent, only.profile, only.sid)?.settleAt ?? Infinity;
      if (next >= (due?.at ?? Infinity)) return;
    } else for (const w of watched.values()) next = Math.min(next, engine?.status(w.agent, w.profile, w.sid)?.settleAt ?? Infinity);
    if (due?.at === next) return;
    if (due) clearTimeout(due.timer);
    due = undefined;
    if (next === Infinity) return;
    const timer = setTimeout(() => {
      due = undefined;
      const keys = ticking();
      if (keys.length) o.onTick?.(keys);
    }, Math.max(0, next - clock() + 1));
    timer.unref();
    due = { at: next, timer };
  };
  const timeBound = (s: LiveStatus | null) => !!s && (s.lifecycle === 'busy' || s.confidence === 'heuristic');
  // Rows are read through here: a time-bound session not yet watched is watched now, so one reloaded from the store at
  // start (or after a restart) still settles, turns into a heuristic wait and gets R1/R5 without new evidence (review M3).
  const status = (agent: string, sid: string, profile: string): LiveStatus | null => {
    const s = read(agent, profile, sid);
    const k = `${agent}\0${profile}\0${sid}`;
    if (timeBound(s) && !watched.has(k)) {
      watched.set(k, { agent, profile, sid, last: JSON.stringify(s) });
      arm({ agent, profile, sid });
    }
    return s;
  };
  const ticking = () => {
    const out: string[] = [];
    for (const [k, w] of watched) {
      const s = read(w.agent, w.profile, w.sid);
      const now = JSON.stringify(s);
      if (now !== w.last) { w.last = now; out.push(k); }
      if (!timeBound(s)) watched.delete(k); // new evidence or a row read re-adds it
    }
    arm();
    return out;
  };
  const feed = (b: Batch) => {
    if (!engine) return;
    try {
      for (const x of fileObservations(b, clock())) { engine.ingest(x); if (x.source === 'file') watch(b.agent, b.profileId, x.sessionId); }
    } catch (e) { o.log?.log('status_feed_failed', { error: errorCode(e) }); }
  };
  // P4-T10c2: the peak parse lag (parseLagOf) over committed batches that carry records; the writer's queue age uses its
  // own monotonic clock (review L2).
  let parseLag = 0;
  const writer = new Writer(db, {
    onCommit: (b) => {
      const lag = b.file && b.events.length ? parseLagOf(clock(), b.file.mtime) : null;
      if (lag !== null) parseLag = Math.max(parseLag, lag);
      price(); feed(b); o.onCommit?.(b);
    },
    // PROD-549: on recovery the remembered gaps are written and the spool is replayed now, not at the backed-off interval
    onDiskFull: (full) => { o.log?.log('disk_full', { full }); if (!full) { hooks?.intake.recovered(); hooks?.replayNow(); } },
  });
  const detections: Detection[] = [];
  const reloadPrices = (explicit = true) => {
    try {
      prices = loadPrices({ db: readOnly ? null : db, overridePath: path.join(o.dataDir, 'models.override.json'), previous: prices, ...(o.log ? { log: o.log } : {}) });
    } catch { o.log?.log('models_invalid', {}); }
    price(true, explicit);
    return prices;
  };
  reloadPrices(false);
  const adapters: Ingester[] = [];
  let profiles: Profile[] = [];
  let stopped = false;
  let catalog: Catalog | undefined;
  let bundled: Catalog | undefined;
  let imported = new Map<string, Record<string, string>>();
  let env: LoginEnv = {};
  let synced = false; // XAIBO-PROD-558: Connect answers `starting` until profiles are synced
  const signInGate = mutationGate(); // XAIBO-PROD-572 review M1
  let detected = false;
  let markDetected = () => {};
  const detection = new Promise<void>((resolve) => { markDetected = resolve; });

  const agents = (): AgentStatus[] | null => (!detected ? null : detections.map((d) => ({
    agent: d.agent, name: catalog?.agents.find((a) => a.id === d.agent)?.displayName ?? d.agent, state: d.state,
    version: d.state === 'detected' ? d.version : null,
  })));
  const announce = () => { const a = agents(); if (a) o.onAgents?.(a); };

  // XAIBO-PROD-590 (P6-T08 slice A; EC-79, FR-01; D-P6-19, design .handoff/p6-t08-design.md with the fresh review): shared by
  // startup and rescan. Bundled entries probe (manual path, login PATH, known locations); imported ones only through the grants
  // loaded for this scan (P6-T07 part 3).
  const detectAll = (grants: Map<string, ProbeGrant[]>, imp = imported) => Promise.all(catalog!.agents.map((a) => detectAgent(a, { env, home: o.home,
    manualPath: readOnly || imp.has(a.id) ? undefined : manualPath(db, a.id), access: imp.has(a.id) ? { origin: 'imported', grants: grants.get(a.id) ?? [] } : BUNDLED, ...(o.log ? { log: o.log } : {}) })));
  const manualOf = () => Object.fromEntries(catalog!.agents.map((a) => [a.id, manualRoots(db, a.id)]));
  let salt: Buffer | null = null;
  const adapted = new Set<string>(); // profile ids with an adapter
  /** A new adapter for a profile of a natively ingested agent (watch it, then backfill). */
  const adapterFor = (p: Profile) => {
    // P6-T01a slice 4 (review M6): sign-in rules from the bundled catalog only, never the merged imports (none shipped)
    const signInRules = p.agent === 'codex' ? bundled?.agents.find((x) => x.id === 'codex')?.signInRules ?? [] : [];
    const a = new ADAPTERS[p.agent]!({ db, writer, profileId: p.id, root: p.root, accountSalt: p.agent === 'codex' ? salt : null, signInRules,
      ...(o.intervalMs ? { intervalMs: o.intervalMs } : {}) });
    adapters.push(a);
    adapted.add(p.id);
    return a;
  };
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = chain.then(fn); chain = r.catch(() => undefined); return r; };
  let settled = false, started = false, scan: Promise<RescanResult> | null = null, lastScan = -Infinity, bg: Promise<void> = Promise.resolve();
  /** One scan at a time (callers join it), at most one per cooldown, never while starting, read-only or stopped. The catalog
   *  and login environment stay as loaded at startup (review M1/M2; ponytail: a PATH or env change needs a restart, and an
   *  import added at runtime arrives with P6-T08a); grants and approved roots are reloaded for every scan (P3-3). */
  const rescan = (): Promise<RescanResult> => {
    const no = (code: Exclude<RescanResult, { status: 'ready' }>['code']) => Promise.resolve<RescanResult>({ status: 'refused', code });
    if (readOnly) return no('read-only');
    if (stopped || !db.isOpen) return no('unavailable');
    if (!settled) return no('starting');
    if (!started) return no('unavailable'); // code review M1: a failed startup has no hooks, salt or scheduler to scan onto
    if (!catalog || !bundled) return no('unavailable');
    if (scan) return scan;
    const now = performance.now(), cooldown = o.rescanCooldownMs ?? RESCAN_MS;
    if (now - lastScan < cooldown) return Promise.resolve({ status: 'refused', code: 'rate-limited', retryAfterMs: Math.min(60_000, Math.ceil(cooldown - (now - lastScan))) });
    lastScan = now;
    scan = serial(async (): Promise<RescanResult> => {
      if (stopped || !db.isOpen) return { status: 'refused', code: 'unavailable' }; // code review L2: stopped while queued
      const loaded = loadImports(o.dataDir, bundled!, { home: o.home, allowed: o.allowedRoots ?? [], denied: deniedRootsFrom(env) });
      // code review H1: what is imported comes from the startup catalog, never from this load: a store that reads as corrupt
      // now (mode, size, EMFILE) leaves its entries imported with no roots and no grants, never bundled
      const fresh = new Map(catalog!.agents.filter((a) => !bundled!.agents.some((b) => b.id === a.id)).map((a) => [a.id, loaded.imported.get(a.id) ?? {}]));
      const next = await detectAll(loaded.grants, fresh);
      if (stopped) return { status: 'refused', code: 'unavailable' };
      imported = fresh;
      detections.splice(0, detections.length, ...next); // review M4: index.ts and Connect read this array live
      profiles = syncProfiles(db, profileRoots(catalog!, env, o.home, manualOf(), imported)); // stable ids; hook status reads it
      announce();
      // ponytail (code review L3): a profile gone since startup keeps its adapter until restart (ingest goes on; status drops it)
      for (const p of profiles.filter((x) => ADAPTERS[x.agent] && !adapted.has(x.id))) {
        if (stopped) break;
        const a = adapterFor(p);
        await a.watch();
        if (stopped) break; // code review L1
        // the new profile's backfill runs after the reply, one at a time (code review L4; P3-T16e), never after a stop
        bg = bg.then(() => (stopped ? undefined : a.backfill())).catch((e: unknown) => o.log?.log('rescan_backfill_failed', { error: errorCode(e) }));
      }
      o.log?.log('rescan', { agents: next.length, profiles: profiles.length });
      return { status: 'ready' };
    }).catch((e: unknown): RescanResult => { o.log?.log('rescan_failed', { error: errorCode(e) }); return { status: 'refused', code: 'failed' }; })
      .finally(() => { scan = null; });
    return scan;
  };

  const start = async () => {
    try {
      catalog = bundled = o.catalog ?? loadCatalog();
      env = await readLoginEnv({ shell: o.shell, ...(o.log ? { log: o.log } : {}) });
      // XAIBO-PROD-566 (P6-T07 part 2): private imports merged onto the base catalog (read-only load, never throws; a store
      // issue is logged as codes only). Merged onto an injected catalog too (deviation from review P2-6), so tests keep
      // their temp-home locations and no installed agent is probed; no store leaves the catalog as it was.
      // ponytail: the status engine keeps the bundled hook maps; imported hookMappings apply once generic setup can install
      // their hooks (P6-T08/T09). Report events do not use the maps.
      const loaded = loadImports(o.dataDir, bundled, { home: o.home, allowed: o.allowedRoots ?? [], denied: deniedRootsFrom(env) });
      if (loaded.issues.length) o.log?.log('catalog_imports', { codes: [...new Set(loaded.issues.map((i) => i.code))].join(',') });
      catalog = loaded.catalog;
      imported = loaded.imported;
      const grants = loaded.grants; // reloaded per scan, never cached (review P3-3)
      // A read-only store may lack kv (failed first migration): detect without manual paths then.
      detections.push(...await detectAll(grants));
      o.log?.log('detect', Object.fromEntries(detections.map((d) => [d.agent, d.state === 'detected'])));
    } finally { // a failed detection (e.g. a bad catalog) announces an empty list, never "detecting" forever
      detected = true;
      markDetected();
      announce();
    }
    if (stopped || readOnly) return;
    profiles = syncProfiles(db, profileRoots(catalog, env, o.home, manualOf(), imported)); // imported ids: approved roots only (P2-1)
    synced = true;
    hooks = await startHooks({
      dataDir: o.dataDir, db, writer, ...(o.log ? { log: o.log } : {}),
      publish: (e, durable) => {
        // only attributed deliveries (a synced profile of the same agent) drive status (security review L1)
        if (!durable || !engine || e.session_id === null || !profiles.some((p) => p.id === e.profile_key && p.agent === e.agent)) return;
        try { engine.ingest({ source: 'hook', envelope: e }); watch(e.agent, e.profile_key, e.session_id); } catch (err) { o.log?.log('status_feed_failed', { error: errorCode(err) }); }
      },
      // Report deliveries arrive durable only when attributed to a profile of the registration's agent (P3-T13b/b2).
      // P6-T07 part 2 (P2-5): not bundled, so an imported id keeps the attribution an unknown id had before imports
      customAgent: (a) => !bundled?.agents.some((x) => x.id === a),
      publishReport: (e, durable) => {
        if (!durable || !engine || e.session_id === null) return;
        try { engine.ingest({ source: 'report', envelope: e }); } catch (err) { o.log?.log('status_feed_failed', { error: errorCode(err) }); }
      },
    });
    if (stopped) { void hooks.close(); return; }
    // P5-T07 (review H3): row and file work a purge committed but did not finish (a crash, a stop, a busy backup) is
    // redone off readiness (review M: ingest never waits for its row batches); G5a-2: again shortly after each UTC
    // midnight (today's spool file a purge still owes)
    void resume();
    // P3-T15: the account-marker salt (created on first boot; review L1); null = no marker, Codex scopes stay unverified
    salt = loadScopeSalt(o.dataDir, o.log);
    // P3-T16e: every adapter watches before any backfills, so appends to one agent's files are seen while another
    // agent's backfill runs; backfills stay one at a time.
    for (const p of profiles.filter((x) => ADAPTERS[x.agent])) {
      if (stopped) return;
      await adapterFor(p).watch();
    }
    for (const a of adapters) {
      if (stopped) return;
      await a.backfill();
    }
    o.log?.log('backfill_done', { profiles: profiles.length });
    if (!stopped) scheduler.start();
    started = !stopped; // XAIBO-PROD-590 code review M1
  };

  // P5-T09 (FR-12): retention after the backfill (review H1: a session continued while Xaibo was off has its new records
  // first), then daily; a run whose wall clock ran more than 1 h ahead of the monotonic clock is skipped (review H3).
  let retentionRun: Promise<RetentionResult | null> | null = null;
  let clearing: Promise<ClearUsageResult> | null = null; // XAIBO-PROD-526: Clear usage history in progress
  const takePurge = purgeLimit(() => performance.now()); // XAIBO-PROD-527 (D-P5-07); review L2: a monotonic clock; one per service
  // XAIBO-PROD-527 (design review L6): fixed codes and result enums only in the log. XAIBO-PROD-550 (D-P5-15 item 9): the
  // owner's history actions answer read-only / failed (stopped, store closed) at once; anything that throws, synchronously
  // (the secret's read) or as a rejection, is logged as `failEvent` and answers failed (review L3); every result is logged.
  // Synchronous work answers synchronously (index.ts posts the value; review L2 of PROD-550). A refused or throwing call
  // answers a plain value even for async work, so an async caller wraps it (purge is async: diff review H1).
  type Refused = 'read-only' | 'failed';
  function guarded<R extends string>(event: string, failEvent: string, fn: () => Promise<R>): Promise<R | Refused> | Refused;
  function guarded<R extends string>(event: string, failEvent: string, fn: () => R): R | Refused;
  function guarded<R extends string>(event: string, failEvent: string, fn: () => R | Promise<R>): R | Refused | Promise<R | Refused> {
    const failed = (e: unknown): Refused => { o.log?.log(failEvent, { error: errorCode(e) }); return 'failed'; };
    const done = <X extends string>(result: X): X => { o.log?.log(event, { result }); return result; };
    let r: R | Promise<R> | Refused;
    try { r = readOnly ? 'read-only' : stopped || !db.isOpen ? 'failed' : fn(); } catch (e) { r = failed(e); }
    return r instanceof Promise ? r.catch(failed).then(done) : done(r);
  }
  // re-review M1: after a Re-import every adapter backfills against the reset checkpoints, one adapter and one sweep at a
  // time (as the boot backfill, P3-T16e); Re-imports during a sweep merge into one more. ponytail: every adapter, not only
  // the re-imported session's profile; narrow it if many profiles make sweeps slow.
  const resync = rerunner(async () => {
    for (const a of adapters) {
      if (stopped) return;
      try { await a.backfill(); } catch (e) { o.log?.log('reimport_sync_failed', { error: errorCode(e) }); }
    }
  });
  const logTo = (event: string, fields?: Record<string, string | number>) => o.log?.log(event, fields);
  // review M: a purge stops between batches once the service stops (the store closes right after); resume finishes it
  // G5Rr1-2: a retention marker cleared by native activity seen during its purge: the adapters re-read its files
  const onReimport = () => { void resync(); };
  const files = () => ({ dataDir: o.dataDir, backupDir: path.join(o.dataDir, 'backups'), secret: loadInstallSecret(o.dataDir), now: clock(), chunks: hooks?.chunks(),
    stopped: () => stopped, log: logTo, onReimport });
  let nightly: NodeJS.Timeout | undefined;
  const resume = async () => {
    try {
      // the secret: a purge stopped while settling finishes it; round 2 review: an unreadable secret stops only that (a
      // purge still settling stays owed), row phases and file work still resume
      let secret: Buffer | undefined;
      try { secret = loadInstallSecret(o.dataDir); } catch { secret = undefined; }
      const resumed = await resumePurges(writer, { dataDir: o.dataDir, backupDir: path.join(o.dataDir, 'backups'), secret, now: clock(), chunks: hooks?.chunks(),
        stopped: () => stopped, log: logTo, onReimport });
      if (resumed) o.log?.log('purge_resumed', { count: resumed });
    } catch (e) { o.log?.log('purge_resume_failed', { error: errorCode(e) }); }
    if (!stopped) nightly = setTimeout(() => { void resume(); }, spoolResumeDelay(clock())).unref();
  };
  const retention = (): Promise<RetentionResult | null> => {
    if (readOnly || stopped || !db.isOpen) return Promise.resolve(null);
    // diff review M1: everything, the secret's read included, inside the chain: a failure is a logged rejection
    retentionRun ??= Promise.resolve().then(() => runRetention(writer, db, { ...files(),
      active: (agent, profile, sid) => isActive(engine?.status(agent, profile, sid)?.lifecycle ?? null) }))
      .then((r) => { if (r.sessions || r.trash || r.quota) o.onRemoved?.(); return r; }) // G5b2-2
      .catch((e: unknown) => { o.log?.log('retention_failed', { error: errorCode(e) }); return null; })
      .finally(() => { retentionRun = null; });
    return retentionRun;
  };
  const scheduler = retentionScheduler({ run: () => { if (!stopped) void retention(); }, delayMs: o.retentionDelayMs ?? RETENTION_DELAY_MS,
    wall: Date.now, mono: () => performance.now(), setTimer: (fn, ms) => setTimeout(fn, ms).unref(), clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    log: logTo });

  const done = start();
  void done.then(() => { settled = true; }, () => { settled = true; }); // XAIBO-PROD-590: rescan waits for startup (review M3)
  done.catch(() => undefined); // callers observe it; this only keeps an early failure from being unhandled meanwhile
  return {
    store, detections, adapters, done, agents,
    profiles: () => (synced ? profiles : null),
    setupAccess: (agent) => (bundled ? setupAccess(o.dataDir, bundled, agent, { home: o.home, allowed: o.allowedRoots ?? [], denied: deniedRootsFrom(env) }) : null),
    loginEnv: () => (env.PATH ? env : null),
    kinds: () => catalog?.sessionKinds ?? [],
    catalog: () => catalog ?? null,
    models: () => prices?.table.models ?? [],
    prices: () => prices,
    reloadPrices: () => reloadPrices(),
    checkPrices: () => checkOverride(path.join(o.dataDir, 'models.override.json')),
    status,
    ticking,
    coverage: () => {
      if (readOnly || !db.isOpen) return [];
      try { return coverageBanners({ db, dataDir: o.dataDir, profiles, diskFull: writer.diskFull, now: clock() }); } catch { return []; }
    },
    metrics: () => {
      const parseLagMs = parseLag;
      parseLag = 0;
      let walBytes = 0;
      // The WAL file's size: without journal_size_limit it never shrinks after a checkpoint, so this is its high-water
      // mark, not what waits to be checkpointed (review L4).
      try { walBytes = statSync(path.join(o.dataDir, 'xaibo.db-wal')).size; } catch { /* no WAL yet */ }
      return { writerQueueAgeMs: writer.takeQueueAgeMs(), parseLagMs, walBytes, watchHandles: adapters.reduce((n, a) => n + a.watched(), 0),
        statusSessions: engine?.cached() ?? 0, diskFull: writer.diskFull ? 1 : 0 };
    },
    async setPath(agent, file) {
      await Promise.race([detection, done.catch(() => undefined)]); // detection, not the whole backfill
      return serial(async () => { // XAIBO-PROD-590 (review L1): never interleaved with a rescan
        const entry = catalog?.agents.find((a) => a.id === agent);
        const i = detections.findIndex((d) => d.agent === agent);
        // P6-T07 part 2 (P2-2): an imported id never gets a manual path (no stat, no kv write) until the part 3 grant
        if (stopped || readOnly || !entry || i < 0 || imported.has(agent) || !(await setManualPath(db, agent, file))) return false;
        detections[i] = await detectAgent(entry, { env, home: o.home, manualPath: manualPath(db, agent), access: BUNDLED, ...(o.log ? { log: o.log } : {}) });
        announce();
        return true;
      });
    },
    rescan,
    suspend: (at) => engine?.suspend(at ?? clock()),
    wake: async () => { scheduler.wake(); engine?.resume(clock()); await Promise.all(adapters.map((a) => a.wake())); }, // sleep is no clock jump
    retention,
    // XAIBO-PROD-526 review L2: overlapping calls (a second window, a retry) share the run in progress.
    // ponytail: a stop mid-clear does not terminate the worker; its result is dropped (the store is closed).
    clearUsage: () => clearing ??= (async (): Promise<ClearUsageResult> => {
      if (readOnly) return 'read-only';
      if (stopped || !db.isOpen) return 'failed';
      // XAIBO-PROD-542 G5b1-3: what was stored when the request arrived; row deletions wait until the clear is applied,
      // so nothing stored meanwhile takes a watermarked rowid
      const release = holdDeletes(writer);
      try { // the scan in a worker, then one writer transaction; review L5: the event only, no count
        const watermarks = clearWatermarks(db);
        const marks = await keysInWorker({ file: path.join(o.dataDir, 'xaibo.db'), secret: loadInstallSecret(o.dataDir), watermarks });
        if (stopped || !db.isOpen) return 'failed';
        writer.transact((t) => applyClear(t, marks, clock()));
        o.log?.log('usage_cleared', {});
        return 'cleared';
      }
      catch (e) { o.log?.log('clear_usage_failed', { error: errorCode(e) }); return 'failed'; }
      finally { release(); }
    })().finally(() => { clearing = null; }),
    // XAIBO-PROD-527: fixed codes and result enums only in the log (design review L6)
    // review L3: anything that throws (the secret's read included) still answers failed
    purge: async (session) => guarded('purge_manual', 'purge_failed', // design review M6: resync once hidden
      () => purgeManual(writer, session, { ...files(), limit: takePurge, hidden: () => o.onRemoved?.() })),
    reimport: (key) => {
      const result = guarded('reimport', 'reimport_failed', () => reimportKey(writer, db, key, files()));
      // review H2: backfill syncs against the stored checkpoints (reset by the Re-import); a scan only sees changed files
      if (result === 'ok') resync();
      return result;
    },
    saveRetention: (value) => guarded('retention_set', 'retention_set_failed', () => saveRetention(writer, value)),
    signIn: (req) => answerSignIn({ db, writer, readOnly: readOnly || stopped, profile: (id) => (synced ? profiles.some((p) => p.id === id) : null), allow: signInGate }, req, Date.now()),
    stop: () => {
      stopped = true;
      if (due) clearTimeout(due.timer);
      scheduler.stop();
      clearTimeout(nightly);
      void hooks?.close();
      for (const a of adapters) a.stop();
      engine?.close();
      writer.flush();
      db.close();
    },
  };
}
