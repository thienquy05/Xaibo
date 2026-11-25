// XAIBO-PROD-575 (P6-T10 unit 2b; FR-06, D-PD-02; design §6.5, .handoff/p6-t10-design.md section 3): the Agent Map
// Agents list. One row per agent and profile from integrationPage over the shared VirtualList: FR-06 glyph and word, named
// reasons, separate Lifecycle receipt and Content coverage; 10 rows a page, three resident (integrations-state.ts), Load
// previous above and Load more below. Its state lives in the caller's store, so a mode switch unmounts the list and keeps
// its pages and anchor; each mount refetches the resident pages in place. Every service string goes through visible().
// Open integration and its panel are unit 4 (no inert control ships here).
// Evidence refreshes on mode entry, on service return and after an integration action (XAIBO-PROD-579: `refresh`).
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { IntegrationKey, IntegrationPageResult, IntegrationRow } from '../../shared/ipc.ts';
import { VirtualList } from '../components/VirtualList.tsx';
import { formatTime } from '../model.ts';
import { Icon } from '../status/StatusBadge.tsx';
import { visible } from '../text.ts';
import { AGENTS_PAGE, agentItems, agentKey, agentLabel, profileName, contentText, pageReply, pageRequest, reasonsText, receiptText, REFUSAL_TEXT, STATE, stateText, type AgentLevel } from './integrations-state.ts';
import { emptyLevel, pageFailed, pageRefreshed, resumeLevel, type Dir } from './tree.ts';

export type PageFetch = (cursor: IntegrationKey | null, limit: number) => Promise<IntegrationPageResult>;
export interface AgentsSnapshot { level: AgentLevel; observedAt: number | null; focus: string | null }

/** XAIBO-PROD-578: `onOpen` opens a row's integration panel (its named button, or Enter on the row); `focusTo` moves focus to a
 *  row (Back to map). */
