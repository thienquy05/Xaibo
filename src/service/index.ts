// Service process (utilityProcess, P1-T06): boots the store and ingest (boot.ts) in the data dir main passes in
// XAIBO_DATA_DIR, posts `ready` once the store is open (health "Running"; ingest continues in the background), and
// answers main's commands. Logs go to their own dir so two processes never rotate one file. P1-T12: each brokered
// port gets agent status on connect, answers listSessions after boot, and receives coalesced session deltas.
import type { MessagePortMain } from 'electron';
import { homedir } from 'node:os';
import path from 'node:path';
import { errorCode, installCrashPolicy } from '../shared/crash.ts';
import { accept, IPC_VERSION, parsePortRequest, parseServiceCommand } from '../shared/ipc.ts';
import type { Banner, PortMessage, RetentionSetting, ServiceEvent, StorageReport } from '../shared/ipc.ts';
import { appendQuiet, createLogger, loadInstallSecret, type Logger } from '../shared/log.ts';
import { answer, answerCost, answerFiles, answerLiveSet, answerMarkers, answerSession, answerSlice, answerSubagents, answerTools, answerTranscript, answerUsage, answerUsageHistory, coalesce, createHub, sessionsByKey, type LiveOf } from './api.ts';
import { boot, type Service } from './boot.ts';
import { applyOverlay, listFolders, listHistory, listProjects } from './history/overlay.ts';
import { mapGroups } from './history/map.ts';
import type { Batch } from './store/writer.ts';
import { traceableIds } from './trace-ids.ts';
import { answerMonthly, MonthlyCache } from './usage/ledger.ts';
import { answerSearch, retentionState, suppressedPage } from './history/tools.ts';
import { StorageMeter } from './storage/meter.ts';

// P3-T10: 50 ms keeps one push per window while leaving most of M1's 250 ms hook-to-paint budget; the tick re-reads
// sessions whose status changes with time alone (settle within interval + 250 ms, M1), coverage is re-read slowly.
const DELTA_MS = 50;
const TICK_MS = 250;
const COVERAGE_MS = 5000;
const parent = process.parentPort;
const hub = createHub<MessagePortMain>();
let svc: Service | undefined;
let ledger: MonthlyCache | undefined; // P5-T17a: the monthly ledger cache, created before boot
let meter: StorageMeter | undefined; // XAIBO-PROD-527: the storage meter (Settings), created before boot
let secret: Buffer | undefined; // the per-install secret (suppressed-session keys)
const STORAGE_MIN_MS = 60_000;
let resolveBooted: (s: Service) => void = () => {};
const booted = new Promise<Service>((resolve) => { resolveBooted = resolve; });
const live: LiveOf = (agent, sid, profileId) => svc?.status(agent, sid, profileId) ?? null;

// Perf trace (XAIBO_PERF_TRACE=1, test only, IDs only): hrtime at commit per delivery/record id, and per pushed delta its
// id and the ids it carries; the renderer acks a delta's paint to main, which stamps the same monotonic clock.
let trace: string | null = null;
const pendingIds = new Map<string, string[]>();
let deltaSeq = 0;
const stamp = (line: object) => { if (trace) appendQuiet(trace, `${JSON.stringify({ ...line, t: process.hrtime.bigint().toString() })}\n`); };

// P4-T10c1: a window with more changed sessions than this sends a resync instead of rows, so one flush is one bounded
// query and message. ponytail: a fixed bound; raise it if the P4-T11 T2 run shows resyncs under normal load.
const DELTA_KEYS_MAX = 200;
let resyncs = 0; // P4-T10c2 metric: delta windows replaced by a resync since start
const broadcast = (m: PortMessage) => hub.broadcast(m);
const changed = coalesce((keys) => {
  if (!keys) { // review L1: a trace tells an overflow (no paint ack for that window's ids) from a lost delta
    pendingIds.clear(); stamp({ ev: 'resync' }); resyncs++;
    if (hub.anyLive()) hub.sessions({ v: IPC_VERSION, type: 'resync' });
    return;
  }
  const ids = trace ? keys.flatMap((k) => { const x = pendingIds.get(k) ?? []; pendingIds.delete(k); return x; }) : []; // cleared on every flush (review L2)
  if (!svc?.store.db.isOpen || !hub.anyLive()) return; // hidden windows resync by cursor when shown (P4-T02)
  const rows = sessionsByKey(svc.store.db, keys.map((k) => { const [agent, profileId, nativeSessionId] = k.split('\0') as [string, string, string]; return { agent, profileId, nativeSessionId }; }), svc.kinds(), svc.models(), live);
  if (!rows.length) return;
  if (!trace) { hub.sessions({ v: IPC_VERSION, type: 'sessions', rows }); return; }
  const delta = ++deltaSeq;
  stamp({ ev: 'delta', delta, ids });
  hub.sessions({ v: IPC_VERSION, type: 'sessions', rows, delta });
}, DELTA_MS, setTimeout, DELTA_KEYS_MAX);

