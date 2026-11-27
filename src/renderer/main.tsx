// Renderer entry (P1-T12): takes the brokered service port and main's health messages from the preload (window
// messages from this window only, validated), keeps the list state (model.ts) and renders health, agents and sessions.
import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { type CatalogImportResult, parseHealth, parseStartupReply } from '../shared/ipc.ts';
import type { AgentStatus, Banner, GrantAsk, Health, IntegrationKey, LedgerFilter, RevokeTarget, SessionRow, StartupRequest } from '../shared/ipc.ts';
import { askGrant } from './agent-map/grants-view.ts';
import { askLockClear, confirmedApply } from './agent-map/integration-dialog.ts';
import { focusInvoker } from './agent-map/integration-panel.ts';
import type { SignInCommand } from './usage/sign-in-view.ts';
import { createClient, parseVisible, type Client, type PortLike } from './client.ts';
import { HealthStatus } from './Health.tsx';
import { Icon } from './status/StatusBadge.tsx';
import { createCoalescer } from './data/coalesce.ts';
import { createHolds, reloadWindow, singleFlight } from './data/pages.ts';
import { applyDelta, applyLiveDelta, applyPage, bandText, collectorStep, restoreFocus, emptyCollector, emptyList, emptyLiveSet, lastKnownLabel, liveSetNeedsRefill, PAGE, type ListState, type LiveSetState } from './model.ts';
import { Dashboard, type UsageApi, type View } from './overview/Dashboard.tsx';
import { framePad } from './frame-pad.ts';
import { openOrder } from './overview/queue.ts';
import { retryIdle, retryStep } from './retry.ts';
import { firstUsablePage, LONG_FRAME, watchLongFrames } from './perf-marks.ts';
import { parseReveal } from './settings/prices-view.ts';
import { Settings, type SettingsApi } from './settings/Settings.tsx';
import type { BrowseApi } from './history/SessionBrowser.tsx';
import { AgentMap, type MapSnapshot } from './agent-map/AgentMap.tsx';
import { Workspace } from './workspace/Workspace.tsx';
import { monthRange, type Query } from './history/browse.ts';
import type { LedgerSnap } from './history/MonthlyChart.tsx';
import type { SessionChanges } from './workspace/view.ts';
import type { WorkspaceApi } from './workspace/OpenSession.tsx';
import { workspaceApiOf } from './workspace/workspace-api.ts';
import './styles/tokens.css';

declare global { interface Window { xaibo?: { setAgentPath(agent: string): void; importCatalog?(): void; paintAck(delta: number): void; revealPriceOverride?(): Promise<unknown>; startup?(request: StartupRequest): Promise<unknown>; grant?(request: unknown): Promise<unknown>; confirmApply?(request: unknown): Promise<unknown> } } }

// M3 marks (P1-T14): read through the Performance API by test/perf.
// ponytail: distinct sessions changed within one frame before the batch is dropped for a cursor resync; raise if a
// real backfill hits it (the resync shows up as a first-page reload).
const DELTA_MAX = 1000;
const onListCommit = firstUsablePage({ raf: (cb) => requestAnimationFrame(cb), mark: (n) => performance.mark(n) });
watchLongFrames((start, duration) => performance.measure(LONG_FRAME, { start, duration }), globalThis.PerformanceObserver);

type Area = 'dashboard' | 'session' | 'map' | 'settings';
const HEADING: Record<Area, string> = { dashboard: 'dashboard-heading', session: 'sessions-heading', map: 'agent-map-heading', settings: 'settings-heading' };

