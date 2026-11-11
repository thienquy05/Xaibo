// Renderer entry (P1-T12): takes the brokered service port and main's health messages from the preload (window
// messages from this window only, validated), keeps the list state (model.ts) and renders health, agents and sessions.
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHealth } from '../shared/ipc.ts';
import type { AgentStatus, Health } from '../shared/ipc.ts';
import { createClient, type Client, type PortLike } from './client.ts';
import { AgentStrip, HealthStatus } from './Health.tsx';
import { applyDelta, applyPage, emptyList, PAGE, type ListState } from './model.ts';
import { firstUsablePage, LONG_FRAME, watchLongFrames } from './perf-marks.ts';
import { SessionList } from './SessionList.tsx';

declare global { interface Window { xaibo?: { setAgentPath(agent: string): void } } }

// M3 marks (P1-T14): read through the Performance API by test/perf.
const onListCommit = firstUsablePage({ raf: (cb) => requestAnimationFrame(cb), mark: (n) => performance.mark(n) });
watchLongFrames((start, duration) => performance.measure(LONG_FRAME, { start, duration }), globalThis.PerformanceObserver);

function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [list, setList] = useState<ListState>(emptyList);
  const [loading, setLoading] = useState(false);
  const client = useRef<Client | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window) return;
      if (e.data === 'xaibo-port' && e.ports[0]) { // a (re)started service: new client, reload the first page
        client.current?.close();
        const c = createClient(e.ports[0] as unknown as PortLike, { sessions: (rows) => setList((s) => applyDelta(s, rows)), agents: setAgents });
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
      </header>
      <main>
        <SessionList list={list} loading={loading} onLoadMore={loadMore} />
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
