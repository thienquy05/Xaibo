// XAIBO-PROD-415 (P4-T06b; PRD FR-47, US-17; design §6.3.1, C21): the Context section of an open session, in design
// order: model · effort, value, meter (or its unavailable note), source/time/Stale, generation, category tables.
// Every value comes from contextView; this component only lays it out.
import type { ContextReading, SessionDetail, SessionRow } from '../../../shared/ipc.ts';
import { Icon } from '../../status/StatusBadge.tsx';
import { visible } from '../../text.ts';
import { CATEGORY_ROWS, contextView, percentWords } from './format.ts';

const GROUPS = ['Used context', 'Outside used context', 'Deferred definitions'];

/** Review M: loading until the detail arrives; a failed detail is unavailable with Retry, never endless loading. */
export function ContextPane({ row, detail, failed, onRetry, now }: { row: SessionRow; detail: SessionDetail | null; failed: boolean; onRetry: () => void; now: number }) {
  if (detail) return <ContextSection row={row} reading={detail.context} now={now} />;
  if (!failed) return <p className="x-context-note">Loading context…</p>;
  return <p className="x-gap" role="alert">Context unavailable — session detail could not be loaded <button type="button" className="x-btn x-btn-secondary" onClick={onRetry}>Retry</button></p>;
}

export function ContextSection({ row, reading, now }: { row: SessionRow; reading: ContextReading | null; now: number }) {
  const v = contextView(row.agent, row.live !== null && row.live.lifecycle !== 'ended', reading, now);
  const awaiting = v.value === 'Awaiting next usage';
  return (
    <div className="x-context">
      <h3>Current context</h3>
      <p className="x-context-model">{visible(row.model)}</p>
      <p className={`x-context-value${awaiting ? ' x-tone-muted' : ''}`}>
        {awaiting ? <Icon id="hourglass" /> : null}
        <span aria-hidden="true">{v.value}</span><span className="x-sr-only">{v.label}</span>
        {v.qualifier ? <span className="x-chip">{v.qualifier}</span> : null}
      </p>
      {v.meter !== null ? (
        <>
          <div className="x-meter" role="img" aria-label={`Context meter: ${percentWords(v.meter)} used`}>
            <span className="x-meter-used" style={{ width: `${v.meter}%` }} />
          </div>
          <p className="x-context-note">{v.unoccupied}</p>
        </>
      ) : <p className="x-context-note">{v.meterNote}</p>}
      {v.warning ? <p className="x-gap"><Icon id="finding" />{v.warning}</p> : null}
      <p className="x-context-meta">
        <span>{v.source}</span><span>{v.freshness}</span>
        {v.stale ? <span className="x-tone-warning"><Icon id="clock-gap" />{v.stale}</span> : null}
        <span>{v.generation}</span>
      </p>
      <p className="x-context-note">Composition estimates arrive in v1-B; until then every category is unavailable.</p>
      {GROUPS.map((g) => (
        <table key={g} className="x-table x-context-table">
          <caption>{g}</caption>
          <tbody>
            {CATEGORY_ROWS.filter((r) => r.group === g).map((r) => (
              <tr key={r.name}><th scope="row">{r.name}</th><td><span aria-hidden="true">{r.value}</span><span className="x-sr-only">{r.label}</span></td></tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}