function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [list, setList] = useState<ListState>(emptyList);
  const [banners, setBanners] = useState<Banner[]>([]);
  const [catalogImport, setCatalogImport] = useState<CatalogImportResult | null>(null); // XAIBO-PROD-595
  const [liveSet, setLiveSet] = useState<LiveSetState>(emptyLiveSet);
  const [area, setArea] = useState<Area>('dashboard');
  const [tick, setTick] = useState(0); // session activity: the usage view refreshes on it (throttled there)
  const [collector, setCollector] = useState(emptyCollector); // the Last known qualifier (design §6.0)
  const [liveFailed, setLiveFailed] = useState(false); // the live set could not be loaded: Retry
  const [liveRetry, liveRetryDo] = useReducer(retryStep, retryIdle); // XAIBO-PROD-438: Retrying…, Still couldn't …
  const [request, setRequest] = useState<SessionRow | null>(null); // P4-T05d: a Dashboard record opened in the Session area
  const client = useRef<Client | null>(null);
  const [changes, setChanges] = useState<SessionChanges>({ rows: [], resync: 0, n: 0 });
  const loadedRows = useRef(0); // rows the user has loaded: a resync refetches that many (P4-T03)
  loadedRows.current = list.rows.length;
  // The Dashboard's live set from the service (start, resync, Retry, refill); a failure shows the Retry notice.
  const loadLive = (c: Client) => c.liveSet().then((s) => { if (client.current === c) { setLiveSet({ ...s, loaded: true }); setLiveFailed(false); liveRetryDo({ type: 'ok' }); } },
    () => { if (client.current === c) { setLiveFailed(true); liveRetryDo({ type: 'fail', at: Date.now() }); } });
  // XAIBO-PROD-448 (G4c-3): members left a capped set: fetch it again for the left-out ones, one request at a time
  const liveRefresh = useMemo(() => singleFlight(() => (client.current ? loadLive(client.current) : Promise.resolve())), []);
  useEffect(() => { if (liveSetNeedsRefill(liveSet)) liveRefresh(); }, [liveSet, liveRefresh]);

  useEffect(() => {
    const holds = createHolds<SessionRow>(DELTA_MAX, () => resync()); // XAIBO-PROD-447: past DELTA_MAX held rows, one more reload
    // The loaded window again by cursor, replacing the list: after a (re)start, a coalescer overflow or showing the window.
    const reload = (c: Client | null): Promise<unknown> => {
      if (!c) return Promise.resolve();
      // P4-T04c: the Dashboard's live set is resynced with the list (start, coalescer overflow, show).
      const set = loadLive(c);
      // XAIBO-PROD-447: deltas flushed while the pages load are replayed on them (page 1 may be older than a delta)
      const page = holds.hold(reloadWindow(loadedRows.current, (cursor, limit) => c.listSessions(cursor, limit), PAGE))
        .then((r) => { if (r && client.current === c) setList((s) => applyDelta(applyPage(s, r.value, false), r.held)); }, () => undefined);
      setChanges((x) => ({ rows: [], resync: x.resync + 1, n: x.n + 1 })); // a resync may hide any change: the open session refreshes
      setTick((t) => t + 1); // XAIBO-PROD-436: and the usage view (a read pending at a restart failed with the old port)
      return Promise.all([set, page]);
    };
    // P4-T10c1 review M1: overflow resyncs (the service's or the frame coalescer's) run one reload at a time.
    const resync = singleFlight(() => reload(client.current));
    // P4-T02: deltas are coalesced per session and committed once per frame. P3-T10 perf trace: delta ids arrive only
    // under XAIBO_PERF_TRACE=1 and are acked after rAF plus one frame, so the ack follows the paint that shows them.
    const deltas = createCoalescer<SessionRow>({
      max: DELTA_MAX, schedule: (cb) => requestAnimationFrame(cb), resync,
      flush: (rows, tags) => {
        holds.push(rows);
        flushSync(() => {
          setList((s) => applyDelta(s, rows)); setLiveSet((s) => applyLiveDelta(s, rows)); setTick((t) => t + 1);
          setChanges((c) => ({ ...c, rows, n: c.n + 1 })); // XAIBO-PROD-424: the open conversation follows these
        });
        if (tags.length) requestAnimationFrame(() => requestAnimationFrame(() => { for (const t of tags) window.xaibo?.paintAck(t); }));
      },
    });
    const sessions = (rows: SessionRow[], delta?: number) => rows.forEach((r, i) => deltas.push(r.id, r, i === 0 ? delta : undefined));
    // Window visibility comes from main (page visibility does not follow hide() on macOS); shown at start.
    let shown = true;
    const visible = () => shown;
    const onVisible = (on: boolean) => {
      if (on === shown) return;
      shown = on;
      const c = client.current;
      if (!c) return;
      c.setLive(on);
      if (on) reload(c); // deltas were paused while hidden
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window) return;
      if (e.data === 'xaibo-port' && e.ports[0]) { // a (re)started service: new client, reload the first page
        client.current?.close();
        const c = createClient(e.ports[0] as unknown as PortLike, { sessions, agents: setAgents, coverage: setBanners, resync, catalogImport: setCatalogImport });
        client.current = c;
        if (!visible()) c.setLive(false);
        // An invalid first page leaves the list empty; deltas and the next restart still fill it.
        reload(c);
        return;
      }
      const v = parseVisible(e.data);
      if (v !== null) { onVisible(v); return; }
      const h = parseHealth(e.data);
      if (h) setHealth(h);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => { onListCommit(list.rows.length); }, [list.rows.length]);
  // XAIBO-PROD-439: focus scrolled into view never lands under the sticky top frame (its height varies with the nav
  // wrapping and the text size)
  useEffect(() => {
    const frame = document.querySelector<HTMLElement>('.x-frame');
    if (!frame) return;
    const set = () => document.documentElement.style.setProperty('--x-frame-pad', `${framePad(frame.offsetHeight, innerWidth, getComputedStyle(frame).position === 'sticky')}px`);
    const o = new ResizeObserver(set);
    o.observe(frame);
    addEventListener('resize', set);
    set();
    return () => { o.disconnect(); removeEventListener('resize', set); };
  }, []);

  // XAIBO-PROD-529 (P5-T18 part 3a): the Session list pages the history itself; this feed keeps the open row current
  const browseApi = useMemo<BrowseApi>(() => {
    const none = () => Promise.reject(new Error('no service connection'));
    return {
      history: (filter, cursor, limit) => client.current?.history(filter, cursor, limit) ?? none(),
      search: (query, filter, cursor, limit) => client.current?.search(query, filter, cursor, limit) ?? none(),
      mapGroups: (parent, cursor, limit) => client.current?.mapGroups(parent, cursor, limit) ?? none(),
      // XAIBO-PROD-532: row actions; without a connection nothing is sent, so nothing changed
      overlay: (op) => client.current?.overlay(op) ?? Promise.resolve({ ok: false as const, error: 'store' as const }),
      historyRow: (session) => client.current?.historyRow(session) ?? none(),
      purge: (session) => client.current?.purge(session) ?? Promise.resolve('failed' as const), // XAIBO-PROD-534: nothing sent, nothing purged
      projects: (cursor, limit) => client.current?.projects(cursor, limit) ?? none(), // XAIBO-PROD-535: the Move dialog's lists
      folders: (project, cursor, limit) => client.current?.folders(project, cursor, limit) ?? none(),
      // XAIBO-PROD-536: Suppressed; without a connection nothing is sent, so nothing was re-imported
      suppressed: (cursor, limit) => client.current?.suppressed(cursor, limit) ?? none(),
      reimport: (key) => client.current?.reimport(key) ?? Promise.resolve('failed' as const),
    };
  }, []);

  // XAIBO-PROD-575: the Agent Map adds the Agents list page to the browse requests. XAIBO-PROD-579: and the panel's writes;
  // without a connection a preview fails and an apply is refused (nothing was sent, so the outcome is known)
  const mapApi = useMemo(() => {
    const gone = () => Promise.reject(new Error('no service connection')), notSent = { status: 'refused', code: 'unavailable' } as const;
    return { ...browseApi, integrationPage: (cursor: IntegrationKey | null, limit: number) => client.current?.integrationPage(cursor, limit) ?? gone(),
      integrationDetail: (key: IntegrationKey) => client.current?.integrationDetail(key) ?? gone(),
      connectPreview: (profileId: string, retention: boolean) => client.current?.connectPreview(profileId, retention) ?? gone(),
      // XAIBO-PROD-601: a real profile's apply answered needs-confirmation goes to main's native confirmation (ids only)
      connectApply: (previewId: string) => (client.current ? confirmedApply('connect', previewId, () => client.current!.connectApply(previewId), window.xaibo?.confirmApply) : Promise.resolve(notSent)),
      removalPreview: (profileId: string | null) => client.current?.removalPreview(profileId) ?? gone(),
      removalApply: (previewId: string) => (client.current ? confirmedApply('removal', previewId, () => client.current!.removalApply(previewId), window.xaibo?.confirmApply) : Promise.resolve(notSent)),
      cleanupPreview: (profileId: string) => client.current?.cleanupPreview(profileId) ?? gone(),
      cleanupApply: (previewId: string) => (client.current ? confirmedApply('cleanup', previewId, () => client.current!.cleanupApply(previewId), window.xaibo?.confirmApply) : Promise.resolve(notSent)),
      teePreview: (profileId: string) => client.current?.teePreview(profileId) ?? gone(),
      // XAIBO-PROD-613: the Clear stale lock: a preview over the port, the clear only through main's confirmation
      lockClearPreview: () => client.current?.lockClearPreview() ?? gone(),
      lockClear: (previewId: string) => askLockClear(window.xaibo?.confirmApply, previewId),
      rescan: () => client.current?.rescan() ?? Promise.resolve({ status: 'refused', code: 'unavailable' } as const), // XAIBO-PROD-593
      // XAIBO-PROD-598: a grant goes to main (ids only; its native confirmation); a revoke over the port; no connection sends nothing
      grant: (a: GrantAsk) => askGrant(window.xaibo?.grant, a),
      revoke: (agent: string, t: RevokeTarget) => client.current?.grantRevoke(agent, t) ?? Promise.resolve('unavailable' as const),
      teeRemovalPreview: (profileId: string) => client.current?.teeRemovalPreview(profileId) ?? gone(),
      // XAIBO-PROD-585: without a connection a read fails and a write is unavailable (nothing was sent)
      signIn: (profileId: string, c: SignInCommand) => client.current?.signIn(profileId, c) ?? (c.op === 'read' ? gone() : Promise.resolve({ code: 'unavailable' as const, view: null })) };
  }, [browseApi]);
  const api = useMemo<UsageApi>(() => ({
    usage: () => client.current?.usageAll() ?? Promise.reject(new Error('no service')), // XAIBO-PROD-587: scopes and profiles
    history: (scope, stream, from, to, cursor) => client.current?.usageHistory(scope, stream, from, to, cursor, PAGE) ?? Promise.reject(new Error('no service')),
    monthly: (filter, end, limit) => client.current?.monthly(filter, end, limit) ?? Promise.reject(new Error('no service')),
  }), []);
  // review L5: with no service connection nothing is sent, so the outcome is known: not cleared
  const settingsApi = useMemo<SettingsApi>(() => {
    const none = () => Promise.reject(new Error('no service connection'));
    return {
      clearUsage: () => client.current?.clearUsage() ?? Promise.resolve('failed' as const),
      // XAIBO-PROD-528 (P5-T18 part 2): retention and storage; without a connection the sections say unavailable
      retention: () => client.current?.retention() ?? none(),
      setRetention: (v) => client.current?.setRetention(v) ?? Promise.resolve('failed' as const),
      storage: (refresh) => client.current?.storage(refresh) ?? none(),
      // XAIBO-PROD-568 (P6-T11): main's reveal answer is checked here too (anything else is a failure)
      prices: (op) => client.current?.prices(op) ?? none(),
      reveal: async () => parseReveal(await (window.xaibo?.revealPriceOverride?.() ?? 'failed')),
      // XAIBO-PROD-569: main's answer is parsed here too; anything malformed or no bridge is unavailable (null)
      startup: async (request) => parseStartupReply(await (window.xaibo?.startup?.(request) ?? null)),
    };
  }, []);
  // P4-T05d: the Session workspace's page requests go to the current client (a restart brings a new one).
  const workspaceApi = useMemo<WorkspaceApi>(() => workspaceApiOf(() => client.current), []);
  const clearRequest = useCallback(() => setRequest(null), []);
  // XAIBO-PROD-437 (design §5.3/§5.4, §6.3): the Dashboard view survives area switches; a session opened from it
  // remembers its record and the order shown, so Return to Dashboard restores that record (or its neighbour).
  const [dashView, setDashView] = useState<View>('live');
  const origin = useRef<{ id: number; view: View; order: number[] } | null>(null);
  const [returnFor, setReturnFor] = useState<number | null>(null);
  // XAIBO-PROD-539: a session opened from an Agent Map leaf returns there, to the map as it was left
  const [returnTo, setReturnTo] = useState<'Dashboard' | 'Agent Map'>('Dashboard');
  const mapSaved = useRef<MapSnapshot | null>(null);
  // XAIBO-PROD-586 (D-P6-17): one route to a profile's integration panel (Settings now; the Dashboard usage blocks next)
  const [openIntegration, setOpenIntegration] = useState<IntegrationKey | null>(null);
  // XAIBO-PROD-610 (Gate 6 D1-3, design §6.5.2): the Dashboard button that opened the panel, for its Return to Dashboard
  const [integrationReturn, setIntegrationReturn] = useState<string | null>(null);
  useEffect(() => { if (area !== 'map') { setOpenIntegration(null); setIntegrationReturn(null); } }, [area]); // the map reads it on arrival only
  const toIntegration = (key: IntegrationKey, invoker: string | null = null) => { clearReturn(); setPreset(null); setLedgerRestore(null); setMapReturn(null); setOpenIntegration(key); setIntegrationReturn(invoker); setArea('map'); };
  const returnFromIntegration = () => {
    const label = integrationReturn;
    setDashView('usage');
    setArea('dashboard');
    // review M: only while nothing else took focus (the user may move on before the usage blocks draw)
    const idle = () => document.activeElement === null || document.activeElement === document.body;
    void focusInvoker(() => (idle() ? [...document.querySelectorAll<HTMLElement>('#view-usage button[aria-label]')].find((b) => b.getAttribute('aria-label') === label) ?? null : null),
      () => (idle() ? document.getElementById('view-usage-heading') : null), () => new Promise((r) => setTimeout(r, 100)));
  };
  const [mapReturn, setMapReturn] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const liveRows = useRef(liveSet.rows);
  liveRows.current = liveSet.rows;
  // review M1: the order comes from data (a virtual list mounts only rows near the viewport)
  const openSession = (row: SessionRow) => {
    origin.current = { id: row.id, view: dashView, order: openOrder(dashView, liveRows.current) };
    setLedgerRestore(null); // the ledger's restore is used once (a later remount starts it fresh)
    setReturnFor(row.id);
    setReturnTo('Dashboard');
    setRequest(row);
    setArea('session');
  };
  const returnToDashboard = useCallback(() => {
    const o = origin.current;
    if (!o) return;
    const id = restoreFocus(openOrder(o.view, liveRows.current), o.order, o.id);
    setFocusId(id); // the Live list mounts that row as its tab stop
    setDashView(o.view);
    setArea('dashboard');
    requestAnimationFrame(() => requestAnimationFrame(() => { // after the list's first layout
      const target = id === null ? null : document.querySelector<HTMLElement>(`#view-${o.view} [data-open-id="${id}"]`);
      (target ?? document.getElementById(`view-${o.view}-heading`))?.focus();
      setFocusId(null); // used: a later visit starts the Live list at its first row (review LOW)
    }));
  }, []);
  // Design §6.0: no unqualified live indicator while the collector is not running (starting, restarting, stopped, and
  // paused on a full disk: D-P4-09). Stepped before paint, so no frame shows a pause without its time.
  const band = bandText(health, banners).state;
  useLayoutEffect(() => { setCollector((c) => collectorStep(c, band, Date.now())); }, [band]);
  const lastKnown = lastKnownLabel(collector, band);
  const retryLive = () => {
    if (!client.current) return;
    liveRetryDo({ type: 'start' }); // the notice stays, its Retry disabled until the answer (D-P4-10)
    void liveRefresh(); // joins a refill already in flight rather than sending a second request
  };
  // review L3: leaving through the Areas links or opening from the Session list ends the Dashboard's Return
  const clearReturn = useCallback(() => { origin.current = null; setReturnFor(null); setFocusId(null); }, []);
  // XAIBO-PROD-538/539: a session leaf opens in Session (design §6.5.1) with Return to Agent Map
  const openFromMap = (row: SessionRow) => { clearReturn(); setReturnFor(row.id); setReturnTo('Agent Map'); setRequest(row); setArea('session'); };
  const returnToMap = () => { const id = returnFor; clearReturn(); setMapReturn(id); setArea('map'); };
  // XAIBO-PROD-555 (design §6.1.1): a ledger month's retained sessions open as the Session list filtered to that month,
  // agent and model; the list's Return to Dashboard restores Usage and history with the ledger as left, at that month
  const [preset, setPreset] = useState<Partial<Query> | null>(null);
  const [ledgerRestore, setLedgerRestore] = useState<LedgerSnap | null>(null);
  const ledgerSaved = useRef<LedgerSnap | null>(null);
  const openMonth = (month: string, filter: LedgerFilter, snap: LedgerSnap) => {
    const range = monthRange(month);
    if (!range) return;
    clearReturn(); ledgerSaved.current = snap; setLedgerRestore(null);
    setPreset({ agent: filter.agent, model: filter.model, from: range.from, to: range.to });
    setArea('session');
  };
  const returnToLedger = () => { setPreset(null); setLedgerRestore(ledgerSaved.current); setDashView('usage'); setArea('dashboard'); };
  const go = (to: Area) => (e: MouseEvent) => {
    e.preventDefault();
    clearReturn(); setPreset(null); setLedgerRestore(null);
    if (to === 'map') setMapReturn(null); // Gate 5 G5d-2: the nav link keeps the map as left (refreshed on entry), no Return target
    setArea(to);
    requestAnimationFrame(() => document.getElementById(HEADING[to])?.focus());
  };
  return (
    <div className={`x-shell${area === 'session' ? ' x-fixed' : ''}`}>
      <a className="x-skip" href="#main">Skip to main content</a>
      <header className="x-frame">
        <nav aria-label="Areas" className="x-nav">
          <span className="x-mark">
            <svg className="x-logo" viewBox="0 0 16 16" width="32" height="32" role="img" aria-label="Xaibo detective" shapeRendering="crispEdges">
              <rect x="6" y="1" width="4" height="1" fill="var(--x-ink)" />
              <rect x="5" y="2" width="6" height="1" fill="var(--x-ink)" />
              <rect x="4" y="3" width="8" height="1" fill="var(--x-ink)" />
              <rect x="4" y="4" width="1" height="1" fill="var(--x-ink)" />
              <rect x="9" y="4" width="3" height="1" fill="var(--x-ink)" />
              <rect x="2" y="5" width="12" height="1" fill="var(--x-ink)" />
              <rect x="3" y="6" width="10" height="1" fill="var(--x-ink)" />
              <rect x="4" y="7" width="1" height="1" fill="var(--x-ink)" />
              <rect x="7" y="7" width="2" height="1" fill="var(--x-ink)" />
              <rect x="11" y="7" width="1" height="1" fill="var(--x-ink)" />
              <rect x="4" y="8" width="1" height="1" fill="var(--x-ink)" />
              <rect x="7" y="8" width="2" height="1" fill="var(--x-ink)" />
              <rect x="11" y="8" width="1" height="1" fill="var(--x-ink)" />
              <rect x="5" y="9" width="5" height="1" fill="var(--x-ink)" />
              <rect x="3" y="10" width="3" height="1" fill="var(--x-ink)" />
              <rect x="7" y="10" width="2" height="1" fill="var(--x-ink)" />
              <rect x="12" y="10" width="3" height="1" fill="var(--x-cyan)" />
              <rect x="2" y="11" width="4" height="1" fill="var(--x-ink)" />
              <rect x="7" y="11" width="2" height="1" fill="var(--x-ink)" />
              <rect x="11" y="11" width="1" height="1" fill="var(--x-cyan)" />
              <rect x="15" y="11" width="1" height="1" fill="var(--x-cyan)" />
              <rect x="2" y="12" width="5" height="1" fill="var(--x-ink)" />
              <rect x="8" y="12" width="1" height="1" fill="var(--x-ink)" />
              <rect x="11" y="12" width="1" height="1" fill="var(--x-cyan)" />
              <rect x="15" y="12" width="1" height="1" fill="var(--x-cyan)" />
              <rect x="1" y="13" width="6" height="1" fill="var(--x-ink)" />
              <rect x="8" y="13" width="1" height="1" fill="var(--x-ink)" />
              <rect x="11" y="13" width="1" height="1" fill="var(--x-cyan)" />
              <rect x="15" y="13" width="1" height="1" fill="var(--x-cyan)" />
              <rect x="1" y="14" width="6" height="1" fill="var(--x-ink)" />
              <rect x="8" y="14" width="2" height="1" fill="var(--x-ink)" />
              <rect x="12" y="14" width="3" height="1" fill="var(--x-cyan)" />
              <rect x="2" y="15" width="8" height="1" fill="var(--x-ink)" />
              <rect x="15" y="15" width="1" height="1" fill="var(--x-cyan)" />
            </svg>
            Xaibo
          </span>
          <a href="#dashboard" aria-current={area === 'dashboard' ? 'page' : undefined} onClick={go('dashboard')}><Icon id="dashboard" />Dashboard</a>
          <a href="#session" aria-current={area === 'session' ? 'page' : undefined} onClick={go('session')}><Icon id="session" />Session</a>
          <a href="#agent-map" aria-current={area === 'map' ? 'page' : undefined} onClick={go('map')}><Icon id="branch" />Agent Map</a>
          <a href="#settings" aria-current={area === 'settings' ? 'page' : undefined} onClick={go('settings')}><Icon id="settings" />Settings</a>
        </nav>
      </header>
      <div className="x-health"><HealthStatus health={health} banners={banners} /></div>
      <main id="main" className="x-main" tabIndex={-1}>
        {area === 'settings' ? <Settings api={settingsApi} readOnly={!!health?.readOnly} signIn={{
            profiles: () => client.current?.usageAll().then((r) => r.profiles) ?? Promise.reject(new Error('no service connection')), api: mapApi.signIn,
            name: (a) => agents?.find((x) => x.agent === a)?.name ?? a, open: toIntegration, live: lastKnown === null }} />
          : area === 'map' ? <AgentMap api={mapApi} importResult={catalogImport} onImport={() => window.xaibo?.importCatalog?.()} agents={agents ?? []} lastKnown={lastKnown} tick={tick} onOpen={openFromMap}
            saved={mapSaved.current} restoreId={mapReturn} onSave={(m) => { mapSaved.current = m; }} open={openIntegration} onReturnDashboard={integrationReturn ? returnFromIntegration : undefined} />
          : area === 'dashboard'
          ? <Dashboard live={liveSet} liveFailed={liveFailed} liveRetry={liveRetry} onRetryLive={retryLive} lastKnown={lastKnown} agents={agents} banners={banners} api={api} tick={tick}
            onSetPath={(agent) => window.xaibo?.setAgentPath(agent)} onOpen={openSession} view={dashView} onView={(v) => { setLedgerRestore(null); setDashView(v); }} focusId={focusId}
            onMonthSessions={openMonth} ledgerRestore={ledgerRestore} onOpenIntegration={(key, invoker) => toIntegration(key, invoker)} />
          : <Workspace list={list} changes={changes} browse={browseApi} agents={agents ?? []} live={{ rows: liveSet.rows, loaded: liveSet.loaded, failed: liveFailed, more: liveSet.more }} lastKnown={lastKnown !== null} api={workspaceApi} request={request} onRequestDone={clearRequest}
            returnFor={returnFor} onReturn={returnTo === 'Agent Map' ? returnToMap : returnToDashboard} returnTo={returnTo} onListOpen={clearReturn}
            preset={preset} onReturnList={preset ? returnToLedger : null} />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
