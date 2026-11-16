// XAIBO-PROD-418 (P4-T07b; PRD FR-48, US-18, §5.12; design §6.3.2): the Cost section of an open session. Headline
// estimate, basis, coverage and notes; one table per (model, price revision, basis) group; then Price provenance with
// one entry per applied revision. Every amount shows ~ visibly and is spoken from text starting "Estimated cost".
// Source references are plain text: nothing here links out or fetches.
import type { CostDetail } from '../../../shared/ipc.ts';
import { visible } from '../../text.ts';
import { componentRows, costHeadline, groupTitle, revisionRows } from './present.ts';

/** undefined = loading; null = no such session; failed = the request failed (Retry). */
export function CostPane({ cost, failed, onRetry }: { cost: CostDetail | null | undefined; failed: boolean; onRetry: () => void }) {
  if (failed) {
    return <p className="x-gap" role="alert">Estimated cost unavailable — cost details could not be loaded <button type="button" className="x-btn x-btn-secondary" onClick={onRetry}>Retry</button></p>;
  }
  if (cost === undefined) return <p className="x-context-note">Loading estimated cost…</p>;
  if (cost === null) return <p className="x-context-note">Estimated cost unavailable — session not found</p>;
  return <CostSection cost={cost} />;
}

export function CostSection({ cost }: { cost: CostDetail }) {
  const h = costHeadline(cost);
  const revisions = revisionRows(cost);
  return (
    <div className="x-context x-cost">
      <h3>Estimated cost</h3>
      <p className="x-context-value"><span aria-hidden="true">{h.value}</span><span className="x-sr-only">{h.label}</span></p>
      {/* review L2: coverage is already spoken in the headline's text */}
      <p className="x-context-meta"><span>{h.basis}</span><span aria-hidden="true">{h.coverage}</span></p>
      {h.notes.map((n) => <p key={n} className="x-context-note">{n}</p>)}
      {cost.groups.map((g) => {
        const title = visible(groupTitle(g, cost.revisions));
        return (
          <table key={`${g.model}\0${g.revision}\0${g.basis}`} className="x-table x-context-table">
            <caption>{title}</caption>
            <thead><tr><th scope="col">Component</th><th scope="col">Tokens</th><th scope="col">Price rate</th><th scope="col">Estimated cost</th></tr></thead>
            <tbody>
              {componentRows(g).map((r) => (
                <tr key={r.name}>
                  <th scope="row">{r.name}</th><td>{r.tokens}</td><td>{r.rate}</td>
                  <td className="x-cost-usd"><span aria-hidden="true">{r.usd}</span><span className="x-sr-only">{r.label}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      })}
      {revisions.length ? (
        <>
          <h4 id="price-provenance">Price provenance</h4>
          <ul className="x-provenance" aria-labelledby="price-provenance">
            {revisions.map((r) => (
              <li key={r.id}>
                <strong>{visible(r.label)}</strong> · {visible(r.asOf)} · {r.source}{r.fallback ? <> · <span className="x-chip x-chip-warn">Owner-set fallback</span></> : null}
                <div className="x-context-note">{r.models ? `${visible(r.models)} · ` : ''}{r.period}</div>
                {r.references.filter((x) => x !== 'Owner-set fallback').map((x, i) => <div key={i} className="x-context-note x-mono">{visible(x)}</div>)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
