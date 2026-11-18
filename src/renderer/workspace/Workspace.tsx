// XAIBO-PROD-413 (P4-T05d; design §6.3 as amended by D-P4-06): the Session area. A compact session list (hideable)
// beside the open session; the page itself does not scroll, each pane does. Below 800 px one region shows at a time.
// Every transcript-derived string is a React text node through visible() (EC-55).
import { useEffect, useRef, useState } from 'react';
import type { SessionRow } from '../../shared/ipc.ts';
import { VirtualList } from '../components/VirtualList.tsx';
import { Title } from '../SessionList.tsx';
import { findingBadges, formatTime, recordLabel, type ListState } from '../model.ts';
import { Icon } from '../status/StatusBadge.tsx';
import { show, visible } from '../text.ts';
import { OpenSession, type WorkspaceApi } from './OpenSession.tsx';
import { compactStatus, openChange, type SessionChanges } from './view.ts';

const keyOf = (r: SessionRow) => r.id;

function Row({ row, open, lastKnown, onOpen }: { row: SessionRow; open: boolean; lastKnown: boolean; onOpen: (r: SessionRow) => void }) {
  const status = compactStatus(row.live);
  return (
    <button type="button" className="x-srow" aria-current={open || undefined} onClick={() => onOpen(row)}>
      <span className="x-s-title" data-field="title"><Title row={row} /></span>
      <span className="x-s-meta">
        <span className={`x-dot x-dot-${status.tone}`} aria-hidden="true" />
        <span data-field="agent">{visible(row.agent)}</span>
        <span data-field="status">{lastKnown ? 'Last known: ' : null}{status.text}
          {findingBadges(row.live).map((t) => <span key={t} className="x-tone-warning"> · {t}</span>)}</span>
        <span data-field="activity">{formatTime(row.lastActivity)}</span>
      </span>
      <span className="x-s-path" data-field="folder">{show(row.cwd, 'Unknown')}</span>
    </button>
  );
}


export function Workspace({ list, changes, loading, onLoadMore, lastKnown, api, request, onRequestDone, returnFor, onReturn, onListOpen }: {
  list: ListState; changes: SessionChanges; loading: boolean; onLoadMore: () => void; lastKnown: boolean; api: WorkspaceApi;
  /** A session to open, e.g. from a Dashboard record; it may be outside the loaded list. */
  request: SessionRow | null;
  /** Called once the request is open, so a later visit does not reopen it (review L9). */
  onRequestDone: () => void;
  /** XAIBO-PROD-437: the session opened from the Dashboard, whose header offers Return to Dashboard. */
  returnFor: number | null; onReturn: () => void;
  /** review L3: a session chosen from this list is not one the Dashboard opened. */
  onListOpen: () => void;
}) {
  const [opened, setOpened] = useState<SessionRow | null>(request);
  const [showList, setShowList] = useState(true);
  useEffect(() => { if (request) { setOpened(request); onRequestDone(); } }, [request, onRequestDone]);
  // XAIBO-PROD-424: a delta naming the open session (any record timestamp) or a resync bumps its change generation, and
  // its row follows the delta even outside the loaded list (Codex review).
  const [gen, setGen] = useState(0);
  const seen = useRef({ n: changes.n, resync: changes.resync }); // review H1: the frame current at mount is not a change
  useEffect(() => {
    const was = seen.current;
    seen.current = { n: changes.n, resync: changes.resync };
    if (!opened) return;
    const c = openChange(changes, was, opened.id);
    if (c.row) setOpened(c.row);
    if (c.bump) setGen((g) => g + 1);
  }, [changes]); // reacts to each delta frame only
  const row = opened ? (list.rows.find((r) => r.id === opened.id) ?? opened) : null;
  const back = () => {
    setOpened(null);
    setShowList(true); // review L6: never an empty pane at narrow widths
    requestAnimationFrame(() => document.getElementById('sessions-heading')?.focus());
  };
  return (
    <section className="x-session-area" aria-labelledby="sessions-heading">
      <div className="x-area-head"><h1 id="sessions-heading" tabIndex={-1}>Session</h1></div>
      <div className={`x-workspace${showList ? '' : ' x-no-list'}${row ? ' x-has-open' : ''}`}>
        {showList ? (
          <section className="x-pane x-list-pane" aria-labelledby="session-list-heading">
            <div className="x-pane-head">
              <h2 id="session-list-heading">Session list</h2>
              {/* XAIBO-PROD-452 (G4d-1): only while a session is open, whose header offers Show session list */}
              {row ? <button type="button" className="x-btn x-btn-quiet x-icon-btn x-wide-only" aria-label="Hide session list" onClick={() => setShowList(false)}><Icon id="back" /></button> : null}
            </div>
            <div className="x-section-list">
              {list.loaded && list.rows.length === 0 ? <p className="x-empty-note">No sessions yet.</p> : (
                <VirtualList items={list.rows} getKey={keyOf} label="Sessions" itemLabel={recordLabel} estimateSize={76} hasMore={list.next !== null} loading={loading} onLoadMore={onLoadMore}
                  render={(r) => <Row row={r} open={r.id === row?.id} lastKnown={lastKnown} onOpen={(r) => { setOpened(r); onListOpen(); }} />} />
              )}
            </div>
          </section>
        ) : null}
        {row ? <OpenSession key={row.id} row={row} changed={gen} api={api} lastKnown={lastKnown} listShown={showList} onShowList={() => setShowList(true)} onBack={back}
          onReturn={row.id === returnFor ? onReturn : undefined} />
          : <section className="x-pane x-choose" aria-label="Open session"><p>Choose a session to read its conversation</p></section>}
      </div>
    </section>
  );
}