let banners: Banner[] = [];
const coverage = () => {
  const now = svc?.coverage() ?? [];
  if (JSON.stringify(now) === JSON.stringify(banners)) return;
  banners = now;
  broadcast({ v: IPC_VERSION, type: 'coverage', banners });
};

const request = accept(parsePortRequest, (req, port: MessagePortMain) => {
  if (req.type === 'live') { hub.setLive(port, req.on); return; }
  void booted.then((s) => {
    // A closed store still answers (empty: each answer catches its store errors), so no renderer request waits forever.
    const db = s.store.db;
    switch (req.type) {
      case 'liveSet': port.postMessage(db.isOpen ? answerLiveSet(db, req, Date.now(), s.kinds(), s.models(), live) : { v: IPC_VERSION, type: 'liveSet', id: req.id, rows: [], more: false }); break;
      case 'usage': port.postMessage(answerUsage(db, req, homedir())); break;
      case 'usageHistory': port.postMessage(answerUsageHistory(db, req)); break;
      case 'session': port.postMessage(answerSession(db, req, s.kinds(), s.models(), live)); break;
      case 'transcript': port.postMessage(answerTranscript(db, req)); break;
      case 'slice': port.postMessage(answerSlice(db, req)); break;
      case 'tools': port.postMessage(answerTools(db, req, live)); break;
      case 'subagents': port.postMessage(answerSubagents(db, req, s.models(), live)); break;
      case 'files': port.postMessage(answerFiles(db, req)); break;
      case 'markers': port.postMessage(answerMarkers(db, req, s.models())); break;
      case 'cost': port.postMessage(answerCost(db, req, s.models())); break;
      // P5-T17a: computed in a worker and cached (ledger.ts); failed when the store cannot answer
      case 'monthly': void answerMonthly(ledger!, req).then((m) => port.postMessage(m)); break;
      // XAIBO-PROD-527 (P5-T18 part 1): history tools and retention/storage settings
      case 'search': {
        let page: Omit<Extract<PortMessage, { type: 'search' }>, 'v' | 'type' | 'id'> = { hits: [], next: null, failed: true };
        try { if (db.isOpen) page = answerSearch(db, req, s.kinds(), s.models(), live); } catch { /* failed */ }
        port.postMessage({ v: IPC_VERSION, type: 'search', id: req.id, ...page } satisfies PortMessage); break;
      }
      case 'purge': {
        const result = s.purge(req.session);
        if (result === 'purged') { ledger?.invalidate(); if (hub.anyLive()) hub.sessions({ v: IPC_VERSION, type: 'resync' }); } // design review M6
        port.postMessage({ v: IPC_VERSION, type: 'purge', id: req.id, result } satisfies PortMessage); break;
      }
      case 'suppressed': {
        let page: Omit<Extract<PortMessage, { type: 'suppressed' }>, 'v' | 'type' | 'id'> = { rows: [], next: null, failed: true };
        try { if (db.isOpen) page = suppressedPage(db, secret!, homedir(), req.cursor, req.limit); } catch { /* failed */ }
        port.postMessage({ v: IPC_VERSION, type: 'suppressed', id: req.id, ...page } satisfies PortMessage); break;
      }
      case 'reimport': port.postMessage({ v: IPC_VERSION, type: 'reimport', id: req.id, result: s.reimport(req.key) } satisfies PortMessage); break;
      case 'retention': {
        let state: { setting: RetentionSetting | null; lastRunAt: number | null } = { setting: null, lastRunAt: null };
        try { if (db.isOpen) state = retentionState(db); } catch { /* unreadable */ }
        port.postMessage({ v: IPC_VERSION, type: 'retention', id: req.id, ...state } satisfies PortMessage); break;
      }
      case 'setRetention': port.postMessage({ v: IPC_VERSION, type: 'setRetention', id: req.id, result: s.saveRetention(req.value) } satisfies PortMessage); break;
      case 'storage': { // measured in the meter's worker on request; at most once a minute (design review M4)
        const last = meter!.latest(), now = Date.now();
        const fresh = last !== null && last.measuredAt <= now && now - last.measuredAt < STORAGE_MIN_MS;
        const reply = (report: StorageReport | null, failed?: true) =>
          port.postMessage({ v: IPC_VERSION, type: 'storage', id: req.id, report, ...(failed ? { failed } : {}) } satisfies PortMessage);
        if (!req.refresh || fresh) reply(last);
        else meter!.refresh().then((r) => reply(r), () => reply(meter!.latest(), true));
        break;
      }
      // P5-T16: the ledger recomputes on the next request (never from a run read before the clear); XAIBO-PROD-526: async
      case 'clearUsage': void s.clearUsage().then((result) => {
        if (result === 'cleared') ledger?.invalidate();
        port.postMessage({ v: IPC_VERSION, type: 'clearUsage', id: req.id, result } satisfies PortMessage);
      }); break;
      // XAIBO-PROD-504 (P5-T01): history overlay; a store that cannot answer gives an empty page or the store error
      case 'history': {
        let page: Omit<Extract<PortMessage, { type: 'history' }>, 'v' | 'type' | 'id'> = { rows: [], next: null };
        try { if (db.isOpen) page = listHistory(db, req.filter, req.cursor, req.limit, s.kinds(), s.models(), live); } catch { /* empty page */ }
        port.postMessage({ v: IPC_VERSION, type: 'history', id: req.id, ...page } satisfies PortMessage); break;
      }
      case 'projects': {
        let page: { projects: { id: number; name: string }[]; next: number | null } = { projects: [], next: null };
        try { if (db.isOpen) page = listProjects(db, req.cursor, req.limit); } catch { /* empty page */ }
        port.postMessage({ v: IPC_VERSION, type: 'projects', id: req.id, ...page } satisfies PortMessage); break;
      }
      case 'folders': {
        let page: { folders: { id: number; name: string }[]; next: number | null } = { folders: [], next: null };
        try { if (db.isOpen) page = listFolders(db, req.project, req.cursor, req.limit); } catch { /* empty page */ }
        port.postMessage({ v: IPC_VERSION, type: 'folders', id: req.id, ...page } satisfies PortMessage); break;
      }
      case 'mapGroups': { // P5-T01c: a store that cannot answer says failed (the renderer offers Retry), never an empty page
        let page: Omit<Extract<PortMessage, { type: 'mapGroups' }>, 'v' | 'type' | 'id'> = { groups: [], next: null, failed: true };
        try { if (db.isOpen) page = mapGroups(db, req.parent, req.cursor, req.limit, live); } catch { /* failed */ }
        port.postMessage({ v: IPC_VERSION, type: 'mapGroups', id: req.id, ...page } satisfies PortMessage); break;
      }
      case 'overlay': port.postMessage({ v: IPC_VERSION, type: 'overlay', id: req.id,
        result: applyOverlay(db, req.op, { readOnly: s.store.readOnly || !db.isOpen, now: Date.now() }) } satisfies PortMessage); break;
      default: port.postMessage(db.isOpen ? answer(db, req, s.kinds(), s.models(), live) : { v: IPC_VERSION, type: 'page', id: req.id, rows: [], next: null });
    }
  });
});

