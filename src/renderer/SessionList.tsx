// Read-only session list (P1-T12, OQ-P1-04): first page plus "Load more"; every transcript-derived string is a React
// text node run through visible() (EC-55). Minimal semantic HTML before the Gate D design; virtualization is Phase 4.
import type { SessionRow } from '../shared/ipc.ts';
import { formatTime, markers, type ListState } from './model.ts';
import { visible } from './text.ts';

const show = (s: string | null, fallback: string) => (s ? visible(s) : fallback);

function Row({ row }: { row: SessionRow }) {
  const m = markers(row);
  return (
    <tr>
      <td>{visible(row.agent)}</td>
      <td>{show(row.entrypoint, '—')}</td>
      <td>{show(row.cwd, 'Unknown')}</td>
      <td>{show(row.title, 'Untitled')}</td>
      <td>{formatTime(row.lastActivity)}</td>
      <td>{m.length === 0 ? '—' : m.map((x) => <span key={x.text}><span aria-hidden="true">{x.glyph}</span> {x.text} </span>)}</td>
    </tr>
  );
}

export function SessionList({ list, loading, onLoadMore }: { list: ListState; loading: boolean; onLoadMore: () => void }) {
  return (
    <section aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">Sessions</h2>
      {list.loaded && list.rows.length === 0 ? <p>No sessions yet.</p> : (
        <table aria-label="Sessions">
          <thead>
            <tr><th scope="col">Agent</th><th scope="col">Entrypoint</th><th scope="col">Folder</th><th scope="col">Title</th><th scope="col">Last activity</th><th scope="col">Coverage</th></tr>
          </thead>
          <tbody>{list.rows.map((r) => <Row key={r.id} row={r} />)}</tbody>
        </table>
      )}
      {list.next ? <button type="button" onClick={onLoadMore} disabled={loading}>Load more</button> : null}
    </section>
  );
}
