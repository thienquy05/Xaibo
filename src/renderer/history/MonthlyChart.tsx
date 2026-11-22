// XAIBO-PROD-524 (P5-T17b; design §6.1.1, US-20, FR-52): the monthly usage ledger in Dashboard > Usage and history.
// Hand-written SVG bars for one metric, every bar with its visible number; words with no bar for no observations or an
// unavailable value; an outlined baseline for an evidenced zero. Under the chart: month controls (roving focus; Enter or
// Space opens the month's detail and provenance), a semantic table with exact values, and quota peaks in their own
// section (per usage scope; the model filter does not apply). Metric, agent and model filters are local to this panel;
// Previous/Next months fetch bounded pages from the service (never all history). Logic lives in monthly-view.ts.
import { useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from 'react';
import type { LedgerFilter, LedgerMonth, LedgerPage } from '../../shared/ipc.ts';
import { rovingKey } from '../components/virtual-list-model.ts';
import { visible } from '../text.ts';
import { bars, ledgerStatus, metricValue, METRIC_LABEL, METRICS, monthLabel, monthsPerPage, PLOT, quotaRows, scaleCaption, shortMonth, type Metric } from './monthly-view.ts';

export type MonthlyApi = (filter: LedgerFilter, end: string | null, limit: number) => Promise<LedgerPage & { failed?: true }>;
const COL = 96, TOP = 28, HEIGHT = 220; // SVG units per month; numbers above the plot, month names below

const num = (n: number | null) => (n === null ? 'Unavailable' : n.toLocaleString('en-US'));
const tokensText = (m: LedgerMonth) => !m.observed ? 'No observations' : !m.tokens ? 'Unavailable'
  : `${num(m.tokens.total)} (input ${num(m.tokens.uncachedInput)}, cache read ${num(m.tokens.cacheRead)}, cache write ${num(m.tokens.cacheWrite)}, output ${num(m.tokens.output)}${m.tokens.gaps ? `; ${m.tokens.gaps} requests with missing counts` : ''})`;
const coverageText = (m: LedgerMonth) => !m.cost ? 'Coverage unavailable'
  : `${m.cost.full} priced, ${m.cost.partial} partly priced, ${m.cost.none} unpriced, ${m.cost.pending} pending`;
const revisionsText = (m: LedgerMonth) => (m.priceRevisions.length ? `Price revisions ${m.priceRevisions.join(', ')}` : 'No price revision');

/** The ledger for one fetched page (presentational; state lives in MonthlyChart). */
export function MonthlyLedger(p: { page: LedgerPage; metric: Metric; selected: number; open: string | null; onSelect: (i: number) => void;
  onOpen: (month: string) => void; onKey: (e: KeyboardEvent, i: number) => void; controls: MutableRefObject<(HTMLButtonElement | null)[]> }) {
  const months = p.page.months, b = bars(months, p.metric), width = Math.max(1, months.length) * COL;
  const opened = months.find((m) => m.month === p.open) ?? null;
  const quota = quotaRows(p.page.quota);
  return (
    <>
      <svg className="x-monthly-chart" viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="xMinYMid meet" role="img"
        aria-label={`${METRIC_LABEL[p.metric]} by month, ${months.length} months; exact values in the table below`}>
        <line className="x-chart-axis" x1={0} x2={width} y1={TOP + PLOT} y2={TOP + PLOT} />
        {months.map((m, i) => {
          const x = i * COL + COL / 2, bar = b[i]!, [first, second] = bar.value.text.split(' known subtotal');
          const top = TOP + PLOT - (bar.height ?? 0);
          return (
            <g key={m.month}>
              {bar.height !== null && bar.height > 0 ? <rect className="x-monthly-bar" x={x - 16} y={top} width={32} height={bar.height} /> : null}
              {bar.zero ? <line className="x-zero" x1={x - 16} x2={x + 16} y1={TOP + PLOT - 1} y2={TOP + PLOT - 1} /> : null}
              <text className="x-monthly-value" x={x} y={bar.height === null ? TOP + PLOT / 2 : top - 8} textAnchor="middle">
                {second === undefined ? first : <><tspan x={x}>{first}</tspan><tspan x={x} dy="1.2em">known subtotal</tspan></>}
              </text>
              <text className="x-monthly-month" x={x} y={HEIGHT - 8} textAnchor="middle">{shortMonth(m.month)}</text>
            </g>
          );
        })}
      </svg>
      <p className="x-chart-caption">{scaleCaption(months, p.metric)}</p>
      <div role="group" aria-label="Months" className="x-monthly-months">
        {months.map((m, i) => (
          <button key={m.month} ref={(el) => { p.controls.current[i] = el; }} type="button" className="x-button" data-month={m.month}
            tabIndex={i === p.selected ? 0 : -1} aria-expanded={p.open === m.month} aria-controls={p.open === m.month ? 'monthly-detail' : undefined}
            onFocus={() => p.onSelect(i)} onKeyDown={(e) => p.onKey(e, i)} onClick={() => p.onOpen(m.month)}>
            {`${monthLabel(m)}: ${metricValue(m, p.metric).text}`}
          </button>
        ))}
      </div>
      {opened ? (
        <div id="monthly-detail" className="x-monthly-detail" role="region" aria-label={`${shortMonth(opened.month)} detail`}>
          <dl>
            <div><dt>Sessions</dt><dd>{opened.observed ? num(opened.sessions) : 'No observations'}</dd></div>
            <div><dt>Turns</dt><dd>{opened.observed ? num(opened.turns) : 'No observations'}</dd></div>
            <div><dt>Observed tokens</dt><dd>{tokensText(opened)}</dd></div>
            <div><dt>Estimated cost</dt><dd>{`${metricValue(opened, 'cost').text} · ${coverageText(opened)} · ${revisionsText(opened)}`}</dd></div>
          </dl>
          <p>{opened.detail === 'totals-only' ? 'Details expired: only this month’s totals are kept, so there are no retained sessions to open.'
            : opened.detail === 'some-expired' ? 'Some details expired: totals include sessions that are no longer retained.' : 'All details for this month are retained.'}</p>
        </div>
      ) : null}
      {/* T15b reflow: a wide table scrolls in its own keyboard-reachable region, never the page (WCAG 1.4.10 data-table exception) */}
      <div className="x-monthly-scroll" tabIndex={0} role="region" aria-label="Monthly usage values"><table className="x-table x-monthly-table">
        <caption className="x-sr-only">Monthly usage values</caption>
        <thead><tr><th scope="col">Month</th><th scope="col">Sessions</th><th scope="col">Turns</th><th scope="col">Observed tokens</th><th scope="col">Estimated cost</th><th scope="col">Provenance</th></tr></thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.month}>
              <th scope="row">{monthLabel(m)}</th>
              <td>{m.observed ? num(m.sessions) : 'No observations'}</td>
              <td>{m.observed ? num(m.turns) : 'No observations'}</td>
              <td>{tokensText(m)}</td>
              <td>{m.observed ? metricValue(m, 'cost').text : 'No observations'}</td>
              <td>{m.observed ? `${coverageText(m)}; ${revisionsText(m)}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <section aria-labelledby="quota-peaks-heading" className="x-monthly-quota">
        <h3 id="quota-peaks-heading">Quota peaks</h3>
        <p className="x-chart-caption">Quota peaks are per usage scope; model filter does not apply</p>
        {quota.length ? (
          <div className="x-monthly-scroll" tabIndex={0} role="region" aria-label="Quota peak values"><table className="x-table">
            <thead><tr><th scope="col">Month</th><th scope="col">Usage scope</th><th scope="col">Limit</th><th scope="col">Peak observed</th><th scope="col">Verification</th></tr></thead>
            <tbody>
              {quota.map((q) => (
                <tr key={`${q.month}-${q.scope}-${q.limit}-${q.window}`}>
                  <th scope="row">{shortMonth(q.month)}</th><td>{visible(q.scope)}</td><td>{`${visible(q.limit)} · ${q.window}`}</td>
                  <td>{`${q.peak} (${q.observations} observations)`}</td><td>{q.verified}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : <p>No quota peaks observed in these months</p>}
      </section>
    </>
  );
}

const ALL = 'all'; // option values: 'all', or 'v:' + the value ('' is a real model id: model unavailable)
/** The panel: metric and filters, paging, loading and failure states. */
export function MonthlyChart({ api, name }: { api: MonthlyApi; name: (agent: string) => string }) {
  const [metric, setMetric] = useState<Metric>('tokens');
  const [draft, setDraft] = useState({ agent: ALL, model: ALL });
  const [filter, setFilter] = useState<LedgerFilter>({ agent: null, model: null });
  const [end, setEnd] = useState<string | null>(null);
  const [perPage, setPerPage] = useState(6);
  const [state, setState] = useState<{ page: LedgerPage | null; failed: boolean; loading: boolean }>({ page: null, failed: false, loading: true });
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // review M4: the last loaded filter options stay while a page is loading or failed (the service sends unfiltered lists)
  const [opts, setOpts] = useState<{ agents: string[]; models: string[] }>({ agents: [], models: [] });
  const refocus = useRef(false); // review M2: focus moves into the ledger after a Retry that loads
  const prev = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const controls = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => { // months per page follow the panel width
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setPerPage(monthsPerPage(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    // ponytail: fetched when the filter, page or width changes and on Retry, not on every live update; add a refresh on a
    // service push if month-to-date totals must tick while the panel stays open
    api(filter, end, perPage).then((page) => {
      if (!live) return;
      setState({ page: page.failed ? null : page, failed: !!page.failed, loading: false });
      setSelected((i) => Math.min(i, Math.max(0, page.months.length - 1)));
      if (!page.failed) setOpts({ agents: page.agents, models: page.models });
      if (!page.failed && refocus.current) {
        refocus.current = false;
        requestAnimationFrame(() => (controls.current[0] ?? prev.current)?.focus());
      }
    }, () => { if (live) setState({ page: null, failed: true, loading: false }); });
    return () => { live = false; };
  }, [api, filter, end, perPage, attempt]);
  const page = state.page;
  const range = page?.months.length ? `${shortMonth(page.months[0]!.month)} to ${shortMonth(page.months.at(-1)!.month)}` : '';
  const options = (xs: string[], label: (x: string) => string) => xs.map((x) => <option key={x} value={`v:${x}`}>{label(x)}</option>);
  const fromOption = (v: string) => (v === ALL ? null : v.slice(2));
  return (
    <div ref={box} className="x-monthly">
      <div className="x-monthly-controls">
        <label>Metric
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>{METRICS.map((m) => <option key={m} value={m}>{METRIC_LABEL[m]}</option>)}</select>
        </label>
        <label>Agent
          <select value={draft.agent} onChange={(e) => setDraft({ ...draft, agent: e.target.value })}>
            <option value={ALL}>All agents</option>{options(opts.agents, name)}
          </select>
        </label>
        <label>Model
          <select value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })}>
            <option value={ALL}>All models</option>{options(opts.models, (x) => (x ? visible(x) : 'Model unavailable'))}
          </select>
        </label>
        <button type="button" className="x-button" onClick={() => { setFilter({ agent: fromOption(draft.agent), model: fromOption(draft.model) }); setEnd(null); setOpen(null); }}>Apply</button>
        <button type="button" className="x-button" onClick={() => { setDraft({ agent: ALL, model: ALL }); setFilter({ agent: null, model: null }); setEnd(null); setOpen(null); }}>Reset</button>
      </div>
      <div className="x-monthly-paging">
        {/* review M1: aria-disabled, not disabled, so focus stays on the button after the last page loads */}
        <button ref={prev} type="button" className="x-button" aria-disabled={!page?.older} onClick={() => { if (page?.older) { setEnd(page.older); setOpen(null); } }}>Previous months</button>
        <button type="button" className="x-button" aria-disabled={!page?.newer} onClick={() => { if (page?.newer) { setEnd(page.newer); setOpen(null); } }}>Next months</button>
        <span aria-live="polite" className="x-chart-caption">{ledgerStatus({ loading: state.loading, failed: state.failed, range })}</span>
      </div>
      {state.failed ? <p className="x-gap">Could not load monthly usage. <button type="button" className="x-button" onClick={() => { refocus.current = true; setAttempt((n) => n + 1); }}>Retry</button></p>
        : page && !page.months.length ? <p>No observations yet. Monthly totals appear after the first observed session.</p>
          : page ? <MonthlyLedger page={page} metric={metric} selected={selected} open={open} controls={controls} onSelect={setSelected}
            onOpen={(m) => setOpen((o) => (o === m ? null : m))} onKey={(e, i) => rovingKey(e, i, page.months.length, controls.current)} /> : null}
    </div>
  );
}
