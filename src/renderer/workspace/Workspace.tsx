// XAIBO-PROD-413 (P4-T05d; design §6.3 as amended by D-P4-06): the Session area. A compact session list (hideable)
// beside the open session; the page itself does not scroll, each pane does. Below 800 px one region shows at a time.
// Every transcript-derived string is a React text node through visible() (EC-55).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentStatus, HistoryRow, ProvisionalRow, SessionRow, SuppressedRow } from '../../shared/ipc.ts';
import type { Shared } from '../history/actions.ts';
import type { Query } from '../history/browse.ts';
import { SessionBrowser, type BrowseApi, type LiveRows } from '../history/SessionBrowser.tsx';
import type { Gone } from '../history/SuppressedList.tsx';
import { SuppressedPane, type Outcome } from '../history/SuppressedPane.tsx';
import { deliver, type Settled } from '../history/suppressed.ts';
import type { ListState } from '../model.ts';
import { OpenSession, type WorkspaceApi } from './OpenSession.tsx';
import { openChange, type SessionChanges } from './view.ts';
import { LaunchDialog, type LaunchDone, type Prefill } from './LaunchDialog.tsx';
import { elapsed, FAILED_TEXT, minutes, type LaunchApi } from './launch.ts';
import { visible } from '../text.ts';
import { OwnershipBadge } from '../status/Ownership.tsx';

