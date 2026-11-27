// XAIBO-PROD-538 (P5-T18a part 2a; design §6.5–6.5.1, S-37, US-21; look D-P5-13): the Agent Map area. One ARIA tree
// (Repositories, worktrees and sessions) over the part 1 model in tree.ts, rendered by the shared VirtualList, and a
// Details pane for the selected item with Open in Session for a session leaf. Every label and count is service evidence
// (exact or an unavailable word); every untrusted string goes through visible(). Part 2b adds the wide connectors and
// Return to Agent Map. XAIBO-PROD-575 (P6-T10 unit 2b; D-PD-02, design §6.5): Repositories | Agents mode buttons; Agents
// shows AgentsList.tsx in the leading pane (no detail pane until unit 4's panel); each mode keeps its own anchor.
// ponytail: collapse discards a branch's pages without keeping its cursor (design allows reloading it explicitly);
// keep the cursor when users ask to reopen deep pages.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import type { AgentStatus, CatalogImportResult, HistoryFilter, HistoryKey, HistoryRow, MapGroup, MapNode, RescanResult } from '../../shared/ipc.ts';
import { VirtualList } from '../components/VirtualList.tsx';
import { rovingKey } from '../components/virtual-list-model.ts';
import { formatTime } from '../model.ts';
import { Icon } from '../status/StatusBadge.tsx';
import { Title } from '../SessionList.tsx';
import { show, visible } from '../text.ts';
import { compactStatus } from '../workspace/view.ts';
import {
  collapse, cursorFor, emptyLevel, evictedText, expand, groupDetail, holdsSessions, kindOf, loadedText, nodeText, nounOf, pageArrived, pageFailed, pageSize,
  dropSession, pageRefreshed, pagingAnchor, refocus, replyApplies, resumeLevel, startRefresh, settleRefresh, REFUSED, returnTarget, sessionKey, connectorPath, rowLabel, rows as flatten, sessionDetail, setPositions, touch, treeKey, typeLabel, type Detail, type RefreshGate, type Dir, type Expansion, type Kids, type Level, type Row,
} from './tree.ts';
import { AgentsList, type AgentsSnapshot, type PageFetch } from './AgentsList.tsx';
import { agentItems, agentKey, MODES, type Mode } from './integrations-state.ts';
import { IntegrationPanel, type DetailFetch } from './IntegrationPanel.tsx';
import { AddAgent } from './AddAgent.tsx';
import type { GrantApi } from './GrantsFieldset.tsx';
import type { WriteApi } from './IntegrationDiffDialog.tsx';
import type { SignInApi } from '../usage/SignInFieldset.tsx';
import { restoreTarget } from './integration-panel.ts';
import type { IntegrationKey } from '../../shared/ipc.ts';

/** XAIBO-PROD-579: plus the panel's previewed writes (WriteApi). */
export interface MapApi extends WriteApi, GrantApi {
  mapGroups(parent: MapGroup | null, cursor: MapGroup | null, limit: number): Promise<{ groups: MapNode[]; next: MapGroup | null }>;
  history(filter: HistoryFilter, cursor: HistoryKey | null, limit: number): Promise<{ rows: HistoryRow[]; next: HistoryKey | null }>;
  historyRow(session: number): Promise<HistoryRow | null>;
  /** XAIBO-PROD-575: one Agents list page. */
  integrationPage: PageFetch;
  /** XAIBO-PROD-578: the integration panel's read. */
  integrationDetail: DetailFetch;
  /** XAIBO-PROD-585: the panel's sign-in fieldset. */
  signIn: SignInApi;
  /** XAIBO-PROD-593 (P6-T08 slice D): rescan agents and profiles without a restart. */
  rescan(): Promise<RescanResult>;
}

