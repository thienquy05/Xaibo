// XAIBO-PROD-538 (P5-T18a part 2a; design §6.5–6.5.1, S-37, US-21; look D-P5-13): the Agent Map area. One ARIA tree
// (Repositories, worktrees and sessions) over the part 1 model in tree.ts, rendered by the shared VirtualList, and a
// Details pane for the selected item with Open in Session for a session leaf. Every label and count is service evidence
// (exact or an unavailable word); every untrusted string goes through visible(). Part 2b adds the wide connectors and
// Return to Agent Map.
// ponytail: collapse discards a branch's pages without keeping its cursor (design allows reloading it explicitly);
// keep the cursor when users ask to reopen deep pages.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { AgentStatus, HistoryFilter, HistoryKey, HistoryRow, MapGroup, MapNode } from '../../shared/ipc.ts';
import { VirtualList } from '../components/VirtualList.tsx';
import { formatTime } from '../model.ts';
import { Icon } from '../status/StatusBadge.tsx';
import { Title } from '../SessionList.tsx';
import { show, visible } from '../text.ts';
import { compactStatus } from '../workspace/view.ts';
import {
  collapse, cursorFor, emptyLevel, evictedText, expand, groupDetail, holdsSessions, kindOf, loadedText, nodeText, nounOf, pageArrived, pageFailed, pageSize,
  pagingAnchor, REFUSED, rowLabel, rows as flatten, sessionDetail, setPositions, touch, treeKey, typeLabel, type Detail, type Dir, type Expansion, type Kids, type Level, type Row,
} from './tree.ts';

export interface MapApi {
  mapGroups(parent: MapGroup | null, cursor: MapGroup | null, limit: number): Promise<{ groups: MapNode[]; next: MapGroup | null }>;
  history(filter: HistoryFilter, cursor: HistoryKey | null, limit: number): Promise<{ rows: HistoryRow[]; next: HistoryKey | null }>;
}

type Child = MapNode | HistoryRow;
interface State { roots: Level<MapNode, MapGroup>; kids: Kids; exp: Expansion; selected: string | null }
const start = (): State => ({ roots: { ...(emptyLevel() as Level<MapNode, MapGroup>), loading: 'first' }, kids: {}, exp: { expanded: [], visit: {}, tick: 0 }, selected: null });
const leafFilter = (group: MapGroup): HistoryFilter => ({ mode: 'all', agent: null, project: null, folder: null, group });

/** `tick` counts session activity: an empty map loads its first page again when sessions arrive (an import after start).
 *  ponytail: a shown tree keeps its counts until the area is entered again; refresh resident levels when users ask. */
