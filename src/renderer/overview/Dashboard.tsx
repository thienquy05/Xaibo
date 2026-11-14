// Dashboard (P4-T04c; design §6.1, §6.2, §5.2-§5.3): h1, the named "Dashboard view" group (Live sessions, Needs
// attention [n], Usage and history; Left/Right/Home/End rove, Enter/Space select and keep focus), the agent strip and
// coverage notices, the live-set summary and the active view. Every number and label comes from the pure modules
// (totals.ts, queue.ts, usage/presentation.ts); while the collector is not running every live label reads "Last known".
// Service-supplied strings go through visible() (EC-55).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AgentStatus, Banner, HistoryCursor, SessionRow, UsageRecord, UsageScope } from '../../shared/ipc.ts';
import { VirtualList } from '../components/VirtualList.tsx';
import { nextFocus } from '../components/virtual-list-model.ts';
import { Coverage } from '../Coverage.tsx';
import { AgentStrip } from '../Health.tsx';
import { costText, findingBadges, formatTime, statusExtras, type LiveSetState } from '../model.ts';
import { Record as SessionRecord } from '../SessionList.tsx';
import { StatusBadge } from '../status/StatusBadge.tsx';
import { visible } from '../text.ts';
import { dayRange, historyBounds, scopeBlocks, shiftDay, usageView } from '../usage/presentation.ts';
import { attentionQueue, sinceText } from './queue.ts';
import { abbreviate, liveSetSummary, type Summary } from './totals.ts';

export interface UsageApi {
  usage(): Promise<UsageScope[]>;
  history(scope: number, stream: string, from: number, to: number, cursor: HistoryCursor | null): Promise<{ records: UsageRecord[]; next: HistoryCursor | null }>;
}
type View = 'live' | 'attention' | 'usage';
const VIEWS: View[] = ['live', 'attention', 'usage'];

