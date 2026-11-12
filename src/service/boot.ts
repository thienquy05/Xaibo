// Service boot (P1-T06; T08 rescan on start, D-P1-09): opens the store in the data dir, then in the background reads
// the login-shell env, detects agents, syncs profiles and starts one adapter per Claude or Codex profile (P2-T03).
// A read-only store (EC-45) is reported and skips ingest. P1-T12: commit and agent-status hooks for the renderer, and
// a manual executable path ("Set path…") that re-detects that agent. P3-T04: once profiles are synced, the hook socket
// listens and the spool replays, before the file backfill; a full disk is logged and its hook-only gap written on recovery.
import path from 'node:path';
import { OUTCOMES, REASONS, RULES, type AgentStatus, type Banner, type LiveStatus, type NotifyState } from '../shared/ipc.ts';
import type { Logger } from '../shared/log.ts';
import { AgyAdapter } from './adapters/agy/index.ts';
import { ClaudeAdapter } from './adapters/claude/index.ts';
import { CodexAdapter } from './adapters/codex/index.ts';
import type { Ingester } from './adapters/tail-adapter.ts';
import { detectAgent, manualPath, manualRoots, profileRoots, setManualPath, syncProfiles, type Detection, type Profile } from './catalog/detect.ts';
import { coverageBanners } from './status/coverage.ts';
import { createEngine, type StatusEngine } from './status/engine.ts';
import { fileObservations } from './status/feed.ts';
import { readLoginEnv, type LoginEnv } from './catalog/env.ts';
import { loadCatalog, type Catalog, type SessionKind } from './catalog/validate.ts';
import type { ModelEntry } from './usage/models.ts';
import { priceUsage } from './usage/cost.ts';
import { loadPrices, type Prices } from './usage/prices.ts';
import { errorCode } from '../shared/crash.ts';
import { openStore, type Store } from './store/db.ts';
import { startHooks, type Hooks } from './receivers/intake.ts';
import { Writer, type Batch } from './store/writer.ts';

export interface BootOptions {
  dataDir: string; home: string; shell?: string | undefined; catalog?: Catalog; intervalMs?: number; log?: Logger;
  /** Status clock (tests); Date.now by default. */
  now?: () => number;
  onCommit?: (batch: Batch) => void;
  onAgents?: (agents: AgentStatus[]) => void;
  /** P3-T11: a confirmed wait newly pending (agent display name, approved label, state). */
  onNotify?: (n: { agent: string; label: string | null; state: NotifyState }) => void;
}
export interface Service {
  store: Store;
  detections: Detection[];
  adapters: Ingester[];
  /** Settles when detection, profile sync and the initial backfill are done. */
  done: Promise<void>;
  /** Agent status for the renderer; null until detection has run. */
  agents(): AgentStatus[] | null;
  /** Catalog session kinds for list badges (P2-T04); empty if the catalog failed to load. */
  kinds(): SessionKind[];
  /** Model list for display names (P2-T08; with the owner override, P2-T09); empty if the bundled list failed to load. */
  models(): ModelEntry[];
  /** Current prices (P2-T09): accepted revision, or the last valid one with an error code; null if the bundled list is invalid. */
  prices(): Prices | null;
  /** Re-reads <dataDir>/models.override.json (the reloadPrices command). */
  reloadPrices(): Prices | null;
  /** P3-T10: live status of a session by agent and native id; null without evidence (or a read-only store). */
  status(agent: string, nativeSessionId: string, profileId?: string): LiveStatus | null;
  /** Session keys (`agent\0profile\0native id`) whose status changed with time alone since the last call (settle,
   *  heuristic wait, R1/R5); called on a timer. */
  ticking(): string[];
  /** Current coverage banners (hook-only gaps, disk full, hooks blocked, awaiting trust). */
  coverage(): Banner[];
  /** Validates and stores a manual executable path, then re-detects that agent; false if refused. */
  setPath(agent: string, file: string): Promise<boolean>;
  /** P3-T12: the machine sleeps from `at` (main's clock); the status engine excludes the gap from R1/R5. */
  suspend(at?: number): void;
  /** Resumes the status engine now, then reconciles every adapter at once (FR-02, bounded scans). */
  wake(): Promise<void>;
  stop(): void;
}

/** The turn-settle interval (PRD §6.2/§6.3, Q8 default; a setting with the Settings screen after Gate D, Q3-14). */
const SETTLE_MS = 4000;