type Child = MapNode | HistoryRow;
interface State { roots: Level<MapNode, MapGroup>; kids: Kids; exp: Expansion; selected: string | null }
/** XAIBO-PROD-539: the map as it was left for a session (bounded: the resident pages and four paths of State). */
type Panel = { key: IntegrationKey; origin: string } | null;
export interface MapSnapshot { state: State; mode: Mode; agents: AgentsSnapshot | null; panel: Panel }
/** A request in flight when the map was left never answers this instance (review M1: resumeLevel). */
const resume = (x: State): State => ({ ...x, roots: resumeLevel(x.roots), kids: Object.fromEntries(Object.entries(x.kids).map(([k, l]) => [k, resumeLevel(l)])) });
const start = (): State => ({ roots: { ...(emptyLevel() as Level<MapNode, MapGroup>), loading: 'first' }, kids: {}, exp: { expanded: [], visit: {}, tick: 0 }, selected: null });
const leafFilter = (group: MapGroup): HistoryFilter => ({ mode: 'all', agent: null, project: null, folder: null, group });

/** `tick` counts session activity: an empty map loads its first page again when sessions arrive (an import after start);
 *  Gate 5 G5d-1: a shown map, and one restored (Return or the nav link), fetches its resident pages again instead. */
export function AgentMap({ api, agents, lastKnown, tick, onOpen, saved = null, restoreId = null, onSave, open = null, importResult = null, onImport }: {
  api: MapApi; agents: AgentStatus[]; lastKnown: string | null; tick: number; onOpen: (row: HistoryRow) => void;
  /** XAIBO-PROD-539 Return to Agent Map: the map as left and the session to return to; `onSave` keeps it on leaving. */
  saved?: MapSnapshot | null; restoreId?: number | null; onSave?: (m: MapSnapshot) => void;
  /** XAIBO-PROD-595: the latest catalog import outcome and the native-dialog action (Add agent step 1). */
  importResult?: CatalogImportResult | null; onImport?: () => void;
  /** XAIBO-PROD-586 (D-P6-17): open this profile's integration panel (Agents mode) on arrival, e.g. from Settings. */
  open?: IntegrationKey | null;
}) {
  const name = useMemo(() => { const m = new Map(agents.map((a) => [a.agent, a.name])); return (id: string) => m.get(id) ?? id; }, [agents]);
  const [s, setS] = useState<State>(() => (saved ? resume(saved.state) : start()));
  const [notice, setNotice] = useState<string | null>(null);
  // XAIBO-PROD-575: the mode as left (nav link); Return from Session always shows Repositories (design §6.5.1)
  const [mode, setMode] = useState<Mode>(() => (open ? 'agents' : saved && restoreId === null ? saved.mode : 'repositories'));
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const agentsStore = useRef<AgentsSnapshot | null>(saved?.agents ?? null);
  // XAIBO-PROD-578: the open integration panel (Agents mode) and the row it was opened from
  const [panel, setPanel] = useState<Panel>(open ? { key: open, origin: agentKey(open) } : saved?.panel ?? null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const [agentsFocus, setAgentsFocus] = useState<{ key: string; n: number } | null>(null);
  const [listTick, setListTick] = useState(0);
  // XAIBO-PROD-593 (P6-T08 slice D; design §6.5.2): the Add agent wizard in the detail pane (Agents mode), Rescan beside it
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const [rescanning, setRescanning] = useState(false);
  const rescanAll = () => {
    if (rescanning) return;
    setRescanning(true);
    void api.rescan().then((r) => {
      setAnnounce(r.status === 'ready' ? 'Agents rescanned.' : r.code === 'rate-limited' ? 'Rescanned moments ago; try again shortly.' : 'Rescan is unavailable.');
      if (r.status === 'ready') setListTick((t) => t + 1);
    }, () => setAnnounce('Rescan is unavailable.')).finally(() => setRescanning(false));
  };
  const openAdd = () => { setFocusReq(null); setMode('agents'); setPanel(null); setAdding(true); }; // XAIBO-PROD-579: an integration action ran: the list refetches
  const backToMap = () => {
    const origin = panelRef.current?.origin;
    setPanel(null);
    const to = origin ? restoreTarget(agentItems(agentsStore.current?.level ?? (emptyLevel() as AgentsSnapshot['level'])).map((r) => agentKey(r.key)), origin) : null;
    if (to) setAgentsFocus((f) => ({ key: to, n: (f?.n ?? 0) + 1 }));
    else requestAnimationFrame(() => document.getElementById('map-tree-heading')?.focus());
  };
  const modeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const sRef = useRef(s);
  sRef.current = s;
  const [announce, setAnnounce] = useState('');
  const [focusReq, setFocusReq] = useState<{ key: string; n: number } | null>(null);
  const focusKey = useRef<string>('');
  /** Focus moves to row `k` (each request once, even to the same key). */
  const focusTo = (k: string) => { focusKey.current = k; setFocusReq((f) => ({ key: k, n: (f?.n ?? 0) + 1 })); };
  const tokens = useRef(new Map<string, number>()); // the latest request per level: older answers are dropped
  const seq = useRef(0); // review M1: one counter for all levels, so a collapsed and re-expanded level never reuses a token
  const list = useMemo(() => flatten(s.roots, s.kids, s.exp.expanded), [s.roots, s.kids, s.exp.expanded]);
  const byKey = useMemo(() => new Map(list.map((r) => [r.key, r])), [list]);
  const positions = useMemo(() => setPositions(list), [list]);
  const parentOf = (k: string) => byKey.get(k)?.parent ?? null;
  const groupOf = (k: string | null): MapGroup | null => { const r = k === null ? null : byKey.get(k); return r?.type === 'group' ? r.node.group : null; };
  const say = (t: string) => setAnnounce((a) => (a === t ? `${t} ` : t)); // a repeated text is announced again

  const fetchLevel = (group: MapGroup | null, cursor: MapGroup | HistoryKey | null): Promise<{ items: Child[]; next: MapGroup | HistoryKey | null }> => {
    const limit = pageSize(group);
    return group !== null && holdsSessions(group)
      ? api.history(leafFilter(group), cursor as HistoryKey | null, limit).then((r) => ({ items: r.rows, next: r.next }))
      : api.mapGroups(group, cursor as MapGroup | null, limit).then((r) => ({ items: r.groups, next: r.next }));
  };
  const load = (parent: string | null, group: MapGroup | null, dir: Dir, note = '') => {
    const level = parent === null ? sRef.current.roots : sRef.current.kids[parent];
    if (dir !== 'first' && (!level || level.loading)) return;
    const cursor = dir === 'first' || !level ? null : cursorFor(level as Level<Child, MapGroup | HistoryKey>, dir);
    const id = parent ?? '', token = ++seq.current;
    tokens.current.set(id, token);
    const put = (f: (l: Level<Child, MapGroup | HistoryKey>) => Level<Child, MapGroup | HistoryKey>) => setS((x) => {
      if (parent === null) return { ...x, roots: f(x.roots as Level<Child, MapGroup | HistoryKey>) as Level<MapNode, MapGroup> };
      const l = x.kids[parent];
      return l ? { ...x, kids: { ...x.kids, [parent]: f(l) } } : x; // collapsed meanwhile: nothing to update
    });
    put((l) => ({ ...l, loading: dir, failed: null }));
    const noun = nounOf(group);
    fetchLevel(group, cursor).then((r) => {
      if (tokens.current.get(id) !== token) return;
      // review M2: focus on the paging item moves to the row before the new ones, so the next arrow reaches them
      const old = parent === null ? sRef.current.roots : sRef.current.kids[parent];
      const anchor = dir !== 'first' && old ? pagingAnchor(old as Level<Child, MapGroup | HistoryKey>, dir) : null;
      put((l) => pageArrived(l, dir, cursor, r.items, r.next));
      if (anchor && focusKey.current === `${dir === 'prev' ? 'start' : 'end'}:${id}`) focusTo(anchor);
      say(note + loadedText(dir, noun, r.items.length));
    }, () => {
      if (tokens.current.get(id) !== token) return;
      put((l) => pageFailed(l, dir));
      say(`${note}Couldn't load ${noun}`);
    });
  };
  useEffect(() => { if (!saved) load(null, null, 'first'); }, []); // the root page loads on first show
  useEffect(() => () => onSave?.({ state: sRef.current, mode: modeRef.current, agents: agentsStore.current, panel: panelRef.current }), []); // kept for Return to Agent Map
  // XAIBO-PROD-539 (design §6.5.1): Return focuses the source leaf, selected; a deleted, trashed or moved session leaves
  // its former group focused with a notice
  useEffect(() => {
    if (restoreId === null || !saved) return;
    const leaf = sessionKey(restoreId), row = byKey.get(leaf);
    if (!row) { document.getElementById('agent-map-heading')?.focus(); return; } // evicted meanwhile: the heading
    const parent = row.parent, group = groupOf(parent);
    // review L1 (part 2b): the leaf is focused and selected at once; the check only moves on when it was dropped
    setS((x) => ({ ...x, selected: leaf }));
    focusTo(leaf);
    let live = true;
    api.historyRow(restoreId).then((r) => r, () => 'failed' as const).then((check) => {
      const t = returnTarget(leaf, parent, group, check);
      if (!live || !t.drop || parent === null) return;
      const shown = flatten(sRef.current.roots, sRef.current.kids, sRef.current.exp.expanded).some((r) => r.key === parent);
      if (!shown) return; // collapsed or evicted meanwhile: nothing to move to
      setS((x) => ({ ...x, kids: dropSession(x.kids, parent, restoreId), selected: x.selected === leaf ? parent : x.selected }));
      if (focusKey.current === leaf) focusTo(parent);
      setNotice(t.notice);
      if (t.notice) say(t.notice);
    });
    return () => { live = false; };
  }, []);
  // Gate 5 G5d-1: each resident page of the root and of every expanded level is fetched again from its own cursor and
  // replaced in place (bounded by the state itself: RESIDENT pages a level, PATHS paths). A level with a load in flight is
  // skipped, a reply after a newer load of its level is dropped, and a failed refresh keeps what is shown. Review M: a run
  // starts only once the previous one settled, and a reply applies only while its run is the latest.
  // `refreshed`: a refresh reply was applied, and whether focus was in the tree just before (review L: only then it moves)
  const refreshed = useRef<{ inTree: boolean } | null>(null);
  const gate = useRef<RefreshGate>({ gen: 0, pending: false });
  const refresh = () => {
    const g = startRefresh(gate.current);
    if (!g) { gate.current = { ...gate.current, again: true }; return; } // G5Rr1-4: rerun once this run settles
    gate.current = g;
    const run: Promise<unknown>[] = [];
    const x = sRef.current;
    const groups = new Map(flatten(x.roots, x.kids, x.exp.expanded).flatMap((r) => (r.type === 'group' ? [[r.key, r.node.group] as const] : [])));
    const levels: [string | null, Level<Child, MapGroup | HistoryKey>][] = [[null, x.roots as Level<Child, MapGroup | HistoryKey>],
      ...x.exp.expanded.flatMap((k) => { const l = x.kids[k]; return l && groups.has(k) ? [[k, l] as [string, Level<Child, MapGroup | HistoryKey>]] : []; })];
    for (const [parent, l] of levels) {
      if (l.loading) continue;
      const id = parent ?? '', token = tokens.current.get(id), group = parent === null ? null : groups.get(parent)!;
      for (const { from } of l.pages) {
        run.push(fetchLevel(group, from).then((r) => {
          if (tokens.current.get(id) !== token || !replyApplies(gate.current, g.gen)) return;
          const inTree = document.activeElement !== null && hostRef.current?.contains(document.activeElement) === true;
          refreshed.current = { inTree: (refreshed.current?.inTree ?? false) || inTree };
          setS((y) => {
            if (parent === null) return { ...y, roots: pageRefreshed(y.roots as Level<Child, MapGroup | HistoryKey>, from, r.items, r.next) as Level<MapNode, MapGroup> };
            const k = y.kids[parent];
            return k ? { ...y, kids: { ...y.kids, [parent]: pageRefreshed(k, from, r.items, r.next) } } : y;
          });
        }, () => undefined));
      }
    }
    void Promise.allSettled(run).then(() => {
      const r = settleRefresh(gate.current, g.gen);
      gate.current = r.gate;
      if (r.rerun) refreshRef.current();
    });
  };
  // a focused or selected row a refresh removed hands over to its nearest surviving ancestor (focus only moves when it was
  // in the tree: a refresh never takes focus from elsewhere)
  const prevList = useRef(list);
  useEffect(() => {
    const before = prevList.current;
    prevList.current = list;
    const r = refreshed.current;
    if (!r) return;
    refreshed.current = null;
    const k = focusKey.current;
    if (k && !byKey.has(k)) {
      const to = refocus(before, list, k);
      if (to) {
        if (r.inTree) focusTo(to);
        else focusKey.current = to;
      }
    }
    const sel = sRef.current.selected;
    if (sel !== null && !byKey.has(sel)) setS((x) => ({ ...x, selected: refocus(before, list, sel) }));
  }, [list]);
  // review L2: at most one empty-map reload or refresh every 2 s, the last tick of a burst still served; on mount this
  // refreshes a restored map once (Return, or the nav link)
  const lastReload = useRef(0), reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (reloadTimer.current) return;
    const r = sRef.current.roots;
    if (r.loading || r.failed || (r.next !== null && r.pages.every((p) => p.items.length === 0))) return;
    const wait = Math.max(0, lastReload.current + 2000 - Date.now());
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      lastReload.current = Date.now();
      const now = sRef.current.roots;
      if (now.pages.some((p) => p.items.length > 0)) refreshRef.current();
      else if (!now.loading && !now.failed && now.next === null) loadRef.current(null, null, 'first');
    }, wait);
  }, [tick]);
  useEffect(() => () => { if (reloadTimer.current) clearTimeout(reloadTimer.current); }, []);

  const loadRef = useRef(load);
  loadRef.current = load;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const doExpand = (key: string) => {
    setNotice(null); // review L3 (part 2b): a Return notice lasts until the next tree action
    const r = expand(s.exp, key, parentOf, focusKey.current || key);
    if (r.refused) { say(REFUSED); return; }
    for (const k of r.evicted) tokens.current.delete(k);
    setS((x) => {
      const kids = { ...x.kids, [key]: emptyLevel() as Level<Child, MapGroup | HistoryKey> };
      for (const k of r.evicted) delete kids[k];
      return { ...x, exp: r.e, kids };
    });
    // the eviction leads this branch's load announcement, so one replaces neither
    const note = r.evicted.length ? `${evictedText(r.evicted.map((k) => { const n = byKey.get(k); return n?.type === 'group' ? nodeText(n.node, name).label : null; }))}. ` : '';
    load(key, groupOf(key), 'first', note); // queued after the update above, so its level exists
  };
  const doCollapse = (key: string) => {
    setNotice(null);
    const r = collapse(s.exp, key, parentOf, focusKey.current);
    for (const k of r.removed) tokens.current.delete(k);
    setS((x) => { const kids = { ...x.kids }; for (const k of r.removed) delete kids[k]; return { ...x, exp: r.e, kids }; });
    if (r.focus !== focusKey.current) focusTo(r.focus);
  };
  const activate = (r: Row) => {
    setNotice(null);
    if (r.type === 'group') setS((x) => ({ ...x, selected: r.key }));
    else if (r.type === 'session') { setS((x) => ({ ...x, selected: r.key })); onOpen(r.row); }
    else if (!r.busy) load(r.parent, groupOf(r.parent), r.dir);
  };

  const onKey = (e: KeyboardEvent<HTMLUListElement>, i: number): number | null => {
    const a = treeKey(list, i, e.key, typeLabel);
    if (!a) return null;
    if ('move' in a) return a.move;
    if ('expand' in a) doExpand(a.expand);
    else if ('collapse' in a) doCollapse(a.collapse);
    else activate(list[a.activate]!);
    return i;
  };
  const toggle = (r: Row) => (e: MouseEvent) => { e.stopPropagation(); if (r.type === 'group') (r.expanded ? doCollapse : doExpand)(r.key); };

  const hostRef = useRef<HTMLDivElement>(null);
  const parentRef = useRef(parentOf);
  parentRef.current = parentOf;

  const selected = s.selected === null ? null : byKey.get(s.selected) ?? null;
  const detail: Detail | null = selected?.type === 'group' ? groupDetail(selected.node, name) : selected?.type === 'session' ? sessionDetail(selected.row, name) : null;
  const rootsEmpty = s.roots.pages.every((p) => p.items.length === 0);

  return (
    <div className="x-map-area">
      <h1 id="agent-map-heading" tabIndex={-1}>Agent Map</h1>
      <div className="x-integration-actions x-map-actions">
        <button ref={addRef} type="button" className="x-btn x-btn-primary" onClick={openAdd}>Add agent</button>
        {/* review L5: while the wizard is open its own Rescan agents is the one that may run (it waits for an apply or receipt test) */}
        <button type="button" className="x-btn x-btn-secondary" aria-disabled={rescanning || adding || lastKnown !== null || undefined} onClick={() => { if (lastKnown === null && !adding) rescanAll(); }}>Rescan</button>
      </div>
      {lastKnown ? <p className="x-hint">Last known {lastKnown}: live counts may be out of date.</p> : null}
      {notice ? <p className="x-hint x-map-notice">{notice}</p> : null}
      <div className={mode !== 'agents' ? 'x-map' : panel || adding ? 'x-map x-map-panel-open' : 'x-map x-map-single'}>
        <section className="x-pane x-map-tree" aria-labelledby="map-tree-heading">
          <div className="x-pane-head">
            <h2 id="map-tree-heading" tabIndex={-1}>{mode === 'agents' ? 'Agents' : 'Repositories'}</h2>
            <div role="group" aria-label="Agent Map view" className="x-modes">
              {MODES.map((m, i) => (
                <button key={m.mode} ref={(el) => { modeRefs.current[i] = el; }} type="button" className="x-mode" aria-pressed={mode === m.mode} tabIndex={mode === m.mode ? 0 : -1}
                  onKeyDown={(e) => rovingKey(e, i, MODES.length, modeRefs.current)} onClick={() => { if (mode !== m.mode) { setFocusReq(null); setMode(m.mode); setAdding(false); } }}>{m.label}</button>
              ))}
            </div>
          </div>
          {mode === 'agents' ? <AgentsList fetchPage={api.integrationPage} lastKnown={lastKnown} store={agentsStore} focusTo={agentsFocus} refresh={listTick} onOpen={(r) => { setAdding(false); setPanel({ key: r.key, origin: agentKey(r.key) }); }} />
            : rootsEmpty && s.roots.loading && s.roots.pages.length === 0 ? <p className="x-hint x-map-note">Loading…</p>
            : rootsEmpty && s.roots.failed ? <p className="x-hint x-map-note">Groups could not be loaded. <button type="button" className="x-btn x-btn-quiet" onClick={() => load(null, null, 'first')}>Retry</button></p>
            : rootsEmpty ? <p className="x-hint x-map-note">No sessions yet.</p>
            : (
              <div className="x-map-host" ref={hostRef} onFocus={(e) => { const k = (e.target as HTMLElement).dataset.key; if (k) { focusKey.current = k; setS((x) => ({ ...x, exp: touch(x.exp, k, parentOf) })); } }}>
                <VirtualList
                  items={list} getKey={(r) => r.key} label="Repositories, worktrees and sessions" initialFocusKey={focusKey.current || null} itemLabel={(r) => rowLabel(r, name)} estimateSize={64}
                  hasMore={false} loading={false} onLoadMore={() => undefined}
                  render={(r) => <Node r={r} name={name} lastKnown={lastKnown !== null} onToggle={toggle(r)} onActivate={() => activate(r)} />}
                  tree={{
                    onKey, focus: focusReq,
                    attrs: (r) => ({ 'data-key': r.key, 'aria-level': r.level, 'aria-posinset': positions.get(r.key)?.pos, 'aria-setsize': positions.get(r.key)?.size, 'aria-expanded': r.type === 'group' ? r.expanded : undefined,
                      'aria-selected': r.key === s.selected ? true : undefined, 'aria-busy': (r.type === 'group' && r.loading) || (r.type !== 'group' && r.type !== 'session' && r.busy) || undefined }),
                  }}
                />
                <Links host={hostRef} parentOf={parentRef} />
              </div>
            )}
        </section>
        {mode === 'agents' ? (adding ? (
          <AddAgent api={api} lastKnown={lastKnown} onChanged={() => setListTick((t) => t + 1)} importResult={importResult} {...(onImport ? { onImport } : {})}
            onCancel={() => { setAdding(false); requestAnimationFrame(() => addRef.current?.focus()); }}
            onDone={(key) => { setAdding(false); setListTick((t) => t + 1); setPanel({ key, origin: agentKey(key) }); }} />
        ) : panel ? (
          <IntegrationPanel key={panel.origin} fetchDetail={api.integrationDetail} fetchPage={api.integrationPage} write={api} signIn={api.signIn} grants={api} target={panel.key} lastKnown={lastKnown} onBack={backToMap} onChanged={() => setListTick((t) => t + 1)}
            onProfile={(id) => setPanel((p) => (p ? { ...p, key: { agent: p.key.agent, profileId: id } } : p))} />
        ) : null) : (
        <section className="x-pane x-map-detail" aria-labelledby="map-detail-heading">
          <div className="x-pane-head"><h2 id="map-detail-heading">Details</h2></div>
          <div className="x-map-detail-body">
            {detail ? (
              <>
                <h3>{visible(detail.heading)}</h3>
                <dl className="x-map-dl">
                  {detail.lines.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{visible(v)}</dd></div>)}
                </dl>
                {selected?.type === 'session' ? <button type="button" className="x-btn x-btn-secondary" onClick={() => onOpen(selected.row)}>Open in Session</button> : null}
              </>
            ) : <p className="x-hint">Select a repository, worktree, folder or session to see its details.</p>}
          </div>
        </section>
        )}
      </div>
      <p className="x-sr-only" aria-live="polite">{announce}</p>
    </div>
  );
}

