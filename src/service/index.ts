// Service process (utilityProcess, P1-T06): boots the store and ingest (boot.ts) in the data dir main passes in
// XAIBO_DATA_DIR, posts `ready` once the store is open (health "Running"; ingest continues in the background), and
// answers main's commands. Logs go to their own dir so two processes never rotate one file. P1-T12: each brokered
// port gets agent status on connect, answers listSessions after boot, and receives coalesced session deltas.
import type { MessagePortMain } from 'electron';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { errorCode, installCrashPolicy } from '../shared/crash.ts';
import { accept, IPC_VERSION, parsePortRequest, parseServiceCommand } from '../shared/ipc.ts';
import type { Banner, PortMessage, ServiceEvent, StorageReport, IntegrationDetailResult, IntegrationPageResult, GrantConfirmResult, GrantOfferResult, ApplyConfirmResult, ApplyOfferResult, RevokeResult } from '../shared/ipc.ts';
import { appendQuiet, createLogger, loadInstallSecret, type Logger } from '../shared/log.ts';
import { answer, answerCost, answerFiles, answerLiveSet, answerMarkers, answerSession, answerSlice, answerSubagents, answerTools, answerTranscript, answerUsage, answerUsageHistory, coalesce, createHub, sessionsByKey, type LiveOf } from './api.ts';
import { allowedRootsFromEnv, boot, retentionDelayFromEnv, type Service } from './boot.ts';
import { applyOverlay, listFolders, listHistory, listProjects, resyncAfter } from './history/overlay.ts';
import { mapGroups } from './history/map.ts';
import type { Batch } from './store/writer.ts';
import { traceableIds } from './trace-ids.ts';
import { answerMonthly, MonthlyCache } from './usage/ledger.ts';
import { priceView } from './usage/prices.ts';
import { answerHistoryRow, answerSearch, retentionState, suppressedPage } from './history/tools.ts';
import { StorageMeter } from './storage/meter.ts';
import { takePerf } from './perf-counters.ts';
import { afterDispatch, answerApply, answerIntegrations, connectContext, type Connect } from './integrations-ipc.ts';
import { answerIntegrationDetail, answerIntegrationPage, pageEvidence } from './integrations/state.ts';
import { createConnect } from './integrations/connect.ts';
import { compatibility } from './catalog/capabilities.ts';

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