export function AgentsList({ fetchPage, lastKnown, store, onOpen, focusTo = null, refresh: refreshTick = 0 }: {
  fetchPage: PageFetch; lastKnown: string | null; store: MutableRefObject<AgentsSnapshot | null>; onOpen: (row: IntegrationRow) => void; focusTo?: { key: string; n: number } | null;
  /** XAIBO-PROD-579: a change refetches the resident pages in place (an integration action ran). */
  refresh?: number;
}) {
  const [s, setS] = useState<AgentsSnapshot>(() => (store.current ? { ...store.current, level: resumeLevel(store.current.level) }
    : { level: { ...(emptyLevel() as AgentLevel), loading: 'first' }, observedAt: null, focus: null }));
  const sRef = useRef(s);
  sRef.current = s;
  // code review H1: the focused row is this mode's anchor; a redraw never puts back an older one
  const focusRef = useRef<string | null>(s.focus);
  store.current = { ...s, focus: focusRef.current };
  const [refused, setRefused] = useState<keyof typeof REFUSAL_TEXT | null>(null);
  // ponytail: while the service is still starting, the request is retried every 2 s until it answers
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (retry.current) clearTimeout(retry.current); }, []);
  const seq = useRef(0); // the latest request: an older reply is dropped
  const [announce, setAnnounce] = useState('');
  const say = (t: string) => setAnnounce((a) => (a === t ? `${t} ` : t));
  const prevFocused = useRef(false);
  const [focusReq, setFocusReq] = useState<{ key: string; n: number } | null>(null);
  // code review M2: a request is taken once; a remount (a mode switch) never replays an old one
  const seenTo = useRef(focusTo?.n ?? null);
  useEffect(() => {
    if (!focusTo || focusTo.n === seenTo.current) return;
    seenTo.current = focusTo.n;
    setFocusReq((f) => ({ key: focusTo.key, n: (f?.n ?? 0) + 1 }));
  }, [focusTo?.n]);

  const load = (dir: Dir) => {
    const l = sRef.current.level;
    if (dir !== 'first' && l.loading) return;
    const req = pageRequest(l, dir), token = ++seq.current;
    setS((x) => ({ ...x, level: { ...x.level, loading: dir, failed: null } }));
    fetchPage(req.cursor, req.limit).then((r) => {
      if (seq.current !== token) return;
      const out = pageReply(sRef.current.level, dir, req.cursor, r);
      setS((x) => ({ ...x, level: out.level, observedAt: out.observedAt ?? x.observedAt }));
      setRefused(out.refused);
      if (!(dir === 'more' && r.status === 'ready')) say(out.note); // review L1: VirtualList announces a Load more itself
      if (out.reload) load('first');
      if (out.refused === 'starting') retry.current = setTimeout(() => load(dir), 2000);
    }, () => {
      if (seq.current !== token) return;
      setS((x) => ({ ...x, level: pageFailed(x.level, dir) }));
      setRefused('failed');
      say(REFUSAL_TEXT.failed);
    });
  };
  /** The resident pages again, each from its own cursor, replaced in place; any refusal starts over from the first page, a
   *  failure keeps what is shown. */
  const refresh = () => {
    const l = sRef.current.level;
    if (l.loading) return;
    if (!l.pages.length) { load('first'); return; }
    const token = ++seq.current;
    Promise.all(l.pages.map((p) => fetchPage(p.from, AGENTS_PAGE).then((r) => ({ from: p.from, r })))).then((all) => {
      if (seq.current !== token) return;
      if (all.some((a) => a.r.status !== 'ready')) { load('first'); return; }
      setS((x) => ({
        ...x,
        level: all.reduce((lv, a) => (a.r.status === 'ready' ? pageRefreshed(lv, a.from, a.r.value.rows, a.r.value.next) : lv), x.level),
        observedAt: Math.max(x.observedAt ?? 0, ...all.map((a) => (a.r.status === 'ready' ? a.r.observedAt : 0))),
      }));
    }, () => undefined);
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => { if (s.level.pages.length) refresh(); else load('first'); }, []);
  const seenTick = useRef(refreshTick);
  useEffect(() => { if (refreshTick !== seenTick.current) { seenTick.current = refreshTick; refreshRef.current(); } }, [refreshTick]);
  const wasLost = useRef(lastKnown !== null);
  useEffect(() => { // the service is back: its evidence again
    if (wasLost.current && lastKnown === null) refreshRef.current();
    wasLost.current = lastKnown !== null;
  }, [lastKnown]);

  const items = agentItems(s.level), l = s.level;
  // Load previous gone while focused (nothing earlier left): the first row takes focus
  useEffect(() => {
    const top = items[0];
    if (prevFocused.current && !l.before.length && l.failed !== 'prev' && top) { prevFocused.current = false; setFocusReq((f) => ({ key: agentKey(top.key), n: (f?.n ?? 0) + 1 })); }
  }, [l.before.length, l.failed]);

  const lost = lastKnown !== null;
  const empty = items.length === 0;
  return (
    <div className="x-map-agents" onKeyDown={(e) => { // Enter on a row opens its integration (the row's own button keeps its keys)
      if (e.key !== 'Enter' || !(e.target as HTMLElement).matches('li[data-index]')) return;
      const r = items[Number((e.target as HTMLElement).dataset.index)];
      if (r) { e.preventDefault(); onOpen(r); }
    }} onFocus={(e) => {
      const i = Number((e.target as HTMLElement).closest('li[data-index]')?.getAttribute('data-index'));
      const r = Number.isInteger(i) ? items[i] : undefined;
      if (r) { focusRef.current = agentKey(r.key); store.current = { ...sRef.current, focus: focusRef.current }; }
    }}>
      {s.observedAt !== null ? <p className="x-hint x-map-note">{lost ? `Last known ${lastKnown}: states may be out of date. ` : ''}Evidence checked {formatTime(s.observedAt)}</p> : null}
      {empty && l.loading === 'first' ? <p className="x-hint x-map-note">Loading agents…</p>
        : empty && l.failed ? <p className="x-hint x-map-note">{REFUSAL_TEXT[refused ?? 'failed']}. <button type="button" className="x-btn x-btn-quiet" onClick={() => load('first')}>Retry</button></p>
        : empty ? <p className="x-hint x-map-note">No agents detected.</p>
        : (
          <>
            {l.before.length || l.failed === 'prev' ? (
              <p className="x-vlist-end">
                <button type="button" className="x-button" aria-disabled={l.loading === 'prev' || undefined} onFocus={() => { prevFocused.current = true; }} onBlur={(e) => { if (e.relatedTarget) prevFocused.current = false; }}
                  onClick={() => { if (!l.loading) load('prev'); }}>{l.loading === 'prev' ? 'Loading agents' : l.failed === 'prev' ? 'Retry loading agents' : 'Load previous agents'}</button>
              </p>
            ) : null}
            <VirtualList
              items={items} getKey={(r) => agentKey(r.key)} label="Agents and profiles" itemLabel={agentLabel} estimateSize={112} initialFocusKey={focusRef.current} focus={focusReq} moreBefore={l.before.length > 0}
              hasMore={l.next !== null} loading={l.loading === 'more'} onLoadMore={() => load('more')}
              render={(r, _i, tabStop) => {
                const st = STATE[r.state], why = reasonsText(r);
                return (
                  <div className="x-agent-row">
                    <span className="x-agent-name">{visible(r.name)}</span>
                    <span className="x-agent-sub">{r.profileLabel === null ? 'No profile' : visible(r.profileLabel)} · {r.version === null ? 'Version unavailable' : `Version ${visible(r.version)}`}</span>
                    <span className="x-agent-state" data-tone={st.tone}><Icon id={st.icon} />{stateText(r, lost)}</span>
                    {why ? <span className="x-agent-sub">{why}</span> : null}
                    <span className="x-agent-sub">{visible(receiptText(r))}</span>
                    <span className="x-agent-sub">{visible(contentText(r.content))}</span>
                    <button type="button" className="x-btn x-btn-quiet x-agent-open" tabIndex={tabStop ? 0 : -1} aria-label={`Open integration: ${profileName(r)}`} onClick={() => onOpen(r)}>Open integration</button>
                  </div>
                );
              }}
            />
            {l.failed === 'more' || l.failed === 'first' ? ( // review L3: a failure while rows are shown is said, with Retry for a reload
              <p className="x-hint x-map-note">{REFUSAL_TEXT[refused ?? 'failed']}.{l.failed === 'first' ? <> <button type="button" className="x-btn x-btn-quiet" onClick={() => load('first')}>Retry</button></> : null}</p>
            ) : null}
          </>
        )}
      <p className="x-sr-only" aria-live="polite">{announce}</p>
    </div>
  );
}