export function AgentMap({ api, agents, lastKnown, tick, onOpen }: { api: MapApi; agents: AgentStatus[]; lastKnown: string | null; tick: number; onOpen: (row: HistoryRow) => void }) {
  const name = useMemo(() => { const m = new Map(agents.map((a) => [a.agent, a.name])); return (id: string) => m.get(id) ?? id; }, [agents]);
  const [s, setS] = useState<State>(start);
  const sRef = useRef(s);
  sRef.current = s;
  const [announce, setAnnounce] = useState('');
  const [focusReq, setFocusReq] = useState<{ key: string; n: number } | null>(null);
  const focusKey = useRef<string>('');
  const tokens = useRef(new Map<string, number>()); // the latest request per level: older answers are dropped
  const seq = useRef(0); // review M1: one counter for all levels, so a collapsed and re-expanded level never reuses a token
  const list = useMemo(() => flatten(s.roots, s.kids, s.exp.expanded), [s.roots, s.kids, s.exp.expanded]);
  const byKey = useMemo(() => new Map(list.map((r) => [r.key, r])), [list]);
  const positions = useMemo(() => setPositions(list), [list]);
  const parentOf = (k: string) => byKey.get(k)?.parent ?? null;
  const groupOf = (k: string | null): MapGroup | null => { const r = k === null ? null : byKey.get(k); return r?.type === 'group' ? r.node.group : null; };
  const say = (t: string) => setAnnounce((a) => (a === t ? `${t} ` : t)); // a repeated text is announced again

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
    const noun = nounOf(group), limit = pageSize(group);
    const req: Promise<{ items: Child[]; next: MapGroup | HistoryKey | null }> = group !== null && holdsSessions(group)
      ? api.history(leafFilter(group), cursor as HistoryKey | null, limit).then((r) => ({ items: r.rows, next: r.next }))
      : api.mapGroups(group, cursor as MapGroup | null, limit).then((r) => ({ items: r.groups, next: r.next }));
    req.then((r) => {
      if (tokens.current.get(id) !== token) return;
      // review M2: focus on the paging item moves to the row before the new ones, so the next arrow reaches them
      const old = parent === null ? sRef.current.roots : sRef.current.kids[parent];
      const anchor = dir !== 'first' && old ? pagingAnchor(old as Level<Child, MapGroup | HistoryKey>, dir) : null;
      put((l) => pageArrived(l, dir, cursor, r.items, r.next));
      if (anchor && focusKey.current === `${dir === 'prev' ? 'start' : 'end'}:${id}`) { focusKey.current = anchor; setFocusReq((f) => ({ key: anchor, n: (f?.n ?? 0) + 1 })); }
      say(note + loadedText(dir, noun, r.items.length));
    }, () => {
      if (tokens.current.get(id) !== token) return;
      put((l) => pageFailed(l, dir));
      say(`${note}Couldn't load ${noun}`);
    });
  };
  useEffect(() => { load(null, null, 'first'); }, []); // the root page loads on first show
  // review L2: at most one empty-map reload every 2 s, the last tick of a burst still served
  const lastReload = useRef(0), reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const r = sRef.current.roots;
    if (r.loading || r.failed || r.next !== null || !r.pages.every((p) => p.items.length === 0) || reloadTimer.current) return;
    const wait = Math.max(0, lastReload.current + 2000 - Date.now());
    reloadTimer.current = setTimeout(() => { reloadTimer.current = null; lastReload.current = Date.now(); loadRef.current(null, null, 'first'); }, wait);
  }, [tick]);
  useEffect(() => () => { if (reloadTimer.current) clearTimeout(reloadTimer.current); }, []);

  const loadRef = useRef(load);
  loadRef.current = load;
  const doExpand = (key: string) => {
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
    const r = collapse(s.exp, key, parentOf, focusKey.current);
    for (const k of r.removed) tokens.current.delete(k);
    setS((x) => { const kids = { ...x.kids }; for (const k of r.removed) delete kids[k]; return { ...x, exp: r.e, kids }; });
    if (r.focus !== focusKey.current) { focusKey.current = r.focus; setFocusReq((f) => ({ key: r.focus, n: (f?.n ?? 0) + 1 })); }
  };
  const activate = (r: Row) => {
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

  const selected = s.selected === null ? null : byKey.get(s.selected) ?? null;
  const detail: Detail | null = selected?.type === 'group' ? groupDetail(selected.node, name) : selected?.type === 'session' ? sessionDetail(selected.row, name) : null;
  const rootsEmpty = s.roots.pages.every((p) => p.items.length === 0);

  return (
    <div className="x-map-area">
      <h1 id="agent-map-heading" tabIndex={-1}>Agent Map</h1>
      {lastKnown ? <p className="x-hint">Last known {lastKnown}: live counts may be out of date.</p> : null}
      <div className="x-map">
        <section className="x-pane x-map-tree" aria-labelledby="map-tree-heading">
          <div className="x-pane-head"><h2 id="map-tree-heading">Repositories</h2></div>
          {rootsEmpty && s.roots.loading && s.roots.pages.length === 0 ? <p className="x-hint x-map-note">Loading…</p>
            : rootsEmpty && s.roots.failed ? <p className="x-hint x-map-note">Groups could not be loaded. <button type="button" className="x-btn x-btn-quiet" onClick={() => load(null, null, 'first')}>Retry</button></p>
            : rootsEmpty ? <p className="x-hint x-map-note">No sessions yet.</p>
            : (
              <div onFocus={(e) => { const k = (e.target as HTMLElement).dataset.key; if (k) { focusKey.current = k; setS((x) => ({ ...x, exp: touch(x.exp, k, parentOf) })); } }}>
                <VirtualList
                  items={list} getKey={(r) => r.key} label="Repositories, worktrees and sessions" itemLabel={(r) => rowLabel(r, name)} estimateSize={64}
                  hasMore={false} loading={false} onLoadMore={() => undefined}
                  render={(r) => <Node r={r} name={name} lastKnown={lastKnown !== null} onToggle={toggle(r)} onActivate={() => activate(r)} />}
                  tree={{
                    onKey, focus: focusReq,
                    attrs: (r) => ({ 'data-key': r.key, 'aria-level': r.level, 'aria-posinset': positions.get(r.key)?.pos, 'aria-setsize': positions.get(r.key)?.size, 'aria-expanded': r.type === 'group' ? r.expanded : undefined,
                      'aria-selected': r.key === s.selected ? true : undefined, 'aria-busy': (r.type === 'group' && r.loading) || (r.type !== 'group' && r.type !== 'session' && r.busy) || undefined }),
                  }}
                />
              </div>
            )}
        </section>
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
      </div>
      <p className="x-sr-only" aria-live="polite">{announce}</p>
    </div>
  );
}