/** XAIBO-PROD-539 (design §6.5.1, DD2-04): at >=1200 px decorative connectors between mounted rows only, from a parent's
 *  right-edge centre to a child's left-edge centre through the column gap; measured from mounted bounds after every layout
 *  change (scroll, resize, virtualization: observed DOM changes), none below 1200 px; bounded by the mounted rows. Its own
 *  component (review M2, part 2b): a scroll frame re-renders only this svg, never the tree. */
function Links({ host: hostRef, parentOf }: { host: RefObject<HTMLDivElement | null>; parentOf: RefObject<(k: string) => string | null> }) {
  const [links, setLinks] = useState<{ paths: [string, string][]; top: number; left: number; w: number; h: number }>({ paths: [], top: 0, left: 0, w: 0, h: 0 });
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const wide = matchMedia('(min-width: 1200px)');
    let frame = 0;
    const measure = () => {
      frame = 0;
      const sc = host.querySelector<HTMLElement>('.x-vlist');
      if (!sc || !wide.matches) { setLinks((l) => (l.paths.length ? { ...l, paths: [] } : l)); return; }
      const o = sc.getBoundingClientRect(), cells = new Map<string, DOMRect>();
      for (const li of host.querySelectorAll<HTMLElement>('[data-key]')) {
        const c = li.querySelector('.x-map-cell');
        if (c) cells.set(li.dataset.key!, c.getBoundingClientRect());
      }
      const paths: [string, string][] = [];
      for (const [k, r] of cells) {
        const p = parentOf.current(k), pr = p === null ? undefined : cells.get(p);
        if (pr) paths.push([k, connectorPath({ x: pr.right - o.left, y: pr.top + pr.height / 2 - o.top }, { x: r.left - o.left, y: r.top + r.height / 2 - o.top })]);
      }
      const next = { paths, top: sc.offsetTop, left: sc.offsetLeft, w: sc.clientWidth, h: sc.clientHeight };
      const same = (l: typeof next) => l.top === next.top && l.left === next.left && l.w === next.w && l.h === next.h && l.paths.join('|') === paths.join('|');
      setLinks((l) => (same(l) ? l : next)); // the svg sits inside the observed host: an unchanged measure must not render
    };
    const later = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const mo = new MutationObserver(later), ro = new ResizeObserver(later);
    mo.observe(host.querySelector('.x-vlist') ?? host, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'aria-expanded'] });
    ro.observe(host);
    host.addEventListener('scroll', later, true);
    wide.addEventListener('change', later);
    later();
    return () => { mo.disconnect(); ro.disconnect(); host.removeEventListener('scroll', later, true); wide.removeEventListener('change', later); if (frame) cancelAnimationFrame(frame); };
  }, [hostRef, parentOf]);
  if (!links.paths.length) return null;
  return (
    <svg className="x-map-links" aria-hidden="true" focusable="false" width={links.w} height={links.h} style={{ top: `${links.top}px`, left: `${links.left}px` }}>
      {links.paths.map(([k, d]) => <path key={k} d={d} />)}
    </svg>
  );
}

