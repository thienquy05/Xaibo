// Renderer entry (P1-T12): takes the brokered service port and main's health messages from the preload (window
// messages from this window only, validated), keeps the list state (model.ts) and renders health, agents and sessions.
import { StrictMode, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { parseHealth } from '../shared/ipc.ts';
import type { AgentStatus, Banner, Health, SessionRow } from '../shared/ipc.ts';
import { createClient, type Client, type PortLike } from './client.ts';
import { Coverage } from './Coverage.tsx';
import { AgentStrip, HealthStatus } from './Health.tsx';
import { applyDelta, applyPage, emptyList, PAGE, type ListState } from './model.ts';
import { firstUsablePage, LONG_FRAME, watchLongFrames } from './perf-marks.ts';
import { SessionList } from './SessionList.tsx';

declare global { interface Window { xaibo?: { setAgentPath(agent: string): void; paintAck(delta: number): void } } }

// M3 marks (P1-T14): read through the Performance API by test/perf.
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
    // P3-T10 perf trace: a delta id arrives only under XAIBO_PERF_TRACE=1; commit it now, then ack after rAF plus one
    // frame, so the ack follows the paint that shows it.
    const sessions = (rows: SessionRow[], delta?: number) => {
      if (delta === undefined) { setList((s) => applyDelta(s, rows)); return; }
      flushSync(() => setList((s) => applyDelta(s, rows)));
      requestAnimationFrame(() => requestAnimationFrame(() => window.xaibo?.paintAck(delta)));
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window) return;
      if (e.data === 'xaibo-port' && e.ports[0]) { // a (re)started service: new client, reload the first page
        client.current?.close();
        const c = createClient(e.ports[0] as unknown as PortLike, { sessions, agents: setAgents, coverage: setBanners });
        client.current = c;
        setLoading(false);
        // An invalid first page leaves the list empty; deltas and the next restart still fill it.
        c.listSessions(null, PAGE).then((page) => { if (client.current === c) setList((s) => applyPage(s, page, false)); }, () => undefined);
        return;
      }
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