/** One treeitem's content: no focusable descendants (the treeitem is the tab stop); the chevron only expands. */
function Node({ r, name, lastKnown, onToggle, onActivate }: { r: Row; name: (a: string) => string; lastKnown: boolean; onToggle: (e: MouseEvent) => void; onActivate: () => void }) {
  if (r.type === 'group') {
    const t = nodeText(r.node, name), k = kindOf(r.node.group);
    return (
      <div className={`x-map-node x-map-l${r.level}`} onClick={onActivate}>
        <span className="x-map-chev" data-open={r.expanded || undefined} aria-hidden="true" onClick={onToggle}><Icon id="chevron" /></span>
        <span className="x-map-box" data-kind={k}>
          <span className="x-map-label"><Icon id={k === 'worktree' ? 'branch' : 'folder'} />{visible(t.label)}</span>
          <span className="x-map-sub">{visible(t.sub)}{t.path && k !== 'folder' ? <> · <span className="x-map-path">{visible(t.path)}</span></> : null}</span>
          <span className="x-map-count">{lastKnown && k !== 'repo' && k !== 'project' ? 'Last known: ' : null}{visible(t.count)}</span>
          {r.loading ? <span className="x-map-sub">Loading…</span> : null}
        </span>
      </div>
    );
  }
  if (r.type === 'session') {
    const row = r.row, st = compactStatus(row.live);
    return (
      <div className={`x-map-node x-map-l${r.level}`} onClick={onActivate}>
        <span className="x-map-chev" aria-hidden="true" />
        <span className="x-map-box x-map-leaf">
          <span className="x-map-label"><Icon id="file" /><span><Title row={row} /></span></span>
          <span className="x-map-sub"><span className={`x-dot x-dot-${st.tone}`} aria-hidden="true" /> {visible(name(row.agent))} · {lastKnown ? 'Last known: ' : null}{st.text} · {formatTime(row.lastActivity)}</span>
          <span className="x-map-sub x-map-path">{show(row.cwd, 'Cwd unavailable')}</span>
        </span>
      </div>
    );
  }
  return (
    <div className={`x-map-node x-map-l${r.level}`} onClick={onActivate}>
      <span className="x-map-chev" aria-hidden="true" />
      <span className="x-map-box x-map-more" data-type={r.type}>{r.busy ? 'Loading…' : r.label}</span>
    </div>
  );
}