/** Sessions left or came back (purge, retention, Trash/restore): the ledger recomputes and open windows resync. */
const removed = () => { ledger?.invalidate(); if (hub.anyLive()) hub.sessions({ v: IPC_VERSION, type: 'resync' }); };

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
    // XAIBO-PROD-550 (D-P5-15 item 3): a history answer that a closed or failing store cannot give says its fallback
    // (failed where it has one: the renderer keeps its rows and offers Retry), never an empty page. The page spreads
    // first, so it can never replace v, type or id (review L4).
    type Body<T extends PortMessage['type']> = Omit<Extract<PortMessage, { type: T }>, 'v' | 'type' | 'id'>;
    const reply = <T extends PortMessage['type']>(type: T, fallback: Body<T>, fn: () => Body<T>) => {
      let page = fallback;
      try { if (db.isOpen) page = fn(); } catch { /* the fallback */ }
      port.postMessage({ ...page, v: IPC_VERSION, type, id: req.id } as PortMessage);
    };
    switch (req.type) {
      case 'liveSet': port.postMessage(db.isOpen ? answerLiveSet(db, req, Date.now(), s.kinds(), s.models(), live) : { v: IPC_VERSION, type: 'liveSet', id: req.id, rows: [], more: false }); break;
      case 'usage': port.postMessage(answerUsage(db, req, homedir())); break;
      case 'usageHistory': port.postMessage(answerUsageHistory(db, req)); break;
      // XAIBO-PROD-594: the VS Code extension and Desktop app lines (US-8) for the agent's detected version
      case 'session': port.postMessage(answerSession(db, req, s.kinds(), s.models(), live, undefined, (agent) => {
        const d = s.detections.find((x) => x.agent === agent);
        return compatibility(s.catalog(), agent, d?.state === 'detected' ? d.version : null).filter((l) => /^(VS Code extension|Desktop app):/.test(l));
      })); break;
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
      case 'search': reply('search', { hits: [], next: null, failed: true }, () => answerSearch(db, req, s.kinds(), s.models(), live)); break;
      // design review M6: the ledger and open windows refresh once the session is hidden (boot's onRemoved, phase a)
      case 'purge': void s.purge(req.session).then((result) => port.postMessage({ v: IPC_VERSION, type: 'purge', id: req.id, result } satisfies PortMessage)); break;
      case 'suppressed': reply('suppressed', { rows: [], next: null, failed: true }, () => suppressedPage(db, secret!, homedir(), req.cursor, req.limit)); break;
      case 'historyRow': port.postMessage({ v: IPC_VERSION, type: 'historyRow', id: req.id, ...answerHistoryRow(db, req.session, s.kinds(), s.models(), live) } satisfies PortMessage); break;
      case 'reimport': port.postMessage({ v: IPC_VERSION, type: 'reimport', id: req.id, result: s.reimport(req.key) } satisfies PortMessage); break;
      case 'retention': reply('retention', { setting: null, lastRunAt: null }, () => retentionState(db)); break; // unreadable: no setting
      case 'setRetention': port.postMessage({ v: IPC_VERSION, type: 'setRetention', id: req.id, result: s.saveRetention(req.value) } satisfies PortMessage); break;
      // XAIBO-PROD-568 (P6-T11): Validate switches nothing; Reload keeps the last valid revision on an invalid file.
      // ponytail (review R6): a read-only store reloads in memory only (not kept across a restart), as reloadPrices does.
      case 'prices': {
        const p = req.op === 'reload' ? s.reloadPrices() : s.prices();
        port.postMessage({ v: IPC_VERSION, type: 'prices', id: req.id, view: p ? priceView(p) : null, check: req.op === 'validate' ? s.checkPrices() : null } satisfies PortMessage);
        break;
      }
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
      // XAIBO-PROD-590 (P6-T08 slice A): rescan without restart; the agents broadcast follows from the service's announce
      case 'agentRescan': void s.rescan().then((result) => port.postMessage({ v: IPC_VERSION, type: 'agentRescan', id: req.id, result } satisfies PortMessage)); break;
      // XAIBO-PROD-597 (P6-T08a slice B): ids only; it only removes authority, so no native confirmation
      case 'grantRevoke': void s.revoke(req.agent, req.target).catch((): RevokeResult => 'unavailable') // code review L: always a reply
        .then((result) => port.postMessage({ v: IPC_VERSION, type: 'grantRevoke', id: req.id, result } satisfies PortMessage)); break;
      case 'clearUsage': void s.clearUsage().then((result) => {
        if (result === 'cleared') ledger?.invalidate();
        port.postMessage({ v: IPC_VERSION, type: 'clearUsage', id: req.id, result } satisfies PortMessage);
      }); break;
      // XAIBO-PROD-504 (P5-T01): history overlay; Gate 5 G5b2-5: a store that cannot answer says failed (the renderer keeps
      // its rows and offers Retry), never an empty page
      case 'history': reply('history', { rows: [], next: null, failed: true }, () => listHistory(db, req.filter, req.cursor, req.limit, s.kinds(), s.models(), live)); break;
      case 'projects': reply('projects', { projects: [], next: null, failed: true }, () => listProjects(db, req.cursor, req.limit)); break;
      case 'folders': reply('folders', { folders: [], next: null, failed: true }, () => listFolders(db, req.project, req.cursor, req.limit)); break;
      // P5-T01c: a store that cannot answer says failed (the renderer offers Retry), never an empty page
      case 'mapGroups': reply('mapGroups', { groups: [], next: null, failed: true }, () => mapGroups(db, req.parent, req.cursor, req.limit, live)); break;
      case 'overlay': {
        const result = applyOverlay(db, req.op, { readOnly: s.store.readOnly || !db.isOpen, now: Date.now() });
        port.postMessage({ v: IPC_VERSION, type: 'overlay', id: req.id, result } satisfies PortMessage);
        if (resyncAfter(req.op, result)) removed(); // G5b2-4: other windows list it (or not) too
        break;
      }
      case 'integrationPage': { // XAIBO-PROD-574 (P6-T10 unit 2a): the Agents list, from a fresh read-only reconcile
        const c = integrationsFor(s);
        const result: IntegrationPageResult = c === null ? { status: 'refused', code: 'starting' } : c === 'unavailable' || !dataDir ? { status: 'refused', code: 'unavailable' }
          : answerIntegrationPage({ db, catalog: s.catalog(), detections: s.detections, profiles: s.profiles(), home: homedir(), now: Date.now(),
            reconcile: () => c.reconcile(s.profiles() ?? []), ...pageEvidence({ db, dataDir }) }, req);
        port.postMessage({ v: IPC_VERSION, type: 'integrationPage', id: req.id, result } satisfies PortMessage);
        break;
      }
      case 'integrationDetail': { // XAIBO-PROD-577 (P6-T10 unit 4a): the integration panel's read, from a fresh read-only reconcile
        const c = integrationsFor(s);
        const result: IntegrationDetailResult = c === null ? { status: 'refused', code: 'starting' } : c === 'unavailable' || !dataDir ? { status: 'refused', code: 'unavailable' }
          : answerIntegrationDetail({ db, catalog: s.catalog(), detections: s.detections, profiles: s.profiles(), home: homedir(), now: Date.now(),
            reconcile: () => c.reconcile(s.profiles() ?? []), grantState: (agent) => s.grantState(agent), ...pageEvidence({ db, dataDir }) }, req.key);
        port.postMessage({ v: IPC_VERSION, type: 'integrationDetail', id: req.id, result } satisfies PortMessage);
        break;
      }
      case 'signIn': { // XAIBO-PROD-572 (P6-T01a slice 3): a change re-groups usage, so the ledger recomputes (review L6)
        const r = s.signIn(req);
        port.postMessage({ v: IPC_VERSION, type: 'signIn', id: req.id, code: r.code, view: r.view } satisfies PortMessage);
        if (r.changed) ledger?.invalidate();
        break;
      }
      // XAIBO-PROD-558 (P6-T03 part 1b): Connect, Disconnect, Uninstall; a preview belongs to this port
      case 'connectPreview': case 'connectApply': case 'removalPreview': case 'removalApply': case 'cleanupPreview': case 'cleanupApply': // XAIBO-PROD-576: no bare removal (R1)
      case 'teePreview': case 'teeRemovalPreview': // XAIBO-PROD-580: the separate tee (R6)
        // part 2a: awaited (the lock is released before the reply); a closed port drops the reply
        void answerIntegrations({ readOnly: s.store.readOnly, connect: () => integrationsFor(s), profile: (id) => s.profiles()?.find((p) => p.id === id), profiles: () => s.profiles() ?? [] }, req, port)
          .then((m) => { try { port.postMessage(m); } catch { /* the window closed */ } }, () => { // code review L-a: never unanswered
            try { port.postMessage({ v: IPC_VERSION, type: req.type, id: req.id, result: afterDispatch(req.type) } as PortMessage); } catch { /* closed */ }
          });
        break;
      default: port.postMessage(db.isOpen ? answer(db, req, s.kinds(), s.models(), live) : { v: IPC_VERSION, type: 'page', id: req.id, rows: [], next: null });
    }
  });
});

