// XAIBO-PROD-529 (P5-T18 part 3a; design §6.4; look D-P5-09): the Session list pane as a history browser. Mode group
// (All sessions, Live, Archived, Trash; roving focus, manual activation), search with Apply, Filters (agent) and
// Projects and folders (map groups on demand) above a paged record list. Rows keep the compact record and add the
// history lines; snippets are text runs with the terms emphasized. Every transcript-derived string is a React text node
// through visible() (EC-55). Logic lives in browse.ts.
// XAIBO-PROD-532 (P5-T18 part 3b-3; design §6.4, §5.1, §5.4): each record outside Trash has More actions (Pin, Archive,
// Keep, Move to Trash) from the session's fresh history row; outcomes are polite and in words; Move to Trash shows the
// Undo notice. Logic lives in actions.ts.
import { useEffect, useRef, useState } from 'react';
import { QUERY_MAX, type AgentStatus, type HistoryFilter, type HistoryKey, type HistoryRow, type MapGroup, type MapNode, type OverlayOp, type OverlayResult, type SearchKey,
  type SessionRow } from '../../shared/ipc.ts';
import { Menu, type MenuEntry } from '../components/Menu.tsx';
import { VirtualList } from '../components/VirtualList.tsx';
import { Title } from '../SessionList.tsx';
import { findingBadges, formatTime, PAGE, recordLabel } from '../model.ts';
import { Icon } from '../status/StatusBadge.tsx';
import { show, visible } from '../text.ts';
import { compactStatus, type SessionChanges } from '../workspace/view.ts';
import { canLoadMore, capped, COVERAGE, emphasis, failureNote, filterOf, freshList, groupLabel, initialQuery, isPlain, listTexts, mergeLive, mergeRows, MODES, modeKey,
  refill, rowLines, startLoad, type BrowseRow, type ListState, type LiveState, type Query } from './browse.ts';
import { doneText, errorText, menuClosed, menuItems, NOTICE, opOf, place, trashed, undoLabel, undone, type ActionKind, type Undo } from './actions.ts';

export interface BrowseApi {
  history(filter: HistoryFilter, cursor: HistoryKey | null, limit: number): Promise<{ rows: HistoryRow[]; next: HistoryKey | null }>;
  search(query: string, filter: HistoryFilter, cursor: SearchKey | null, limit: number): Promise<{ hits: { row: HistoryRow; snippet: string }[]; next: SearchKey | null; failed?: true }>;
  mapGroups(parent: MapGroup | null, cursor: MapGroup | null, limit: number): Promise<{ groups: MapNode[]; next: MapGroup | null }>;
  /** XAIBO-PROD-532: an overlay op, and one session's fresh history row (null = gone; throws when unavailable). */
  overlay(op: OverlayOp): Promise<OverlayResult>;
  historyRow(session: number): Promise<HistoryRow | null>;
}
const MENU = 'session-row-menu';
/** The Dashboard's live set as Live mode shows it. */
export type LiveRows = LiveState & { rows: SessionRow[] };

const keyOf = (r: BrowseRow) => r.id;
const sameGroup = (a: MapGroup | null, b: MapGroup | null) => JSON.stringify(a) === JSON.stringify(b);

