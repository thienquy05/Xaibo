// XAIBO-PROD-413 (P4-T05d; design §6.3 as amended by D-P4-06): the Session area. A compact session list (hideable)
// beside the open session; the page itself does not scroll, each pane does. Below 800 px one region shows at a time.
// Every transcript-derived string is a React text node through visible() (EC-55).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentStatus, HistoryRow, SessionRow } from '../../shared/ipc.ts';
import type { Shared } from '../history/actions.ts';
import { SessionBrowser, type BrowseApi, type LiveRows } from '../history/SessionBrowser.tsx';
import type { ListState } from '../model.ts';
import { OpenSession, type WorkspaceApi } from './OpenSession.tsx';
import { openChange, type SessionChanges } from './view.ts';

// XAIBO-PROD-529 (P5-T18 part 3a): the list pane is the history browser (history/SessionBrowser.tsx); `list` (the live
// session feed) still keeps the open session's row current.
export function Workspace({ list, changes, browse, agents, live, lastKnown, api, request, onRequestDone, returnFor, onReturn, onListOpen }: {
  list: ListState; changes: SessionChanges; browse: BrowseApi; agents: AgentStatus[]; live: LiveRows; lastKnown: boolean; api: WorkspaceApi;
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
  // XAIBO-PROD-533: a history row refreshed in the list or the open session reaches the other (no stale Keep)
  // ponytail: one shared value; two shares before a render keep the last (the other side's next refresh corrects it)
  const [history, setHistory] = useState<Shared | null>(null);
  const shareHistory = useCallback((id: number, r: HistoryRow | null) => setHistory((h) => ({ id, row: r, n: (h?.n ?? 0) + 1 })), []);
  // XAIBO-PROD-534 (design §5.4): a gone (purged) open session closes; focus goes to the list's results heading unless
  // the purge came from the list, which places focus itself
  useEffect(() => {
    if (!history || history.row !== null || opened?.id !== history.id) return;
    setOpened(null);
    setShowList(true);
    requestAnimationFrame(() => { if (!document.querySelector('.x-list-pane')?.contains(document.activeElement)) document.getElementById('results-heading')?.focus(); });
  }, [history]);
  const back = () => {
    setOpened(null);
    setShowList(true); // review L6: never an empty pane at narrow widths
    requestAnimationFrame(() => document.getElementById('sessions-heading')?.focus());
  };
  return (
    <section className="x-session-area" aria-labelledby="sessions-heading">
      <div className="x-area-head"><h1 id="sessions-heading" tabIndex={-1}>Session</h1></div>
      <div className={`x-workspace${showList ? '' : ' x-no-list'}${row ? ' x-has-open' : ''}`}>
        {/* XAIBO-PROD-452 (G4d-1): Hide only while a session is open, whose header offers Show session list; the browser
            stays mounted while hidden so its mode, search and filters survive */}
        <div hidden={!showList} className="x-list-slot">
          <SessionBrowser api={browse} agents={agents} live={live} changes={changes} lastKnown={lastKnown} openId={row?.id ?? null}
            onOpen={(r) => { setOpened(r); onListOpen(); }} hide={row ? () => setShowList(false) : null} history={history} onHistory={shareHistory} />
        </div>
        {row ? <OpenSession key={row.id} row={row} changed={gen} api={api} lastKnown={lastKnown} listShown={showList} onShowList={() => setShowList(true)} onBack={back}
          onReturn={row.id === returnFor ? onReturn : undefined} history={history} onHistory={shareHistory} />
          : <section className="x-pane x-choose" aria-label="Open session"><p>Choose a session to read its conversation</p></section>}
      </div>
    </section>
  );
}