/** The Connect core, built once profiles are synced (null before: `starting`). XAIBO_BIN is always set by main (review M3). */
let integrations: Connect | null = null;
let startupDone = false; // review L-2: startup settled; still no profile sync = `unavailable`, never `starting` forever
void booted.then((s) => s.done.then(() => { startupDone = true; reconcileOnStart(s); }, () => { startupDone = true; reconcileOnStart(s); }));
/** XAIBO-PROD-562 (P6-T04 part 1, EC-26): one read-only reconcile once startup settled; the IPC reads (P6-T10) run their
 *  own fresh reconcile per request. */
function reconcileOnStart(s: Service) {
  try { const c = integrationsFor(s); if (c && c !== 'unavailable') c.reconcile(s.profiles() ?? []); } catch { /* read-only: nothing to undo; the next start retries */ }
}
const integrationsFor = (s: Service): Connect | null | 'unavailable' => {
  if (!integrations && s.profiles() !== null && dataDir) {
    integrations = createConnect(connectContext({
      dataDir, login: s.loginEnv(), bin: process.env.XAIBO_BIN ?? '', catalog: s.catalog(), e2e: process.env.XAIBO_E2E === '1',
      detection: (agent) => s.detections.find((d) => d.agent === agent), // the live list: "Set path…" re-detects in place
      setupAccess: (agent) => s.setupAccess(agent), // XAIBO-PROD-589: fresh per call, never cached
    }));
  }
  return integrations ?? (startupDone ? 'unavailable' : null);
};

