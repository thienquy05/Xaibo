// Renderer entry (P1-T12): takes the brokered service port and main's health messages from the preload (window
// messages from this window only, validated), keeps the list state (model.ts) and renders health, agents and sessions.
import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { parseHealth } from '../shared/ipc.ts';
import type { AgentStatus, Banner, Health, SessionRow } from '../shared/ipc.ts';
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
import { Workspace } from './workspace/Workspace.tsx';
import type { SessionChanges } from './workspace/view.ts';
import type { WorkspaceApi } from './workspace/OpenSession.tsx';
import { workspaceApiOf } from './workspace/workspace-api.ts';
import './styles/tokens.css';

declare global { interface Window { xaibo?: { setAgentPath(agent: string): void; paintAck(delta: number): void } } }

// M3 marks (P1-T14): read through the Performance API by test/perf.
// ponytail: distinct sessions changed within one frame before the batch is dropped for a cursor resync; raise if a
// real backfill hits it (the resync shows up as a first-page reload).
const DELTA_MAX = 1000;
const onListCommit = firstUsablePage({ raf: (cb) => requestAnimationFrame(cb), mark: (n) => performance.mark(n) });
watchLongFrames((start, duration) => performance.measure(LONG_FRAME, { start, duration }), globalThis.PerformanceObserver);

function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [list, setList] = useState<ListState>(emptyList);
  const [banners, setBanners] = useState<Banner[]>([]);
  const [loading, setLoading] = useState(false);
  const [liveSet, setLiveSet] = useState<LiveSetState>(emptyLiveSet);
  const [area, setArea] = useState<'dashboard' | 'session'>('dashboard');
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
        const c = createClient(e.ports[0] as unknown as PortLike, { sessions, agents: setAgents, coverage: setBanners, resync });
        client.current = c;
        setLoading(false);
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

  const loadMore = () => {
    const c = client.current;
    if (!c || !list.next || loading) return;
    setLoading(true);
    c.listSessions(list.next, PAGE).then((page) => {
      if (client.current !== c) return;
      setList((s) => applyPage(s, page, true));
      setLoading(false);
    }, () => { if (client.current === c) setLoading(false); }); // an invalid page: "Load more" works again
  };

  const api = useMemo<UsageApi>(() => ({
    usage: () => client.current?.usage() ?? Promise.reject(new Error('no service')),
    history: (scope, stream, from, to, cursor) => client.current?.usageHistory(scope, stream, from, to, cursor, PAGE) ?? Promise.reject(new Error('no service')),
    monthly: (filter, end, limit) => client.current?.monthly(filter, end, limit) ?? Promise.reject(new Error('no service')),
  }), []);
  // P4-T05d: the Session workspace's page requests go to the current client (a restart brings a new one).
  const workspaceApi = useMemo<WorkspaceApi>(() => workspaceApiOf(() => client.current), []);
  const clearRequest = useCallback(() => setRequest(null), []);
  // XAIBO-PROD-437 (design §5.3/§5.4, §6.3): the Dashboard view survives area switches; a session opened from it
  // remembers its record and the order shown, so Return to Dashboard restores that record (or its neighbour).
  const [dashView, setDashView] = useState<View>('live');
  const origin = useRef<{ id: number; view: View; order: number[] } | null>(null);
  const [returnFor, setReturnFor] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const liveRows = useRef(liveSet.rows);
  liveRows.current = liveSet.rows;
  // review M1: the order comes from data (a virtual list mounts only rows near the viewport)
  const openSession = (row: SessionRow) => {
    origin.current = { id: row.id, view: dashView, order: openOrder(dashView, liveRows.current) };
    setReturnFor(row.id);
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
  const go = (to: 'dashboard' | 'session') => (e: MouseEvent) => {
    e.preventDefault();
    clearReturn();
    setArea(to);
    requestAnimationFrame(() => document.getElementById(to === 'dashboard' ? 'dashboard-heading' : 'sessions-heading')?.focus());
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
          {/* ponytail: Agent Map and Settings links arrive with their areas (Phases 5–6); no placeholder links now. */}
          <a href="#dashboard" aria-current={area === 'dashboard' ? 'page' : undefined} onClick={go('dashboard')}><Icon id="dashboard" />Dashboard</a>
          <a href="#session" aria-current={area === 'session' ? 'page' : undefined} onClick={go('session')}><Icon id="session" />Session</a>
        </nav>
      </header>
      <div className="x-health"><HealthStatus health={health} banners={banners} /></div>
      <main id="main" className="x-main" tabIndex={-1}>
        {area === 'dashboard'
          ? <Dashboard live={liveSet} liveFailed={liveFailed} liveRetry={liveRetry} onRetryLive={retryLive} lastKnown={lastKnown} agents={agents} banners={banners} api={api} tick={tick}
            onSetPath={(agent) => window.xaibo?.setAgentPath(agent)} onOpen={openSession} view={dashView} onView={setDashView} focusId={focusId} />
          : <Workspace list={list} changes={changes} loading={loading} onLoadMore={loadMore} lastKnown={lastKnown !== null} api={workspaceApi} request={request} onRequestDone={clearRequest}
            returnFor={returnFor} onReturn={returnToDashboard} onListOpen={clearReturn} />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