/** The local clock, re-read every `ms` while mounted (countdowns, Since); never a request to anything. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export function Dashboard(p: {
  live: LiveSetState; liveFailed: boolean; onRetryLive: () => void; lastKnown: string | null; agents: AgentStatus[] | null; banners: Banner[];
  api: UsageApi; tick: number; onSetPath: (agent: string) => void;
}) {
  const [view, setView] = useState<View>('live');
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const summary = liveSetSummary(p.live.rows, p.live.more);
  const queue = attentionQueue(p.live.rows);
  const waiting = queue.reduce((n, g) => n + g.rows.length, 0);
  const name = (id: string) => visible(p.agents?.find((a) => a.agent === id)?.name ?? id);
  const label: Record<View, string> = {
    live: 'Live sessions',
    attention: p.live.loaded ? `Needs attention ${waiting}${p.live.more ? '+' : ''}${p.lastKnown ? ` · last known ${p.lastKnown}` : ''}` : 'Needs attention · count unavailable',
    usage: 'Usage and history',
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = nextFocus(i, e.key, VIEWS.length, 'horizontal');
    if (n === null || n < 0) return;
    e.preventDefault();
    buttons.current[n]?.focus();
  };
  const showLive = () => { setView('live'); requestAnimationFrame(() => document.getElementById('view-live-heading')?.focus()); };
  return (
    <>
      <h1 id="dashboard-heading" tabIndex={-1}>Dashboard</h1>
      <div role="group" aria-label="Dashboard view" className="x-views">
        {VIEWS.map((v, i) => (
          <button key={v} ref={(el) => { buttons.current[i] = el; }} type="button" className="x-button x-view" aria-pressed={view === v}
            aria-controls={view === v ? `view-${v}` : undefined} tabIndex={view === v ? 0 : -1} onKeyDown={(e) => onKey(e, i)} onClick={() => setView(v)}>
            {label[v]}
          </button>
        ))}
      </div>
      <AgentStrip agents={p.agents} onSetPath={p.onSetPath} />
      <Coverage banners={p.banners} agents={p.agents} />
      {p.live.loaded ? <LiveSummary s={summary} lastKnown={p.lastKnown} /> : (
        <section aria-labelledby="summary-heading" className="x-summary">
          <h2 id="summary-heading">Live-session set</h2>
          {p.liveFailed ? <p>Could not load live sessions. <button type="button" className="x-button" onClick={p.onRetryLive}>Retry</button></p> : <p>Loading live sessions…</p>}
        </section>
      )}
      <section id={`view-${view}`} aria-labelledby={`view-${view}-heading`} className="x-view-body">
        {view === 'live' ? <LiveView live={p.live} lastKnown={p.lastKnown} />
          : view === 'attention' ? <AttentionView queue={queue} lastKnown={p.lastKnown} name={name} onShowLive={showLive} />
            : <UsageView api={p.api} tick={p.tick} name={name} />}
      </section>
    </>
  );
}

function LiveSummary({ s, lastKnown }: { s: Summary; lastKnown: string | null }) {
  const cover = (n: number, of: number, verb: string) => (of === 0 ? 'coverage unavailable' : `${verb} for ${n} of ${of} sessions`);
  const tokens = s.tokens.value === null ? 'Unavailable' : `${abbreviate(s.tokens.value)}${s.tokens.partial ? ' known subtotal' : ''}`;
  const cost = s.cost.usd === null ? '~$ unavailable' : costText(s.cost.usd, s.cost.partial ? 'partial' : 'full');
  return (
    <section aria-labelledby="summary-heading" className="x-summary">
      <h2 id="summary-heading">{lastKnown ? `Last known live-session set · ${lastKnown}` : 'Live-session set'}</h2>
      <p>{`${lastKnown ? 'Last known live-session set' : 'Live-session set'}: ${s.sessions}${s.atLeast ? ' or more' : ''} currently tracked, non-ended sessions`}</p>
      <dl className="x-record-fields">
        <div><dt>Active agents</dt><dd data-field="active-agents">{s.activeAgents}</dd></div>
        <div><dt>Sessions</dt><dd data-field="sessions">{s.sessions}{s.atLeast ? ' or more' : ''}</dd></div>
        <div>
          <dt>Observed tokens</dt>
          <dd data-field="tokens">
            <span aria-hidden={s.tokens.value !== null}>{tokens}</span>
            {s.tokens.value !== null ? <span className="x-sr-only">{`${s.tokens.value.toLocaleString('en-US')} tokens${s.tokens.partial ? ', known subtotal' : ''}`}</span> : null}
            {' · '}{cover(s.tokens.observed, s.tokens.eligible, 'observed')}{s.tokens.low ? ' · coverage below 80%' : ''}
          </dd>
        </div>
        <div>
          <dt>Estimated cost</dt>
          <dd data-field="cost">{cost} · {cover(s.cost.priced, s.cost.eligible, 'priced')}{s.cost.low ? ' · coverage below 80%' : ''}</dd>
        </div>
      </dl>
    </section>
  );
}

const keyOf = (r: SessionRow) => r.id;
function LiveView({ live, lastKnown }: { live: LiveSetState; lastKnown: string | null }) {
  return (
    <>
      <h2 id="view-live-heading" tabIndex={-1}>{lastKnown ? 'Last known live sessions' : 'Live sessions'}</h2>
      {live.more ? <p>Showing the {live.rows.length} most recently active live sessions; more are tracked.</p> : null}
      {!live.loaded ? <p>Loading live sessions…</p> : live.rows.length === 0 ? <p>No live sessions.</p> : (
        <VirtualList items={live.rows} getKey={keyOf} label="Live sessions" estimateSize={132} hasMore={false} loading={false} onLoadMore={() => undefined}
          render={(row) => <SessionRecord row={row} lastKnown={lastKnown !== null} />} />
      )}
    </>
  );
}

function AttentionView({ queue, lastKnown, name, onShowLive }: { queue: ReturnType<typeof attentionQueue>; lastKnown: string | null; name: (id: string) => string; onShowLive: () => void }) {
  const now = useNow(1000);
  return (
    <>
      <h2 id="view-attention-heading" tabIndex={-1}>{lastKnown ? `Last known needs attention · ${lastKnown}` : 'Needs attention'}</h2>
      {queue.length === 0 ? (
        <p>Nothing needs attention. View Live sessions to continue monitoring. <button type="button" className="x-button" onClick={onShowLive}>Live sessions</button></p>
      ) : queue.map((g) => (
        <section key={g.name} aria-labelledby={`queue-${g.name.replace(/ /g, '-')}`}>
          <h3 id={`queue-${g.name.replace(/ /g, '-')}`}>{g.name}</h3>
          <ul aria-label={g.name} className="x-queue">
            {g.rows.map((r) => (
              <li key={r.id} className="x-record">
                <p className="x-record-head"><span data-field="agent">{name(r.agent)}</span><span data-field="project">Project</span></p>
                <p className="x-record-status" data-field="status">
                  {lastKnown ? <span>Last known: </span> : null}
                  <StatusBadge status={r.live} />
                  {r.live ? statusExtras(r.live).map((t) => <span key={t}> · {t}</span>) : null}
                  {findingBadges(r.live).map((b) => <span key={b.text}> · {b.text}</span>)}
                </p>
                <p data-field="since">{sinceText(r.live?.since ?? null, now)}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function UsageView({ api, tick, name }: { api: UsageApi; tick: number; name: (id: string) => string }) {
  const now = useNow(1000);
  const [scopes, setScopes] = useState<UsageScope[] | null>(null);
  const [failed, setFailed] = useState(false);
  const last = useRef(0);
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    // Refreshed on open and on new session activity (at most every 5 s): a local service read, never a quota request.
    // An answer is dropped only on unmount or when a newer request was sent (review M1), never by the throttle.
    if (Date.now() - last.current < 5000) return;
    last.current = Date.now();
    const n = ++seq.current;
    api.usage().then((s) => { if (mounted.current && n === seq.current) { setScopes(s); setFailed(false); } },
      () => { if (mounted.current && n === seq.current) setFailed(true); });
  }, [api, tick]);
  return (
    <>
      <h2 id="view-usage-heading" tabIndex={-1}>Usage and history</h2>
      {failed && scopes === null ? <p>Usage unavailable: the service did not answer.</p> : scopes === null ? <p>Loading usage…</p>
        : scopes.length === 0 ? <p>No usage scopes yet.</p> : scopeBlocks(scopes).map((b) => (
          <section key={b.key} className="x-scope" aria-label={`${name(b.agent)} · ${visible(b.profile)}`}>
            <h3>{name(b.agent)} · {visible(b.profile)}</h3>
            {b.unverified ? <p className="x-tone-warning">Account scope unverified</p> : null}
            {b.rows.map((s, i) => <ScopeRow key={`${s.stream ?? 'none'}-${i}`} s={s} now={now} api={api} />)}
          </section>
        ))}
    </>
  );
}

function ScopeRow({ s, now, api }: { s: UsageScope; now: number; api: UsageApi }) {
  const v = usageView(s, now);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className="x-scope-row" data-field="usage">
      <p><strong>{v.title}</strong>: <span data-field="usage-value">{v.value}</span>
        {v.percent !== null ? <> <meter min={0} max={100} value={Math.min(v.percent, 100)} aria-label={`${v.title} utilization`} /></> : null}
        {v.aboveScale ? <span> Above displayed scale</span> : null}
      </p>
      {v.reset || v.countdown ? <p>{[v.reset, v.countdown].filter(Boolean).join(' · ')}</p> : null}
      {v.stale ? <p className="x-tone-warning">{v.stale}</p> : null}
      {v.plan || v.credits ? <p>{[v.plan, v.credits].filter(Boolean).join(' · ')}</p> : null}
      {v.freshness ? <p className="x-tone-muted">{v.freshness}</p> : null}
      {s.scope !== null && s.stream !== null ? (
        <>
          <button ref={button} type="button" className="x-button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Observed history</button>
          {open ? <History scope={s.scope} stream={s.stream} api={api} onClose={() => { setOpen(false); button.current?.focus(); }} /> : null}
        </>
      ) : null}
    </div>
  );
}

function History({ scope, stream, api, onClose }: { scope: number; stream: string; api: UsageApi; onClose: () => void }) {
  const [bounds] = useState(() => historyBounds(Date.now()));
  const [day, setDay] = useState(bounds.last);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [next, setNext] = useState<HistoryCursor | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const range = dayRange(day);
  const seq = useRef(0);
  const load = (cursor: HistoryCursor | null) => {
    const n = ++seq.current; // review L: an answer for an earlier day or page never lands under the current heading
    setState('loading');
    api.history(scope, stream, range.from, range.to, cursor).then((p) => {
      if (n !== seq.current) return;
      setRecords((r) => (cursor ? [...r, ...p.records] : p.records));
      setNext(p.next);
      setState('ready');
    }, () => { if (n === seq.current) setState('failed'); }); // prior observations stay visible; Retry below
  };
  // Review L: at a bound the button stays focusable (aria-disabled) so keyboard focus never drops to the body.
  const step = (days: number, blocked: boolean) => () => { if (!blocked) setDay((d) => shiftDay(d, days)); };
  const atFirst = day <= bounds.first, atLast = day >= bounds.last;
  useEffect(() => { setRecords([]); setNext(null); load(null); }, [day]); // reload per day only
  const row = (r: UsageRecord): ReactNode => (
    <li key={r.id}>
      {formatTime(r.measuredAt).slice(11)} · {r.usedPercent === null ? 'Utilization unavailable' : `${Math.round(r.usedPercent * 10) / 10}%`}
      {r.resetsAt !== null ? ` · Resets ${formatTime(r.resetsAt)}` : ''}{r.kind === 'transition' ? ' · Window or reset changed' : ''}
      {r.sourceTimeKnown ? '' : ' · Source time unknown'}
    </li>
  );
  return (
    <div className="x-history" role="region" aria-label={`Observed history ${range.date}`} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <h4 aria-live="polite">{range.date}</h4>
      <div className="x-views">
        <button type="button" className="x-button" aria-disabled={atFirst} onClick={step(-1, atFirst)}>Previous day</button>
        <button type="button" className="x-button" aria-disabled={atLast} onClick={step(1, atLast)}>Next day</button>
        <button type="button" className="x-button" onClick={onClose}>Close</button>
      </div>
      <div className="x-history-scroll">
        {records.length ? <ul>{records.map(row)}</ul> : state === 'ready' ? <p>No observations for this day</p> : null}
        {state === 'loading' ? <p>Loading observations…</p> : null}
        {state === 'failed' ? <p>Observations unavailable. <button type="button" className="x-button" onClick={() => load(next)}>Retry</button></p> : null}
        {state === 'ready' && next ? <button type="button" className="x-button" onClick={() => load(next)}>Load more</button> : null}
      </div>
    </div>
  );
}
