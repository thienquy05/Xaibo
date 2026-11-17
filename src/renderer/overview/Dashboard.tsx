// Dashboard (P4-T04c; design §6.1, §6.2, §5.2-§5.3): h1, the named "Dashboard view" group (Live sessions, Needs
// attention [n], Usage and history; Left/Right/Home/End rove, Enter/Space select and keep focus), the agent strip and
// coverage notices, the live-set summary and the active view. Quantity semantics come from the pure modules
// (totals.ts, queue.ts, usage/presentation.ts); while the collector is not running every live label reads "Last known".
// Service-supplied strings go through visible() (EC-55).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AgentStatus, Banner, HistoryCursor, SessionRow, UsageRecord, UsageScope } from '../../shared/ipc.ts';
import { VirtualList } from '../components/VirtualList.tsx';
import { nextFocus } from '../components/virtual-list-model.ts';
import { Coverage } from '../Coverage.tsx';
import { AgentStrip } from '../Health.tsx';
import { capText, costText, findingBadges, formatTime, openSessionLabels, recordLabel, statusExtras, type LiveSetState } from '../model.ts';
import { Record as SessionRecord } from '../SessionList.tsx';
import { StatusBadge } from '../status/StatusBadge.tsx';
import { visible } from '../text.ts';
import { dayRange, historyBounds, scopeBlocks, shiftDay, usageRefreshDue, usageView } from '../usage/presentation.ts';
import { attentionQueue, sinceText } from './queue.ts';
import { barGeometry, historyGeometry, quotaArc, tileSeries, type Datum } from './charts.ts';
import { abbreviate, liveSetSummary, type Summary } from './totals.ts';

