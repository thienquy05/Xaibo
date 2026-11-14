// Renderer entry (P1-T12): takes the brokered service port and main's health messages from the preload (window
// messages from this window only, validated), keeps the list state (model.ts) and renders health, agents and sessions.
import { StrictMode, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { parseHealth } from '../shared/ipc.ts';
import type { AgentStatus, Banner, Health, SessionRow } from '../shared/ipc.ts';
import { createClient, parseVisible, type Client, type PortLike } from './client.ts';
import { Coverage } from './Coverage.tsx';
import { AgentStrip, HealthStatus } from './Health.tsx';
import { createCoalescer } from './data/coalesce.ts';
import { applyDelta, applyPage, emptyList, PAGE, type ListState } from './model.ts';
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
  const client = useRef<Client | null>(null);

  useEffect(() => {
    // The first page by cursor, replacing the list: after a (re)start, a coalescer overflow or showing the window.
    const reload = (c: Client | null) => {
      c?.listSessions(null, PAGE).then((page) => { if (client.current === c) setList((s) => applyPage(s, page, false)); }, () => undefined);
    };
    // P4-T02: deltas are coalesced per session and committed once per frame. P3-T10 perf trace: delta ids arrive only
    // under XAIBO_PERF_TRACE=1 and are acked after rAF plus one frame, so the ack follows the paint that shows them.
    const deltas = createCoalescer<SessionRow>({
      max: DELTA_MAX, schedule: (cb) => requestAnimationFrame(cb), resync: () => reload(client.current),
      flush: (rows, tags) => {
        flushSync(() => setList((s) => applyDelta(s, rows)));
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
      if (h) setHealth(h);
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

  return (
    <>
      <header>
        <h1>Xaibo</h1>
        <HealthStatus health={health} />
        <AgentStrip agents={agents} onSetPath={(agent) => window.xaibo?.setAgentPath(agent)} />
        <Coverage banners={banners} agents={agents} />
      </header>
      <main>
        <SessionList list={list} loading={loading} onLoadMore={loadMore} />
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
