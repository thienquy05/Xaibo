// Read-only session list (P1-T12, OQ-P1-04; P4-T03 virtualized record list, design §5.1): one record per session with
// title, agent and folder first, then status and the remaining fields as labeled detail. Every transcript-derived string
// is a React text node run through visible() (EC-55). P4-T05d: the Session area's list is the workspace's compact list
// (workspace/Workspace.tsx); this full record stays for the Dashboard's live sessions, with an Open session button.
import type { SessionRow } from '../shared/ipc.ts';
import { contextText, costText, findingBadges, formatTime, markers, originText, statusExtras } from './model.ts';
import { Icon, StatusBadge } from './status/StatusBadge.tsx';
import { visible } from './text.ts';

const show = (s: string | null, fallback: string) => (s ? visible(s) : fallback);

/** One session record; `lastKnown` qualifies its status while the collector is not running (design §3.2, §6.0). */
export function Record({ row, lastKnown = false, onOpen }: { row: SessionRow; lastKnown?: boolean; onOpen?: (row: SessionRow) => void }) {
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
      {onOpen ? <button type="button" className="x-btn x-btn-primary x-record-open" onClick={() => onOpen(row)}>Open session</button> : null}
    </article>
  );
}