export interface UsageApi {
  usage(): Promise<UsageScope[]>;
  history(scope: number, stream: string, from: number, to: number, cursor: HistoryCursor | null): Promise<{ records: UsageRecord[]; next: HistoryCursor | null }>;
}
export type View = 'live' | 'attention' | 'usage';
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
  /** P4-T05d: a live record's Open session button opens it in the Session area. */
  onOpen?: (row: SessionRow) => void;
  /** XAIBO-PROD-437: the selected view lives in the app, so it survives an area switch and Return to Dashboard. */
  view: View; onView: (v: View) => void;
  /** XAIBO-PROD-437 review M1: the record Return to Dashboard restores (its row stays mounted in the Live list). */
  focusId: number | null;
}) {
  const { view, onView: setView } = p;
  const lastKnown = p.lastKnown ?? (p.live.loaded && p.liveFailed ? 'refresh unavailable' : null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const summary = liveSetSummary(p.live.rows, p.live.more);
  const queue = attentionQueue(p.live.rows);
  const waiting = queue.reduce((n, g) => n + g.rows.length, 0);
  const name = (id: string) => visible(p.agents?.find((a) => a.agent === id)?.name ?? id);
  const series = tileSeries(p.live.rows, name);
  const label: Record<View, string> = {
    live: 'Live sessions',
    attention: p.live.loaded ? `Needs attention ${waiting}${p.live.more ? '+' : ''}${lastKnown ? ` · last known ${lastKnown}` : ''}` : 'Needs attention · count unavailable',
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
    <div className="x-dashboard">
      <div className="x-dashboard-head">
        <h1 id="dashboard-heading" tabIndex={-1}>Dashboard</h1>
        <div role="group" aria-label="Dashboard view" className="x-views">
          {VIEWS.map((v, i) => (
            <button key={v} ref={(el) => { buttons.current[i] = el; }} type="button" className="x-button x-view" aria-pressed={view === v}
              aria-controls={view === v ? `view-${v}` : undefined} tabIndex={view === v ? 0 : -1} onKeyDown={(e) => onKey(e, i)} onClick={() => setView(v)}>
              {label[v]}
            </button>
          ))}
        </div>
      </div>
      <Coverage banners={p.banners} agents={p.agents} />
      {p.live.loaded && p.liveFailed ? <p>Could not refresh live sessions. Showing last known data. <button type="button" className="x-button" onClick={p.onRetryLive}>Retry</button></p> : null}
      {p.live.loaded ? <LiveSummary s={summary} rows={p.live.rows} series={series} lastKnown={lastKnown} /> : (
        <section aria-labelledby="summary-heading" className="x-summary">
          <h2 id="summary-heading">Live-session set</h2>
          {p.liveFailed ? <p>Could not load live sessions. <button type="button" className="x-button" onClick={p.onRetryLive}>Retry</button></p> : <p>Loading live sessions…</p>}
        </section>
      )}
      <div className="x-dashboard-panels">
        <section id={`view-${view}`} aria-labelledby={`view-${view}-heading`} className="x-view-body">
          {view === 'live' ? <LiveView live={p.live} lastKnown={lastKnown} focusId={p.focusId} onOpen={p.onOpen} />
            : view === 'attention' ? <AttentionView queue={queue} lastKnown={lastKnown} name={name} onShowLive={showLive} onOpen={p.onOpen} />
              : <UsageView api={p.api} tick={p.tick} name={name} lastKnown={lastKnown} />}
        </section>
        {view === 'usage' ? <div className="x-dashboard-lower">
          <section className="x-panel" aria-labelledby="current-state-heading">
            <h2 id="current-state-heading">{lastKnown ? 'Last known current state' : 'Current state'}</h2>
            {p.live.loaded ? <><p className="x-chart-caption">{p.live.more ? 'Loaded subset' : 'Loaded live-session set'}{lastKnown ? ` · ${lastKnown}` : ''}</p><StateCounts data={series.states} /></> : <p>Current state unavailable</p>}
          </section>
          <AgentStrip agents={p.agents} onSetPath={p.onSetPath} />
          <section className="x-panel" aria-labelledby="monthly-heading">
            <h2 id="monthly-heading">Monthly usage</h2>
            <p>No observations yet — monthly totals are not available in this phase.</p>
          </section>
        </div> : <AgentStrip agents={p.agents} onSetPath={p.onSetPath} />}
      </div>
    </div>
  );
}

function LiveSummary({ s, rows, series, lastKnown }: { s: Summary; rows: SessionRow[]; series: ReturnType<typeof tileSeries>; lastKnown: string | null }) {
  const cover = (n: number, of: number, verb: string) => (of === 0 ? 'coverage unavailable' : `${verb} for ${n} of ${of} sessions`);
  const tokens = s.tokens.value === null ? 'Unavailable' : `${abbreviate(s.tokens.value)}${s.tokens.partial ? ' known subtotal' : ''}`;
  const times = rows.map((r) => r.lastActivity).filter((t): t is number => t !== null);
  const observed = times.length ? `Latest loaded session activity ${formatTime(Math.max(...times))}` : 'Observation time unavailable';
  const cost = s.cost.usd === null ? '~$ unavailable' : costText(s.cost.usd, s.cost.partial ? 'partial' : 'full');
  return (
    <section aria-labelledby="summary-heading" className="x-summary">
      <h2 id="summary-heading">{lastKnown ? `Last known live-session set · ${lastKnown}` : 'Live-session set'}</h2>
      <p>{`${lastKnown ? 'Last known live-session set' : 'Live-session set'}: ${s.sessions}${s.atLeast ? ' or more' : ''} currently tracked, non-ended sessions`}</p>
      <dl className="x-metrics">
        <div><dt>Active agents</dt><dd data-field="active-agents">{s.activeAgents}</dd>
          <dd className="x-metric-chart"><Microchart title="Active sessions by agent" unit="sessions" data={series.agents} /></dd>
        </div>
        <div><dt>Sessions</dt><dd data-field="sessions">{s.sessions}{s.atLeast ? ' or more' : ''}</dd>
          <dd className="x-metric-chart"><Microchart title="Sessions by live state" unit="sessions" data={series.states.map((d) => ({ ...d, label: stateName(d.label) }))} /></dd>
        </div>
        <div>
          <dt>Observed tokens</dt>
          <dd data-field="tokens">
            <span aria-hidden={s.tokens.value !== null}>{tokens}</span>
            {s.tokens.value !== null ? <span className="x-sr-only">{`${s.tokens.value.toLocaleString('en-US')} tokens${s.tokens.partial ? ', known subtotal' : ''}`}</span> : null}
            {' '}<span className="x-metric-evidence">{cover(s.tokens.observed, s.tokens.eligible, 'observed')}{s.tokens.low ? ' · coverage below 80%' : ''}</span>
          </dd>
          <dd className="x-metric-chart"><Microchart title="Observed tokens by session" unit="tokens" data={series.tokens} /></dd>
        </div>
        <div>
          <dt>Estimated cost</dt>
          <dd data-field="cost">{cost}{' '}<span className="x-metric-evidence">{cover(s.cost.priced, s.cost.eligible, 'priced')}{s.cost.low ? ' · coverage below 80%' : ''}</span></dd>
          <dd className="x-metric-chart"><Microchart title="Estimated cost by session" unit="estimated USD" data={series.cost} /></dd>
        </div>
      </dl>
      <p className="x-chart-caption">{s.atLeast ? 'Loaded subset' : 'Loaded live-session set'} · {observed}. Categorical bars, not time trends. Session estimates retain service cost coverage; price provenance is unavailable in this view.</p>
      <details className="x-micro-details"><summary>Session measurement coverage</summary><ul>{[...new Map(rows.map((r) => [r.id, r])).values()].map((r, i) => <li key={r.id}>
        Session {i + 1}: tokens {r.tokens === null ? 'unavailable' : `${r.tokens.toLocaleString('en-US')} · ${r.tokensComplete ? 'complete' : 'known subtotal'}`} · estimated cost coverage {r.costCoverage} · {r.lastActivity === null ? 'Activity time unavailable' : `Activity ${formatTime(r.lastActivity)}`}
      </li>)}</ul></details>
    </section>
  );
}


const stateName = (label: string) => label === 'waiting-for-permission' ? 'Waiting for permission' : label === 'needs-input' ? 'Needs input' : label.charAt(0).toUpperCase() + label.slice(1);
function StateCounts({ data }: { data: Datum[] }) {
  return <ul className="x-state-list">{data.map((d) => <li key={d.label}>{stateName(d.label)}: {d.value}</li>)}</ul>;
}
function Microchart({ title, unit, data }: { title: string; unit: string; data: Datum[] }) {
  const bars = barGeometry(data.map((d) => d.value));
  const max = data.reduce((max, d) => Math.max(max, d.value ?? 0), 0);
  return <>
    <svg className="x-micro" viewBox="0 0 240 46" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {bars.map((b, i) => b ? b.height === 0
        ? <path key={i} className="x-zero" d={`M${b.x} 43h${b.width}`} />
        : <rect key={i} x={b.x} y={44 - b.height} width={b.width} height={b.height} rx={2} /> : null)}
    </svg>
    <details className="x-micro-details"><summary>{title}</summary>
      <p>{data.some((d) => d.value !== null) ? `Local scale: zero to ${unit === 'estimated USD' ? costText(max, 'full') : max.toLocaleString('en-US')} ${unit}; loaded set only.` : 'Scale unavailable; no known values.'}</p>
      {data.length ? <ul>{data.map((d, i) => <li key={i}>{visible(d.label)}: {unit === 'estimated USD' ? `Estimated cost ${costText(d.value, d.coverage ?? 'unavailable')}` : d.value === null ? 'Unavailable' : `${d.value.toLocaleString('en-US')} ${unit}${d.partial ? ' known subtotal' : ''}`}</li>)}</ul> : <p>No active sessions observed.</p>}
    </details>
  </>;
}

const keyOf = (r: SessionRow) => r.id;
/** XAIBO-PROD-437 (design §8.1): Open session names per record, keyed by session id. */
// review L4: each list names the agent as it shows it (Live: the agent id; Needs attention: its display name)
const openNames = (rows: readonly SessionRow[], agent: (id: string) => string) => {
  const labels = openSessionLabels(rows.map((r) => ({ agent: agent(r.agent), place: r.cwd ? capText(r.cwd, 120) : 'Unknown folder' })));
  return new Map(rows.map((r, i) => [r.id, labels[i]!]));
};

function LiveView({ live, lastKnown, focusId, onOpen }: { live: LiveSetState; lastKnown: string | null; focusId: number | null; onOpen?: (row: SessionRow) => void }) {
  const labels = openNames(live.rows, (id) => capText(id, 60));
  return (
    <>
      <h2 id="view-live-heading" tabIndex={-1}>{lastKnown ? 'Last known live sessions' : 'Live sessions'}</h2>
      {live.more ? <p>Showing the {live.rows.length} most recently active live sessions; more are tracked.</p> : null}
      {!live.loaded ? <p>Loading live sessions…</p> : live.rows.length === 0 ? <p>No live sessions.</p> : (
        <VirtualList items={live.rows} getKey={keyOf} label="Live sessions" itemLabel={recordLabel} initialFocusKey={focusId} estimateSize={132} hasMore={false} loading={false} onLoadMore={() => undefined}
          render={(row) => <SessionRecord row={row} lastKnown={lastKnown !== null} onOpen={onOpen} openLabel={labels.get(row.id)} />} />
      )}
    </>
  );
}

function AttentionView({ queue, lastKnown, name, onShowLive, onOpen }: { queue: ReturnType<typeof attentionQueue>; lastKnown: string | null; name: (id: string) => string; onShowLive: () => void; onOpen?: (row: SessionRow) => void }) {
  const now = useNow(1000);
  const labels = openNames(queue.flatMap((g) => g.rows), name);
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
                {/* XAIBO-PROD-437 (design §6.2): each record opens its session */}
                {onOpen ? <button type="button" className="x-btn x-btn-primary x-record-open" data-open-id={r.id} aria-label={labels.get(r.id)} onClick={() => onOpen(r)}>Open session</button> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function UsageView({ api, tick, name, lastKnown }: { api: UsageApi; tick: number; name: (id: string) => string; lastKnown: string | null }) {
  const now = useNow(1000);
  const [scopes, setScopes] = useState<UsageScope[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const last = useRef(0);
  const seq = useRef(0);
  const failures = useRef(0); // consecutive failed reads
  const retrying = useRef(false); // the one immediate retry after a first failure is pending
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    // Refreshed on open and on new session activity (at most every 5 s): a local service read, never a quota request.
    // An answer is dropped only on unmount or when a newer request was sent (review M1), never by the throttle.
    // XAIBO-PROD-436: a first failure retries at the next tick, once (review M: not while that retry is pending)
    if (!usageRefreshDue(last.current, Date.now(), failures.current, retrying.current)) return;
    const retry = failures.current === 1 && Date.now() - last.current < 5000;
    last.current = Date.now();
    retrying.current ||= retry;
    const n = ++seq.current;
    const done = () => { if (retry) retrying.current = false; };
    api.usage().then((s) => { done(); failures.current = 0; if (mounted.current && n === seq.current) { setScopes(s); setFailed(false); } },
      () => { done(); failures.current++; if (mounted.current && n === seq.current) setFailed(true); });
  }, [api, tick]);
  const scopeKey = (s: UsageScope) => JSON.stringify([s.scope, s.agent, s.profile, s.stream]);
  const choice = scopes?.find((s) => scopeKey(s) === selected) ?? scopes?.find((s) => s.scope !== null && s.stream !== null) ?? scopes?.[0];
  return (
    <>
      <h2 id="view-usage-heading" tabIndex={-1}>Usage and history</h2>
      {scopes?.length ? <label className="x-scope-select">Usage scope and window
        <select value={choice ? scopeKey(choice) : ''} onChange={(e) => setSelected(e.target.value)}>
          {scopes.map((s) => <option key={scopeKey(s)} value={scopeKey(s)}>{name(s.agent)} · {visible(s.profile)} · {s.scope === null ? 'Scope unavailable' : `Scope ${s.scope}`} · {usageView(s, now).title}{s.stream ? ` · ${visible(s.stream)}` : ''}</option>)}
        </select>
      </label> : null}
      {failed && scopes !== null ? <p>Usage refresh unavailable; showing prior observations.</p> : null}
      {failed && scopes === null ? <p>Usage unavailable: the service did not answer.</p> : scopes === null ? <p>Loading usage…</p>
        : scopes.length === 0 ? <p>No usage scopes yet.</p> : scopeBlocks(scopes).map((b) => (
          <section key={b.key} className="x-scope" aria-label={`${name(b.agent)} · ${visible(b.profile)}`}>
            <h3>{name(b.agent)} · {visible(b.profile)}</h3>
            {b.unverified ? <p className="x-tone-warning">Account scope unverified</p> : null}
            {b.rows.map((s, i) => <ScopeRow key={`${s.stream ?? 'none'}-${i}`} s={s} now={now} api={api} lastKnown={lastKnown} selected={choice !== undefined && scopeKey(choice) === scopeKey(s)} onSelect={() => setSelected(scopeKey(s))} />)}
          </section>
        ))}
    </>
  );
}

function ScopeRow({ s, now, api, lastKnown, selected, onSelect }: { s: UsageScope; now: number; api: UsageApi; lastKnown: string | null; selected: boolean; onSelect: () => void }) {
  const v = usageView(s, now, lastKnown);
  const [open, setOpen] = useState(true);
  const button = useRef<HTMLButtonElement>(null);
  const arc = quotaArc(v.percent);
  const reading = <div className="x-gauge-reading">
    <h4>Observed quota · {v.title}</h4>
    <p><strong>{v.title}</strong>: <span data-field="usage-value" className={selected ? 'x-arc-value-text' : undefined}>{v.value}</span>
      {v.aboveScale ? <span> Above displayed scale</span> : null}
    </p>
    {selected && arc !== null ? <svg className="x-arc" viewBox="0 0 260 158" role="img" aria-label={`${v.title} utilization ${v.value}; displayed scale zero to 100 percent`}>
      <path className="x-arc-track" d="M8 130 A122 122 0 0 1 252 130" />
      {arc ? <path className="x-arc-value" d={arc} /> : null}
    </svg> : null}
    {selected && arc !== null ? <p className="x-chart-scale"><span>0%</span><span>100%</span></p> : null}
    {v.reset || v.countdown ? <p>{[v.reset, v.countdown].filter(Boolean).join(' · ')}</p> : null}
    {v.lastKnown ? <p className="x-tone-warning">{v.lastKnown}</p> : null}
    {v.stale ? <p className="x-tone-warning"><span aria-hidden="true">{v.stale}</span><span className="x-sr-only">{v.staleLabel}</span></p> : null}
    {v.plan || v.credits ? <p>{[v.plan, v.credits].filter(Boolean).join(' · ')}</p> : null}
    {v.freshness ? <p className="x-tone-muted">{v.freshness}</p> : null}
    <p className="x-chart-caption">{s.stream ? `Stream ${visible(s.stream)}` : 'Stream unavailable'} · {s.scope === null ? 'Scope unavailable' : `Scope ${s.scope}`} · local stored observation</p>
  </div>;
  return (
    <div className="x-scope-row" data-field="usage">
      {s.scope !== null && s.stream !== null ? <>
        <button ref={button} type="button" className="x-button" aria-expanded={selected && open} onClick={() => { if (selected) setOpen((o) => !o); else { setOpen(true); onSelect(); } }}>Observed history</button>
        <div className={selected && open ? 'x-instruments' : undefined}>
          {selected && open ? <History key={`${s.scope}-${s.stream}`} scope={s.scope} stream={s.stream} api={api} onClose={() => { setOpen(false); button.current?.focus(); }} /> : null}
          {reading}
        </div>
      </> : reading}
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
      {r.windowMinutes === null ? ' · Window unavailable' : ` · ${r.windowMinutes}-minute window`}
      {r.resetsAt !== null ? ` · Resets ${formatTime(r.resetsAt)}` : ' · Reset unavailable'}{r.kind === 'transition' ? ' · Window or reset changed' : ''}
      {r.sourceTimeKnown ? '' : ' · Source time unknown'}
    </li>
  );
  return (
    <div className="x-history" role="region" aria-label={`Observed history ${range.date}`} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <h4>Observed quota history</h4>
      <p aria-live="polite">{range.date}</p>
      <p className="x-chart-caption">Scope {scope} · stream {visible(stream)} · utilization (%) · local stored observations</p>
      <div className="x-views">
        <button type="button" className="x-button" aria-disabled={atFirst} onClick={step(-1, atFirst)}>Previous day</button>
        <button type="button" className="x-button" aria-disabled={atLast} onClick={step(1, atLast)}>Next day</button>
        <button type="button" className="x-button" onClick={onClose}>Close</button>
      </div>
      <HistoryChart records={records} />
      <div className="x-history-scroll">
        {records.length ? <ul>{records.map(row)}</ul> : state === 'ready' ? <p>No observations yet</p> : null}
        {state === 'loading' ? <p>Loading observations…</p> : null}
        {state === 'failed' ? <p>Observations unavailable. <button type="button" className="x-button" onClick={() => load(next)}>Retry</button></p> : null}
        {state === 'ready' && next ? <button type="button" className="x-button" onClick={() => load(next)}>Load more</button> : null}
      </div>
    </div>
  );
}

function HistoryChart({ records }: { records: UsageRecord[] }) {
  const g = historyGeometry(records);
  if (!records.length) return null;
  return <>
    <p className="x-chart-caption">Utilization (%) · scale 0–{g.maxPercent}%</p>
    {g.points.length ? <svg className="x-history-chart" viewBox="0 0 560 235" role="img" aria-label={`Observed quota history, ${g.points.length} percentage observations; observation records below. Missing minutes and window changes break the line.`}>
      <path className="x-chart-axis" d="M32 16V208H528" />
      {g.segments.filter((part) => part.length > 1).map((part, i) => {
        const trace = part.map((p) => `${p.x} ${p.y}`).join(' L');
        return <g key={i}><path className="x-chart-area" d={`M${part[0]!.x} 200 L${trace} L${part.at(-1)!.x} 200 Z`} /><path className="x-chart-line" d={`M${trace}`} /></g>;
      })}
      {g.points.map((p) => <circle key={p.record.id} className="x-chart-point" cx={p.x} cy={p.y} r={3} />)}
    </svg> : <p>Utilization unavailable for loaded observations.</p>}
    <p className="x-chart-scale"><span>{formatTime(g.from).slice(11)}</span><span>{formatTime(g.to).slice(11)}</span></p>
    <p className="x-chart-caption">Loaded range: {formatTime(g.from)} – {formatTime(g.to)}. Displayed scale 0–{g.maxPercent}%; values rounded to one decimal below. Straight joins show sequence only between adjacent observed minutes of the same known window/reset; no measured intermediate values. Missing minutes, unknown source time and transitions break the line and area. {records.length} loaded records.</p>
  </>;
}