// XAIBO-PROD-529 (P5-T18 part 3a): the list pane is the history browser (history/SessionBrowser.tsx); `list` (the live
// session feed) still keeps the open session's row current.
export function Workspace({ list, changes, browse, agents, live, lastKnown, api, request, onRequestDone, returnFor, onReturn, returnTo, onListOpen, preset = null, onReturnList = null,
  provisional = [], bound = null, launch, removeProvisional }: {
  list: ListState; changes: SessionChanges; browse: BrowseApi; agents: AgentStatus[]; live: LiveRows; lastKnown: boolean; api: WorkspaceApi;
  /** A session to open, e.g. from a Dashboard record; it may be outside the loaded list. */
  request: SessionRow | null;
  /** Called once the request is open, so a later visit does not reopen it (review L9). */
  onRequestDone: () => void;
  /** XAIBO-PROD-437: the session opened from the Dashboard, whose header offers Return to Dashboard. */
  returnFor: number | null; onReturn: () => void;
  /** XAIBO-PROD-539: where Return goes (the Agent Map for a session opened from a tree leaf). */
  returnTo?: 'Dashboard' | 'Agent Map';
  /** review L3: a session chosen from this list is not one the Dashboard opened. */
  onListOpen: () => void;
  /** XAIBO-PROD-555: the Dashboard month detail's Session list query and the list's Return to Dashboard. */
  preset?: Partial<Query> | null; onReturnList?: (() => void) | null;
  /** XAIBO-PROD-624 (P7-T04): provisional launch rows, the latest binding, the launch asks and Remove provisional row. */
  provisional?: ProvisionalRow[]; bound?: { items: { key: string; session: number }[]; n: number } | null; launch: LaunchApi; removeProvisional: (key: string) => void;
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
  // Gate 5 G5d-3: the open session's header Move to Trash goes through the list's Undo notice
  const [headerTrash, setHeaderTrash] = useState<{ id: number; n: number } | null>(null);
  const onTrashed = useCallback((id: number) => setHeaderTrash((t) => ({ id, n: (t?.n ?? 0) + 1 })), []);
  // XAIBO-PROD-534 (design §5.4): a gone (purged) open session closes; focus goes to the list's results heading unless
  // the purge came from the list, which places focus itself
  useEffect(() => {
    if (!history || history.row !== null || opened?.id !== history.id) return;
    setOpened(null);
    setShowList(true);
    requestAnimationFrame(() => { if (!document.querySelector('.x-list-pane')?.contains(document.activeElement)) document.getElementById('results-heading')?.focus(); });
  }, [history]);
  // XAIBO-PROD-536 (design §6.4, §5.4): a suppressed record's metadata pane in place of the conversation; a record that
  // left (Re-import) closes it, and the list heading takes focus when the pane had it
  const [supp, setSupp] = useState<SuppressedRow | null>(null);
  const suppNow = useRef(supp);
  suppNow.current = supp;
  const [suppGone, setSuppGone] = useState<Gone | null>(null);
  // ponytail: one shared value; two results settled to the list before a render keep the last (the other record reads
  // none or not-found when opened, and leaves then)
  const goneSupp = (key: string, note: string, gone = true) => {
    setSuppGone((g) => ({ key, note, gone, n: (g?.n ?? 0) + 1 }));
    if (!gone) return;
    const shown = suppNow.current?.key === key;
    setSupp((s) => (s?.key === key ? null : s));
    if (shown) setShowList(true); // re-review: a result for a pane not shown never reopens a hidden list
    requestAnimationFrame(() => { if (document.activeElement === document.body) document.getElementById('results-heading')?.focus(); });
  };
  // review M1: Re-imports in flight live here, not in the pane (which a record switch unmounts): one per key, and each
  // result reaches the pane showing its record, else the list heading
  const reimporting = useRef(new Set<string>());
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const sendReimport = (key: string) => {
    if (reimporting.current.has(key)) return;
    reimporting.current.add(key);
    const settle = (result: Settled) => {
      reimporting.current.delete(key);
      const d = deliver(result, key, suppNow.current?.key ?? null);
      if (d.to === 'pane') setOutcome((o) => ({ key, result, n: (o?.n ?? 0) + 1 }));
      else goneSupp(key, d.note, d.gone);
    };
    browse.reimport(key).then(settle, () => settle('unavailable'));
  };
  // XAIBO-PROD-624 (design §6.7): Launch, the provisional Starting… rows and their status-only detail. An accepted launch opens
  // its row; evidence binding replaces it with the session (focus moves to the session heading); a row is never ended by time.
  const [prov, setProv] = useState<string | null>(null);
  const [launchOpen, setLaunchOpen] = useState<{ n: number; prefill: Prefill | null } | null>(null);
  const trigger = useRef<HTMLElement | null>(null), retryOf = useRef<string | null>(null), provSeen = useRef<string | null>(null);
  const [binding, setBinding] = useState<number | null>(null);
  const boundSeen = useRef(new Map<string, number>()); // 624 review: evidence may bind a row before the launch reply arrives
  const provRow = prov ? provisional.find((r) => r.key === prov) ?? null : null;
  if (provRow) provSeen.current = prov;
  const openLaunch = (prefill: Prefill | null, retry: string | null = null) => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    retryOf.current = retry;
    setLaunchOpen((o) => ({ n: (o?.n ?? 0) + 1, prefill }));
  };
  const launched = (d: LaunchDone) => {
    setLaunchOpen(null);
    if (!d) { requestAnimationFrame(() => trigger.current?.focus()); return; } // Cancel restores the trigger
    if (retryOf.current) removeProvisional(retryOf.current);
    retryOf.current = null;
    setSupp(null); setOpened(null); setBinding(boundSeen.current.get(d.key) ?? null); setProv(d.key);
  };
  useEffect(() => {
    for (const b of bound?.items ?? []) { boundSeen.current.set(b.key, b.session); if (b.key === prov) setBinding(b.session); }
    while (boundSeen.current.size > 32) boundSeen.current.delete(boundSeen.current.keys().next().value!);
  }, [bound?.n]);
  useEffect(() => { // the bound session's row arrives with its delta: open it in place of the provisional detail
    if (binding === null) return;
    const r = list.rows.find((x) => x.id === binding) ?? live.rows.find((x) => x.id === binding);
    if (!r) return;
    const here = document.activeElement === document.body || !!document.querySelector('.x-provisional-pane')?.contains(document.activeElement);
    setBinding(null); setProv(null); setOpened(r);
    if (here) requestAnimationFrame(() => document.getElementById('open-session-title')?.focus()); // never steals focus from elsewhere
  }, [binding, list.rows, live.rows]);
  useEffect(() => { // removed elsewhere (another window): the detail closes
    if (prov && !provRow && binding === null && provSeen.current === prov) { setProv(null); setShowList(true); }
  }, [prov, provRow, binding]);
  const removeProv = (key: string) => {
    removeProvisional(key);
    setProv(null); setShowList(true);
    const others = provisional.some((r) => r.key !== key);
    requestAnimationFrame(() => document.getElementById(others ? 'starting-heading' : 'sessions-heading')?.focus());
  };
  const agentName = (a: string) => agents.find((x) => x.agent === a)?.name ?? a;
  const back = () => {
    setProv(null);
    setSupp(null);
    setOpened(null);
    setShowList(true); // review L6: never an empty pane at narrow widths
    requestAnimationFrame(() => document.getElementById('sessions-heading')?.focus());
  };
  return (
    <section className="x-session-area" aria-labelledby="sessions-heading">
      <div className="x-area-head"><h1 id="sessions-heading" tabIndex={-1}>Session</h1>
        <button type="button" className="x-btn x-btn-secondary" onClick={() => openLaunch(null)}>Launch</button></div>
      <LaunchDialog open={launchOpen} api={launch} rows={list.rows} refresh={agents.map((a) => `${a.agent}:${a.state}:${a.version ?? ''}`).join(',')} onDone={launched} />
      <div className={`x-workspace${showList ? '' : ' x-no-list'}${row || supp || prov ? ' x-has-open' : ''}`}>
        {/* XAIBO-PROD-452 (G4d-1): Hide only while a session is open, whose header offers Show session list; the browser
            stays mounted while hidden so its mode, search and filters survive */}
        <div hidden={!showList} className="x-list-slot">
          {provisional.length ? (
            <section className="x-provisional" aria-labelledby="starting-heading">
              <h2 id="starting-heading" className="x-label" tabIndex={-1}>Launched from Xaibo</h2>
              <ul>{provisional.map((r) => (
                <li key={r.key}><button type="button" className="x-srow" aria-current={prov === r.key || undefined} onClick={() => { setSupp(null); setOpened(null); setProv(r.key); onListOpen(); }}>
                  <strong>{r.state === 'failed' ? 'Launch failed' : 'Starting…'}</strong>
                  <small>{visible(agentName(r.agent))} · {visible(r.cwd.split('/').pop() || r.cwd)}{r.state === 'starting' ? <> · <Clock since={r.startedAt} every={15_000} show={minutes} /></> : null}</small>
                </button></li>
              ))}</ul>
            </section>
          ) : null}
          <SessionBrowser api={browse} agents={agents} live={live} changes={changes} lastKnown={lastKnown} openId={row?.id ?? null}
            onOpen={(r) => { setSupp(null); setProv(null); setOpened(r); onListOpen(); }} hide={row ? () => setShowList(false) : null} history={history} onHistory={shareHistory} headerTrash={headerTrash}
            onOpenSuppressed={(r) => { if (r) { setOpened(null); onListOpen(); } setSupp(r); }} suppressedOpen={supp?.key ?? null} suppressedGone={suppGone}
            preset={preset} onReturnList={onReturnList} />
        </div>
        {prov ? <ProvisionalPane key={prov} row={provRow} name={provRow ? agentName(provRow.agent) : ''} binding={binding !== null} onBack={back}
          onRemove={() => removeProv(prov)} onRetry={() => { if (provRow) openLaunch({ agent: provRow.agent, profileId: provRow.profileId, cwd: provRow.cwd }, provRow.key); }} />
          : row ? <OpenSession key={row.id} row={row} changed={gen} api={api} lastKnown={lastKnown} listShown={showList} onShowList={() => setShowList(true)} onBack={back}
          onReturn={row.id === returnFor ? onReturn : undefined} returnTo={returnTo} history={history} onHistory={shareHistory} onTrashed={onTrashed} />
          : supp ? <SuppressedPane key={supp.key} row={supp} inflight={reimporting.current.has(supp.key)} send={sendReimport} outcome={outcome} onBack={back} onGone={goneSupp} />
            : <section className="x-pane x-choose" aria-label="Open session"><p>Choose a session to read its conversation</p></section>}
      </div>
    </section>
  );
}