function connect(port: MessagePortMain) {
  hub.add(port);
  port.on('message', (e) => request(e.data, port));
  port.on('close', () => hub.remove(port));
  port.start();
  port.postMessage({ v: IPC_VERSION, type: 'agents', agents: svc?.agents() ?? null } satisfies PortMessage);
  port.postMessage({ v: IPC_VERSION, type: 'coverage', banners } satisfies PortMessage);
}

function committed(b: Batch) {
  ledger?.invalidate();
  const keys = new Set(b.sessions.map((s) => `${b.agent}\0${b.profileId}\0${s.nativeSessionId}`));
  for (const k of keys) changed(k);
  if (!trace) return;
  // IDs only: record ids come from untrusted files, so only derived id shapes are traced (review L2; P3-T16a)
  const ids = traceableIds(b.delivery ? [b.delivery.deliveryId] : b.events.map((e) => e.nativeId));
  stamp({ ev: 'commit', ids });
  for (const k of keys) pendingIds.set(k, [...(pendingIds.get(k) ?? []), ...ids]);
}

const command = accept(parseServiceCommand, (m, transferred: MessagePortMain[]) => {
  if (m.type === 'quit') { svc?.stop(); process.exit(0); }
  // Power events wait for boot, in arrival order, so a sleep during startup still reaches the engine (P3-T12 review).
  else if (m.type === 'wake') void booted.then((s) => s.wake());
  else if (m.type === 'suspend') { const { at } = m; void booted.then((s) => s.suspend(at)); }
  else if (m.type === 'reloadPrices') void booted.then((s) => s.reloadPrices());
  else if (m.type === 'port') transferred.forEach(connect);
  else if (m.type === 'setPath') { const { agent, path: file } = m; void booted.then((s) => s.setPath(agent, file)); }
});
parent.on('message', (e) => command(e.data, e.ports));