function Row({ row, open, lastKnown, search, snippet, onOpen, onMore }: {
  row: BrowseRow; open: boolean; lastKnown: boolean; search: string; snippet: string | undefined; onOpen: (r: HistoryRow) => void;
  /** More actions (null for a Trash row: Restore and Purge instead). */
  onMore: ((r: BrowseRow) => void) | null;
}) {
  const status = compactStatus(row.live);
  const lines = rowLines(row);
  return (
    <div className="x-srow-wrap">
    <button type="button" className="x-srow" data-row={row.id} aria-current={open || undefined} onClick={() => onOpen(row)}>
      <span className="x-s-title" data-field="title">
        {row.pinned ? <span className="x-pin"><Icon id="pin" /><span className="x-sr-only">Pinned: </span></span> : null}<Title row={row} />
      </span>
      <span className="x-s-meta">
        <span className={`x-dot x-dot-${status.tone}`} aria-hidden="true" />
        <span data-field="agent">{visible(row.agent)}</span>
        <span data-field="status">{lastKnown ? 'Last known: ' : null}{status.text}
          {findingBadges(row.live).map((t) => <span key={t} className="x-tone-warning"> · {t}</span>)}</span>
        <span data-field="activity">{formatTime(row.lastActivity)}</span>
      </span>
      <span className="x-s-path" data-field="folder">{show(row.cwd, 'Unknown')}</span>
      {snippet !== undefined ? (
        <span className="x-snippet" data-field="snippet">
          {emphasis(visible(snippet), search).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
        </span>
      ) : null}
      {lines.length ? (
        <span className="x-flags" data-field="history">
          {lines.map((l) => <span key={l.text} className={l.tone ? `x-tone-${l.tone}` : undefined}>{l.text}</span>)}
        </span>
      ) : null}
    </button>
    {onMore ? (
      <button type="button" className="x-btn x-btn-quiet x-icon-btn x-srow-more" popoverTarget={MENU} aria-haspopup="menu" aria-label={`More actions for ${recordLabel(row)}`}
        onClick={() => onMore(row)}><Icon id="more" /></button>
    ) : null}
    </div>
  );
}

type Groups = { groups: MapNode[]; next: MapGroup | null; status: 'loading' | 'ready' | 'failed' };

/** One level of map groups under `parent`, paged on demand. */
function GroupLevel({ api, parent, selected, onPick }: { api: BrowseApi; parent: MapGroup | null; selected: MapGroup | null; onPick: (g: MapGroup, label: string) => void }) {
  const [s, setS] = useState<Groups>({ groups: [], next: null, status: 'loading' });
  const live = useRef(true);
  const load = (cursor: MapGroup | null) => {
    setS((x) => ({ ...x, status: 'loading' }));
    api.mapGroups(parent, cursor, PAGE).then(
      (r) => { if (live.current) setS((x) => ({ groups: cursor ? [...x.groups, ...r.groups] : r.groups, next: r.next, status: 'ready' })); },
      () => { if (live.current) setS((x) => ({ ...x, status: 'failed' })); });
  };
  // ponytail: levels load when first shown and are never evicted or refreshed; the Agent Map tree (P5-T18a) adds page
  // caps, eviction and resync
  useEffect(() => { live.current = true; load(null); return () => { live.current = false; }; }, []);
  return (
    <ul className="x-tree">
      {s.groups.map((n) => <GroupItem key={JSON.stringify(n.group)} api={api} node={n} selected={selected} onPick={onPick} />)}
      {s.status === 'loading' ? <li className="x-hint">Loading…</li> : null}
      {s.status === 'failed' ? <li className="x-hint">Groups could not be loaded. <button type="button" className="x-btn x-btn-quiet" onClick={() => load(null)}>Retry</button></li> : null}
      {s.status === 'ready' && s.next ? <li><button type="button" className="x-btn x-btn-quiet x-more-link" onClick={() => load(s.next)}>Load more</button></li> : null}
      {s.status === 'ready' && !s.next && s.groups.length === 0 && parent === null ? <li className="x-hint">No projects yet.</li> : null}
    </ul>
  );
}

function GroupItem({ api, node, selected, onPick }: { api: BrowseApi; node: MapNode; selected: MapGroup | null; onPick: (g: MapGroup, label: string) => void }) {
  const l = groupLabel(node);
  const [open, setOpen] = useState(false);
  const expandable = l.kind === 'project' || l.kind === 'repo';
  return (
    <li>
      <div className="x-tree-row">
        {expandable ? (
          <button type="button" className="x-tree-toggle" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${visible(l.label)}`} onClick={() => setOpen((o) => !o)}>
            <Icon id="chevron" />
          </button>
        ) : <span className="x-tree-spacer" />}
        <button type="button" className="x-tree-pick" aria-pressed={sameGroup(selected, node.group)} onClick={() => onPick(node.group, l.label)}>
          <Icon id={l.kind === 'folder' ? 'folder' : 'branch'} /><span className="x-tree-label">{visible(l.label)}</span>
          {node.sessions !== null ? <span className="x-n">{node.sessions}</span> : null}
        </button>
      </div>
      {l.note ? <span className="x-note">{l.note}</span> : null}
      {open ? <GroupLevel api={api} parent={node.group} selected={selected} onPick={onPick} /> : null}
    </li>
  );
}

type List = ListState<HistoryKey | SearchKey>;
type Page = { rows: HistoryRow[]; next: HistoryKey | SearchKey | null; snippets: (readonly [number, string])[] };
const fresh = (): List => freshList();

export function SessionBrowser({ api, agents, live, changes, lastKnown, openId, onOpen, hide }: {
  api: BrowseApi; agents: AgentStatus[]; live: LiveRows; changes: SessionChanges; lastKnown: boolean;
  openId: number | null; onOpen: (r: HistoryRow) => void;
  /** The Hide session list button, shown while a session is open. */
  hide: (() => void) | null;
}) {
  const [q, setQ] = useState<Query>(initialQuery);
  const [list, setList] = useState<List>(fresh);
  const [draft, setDraft] = useState('');
  const [agentDraft, setAgentDraft] = useState('');
  const [groupName, setGroupName] = useState<string | null>(null);
  const [treeShown, setTreeShown] = useState(false); // review L10: the tree loads when its disclosure first opens
  const [focusMode, setFocusMode] = useState(0);
  const modeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const gen = useRef(0);
  const current = useRef(list);
  current.current = list;
  // review M3 (as main.tsx holds, XAIBO-PROD-447): live updates flushed while a first page or a resync loads are replayed
  // on its reply (the page may be older than an update)
  const held = useRef<Map<number, SessionRow> | null>(null);
  const query = useRef(q);
  query.current = q;

  // XAIBO-PROD-532: row actions. The menu shows the session's fresh row (the list's copy may be stale); an action's
  // refreshed row is placed back (actions.place); a failed refresh keeps the record and says so (design review L3).
  const [menu, setMenu] = useState<{ id: number; row: HistoryRow | null; status: 'loading' | 'ready' | 'failed' } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [restored, setRestored] = useState<HistoryRow | null>(null);
  const menuGen = useRef(0);
  // a restored record to focus once the list holds it (Undo); not rendered (outside the virtual window: review L5),
  // the heading and Open restored session
  const focusRow = useRef<HistoryRow | null>(null);
  useEffect(() => {
    const row = focusRow.current;
    if (row === null) return;
    focusRow.current = null;
    const el = document.querySelector<HTMLElement>(`.x-list-pane [data-row="${row.id}"]`);
    if (el) el.focus(); else { setRestored(row); heading.current?.focus(); }
  }, [list]);
  /** The refreshed row (null = gone) into the list; true when the row is in it. Live shows the live set: nothing to place. */
  const applyRow = (id: number, row: HistoryRow | null): boolean => {
    if (query.current.mode === 'live') return false;
    const p = place(current.current.rows, id, row, query.current, current.current.next !== null);
    current.current = { ...current.current, rows: p.rows };
    setList((x) => ({ ...x, rows: place(x.rows, id, row, query.current, x.next !== null).rows }));
    if (!p.rows.length) requestAnimationFrame(() => heading.current?.focus()); // design §5.4: the list heading when nothing is left
    return p.placed;
  };
  const openMenu = (r: BrowseRow) => {
    const g = ++menuGen.current;
    setMenu({ id: r.id, row: null, status: 'loading' });
    api.historyRow(r.id).then((row) => {
      if (g !== menuGen.current) return;
      const closed = menuClosed(row); // review M3: gone, or in Trash since the list was read
      if (closed) { document.getElementById(MENU)?.hidePopover(); setMenu(null); applyRow(r.id, row); setNote(closed); return; }
      setMenu({ id: r.id, row, status: 'ready' });
      applyRow(r.id, row);
    }, () => { if (g === menuGen.current) setMenu({ id: r.id, row: null, status: 'failed' }); });
  };
  const refresh = (id: number) => api.historyRow(id).then((row) => applyRow(id, row), () => {
    setNote((n) => `${n ?? ''} The list could not be refreshed.`.trim());
    return false;
  });
  const run = async (kind: ActionKind, row: HistoryRow) => {
    const op = opOf(kind, row);
    setNote(null);
    const r = await api.overlay(op).catch(() => null);
    if (!r) { setNote('The result is unavailable.'); void refresh(row.id); return; } // a lost reply never means success
    if (!r.ok) { setNote(errorText(r.error)); if (r.error === 'not-found') void refresh(row.id); return; } // review L6: a gone record leaves
    if (op.kind === 'trash') { setRestored(null); setUndo((u) => trashed(u, row.id)); } else if ('on' in op) setNote(doneText(kind as Exclude<ActionKind, 'trash'>, op.on));
    void refresh(row.id);
  };
  const undoTrash = async () => {
    const u = undo;
    if (!u || u.status === 'undoing' || u.status === 'restored') return;
    // review M1: each reply changes the notice only while it is still this session's (a newer Trash keeps its Undo)
    setUndo((cur) => undone(cur, u.id, { status: 'undoing', note: null }));
    const r = await api.overlay({ kind: 'trash', session: u.id, on: false }).catch(() => null);
    if (!r || !r.ok) { setUndo((cur) => undone(cur, u.id, { status: 'failed', note: r && !r.ok ? errorText(r.error) : 'The result is unavailable.' })); return; }
    let row: HistoryRow | null = null;
    try { row = await api.historyRow(u.id); } catch { /* restored; the row could not be read */ }
    const placed = row ? applyRow(u.id, row) : false;
    setUndo((cur) => undone(cur, u.id, { status: 'restored', note: row ? null : 'The list could not be refreshed.' }));
    // design §5.4: Undo focuses the restored record; outside the current list, the list heading and Open restored session
    setRestored(placed ? null : row);
    if (placed) focusRow.current = row; else heading.current?.focus();
  };
  const menuRow = menu?.status === 'ready' ? menu.row : null;
  const entries: MenuEntry[] = menu?.status === 'failed'
    ? [{ key: 'retry', label: 'Retry', checked: null, keepOpen: true, onSelect: () => { const r = current.current.rows.find((x) => x.id === menu.id); if (r) openMenu(r); } }]
    : menuRow ? menuItems(menuRow).map((i) => ({ key: i.kind, label: i.label, checked: i.checked, onSelect: () => void run(i.kind, menuRow) })) : [];

  const fetchPage = (query: Query, f: HistoryFilter, cursor: HistoryKey | SearchKey | null, limit: number): Promise<Page> => query.search
    ? api.search(query.search, f, cursor as SearchKey | null, limit).then((r) => {
      if (r.failed) throw new Error('search failed');
      return { rows: r.hits.map((h) => h.row), next: r.next, snippets: r.hits.map((h) => [h.row.id, h.snippet] as const) };
    })
    : api.history(f, cursor as HistoryKey | null, limit).then((r) => ({ rows: r.rows, next: r.next, snippets: [] }));

  /** 'new': another query (rows cleared, review M2); 'resync': the same query again, its loaded window (L9); 'more': Load more. */
  const load = (query: Query, kind: 'new' | 'resync' | 'more') => {
    const f = filterOf(query);
    if (!f) return;
    const before = current.current;
    if (kind === 'more' && !canLoadMore(before)) return;
    const g = kind === 'more' ? gen.current : ++gen.current; // a new query or resync drops replies for the old one
    if (kind !== 'more') held.current = new Map();
    setList(kind === 'new' ? fresh() : (x) => startLoad(x, kind));
    const page: Promise<Page> = kind === 'more' ? fetchPage(query, f, before.next, PAGE)
      : kind === 'resync' ? refill(before.capacity, PAGE, (cursor: HistoryKey | SearchKey | null, limit) => fetchPage(query, f, cursor, limit)
        .then((p) => ({ rows: p.rows.map((row) => ({ row, snip: p.snippets.find(([id]) => id === row.id)?.[1] })), next: p.next })))
        .then((r) => ({ rows: r.rows.map((x) => x.row), next: r.next, snippets: r.rows.flatMap((x) => (x.snip === undefined ? [] : [[x.row.id, x.snip] as const])) }))
      : fetchPage(query, f, null, PAGE);
    page.then((r) => {
      if (g !== gen.current) return;
      const replay = kind === 'more' ? [] : [...(held.current?.values() ?? [])];
      if (kind !== 'more') held.current = null;
      setList((x) => {
        const have = new Set(kind === 'more' ? x.rows.map((row) => row.id) : []);
        const snippets = new Map(kind === 'more' ? x.snippets : []);
        for (const [id, s] of r.snippets) snippets.set(id, s);
        const capacity = kind === 'more' ? x.capacity + PAGE : kind === 'resync' ? Math.max(PAGE, x.capacity) : PAGE;
        let rows: BrowseRow[] = [...(kind === 'more' ? x.rows : []), ...r.rows.filter((row) => !have.has(row.id))];
        let next = r.next;
        if (replay.length) {
          rows = mergeRows(rows, replay, isPlain(query), next !== null);
          if (isPlain(query)) { const c = capped(rows, capacity); rows = c.rows; next = c.next ?? next; }
        }
        return { rows, snippets, next, status: 'ready', capacity, failed: null };
      });
    }, () => {
      if (g !== gen.current) return;
      if (kind !== 'more') held.current = null;
      setList((x) => ({ ...x, status: 'failed', failed: kind }));
    });
  };
  // applying a mode, search or filter resets only this list's cursor (design §6.4); a service resync reloads it
  useEffect(() => { load(q, 'new'); }, [q]);
  const resyncs = useRef(changes.resync);
  useEffect(() => { if (resyncs.current !== changes.resync) { resyncs.current = changes.resync; load(q, 'resync'); } }, [changes.resync]);
  const seen = useRef(changes.n);
  useEffect(() => { // live updates by id (the frame current at mount is not a change)
    if (seen.current === changes.n) return;
    seen.current = changes.n;
    const holding = held.current !== null;
    if (held.current) for (const r of changes.rows) { held.current.delete(r.id); held.current.set(r.id, r); }
    setList((x) => ({ ...x, ...mergeLive(x, changes.rows, isPlain(q), holding) })); // the plain view stays within the loaded window
  }, [changes]);

  const apply = (next: Query) => { setQ(next); requestAnimationFrame(() => heading.current?.focus()); };
  const isLive = q.mode === 'live';
  const t = listTexts(q, live);
  const rows: BrowseRow[] = isLive ? (live.rows as HistoryRow[]) : list.rows;
  const ready = isLive ? live.loaded && !live.failed : list.status === 'ready' || list.status === 'more';
  const agentName = q.agent ? (agents.find((a) => a.agent === q.agent)?.name ?? q.agent) : null;
  const more = isLive ? live.more : list.next !== null;

  return (
    <section className="x-pane x-list-pane" aria-labelledby="session-list-heading">
      <div className="x-pane-head">
        <h2 id="session-list-heading">Session list</h2>
        {hide ? <button type="button" className="x-btn x-btn-quiet x-icon-btn x-wide-only" aria-label="Hide session list" onClick={hide}><Icon id="back" /></button> : null}
      </div>
      <div className="x-browse">
        <div className="x-modes" role="group" aria-label="Session list mode">
          {MODES.map((m, i) => (
            <button key={m.mode} ref={(el) => { modeRefs.current[i] = el; }} type="button" className="x-mode" aria-pressed={q.mode === m.mode}
              aria-controls="session-results" tabIndex={i === focusMode ? 0 : -1} onFocus={() => setFocusMode(i)}
              onKeyDown={(e) => { const n = modeKey(e.key, i, MODES.length); if (n === null) return; e.preventDefault(); setFocusMode(n); modeRefs.current[n]?.focus(); }}
              onClick={() => {
                if (m.mode === 'trash') setGroupName(null); // review L7: map groups never hold Trash rows
                setQ((x) => ({ ...x, mode: m.mode, group: m.mode === 'trash' ? null : x.group }));
              }}>{m.label}</button>
          ))}
        </div>
        {isLive ? <p className="x-hint x-browse-note">Sessions active now. Search and filters apply to the other modes.</p> : null}
        {/* kept mounted in Live (review L10): the drafts, disclosures and tree survive a visit there */}
        <div className="x-browse-tools" hidden={isLive}>
          <form className="x-search" role="search" aria-label="Search sessions" onSubmit={(e) => { e.preventDefault(); apply({ ...q, search: draft.trim() }); }}>
            <label className="x-search-field">
              <span className="x-sr-only">Search sessions</span>
              <Icon id="search" />
              <input className="x-input" type="search" value={draft} maxLength={QUERY_MAX} placeholder="Search sessions" onChange={(e) => setDraft(e.target.value)} />
            </label>
            <button type="submit" className="x-btn x-btn-secondary">Apply</button>
          </form>
          {q.search ? <button type="button" className="x-btn x-btn-quiet x-clear" onClick={() => { setDraft(''); apply({ ...q, search: '' }); }}>Clear search</button> : null}
          <div className="x-discl">
            <details>
              <summary><Icon id="chevron" />Filters<span className="x-sum-val">{agentName ? visible(agentName) : 'None'}</span></summary>
              <form className="x-filters" onSubmit={(e) => { e.preventDefault(); apply({ ...q, agent: agentDraft || null }); }}>
                <label>Agent
                  <select value={agentDraft} onChange={(e) => setAgentDraft(e.target.value)}>
                    <option value="">Any agent</option>
                    {agents.map((a) => <option key={a.agent} value={a.agent}>{visible(a.name)}</option>)}
                  </select>
                </label>
                <div className="x-acts">
                  <button type="submit" className="x-btn x-btn-primary">Apply</button>
                  <button type="button" className="x-btn x-btn-quiet" onClick={() => { setAgentDraft(''); setQ((x) => ({ ...x, agent: null })); }}>Reset</button>
                </div>
              </form>
            </details>
            <details hidden={q.mode === 'trash'} onToggle={(e) => { if (e.currentTarget.open) setTreeShown(true); }}>
              <summary><Icon id="chevron" />Projects and folders<span className="x-sum-val">{groupName ? visible(groupName) : 'All'}</span></summary>
              <div className="x-tree-root">
                <p className="x-hint">Counts cover sessions outside Trash.</p>
                <button type="button" className="x-tree-pick x-tree-all" aria-pressed={q.group === null} onClick={() => { setGroupName(null); setQ((x) => ({ ...x, group: null })); }}>All projects</button>
                {treeShown ? <GroupLevel api={api} parent={null} selected={q.group} onPick={(g, name) => { setGroupName(name); setQ((x) => ({ ...x, group: g })); }} /> : null}
              </div>
            </details>
          </div>
        </div>
      </div>
      <div className="x-results-head" id="session-results">
        <h3 id="results-heading" ref={heading} tabIndex={-1}>{t.title}</h3>
        {t.order ? <span>{t.order}</span> : null}
        <span className="x-sr-only" aria-live="polite">{ready ? `${t.title}: ${rows.length}${more ? ' or more' : ''} shown` : ''}</span>
      </div>
      <p className="x-action-note" aria-live="polite">{note}</p>
      <div className="x-section-list">
        {/* re-review N4: a failed live set says so even while its last rows are shown */}
        {isLive && live.failed && rows.length > 0 ? <p className="x-empty-note">{t.empty}</p> : null}
        {!isLive && list.status === 'failed' && list.rows.length === 0 ? (
          <p className="x-empty-note">{failureNote(list)} <button type="button" className="x-btn x-btn-quiet" onClick={() => load(q, 'new')}>Retry</button></p>
        ) : rows.length === 0 && (ready || isLive) ? <p className="x-empty-note">{t.empty}</p> : (
          <VirtualList key={JSON.stringify(q)} items={rows} getKey={keyOf} label="Sessions" itemLabel={recordLabel} estimateSize={t.searching ? 112 : 76}
            hasMore={!isLive && list.next !== null} loading={!isLive && (list.status === 'more' || list.status === 'loading')} onLoadMore={() => load(q, 'more')}
            render={(r) => <Row row={r} open={r.id === openId} lastKnown={lastKnown} search={q.search} snippet={t.searching ? list.snippets.get(r.id) : undefined} onOpen={onOpen}
              onMore={r.trashedAt != null ? null : openMenu} />} />
        )}
        {!isLive && list.status === 'failed' && list.rows.length > 0 ? ( // re-review N2: Retry repeats what failed
          <p className="x-empty-note">{failureNote(list)} <button type="button" className="x-btn x-btn-quiet" onClick={() => load(q, list.failed === 'more' ? 'more' : 'resync')}>Retry</button></p>
        ) : null}
      </div>
      {t.searching ? <p className="x-list-foot">{COVERAGE}</p> : null}
      <Menu id={MENU} label="More actions" entries={entries} note={menu?.status === 'loading' ? <p className="x-hint">Loading actions…</p>
        : menu?.status === 'failed' ? <p className="x-hint">Actions could not be loaded.</p> : null} />
      {/* design §5.1 Undo notice: one at a time, polite (aria-live: the one status role is health, P4-T03), no timer, no
          focus theft; the live region stays mounted so the first notice is read (review M2) */}
      <div aria-live="polite">{undo ? (
        <div className="x-undo">
          <p>{undo.status === 'restored' ? 'Restored from Trash.' : NOTICE}</p>
          {undo.note ? <p className="x-tone-warning">{undo.note}</p> : null}
          <div className="x-acts">
            {undo.status !== 'restored' ? <button type="button" className="x-btn x-btn-secondary" aria-disabled={undo.status === 'undoing' || undefined} onClick={() => void undoTrash()}>{undoLabel(undo)}</button>
              : restored ? <button type="button" className="x-btn x-btn-secondary" onClick={() => onOpen(restored)}>Open restored session</button> : null}
            <button type="button" className="x-btn x-btn-quiet" onClick={() => { setUndo(null); setRestored(null); heading.current?.focus(); }}>Dismiss</button>
          </div>
        </div>
      ) : null}</div>
    </section>
  );
}