/** One treeitem's content: no focusable descendants (the treeitem is the tab stop); the chevron only expands. */
function Node({ r, name, lastKnown, onToggle, onActivate }: { r: Row; name: (a: string) => string; lastKnown: boolean; onToggle: (e: MouseEvent) => void; onActivate: () => void }) {
  if (r.type === 'group') {
    const t = nodeText(r.node, name), k = kindOf(r.node.group);
    return (
      <div className={`x-map-node x-map-l${r.level}`} onClick={onActivate}>
        <span className="x-map-cell">
        <span className="x-map-chev" data-open={r.expanded || undefined} aria-hidden="true" onClick={onToggle}><Icon id="chevron" /></span>
        <span className="x-map-box" data-kind={k}>
          <span className="x-map-label"><Icon id={k === 'worktree' ? 'branch' : 'folder'} />{visible(t.label)}</span>
          <span className="x-map-sub">{visible(t.sub)}{t.path && k !== 'folder' ? <> · <span className="x-map-path">{visible(t.path)}</span></> : null}</span>
          <span className="x-map-count">{lastKnown && k !== 'repo' && k !== 'project' ? 'Last known: ' : null}{visible(t.count)}</span>
          {r.loading ? <span className="x-map-sub">Loading…</span> : null}
        </span>
        </span>
      </div>
    );
  }
  if (r.type === 'session') {
    const row = r.row, st = compactStatus(row.live);
    return (
      <div className={`x-map-node x-map-l${r.level}`} onClick={onActivate}>
        <span className="x-map-cell">
        <span className="x-map-chev" aria-hidden="true" />
        <span className="x-map-box x-map-leaf">
          <span className="x-map-label"><Icon id="file" /><span><Title row={row} /></span></span>
          <span className="x-map-sub"><span className={`x-dot x-dot-${st.tone}`} aria-hidden="true" /> {visible(name(row.agent))} · {lastKnown ? 'Last known: ' : null}{st.text} · {formatTime(row.lastActivity)}</span>
          <span className="x-map-sub x-map-path">{show(row.cwd, 'Cwd unavailable')}</span>
        </span>
        </span>
      </div>
    );
  }
  return (
    <div className={`x-map-node x-map-l${r.level}`} onClick={onActivate}>
      <span className="x-map-cell">
        <span className="x-map-chev" aria-hidden="true" />
        <span className="x-map-box x-map-more" data-type={r.type}>{r.busy ? 'Loading…' : r.label}</span>
      </span>
    </div>
  );
}