function connect(port: MessagePortMain) {
  hub.add(port);
  port.on('message', (e) => request(e.data, port));
  port.on('close', () => { hub.remove(port); integrations?.dropOwner(port); });
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
  // XAIBO-PROD-595 (P6-T08 slice E part 2): a picked catalog file; the outcome (codes only) goes to every window
  else if (m.type === 'importCatalog') { const { path: picked } = m; void booted.then((s) => broadcast({ v: IPC_VERSION, type: 'catalogImport', result: s.importCatalog(picked) })); }
  else if (m.type === 'suspend') { const { at } = m; void booted.then((s) => s.suspend(at)); }
  else if (m.type === 'reloadPrices') void booted.then((s) => s.reloadPrices());
  else if (m.type === 'port') transferred.forEach(connect);
  else if (m.type === 'setPath') { const { agent, path: file } = m; void booted.then((s) => s.setPath(agent, file)); }
  // XAIBO-PROD-597 (P6-T08a slice B; review M5): main's grant offer and confirm; the reply goes to main only, never a port
  else if (m.type === 'grantOffer' || m.type === 'grantConfirm') { // code review L: always a reply, a failure included
    const reply = (result: GrantOfferResult | GrantConfirmResult) => parent.postMessage({ v: IPC_VERSION, type: 'grant', id: m.id, result } satisfies ServiceEvent);
    const run = m.type === 'grantOffer' ? booted.then((s) => s.grantOffer(m.request)) : booted.then((s) => s.grantConfirm(m.request, m.binding));
    void run.catch((): GrantConfirmResult => ({ status: 'refused', code: 'failed' })).then(reply);
  }
  // XAIBO-PROD-600 (P6-T12 slice 2): main's apply offer and confirm; the reply goes to main only, never a port, always one
  else if (m.type === 'applyOffer' || m.type === 'applyConfirm') {
    const reply = (result: ApplyOfferResult | ApplyConfirmResult) => parent.postMessage({ v: IPC_VERSION, type: 'apply', id: m.id, result } satisfies ServiceEvent);
    const run = booted.then((s) => answerApply({ readOnly: s.store.readOnly, connect: () => integrationsFor(s), profile: (id) => s.profiles()?.find((p) => p.id === id), profiles: () => s.profiles() ?? [] }, m));
    void run.catch((): ApplyConfirmResult => ({ status: 'refused', code: m.type === 'applyConfirm' ? 'unknown' : 'failed' })).then(reply);
  }
});
parent.on('message', (e) => command(e.data, e.ports));

async function main(dataDir: string, log: Logger) {
  secret = loadInstallSecret(dataDir);
  ledger = new MonthlyCache({ file: path.join(dataDir, 'xaibo.db'), secret, home: homedir(), log: (e, f) => log.log(e, f) });
  meter = new StorageMeter(dataDir);
  // code review nit: userInfo() only when the variable is set (it throws for a uid with no user-database entry)
  // XAIBO-PROD-611: this process's XAIBO_* values come only through main's trustedEnv + serviceEnv (no other launch path)
  const testRoots = process.env.XAIBO_TEST_ALLOWED_ROOT ? allowedRootsFromEnv(process.env, { home: homedir(), accountHome: userInfo().homedir, dataDir }) : [];
  if (testRoots.length) log.log('test_allowed_root');
  svc = await boot({
    dataDir, home: homedir(), shell: process.env.SHELL, log, retentionDelayMs: retentionDelayFromEnv(process.env),
    allowedRoots: testRoots, // XAIBO-PROD-596: none unless an isolated-HOME E2E run sets XAIBO_TEST_ALLOWED_ROOT
    onCommit: committed,
    onAgents: (agents) => broadcast({ v: IPC_VERSION, type: 'agents', agents }),
    onNotify: (n) => parent.postMessage({ v: IPC_VERSION, type: 'notify', ...n } satisfies ServiceEvent), // P3-T11
    onTick: (keys) => { for (const k of keys) changed(k); }, // P3-T16e: a settle at its deadline, not the next tick
    onPriced: () => { ledger?.invalidate(); if (hub.anyLive()) hub.sessions({ v: IPC_VERSION, type: 'resync' }); }, // XAIBO-PROD-445: one per sliced job
    onRemoved: removed, // XAIBO-PROD-542 G5b2-2: a retention run or manual purge removed sessions, Trash or usage history
  });
  resolveBooted(svc);
  setInterval(() => { for (const k of svc?.ticking() ?? []) changed(k); }, TICK_MS);
  setInterval(coverage, COVERAGE_MS);
  // P4-T10c2: content-free metrics for main's diagnostics bundle, at the coverage cadence (peaks cover the interval).
  setInterval(() => { // a failing metric is logged, never an uncaught exception (the crash policy would restart us; review L5)
    try {
      const metrics = { ...svc!.metrics(), deltaResyncs: resyncs };
      stamp({ ev: 'metrics', ...metrics }); // P4-T11: the live-load run reads queue age and resyncs from the perf trace
      // XAIBO-PROD-552 (D-P5-20/22): content-free counters and the service's memory, perf trace only
      if (trace) { const m = process.memoryUsage(); stamp({ ev: 'perf', ...takePerf(), rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers }); }
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
