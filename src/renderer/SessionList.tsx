// Read-only session list (P1-T12, OQ-P1-04; P4-T03 virtualized record list, design §5.1): one record per session with
// title, agent and folder first, then status and the remaining fields as labeled detail. Every transcript-derived string
// is a React text node run through visible() (EC-55). Opening a record arrives with the Session workspace (P4-T05).
import type { SessionRow } from '../shared/ipc.ts';
import { VirtualList } from './components/VirtualList.tsx';
import { contextText, costText, findingBadges, formatTime, markers, originText, statusExtras, type ListState } from './model.ts';
import { Icon, StatusBadge } from './status/StatusBadge.tsx';
import { visible } from './text.ts';

const show = (s: string | null, fallback: string) => (s ? visible(s) : fallback);
const keyOf = (r: SessionRow) => r.id;

/** One session record; `lastKnown` qualifies its status while the collector is not running (design §3.2, §6.0). */
export function Record({ row, lastKnown = false }: { row: SessionRow; lastKnown?: boolean }) {
  const m = markers(row);
  return (
    <article className="x-record">
      <p className="x-record-head">
        <span className="x-record-title" data-field="title">{show(row.title, 'Untitled')}</span>
        <span data-field="agent">{visible(row.agent)}</span>
        <span className="x-record-path" data-field="folder">{show(row.cwd, 'Unknown')}</span>
      </p>
      <p className="x-record-status" data-field="status">
        {lastKnown ? <span>Last known: </span> : null}
        <StatusBadge status={row.live} />
        {row.live ? statusExtras(row.live).map((t) => <span key={t}> · {t}</span>) : null}
        {findingBadges(row.live).map((b) => <span key={b.text}> <Icon id="finding" /> {b.text}</span>)}
      </p>
      <dl className="x-record-fields">
        <div><dt>Origin</dt><dd data-field="origin">{originText(row)}</dd></div>
        <div><dt>Last activity</dt><dd data-field="activity">{formatTime(row.lastActivity)}</dd></div>
        <div><dt>Model</dt><dd data-field="model">{visible(row.model)}</dd></div>
        <div><dt>Coverage</dt><dd data-field="coverage">{m.length === 0 ? '—' : m.map((x) => <span key={x.text}><Icon id="finding" /> {x.text} </span>)}</dd></div>
        <div><dt>Context</dt><dd data-field="context">{contextText(row.contextPct)}</dd></div>
        <div><dt>Cost</dt><dd data-field="cost">{costText(row.costUsd, row.costCoverage)}</dd></div>
      </dl>
    </article>
  );
}

export function SessionList({ list, loading, onLoadMore, lastKnown = false }: { list: ListState; loading: boolean; onLoadMore: () => void; lastKnown?: boolean }) {
  return (
    <section aria-labelledby="sessions-heading">
      <h1 id="sessions-heading" tabIndex={-1}>Session</h1>
      {list.loaded && list.rows.length === 0 ? <p>No sessions yet.</p> : (
        <VirtualList
          items={list.rows} getKey={keyOf} label="Sessions" estimateSize={132}
          hasMore={list.next !== null} loading={loading} onLoadMore={onLoadMore}
          render={(row) => <Record row={row} lastKnown={lastKnown} />}
        />
      )}
    </section>
  );
}