/** XAIBO-PROD-624 (design §6.7, §6.9): the provisional row's status-only detail. It is not a session, a chat response or
 *  Controlled here; ownership stays unavailable until evidence binds it. */
function ProvisionalPane({ row, name, binding, onBack, onRemove, onRetry }: {
  row: ProvisionalRow | null; name: string; binding: boolean; onBack: () => void; onRemove: () => void; onRetry: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const failed = row?.state === 'failed';
  return (
    <section className="x-pane x-provisional-pane" aria-labelledby="provisional-title">
      <div className="x-open-title"><button type="button" className="x-btn x-btn-secondary x-back" onClick={onBack}>Back to session list</button></div>
      <h2 id="provisional-title" ref={heading} tabIndex={-1}>{failed ? 'Launch failed' : 'Starting…'}</h2>
      <p><OwnershipBadge kind="unavailable" /></p>
      {row ? <p>{visible(name)} · {visible(row.cwd)}</p> : null}
      {row && !failed ? <p>Elapsed <Clock since={row.startedAt} every={1000} show={elapsed} /></p> : null}
      <p aria-live="polite">{failed ? (row?.reason === 'write' || row?.reason === 'open' ? FAILED_TEXT[row.reason] : 'The launch did not start.')
        : binding ? 'Session evidence arrived. Opening the session…' : 'No session evidence yet'}</p>
      {failed ? null : <p className="x-hint">Opened in Terminal. This row becomes the session once its first evidence arrives ({row?.nativeId ? 'matched by the session ID' : 'matched by its first start in this folder'}). Sessions launched in a terminal are observed externally.</p>}
      <div className="x-dialog-actions x-provisional-actions">
        {failed ? <button type="button" className="x-btn x-btn-primary" onClick={onRetry}>Retry launch</button> : null}
        <button type="button" className="x-btn x-btn-secondary" onClick={onRemove}>Remove provisional row</button>
      </div>
    </section>
  );
}

/** 624 review: the elapsed clock re-renders only itself (a Starting… row may wait indefinitely). */
function Clock({ since, every, show }: { since: number; every: number; show: (ms: number) => string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t); }, [every]);
  return <>{show(now - since)}</>;
}