async function main(dataDir: string, log: Logger) {
  secret = loadInstallSecret(dataDir);
  ledger = new MonthlyCache({ file: path.join(dataDir, 'xaibo.db'), secret, home: homedir(), log: (e, f) => log.log(e, f) });
  meter = new StorageMeter(dataDir);
  svc = await boot({
    dataDir, home: homedir(), shell: process.env.SHELL, log,
    onCommit: committed,
    onAgents: (agents) => broadcast({ v: IPC_VERSION, type: 'agents', agents }),
    onNotify: (n) => parent.postMessage({ v: IPC_VERSION, type: 'notify', ...n } satisfies ServiceEvent), // P3-T11
    onTick: (keys) => { for (const k of keys) changed(k); }, // P3-T16e: a settle at its deadline, not the next tick
    onPriced: () => { ledger?.invalidate(); if (hub.anyLive()) hub.sessions({ v: IPC_VERSION, type: 'resync' }); }, // XAIBO-PROD-445: one per sliced job
  });
  resolveBooted(svc);
  setInterval(() => { for (const k of svc?.ticking() ?? []) changed(k); }, TICK_MS);
  setInterval(coverage, COVERAGE_MS);
  // P4-T10c2: content-free metrics for main's diagnostics bundle, at the coverage cadence (peaks cover the interval).
  setInterval(() => { // a failing metric is logged, never an uncaught exception (the crash policy would restart us; review L5)
    try {
      const metrics = { ...svc!.metrics(), deltaResyncs: resyncs };
      stamp({ ev: 'metrics', ...metrics }); // P4-T11: the live-load run reads queue age and resyncs from the perf trace
      parent.postMessage({ v: IPC_VERSION, type: 'metrics', metrics } satisfies ServiceEvent);
    }
    catch (e) { log.log('metrics_failed', { error: errorCode(e) }); }
  }, COVERAGE_MS);
  svc.done.then(coverage, coverage); // profiles are synced by then; a spool replay still running is caught by the interval
  const ready: ServiceEvent = { v: IPC_VERSION, type: 'ready', readOnly: svc.store.reason ?? null };
  parent.postMessage(ready);
  svc.done.catch((e: unknown) => log.log('ingest_failed', { error: errorCode(e) }));
}

const dataDir = process.env.XAIBO_DATA_DIR;
if (!dataDir || !path.isAbsolute(dataDir)) process.exit(1);
else {
  const log = createLogger({ dir: path.join(dataDir, 'logs', 'service'), secret: loadInstallSecret(dataDir) });
  if (process.env.XAIBO_PERF_TRACE === '1') trace = path.join(dataDir, 'logs', 'perf-trace-service.jsonl');
  installCrashPolicy(process, log, { exitOnUncaught: () => process.exit(1) }); // P1-T13; the supervisor restarts us
  main(dataDir, log).catch((e: unknown) => { log.log('boot_failed', { error: errorCode(e) }); process.exit(1); });
}
