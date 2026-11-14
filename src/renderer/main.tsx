// Renderer entry (P1-T12): takes the brokered service port and main's health messages from the preload (window
// messages from this window only, validated), keeps the list state (model.ts) and renders health, agents and sessions.
import { StrictMode, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { parseHealth } from '../shared/ipc.ts';
import type { AgentStatus, Banner, Health, SessionRow } from '../shared/ipc.ts';
import { createClient, parseVisible, type Client, type PortLike } from './client.ts';
import { HealthStatus } from './Health.tsx';
import { createCoalescer } from './data/coalesce.ts';
import { reloadWindow } from './data/pages.ts';
import { applyDelta, applyLiveDelta, applyPage, collectorStep, emptyCollector, emptyList, emptyLiveSet, lastKnownLabel, PAGE, type ListState, type LiveSetState } from './model.ts';
import { Dashboard, type UsageApi } from './overview/Dashboard.tsx';
import { firstUsablePage, LONG_FRAME, watchLongFrames } from './perf-marks.ts';
import { SessionList } from './SessionList.tsx';
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
  const client = useRef<Client | null>(null);
  const loadedRows = useRef(0); // rows the user has loaded: a resync refetches that many (P4-T03)
  loadedRows.current = list.rows.length;

  useEffect(() => {
    // The loaded window again by cursor, replacing the list: after a (re)start, a coalescer overflow or showing the window.
    const reload = (c: Client | null) => {
      if (!c) return;
      // P4-T04c: the Dashboard's live set is resynced with the list (start, coalescer overflow, show).
      c.liveSet().then((set) => { if (client.current === c) { setLiveSet({ ...set, loaded: true }); setLiveFailed(false); } },
        () => { if (client.current === c) setLiveFailed(true); });
      reloadWindow(loadedRows.current, (cursor, limit) => c.listSessions(cursor, limit), PAGE)
        .then((page) => { if (client.current === c) setList((s) => applyPage(s, page, false)); }, () => undefined);
    };
    // P4-T02: deltas are coalesced per session and committed once per frame. P3-T10 perf trace: delta ids arrive only
    // under XAIBO_PERF_TRACE=1 and are acked after rAF plus one frame, so the ack follows the paint that shows them.
    const deltas = createCoalescer<SessionRow>({
      max: DELTA_MAX, schedule: (cb) => requestAnimationFrame(cb), resync: () => reload(client.current),
      flush: (rows, tags) => {
        flushSync(() => { setList((s) => applyDelta(s, rows)); setLiveSet((s) => applyLiveDelta(s, rows)); setTick((t) => t + 1); });
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
        const c = createClient(e.ports[0] as unknown as PortLike, { sessions, agents: setAgents, coverage: setBanners });
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
      if (h) {
        setHealth(h);
        setCollector((c) => collectorStep(c, h.state, Date.now()));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => { onListCommit(list.rows.length); }, [list.rows.length]);

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
  }), []);
  // Design §6.0: no unqualified live indicator while the collector is not running (starting, restarting, stopped).
  const lastKnown = lastKnownLabel(collector, health?.state ?? null);
  const retryLive = () => {
    const c = client.current;
    if (!c) return;
    setLiveFailed(false);
    c.liveSet().then((set) => { if (client.current === c) setLiveSet({ ...set, loaded: true }); }, () => { if (client.current === c) setLiveFailed(true); });
  };
  const go = (to: 'dashboard' | 'session') => (e: MouseEvent) => {
    e.preventDefault();
    setArea(to);
    requestAnimationFrame(() => document.getElementById(to === 'dashboard' ? 'dashboard-heading' : 'sessions-heading')?.focus());
  };
  return (
    <>
      <a className="x-skip" href="#main">Skip to main content</a>
      <header className="x-frame">
        <nav aria-label="Areas" className="x-nav">
          <span className="x-mark">Xaibo</span>
          {/* ponytail: Agent Map and Settings links arrive with their areas (Phases 5–6); no placeholder links now. */}
          <a href="#dashboard" aria-current={area === 'dashboard' ? 'page' : undefined} onClick={go('dashboard')}>Dashboard</a>
          <a href="#session" aria-current={area === 'session' ? 'page' : undefined} onClick={go('session')}>Session</a>
        </nav>
        <HealthStatus health={health} />
      </header>
      <main id="main" className="x-main" tabIndex={-1}>
        {area === 'dashboard'
          ? <Dashboard live={liveSet} liveFailed={liveFailed} onRetryLive={retryLive} lastKnown={lastKnown} agents={agents} banners={banners} api={api} tick={tick}
            onSetPath={(agent) => window.xaibo?.setAgentPath(agent)} />
          : <SessionList list={list} loading={loading} onLoadMore={loadMore} lastKnown={lastKnown !== null} />}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