export async function boot(o: BootOptions): Promise<Service> {
  const store = await openStore({ file: path.join(o.dataDir, 'xaibo.db'), backupDir: path.join(o.dataDir, 'backups') });
  const { db, readOnly } = store;
  let prices: Prices | null = null;
  // P2-T10/T14: after each commit price only usage rows above the high-water mark; after a price load, every pending row.
  let pricedUpTo = 0;
  const topUsage = readOnly ? undefined : db.prepare('SELECT coalesce(max(id), 0) AS id FROM usage');
  const price = (full = false) => {
    if (readOnly || !prices) return;
    try {
      const top = Number((topUsage!.get() as { id: number }).id);
      priceUsage(db, prices, full ? {} : { afterUsageId: pricedUpTo });
      pricedUpTo = top;
    } catch (e) { o.log?.log('pricing_failed', { error: errorCode(e) }); }
  };
  let hooks: Hooks | undefined;
  // P3-T10: the status engine (P3-T08/T09) over durable hook deliveries and live-window file records.
  const clock = o.now ?? Date.now;
  // P3-T11: the approved project label is always null until the Phase 5 overlay can store one (FR-10, Q3-6, D-P3-10).
  const onWait = (agent: string, _sid: string, state: NotifyState) =>
    o.onNotify?.({ agent: catalog?.agents.find((a) => a.id === agent)?.displayName ?? agent, label: null, state });
  const engine: StatusEngine | null = readOnly ? null : createEngine({ db, now: clock, settleMs: SETTLE_MS, log: (l) => o.log?.log(l.split(' ')[0]!), onWait });
  const read = (agent: string, sid: string): LiveStatus | null => {
    const s = engine?.status(agent, sid);
    if (!s) return null;
    const known = <T extends string>(xs: readonly T[], x: string | null): T | null => (x !== null && (xs as readonly string[]).includes(x) ? x as T : null);
    return { lifecycle: s.lifecycle, confidence: s.confidence, health: s.health, reason: known(REASONS, s.reason), outcome: known(OUTCOMES, s.outcome),
      findings: s.findings.filter((r): r is LiveStatus['findings'][number] => (RULES as readonly string[]).includes(r)) };
  };
  // Sessions whose status can change with time alone (busy: settle, R1/R5; heuristic waits), with the last status seen.
  const watched = new Map<string, { key: string; agent: string; sid: string; last: string }>();
  const watch = (agent: string, profileId: string, sid: string) => {
    watched.set(`${agent}\0${sid}`, { key: `${agent}\0${profileId}\0${sid}`, agent, sid, last: JSON.stringify(read(agent, sid)) });
  };
  const timeBound = (s: LiveStatus | null) => !!s && (s.lifecycle === 'busy' || s.confidence === 'heuristic');
  // Rows are read through here: a time-bound session not yet watched is watched now, so one reloaded from the store at
  // start (or after a restart) still settles, turns into a heuristic wait and gets R1/R5 without new evidence (review M3).
  const status = (agent: string, sid: string, profileId?: string): LiveStatus | null => {
    const s = read(agent, sid);
    if (profileId !== undefined && timeBound(s) && !watched.has(`${agent}\0${sid}`)) {
      watched.set(`${agent}\0${sid}`, { key: `${agent}\0${profileId}\0${sid}`, agent, sid, last: JSON.stringify(s) });
    }
    return s;
  };
  const ticking = () => {
    const out: string[] = [];
    for (const [k, w] of watched) {
      const s = read(w.agent, w.sid);
      const now = JSON.stringify(s);
      if (now !== w.last) { w.last = now; out.push(w.key); }
      if (!timeBound(s)) watched.delete(k); // new evidence or a row read re-adds it
    }
    return out;
  };
  const feed = (b: Batch) => {
    if (!engine) return;
    try {
      for (const x of fileObservations(b, clock())) { engine.ingest(x); if (x.source === 'file') watch(b.agent, b.profileId, x.sessionId); }
    } catch (e) { o.log?.log('status_feed_failed', { error: errorCode(e) }); }
  };
  const writer = new Writer(db, {
    onCommit: (b) => { price(); feed(b); o.onCommit?.(b); },
    onDiskFull: (full) => { o.log?.log('disk_full', { full }); if (!full) hooks?.intake.recovered(); },
  });
  const detections: Detection[] = [];
  const reloadPrices = () => {
    try {
      prices = loadPrices({ db: readOnly ? null : db, overridePath: path.join(o.dataDir, 'models.override.json'), previous: prices, ...(o.log ? { log: o.log } : {}) });
    } catch { o.log?.log('models_invalid', {}); }
    price(true);
    return prices;
  };
  reloadPrices();
  const adapters: Ingester[] = [];
  let profiles: Profile[] = [];
  let stopped = false;
  let catalog: Catalog | undefined;
  let env: LoginEnv = {};
  let detected = false;
  let markDetected = () => {};
  const detection = new Promise<void>((resolve) => { markDetected = resolve; });

  const agents = (): AgentStatus[] | null => (!detected ? null : detections.map((d) => ({
    agent: d.agent, name: catalog?.agents.find((a) => a.id === d.agent)?.displayName ?? d.agent, state: d.state,
    version: d.state === 'detected' ? d.version : null,
  })));
  const announce = () => { const a = agents(); if (a) o.onAgents?.(a); };

  const start = async () => {
    try {
      catalog = o.catalog ?? loadCatalog();
      env = await readLoginEnv({ shell: o.shell, ...(o.log ? { log: o.log } : {}) });
      // A read-only store may lack kv (failed first migration): detect without manual paths then.
      detections.push(...await Promise.all(catalog.agents.map((a) =>
        detectAgent(a, { env, home: o.home, manualPath: readOnly ? undefined : manualPath(db, a.id), ...(o.log ? { log: o.log } : {}) }))));
      o.log?.log('detect', Object.fromEntries(detections.map((d) => [d.agent, d.state === 'detected'])));
    } finally { // a failed detection (e.g. a bad catalog) announces an empty list, never "detecting" forever
      detected = true;
      markDetected();
      announce();
    }
    if (stopped || readOnly) return;
    const manual = Object.fromEntries(catalog.agents.map((a) => [a.id, manualRoots(db, a.id)]));
    profiles = syncProfiles(db, profileRoots(catalog, env, o.home, manual));
    hooks = await startHooks({
      dataDir: o.dataDir, db, writer, ...(o.log ? { log: o.log } : {}),
      publish: (e, durable) => {
        // only attributed deliveries (a synced profile of the same agent) drive status (security review L1)
        if (!durable || !engine || e.session_id === null || !profiles.some((p) => p.id === e.profile_key && p.agent === e.agent)) return;
        try { engine.ingest({ source: 'hook', envelope: e }); watch(e.agent, e.profile_key, e.session_id); } catch (err) { o.log?.log('status_feed_failed', { error: errorCode(err) }); }
      },
    });
    if (stopped) { void hooks.close(); return; }
    const Adapters: Record<string, typeof ClaudeAdapter | typeof CodexAdapter | typeof AgyAdapter> = { claude: ClaudeAdapter, codex: CodexAdapter, agy: AgyAdapter };
    for (const p of profiles.filter((x) => Adapters[x.agent])) {
      if (stopped) return;
      const a = new Adapters[p.agent]!({ db, writer, profileId: p.id, root: p.root, ...(o.intervalMs ? { intervalMs: o.intervalMs } : {}) });
      adapters.push(a);
      await a.start();
    }
    o.log?.log('backfill_done', { profiles: profiles.length });
  };

  const done = start();
  done.catch(() => undefined); // callers observe it; this only keeps an early failure from being unhandled meanwhile
  return {
    store, detections, adapters, done, agents,
    kinds: () => catalog?.sessionKinds ?? [],
    models: () => prices?.table.models ?? [],
    prices: () => prices,
    reloadPrices,
    status,
    ticking,
    coverage: () => {
      if (readOnly || !db.isOpen) return [];
      try { return coverageBanners({ db, dataDir: o.dataDir, profiles, diskFull: writer.diskFull, now: clock() }); } catch { return []; }
    },
    async setPath(agent, file) {
      await Promise.race([detection, done.catch(() => undefined)]); // detection, not the whole backfill
      const entry = catalog?.agents.find((a) => a.id === agent);
      const i = detections.findIndex((d) => d.agent === agent);
      if (stopped || readOnly || !entry || i < 0 || !(await setManualPath(db, agent, file))) return false;
      detections[i] = await detectAgent(entry, { env, home: o.home, manualPath: manualPath(db, agent), ...(o.log ? { log: o.log } : {}) });
      announce();
      return true;
    },
    suspend: (at) => engine?.suspend(at ?? clock()),
    wake: async () => { engine?.resume(clock()); await Promise.all(adapters.map((a) => a.wake())); },
    stop: () => {
      stopped = true;
      void hooks?.close();
      for (const a of adapters) a.stop();
      engine?.close();
      writer.flush();
      db.close();
    },
  };
}
