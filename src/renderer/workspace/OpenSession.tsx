// XAIBO-PROD-413 (P4-T05d; design §6.3 as amended by D-P4-06): one open session. Fixed header (title, chips, Details),
// fixed section tabs, a section body that scrolls on its own, a fixed bottom bar, and a Details drawer over the body.
// A live session opens on its latest page, anything else at its first turn; later activity is appended at the end
// without moving the reading position.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CostDetail, FileItem, ModelMarker, SessionDetail, SessionRow, SubagentItem, TCursor, ToolItem, TranscriptItem } from '../../shared/ipc.ts';
import type { Client } from '../client.ts';
import { contextText, costText, findingBadges, formatTime, markers as rowMarkers, originText, statusExtras } from '../model.ts';
import { Icon, StatusBadge } from '../status/StatusBadge.tsx';
import { visible } from '../text.ts';
import { ContextPane } from './context/ContextSection.tsx';
import { CostPane } from './cost/CostSection.tsx';
import { Conversation, Files, Subagents, Timeline, Tools, type Paged, type SliceFn } from './sections.tsx';
import { mergeTimeline } from './timeline.ts';
import { appendLive, compactStatus, countText, incompleteReasons, initialAt, liveAction, settled, trimWindow, WINDOW_MAX } from './view.ts';

export type WorkspaceApi = Pick<Client, 'session' | 'transcript' | 'slice' | 'tools' | 'subagents' | 'files' | 'markers' | 'cost'>;
const PAGE = 50;
const SIDE_MS = 1_000; // review M3: refresh cadence of detail, cost and the lists under a burst of changes

/** Review M3: a trailing throttle; a burst of changes yields at most one new value per `ms`, the last one always lands. */
function useThrottled(v: number, ms: number): number {
  const [out, setOut] = useState(v);
  const last = useRef(0);
  useEffect(() => {
    if (v === out) return;
    const t = setTimeout(() => { last.current = Date.now(); setOut(v); }, Math.max(0, last.current + ms - Date.now()));
    return () => clearTimeout(t);
  }, [v]); // reacts to new values only
  return out;
}
const LEDGER_PAGE = 100;
// ponytail: tool records for the conversation come from the first 5 tool pages (500 calls); a longer session shows
// later calls without their record until Tools > Load more reaches them. Page the tool records by transcript range if
// sessions that long are common.
const TOOL_PAGES = 5;
const RELOAD_MAX = 5; // pages refetched per live reload (re-review)

/** A forward-paged list loaded on mount (up to `pages` pages) and reloaded when `key` changes. Review M2: a reload
 *  fetches as many pages as were loaded, so live activity never drops pages the user loaded. Review L5: Retry after a
 *  failed (re)load reloads instead of appending page 1 again. */
function usePaged<T, C>(fetch: (c: C | null) => Promise<{ items: T[]; next: C | null }>, pages: number, key: unknown): Paged<T> {
  const [s, setS] = useState<{ items: T[]; next: C | null; loading: boolean; failed: boolean; reloadFailed: boolean }>({ items: [], next: null, loading: true, failed: false, reloadFailed: false });
  const [retry, setRetry] = useState(0);
  const gen = useRef(0);
  const loaded = useRef(0); // pages currently shown
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  useEffect(() => {
    const g = ++gen.current;
    // ponytail: a live reload refetches at most RELOAD_MAX pages; pages loaded beyond that drop back on activity.
    // Refresh only the last loaded page if users page that far through busy sessions.
    const want = Math.max(pages, Math.min(loaded.current, RELOAD_MAX));
    let acc: T[] = [];
    let got = 0;
    setS((x) => ({ ...x, loading: true }));
    const step = (c: C | null): Promise<void> => fetchRef.current(c).then((p) => {
      if (gen.current !== g) return undefined;
      acc = [...acc, ...p.items];
      got++;
      if (p.next !== null && got < want) return step(p.next);
      loaded.current = got;
      setS({ items: acc, next: p.next, loading: false, failed: false, reloadFailed: false });
      return undefined;
    }, () => { if (gen.current === g) setS((x) => ({ ...x, loading: false, failed: true, reloadFailed: true })); });
    void step(null);
  }, [key, pages, retry]);
  const loadMore = () => {
    if (s.loading) return;
    if (s.reloadFailed) { setRetry((r) => r + 1); return; }
    if (s.next === null) return;
    const g = gen.current;
    setS((x) => ({ ...x, loading: true }));
    fetchRef.current(s.next).then((p) => {
      if (gen.current !== g) return;
      loaded.current++;
      setS((x) => ({ items: [...x.items, ...p.items], next: p.next, loading: false, failed: false, reloadFailed: false }));
    }, () => { if (gen.current === g) setS((x) => ({ ...x, loading: false, failed: true })); });
  };
  return { items: s.items, more: s.next !== null, loading: s.loading, failed: s.failed, loadMore };
}

interface Window { items: TranscriptItem[]; prev: TCursor | null; next: TCursor | null; loading: boolean; failed: boolean; loaded: boolean }
const SECTIONS = ['conversation', 'timeline', 'tools', 'subagents', 'files', 'context', 'cost'] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_TEXT: Record<Section, string> = { conversation: 'Conversation', timeline: 'Timeline', tools: 'Tools', subagents: 'Subagents', files: 'Files', context: 'Context', cost: 'Cost' };

export function OpenSession({ row, changed, api, lastKnown, listShown, onShowList, onBack }: {
  row: SessionRow; changed: number; api: WorkspaceApi; lastKnown: boolean; listShown: boolean; onShowList: () => void; onBack: () => void;
}) {
  const id = row.id;
  // XAIBO-PROD-424: the session's change generation (deltas naming it, resyncs); a lastActivity bucket missed records
  // whose timestamps did not raise last_activity and appends within one bucket (Codex review).
  const activity = useThrottled(changed, SIDE_MS); // review M3: detail, cost and the lists at most once a second
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [section, setSection] = useState<Section>('conversation');
  const [drawer, setDrawer] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const detailsRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);
  // Review M (P4-T06b): a rejected or null detail is a failure the Context tab shows with Retry; a later success clears it.
  const [detailFailed, setDetailFailed] = useState(false);
  const [detailRetry, setDetailRetry] = useState(0);
  useEffect(() => {
    let on = true;
    api.session(id).then((d) => { if (!on) return; if (d) setDetail(d); setDetailFailed(d === null); }, () => { if (on) setDetailFailed(true); });
    return () => { on = false; };
  }, [api, id, activity, detailRetry]);
  // P4-T07b: the cost breakdown is fetched only while the Cost tab is shown, and again on activity or Retry.
  const [cost, setCost] = useState<CostDetail | null | undefined>(undefined);
  const [costFailed, setCostFailed] = useState(false);
  const [costRetry, setCostRetry] = useState(0);
  useEffect(() => {
    if (section !== 'cost') return;
    let on = true;
    api.cost(id).then((c) => { if (on) { setCost(c); setCostFailed(false); } }, () => { if (on) setCostFailed(true); });
    return () => { on = false; };
  }, [api, id, activity, section, costRetry]);

  const tools = usePaged<ToolItem, number>((c) => api.tools(id, c, LEDGER_PAGE).then((r) => ({ items: r.calls, next: r.next })), TOOL_PAGES, activity);
  const files = usePaged<FileItem, number>((c) => api.files(id, c, LEDGER_PAGE).then((r) => ({ items: r.touches, next: r.next })), 1, activity);
  const subagents = usePaged<SubagentItem, number>((c) => api.subagents(id, c, LEDGER_PAGE).then((r) => ({ items: r.subagents, next: r.next })), 1, activity);
  const markers = usePaged((c: { ts: number; id: number } | null) => api.markers(id, c, LEDGER_PAGE).then((r) => ({ items: r.markers as ModelMarker[], next: r.next })), 1, activity);

  // The transcript window: replaced by Go to first turn / Go to latest, grown by Load earlier / Load more.
  const [tr, setTr] = useState<Window>({ items: [], prev: null, next: null, loading: true, failed: false, loaded: false });
  const trGen = useRef(0);
  const trRef = useRef(tr);
  trRef.current = tr;
  const [fresh, setFresh] = useState(false); // New activity available
  const notice = fresh && tr.next !== null; // review L6: never once the window reaches the end again
  const latestRef = useRef<HTMLButtonElement>(null);
  const autoReloaded = useRef(false); // XAIBO-PROD-436: the failed window already reloaded itself once
  const loadAt = (at: 'first' | 'latest') => {
    const g = ++trGen.current;
    setFresh(false);
    setTr((s) => ({ ...s, loading: true }));
    api.transcript(id, at, PAGE).then((p) => { if (trGen.current === g) { autoReloaded.current = false; setTr({ items: p.items, prev: p.prev, next: p.next, loading: false, failed: false, loaded: true }); } },
      () => { if (trGen.current === g) setTr((s) => ({ ...s, loading: false, failed: true })); });
  };
  const grow = (dir: 'after' | 'before') => {
    const s = trRef.current;
    const c = dir === 'after' ? s.next : s.prev;
    if (!c || s.loading) return;
    const g = trGen.current;
    setTr((x) => ({ ...x, loading: true }));
    api.transcript(id, dir === 'after' ? { after: c } : { before: c }, PAGE).then((p) => {
      if (trGen.current !== g) return;
      setTr((x) => (dir === 'after' ? trimWindow({ ...x, items: [...x.items, ...p.items], next: p.next, loading: false, failed: false }, 'end')
        : trimWindow({ ...x, items: [...p.items, ...x.items], prev: p.prev, loading: false, failed: false }, 'start')));
    }, () => { if (trGen.current === g) setTr((x) => ({ ...x, loading: false, failed: true })); });
  };
  const initial = useRef(initialAt(row));
  useEffect(() => { loadAt(initial.current); }, []); // once per opened session (the component is keyed by session id)
  // XAIBO-PROD-424 (design §5.2/§6.3): on a change, a window at the end appends what follows its last record in place; a
  // scrolled-back window offers New activity available (never moves the anchor); a change during a load waits for it.
  // ponytail: records inserted before the window's end (an earlier-sequence backfill, an agy rewrite) show after Go to
  // latest or reopening; reconcile the loaded range if real stores do that while a session is open.
  const pending = useRef(false);
  const appending = useRef(false);
  const onChange = () => {
    const s = trRef.current;
    // review L: one automatic reload per failure (a transcript the service keeps refusing waits for Retry)
    switch (liveAction({ loaded: s.loaded, loading: s.loading, failed: s.failed && !autoReloaded.current, next: s.next, items: s.items.length, appending: appending.current })) {
      case 'later': pending.current = true; return;
      case 'notice': setFresh(true); return;
      case 'reload': autoReloaded.current ||= s.failed; loadAt(initial.current); return;
      case 'append': {
        const last = s.items.at(-1)!;
        const g = trGen.current;
        api.transcript(id, { after: { seq: last.seq, id: last.event } }, PAGE).then((p) => {
          if (trGen.current !== g || !p.items.length) return;
          setTr((x) => (x.items.at(-1) === last ? appendLive(x, p) : x));
          // More than one page arrived, or the window is full: the rest is offered, not pulled (review L6).
          if (p.next !== null || s.items.length + p.items.length > WINDOW_MAX) setFresh(true);
        }, () => undefined).finally(() => { // review M2: a change during the append (or a failed one) runs again
          appending.current = false;
          if (pending.current) { pending.current = false; onChange(); }
        });
        appending.current = true;
      }
    }
  };
  const seen = useRef(changed); // the generation at open is not a change (the open load already includes it)
  useEffect(() => { if (changed !== seen.current) { seen.current = changed; onChange(); } }, [changed]); // reacts to changes only
  // XAIBO-PROD-436: also after a failed load, so a change held during it (the reconnect resync) still reloads
  useEffect(() => { if (settled(tr) && pending.current) { pending.current = false; onChange(); } }, [tr.loading, tr.loaded, tr.failed]);

  const entries = useMemo(() => mergeTimeline({ items: tr.items, tools: tools.items, markers: markers.items, subagents: subagents.items, moreBefore: tr.prev !== null, moreAfter: tr.next !== null }),
    [tr.items, tr.prev, tr.next, tools.items, markers.items, subagents.items]);
  const slice: SliceFn = (event, part, offset) => api.slice(id, event, part, offset);
  const coverage = detail?.coverage ?? [];
  const gaps = incompleteReasons(coverage);
  const drift = coverage.includes('drift');

  const openDrawer = (on: boolean) => {
    setDrawer(on);
    requestAnimationFrame(() => (on ? closeRef.current : detailsRef.current)?.focus());
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && drawer) { e.stopPropagation(); openDrawer(false); } };
  const count = (s: Section) => (s === 'tools' ? tools : s === 'subagents' ? subagents : s === 'files' ? files : null);
  const title = row.title ? visible(row.title) : 'Untitled';
  const status = compactStatus(row.live);

  return (
    <section className="x-pane x-open" aria-labelledby="open-session-title" onKeyDown={onKey}>
      <div className="x-open-head" inert={drawer}>
        <div className="x-open-title">
          <button type="button" className="x-btn x-btn-quiet x-icon-btn x-narrow-only" aria-label="Back to session list" onClick={onBack}><Icon id="back" /></button>
          {!listShown ? <button type="button" className="x-btn x-btn-quiet x-icon-btn x-wide-only" aria-label="Show session list" onClick={onShowList}><Icon id="session" /></button> : null}
          <h2 id="open-session-title" ref={titleRef} tabIndex={-1}>{title}</h2>
        </div>
        <div className="x-actions">
          <button type="button" ref={detailsRef} className="x-btn x-btn-quiet" aria-expanded={drawer} aria-controls="session-details" onClick={() => openDrawer(!drawer)}><Icon id="information" />Details</button>
        </div>
        <div className="x-chips">
          <span className="x-chip" data-field="status"><span className={`x-dot x-dot-${status.tone}`} aria-hidden="true" />{lastKnown ? 'Last known: ' : null}{status.text}</span>
          {gaps.length ? <span className="x-chip x-chip-warn"><Icon id="finding" />Content incomplete</span> : null}
          {drift ? <span className="x-chip x-chip-warn"><Icon id="finding" />Source format drift detected</span> : null}
          <span className="x-chip">{visible(row.model)}</span>
          <span className="x-chip">{visible(row.agent)}</span>
        </div>
      </div>
      <div className="x-tabs" role="group" aria-label="Session section" inert={drawer}>
        {SECTIONS.map((s) => {
          const p = count(s);
          return (
            <button key={s} type="button" aria-pressed={section === s} aria-controls="session-section-body" onClick={() => setSection(s)}>
              {SECTION_TEXT[s]}{p && (p.items.length || p.more) ? <span className="x-count">{countText(s === 'files' ? new Set(p.items.map((f) => (f as FileItem).path)).size : p.items.length, p.more)}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="x-open-body" id="session-section-body" aria-label={SECTION_TEXT[section]} role="region" inert={drawer}>
        {section === 'conversation' ? <Conversation entries={entries} touches={files.items} slice={slice} gaps={gaps} prev={tr.prev !== null} onPrev={() => grow('before')} next={tr.next !== null} onNext={() => grow('after')} loading={tr.loading} />
          : section === 'timeline' ? <Timeline entries={entries} next={tr.next !== null} onNext={() => grow('after')} loading={tr.loading} />
            : section === 'tools' ? <div className="x-scroll"><Tools tools={tools} touches={files.items} /></div>
              : section === 'subagents' ? <div className="x-scroll"><Subagents subagents={subagents} /></div>
                : section === 'files' ? <div className="x-scroll"><Files files={files} tools={tools.items} /></div>
                  // ponytail: Stale is evaluated at render (detail reloads on activity); a quiet live session shows it
                  // only on its next render. Add a minute tick if a quiet session must flip to Stale on its own.
                  : section === 'context' ? <div className="x-scroll"><ContextPane row={row} detail={detail} failed={detailFailed} onRetry={() => setDetailRetry((n) => n + 1)} now={Date.now()} /></div>
                    : <div className="x-scroll"><CostPane cost={cost} failed={costFailed} onRetry={() => { setCostFailed(false); setCostRetry((n) => n + 1); }} /></div>}
        {/* review M4: a live region present from the start, so the notice is announced; review L6: only while more follows */}
        <p className="x-sr-only" aria-live="polite">{notice ? 'New activity available' : ''}</p>
        {notice && (section === 'conversation' || section === 'timeline') ? (
          <p className="x-earlier">New activity available <button type="button" className="x-btn x-btn-secondary"
            onClick={() => { loadAt('latest'); latestRef.current?.focus(); }}>Go to latest</button></p>
        ) : null}
        {tr.failed && (section === 'conversation' || section === 'timeline') ? <p className="x-gap" role="alert">The transcript could not be loaded <button type="button" className="x-btn x-btn-secondary" onClick={() => loadAt(initial.current)}>Retry</button></p> : null}
      </div>
      <div className="x-foot" inert={drawer}>
        <span className="x-foot-left"><Icon id="external" />Read-only observation</span>
        <span className="x-foot-right">
          <button type="button" className="x-btn x-btn-secondary" onClick={() => loadAt('first')}>Go to first turn</button>
          <button type="button" ref={latestRef} className="x-btn x-btn-primary" onClick={() => loadAt('latest')}>Go to latest</button>
        </span>
      </div>
      <aside id="session-details" className={`x-drawer${drawer ? ' x-drawer-open' : ''}`} aria-labelledby="session-details-title" hidden={!drawer}>
        <div className="x-pane-head"><h2 id="session-details-title">Session details</h2>
          <button type="button" ref={closeRef} className="x-btn x-btn-quiet x-icon-btn" aria-label="Close details" onClick={() => openDrawer(false)}><Icon id="close" /></button></div>
        <div className="x-scroll">
          <dl className="x-facts">
            <div><dt>Agent</dt><dd>{visible(row.agent)}</dd></div>
            <div><dt>Folder</dt><dd className="x-mono" data-field="folder">{row.cwd ? visible(row.cwd) : 'Unknown'}</dd></div>
            <div><dt>Origin</dt><dd data-field="origin">{originText(row)}</dd></div>
            <div><dt>Status</dt><dd>{lastKnown ? 'Last known: ' : null}<StatusBadge status={row.live} />{row.live ? statusExtras(row.live).map((t) => <span key={t}> · {t}</span>) : null}
              {findingBadges(row.live).map((b) => <span key={b.text}> <Icon id="finding" /> {b.text}</span>)}</dd></div>
            <div><dt>Model</dt><dd>{visible(row.model)}</dd></div>
            <div><dt>Last activity</dt><dd>{formatTime(row.lastActivity)}</dd></div>
            <div><dt>Context</dt><dd>{contextText(row.contextPct)}</dd></div>
            <div><dt>Estimated cost</dt><dd>{costText(row.costUsd, row.costCoverage)}</dd></div>
            <div><dt>Coverage</dt><dd>{gaps.length || rowMarkers(row).length
              ? [...gaps.map((g) => `Content incomplete: ${g}`), ...rowMarkers(row).map((m) => m.text)].join('; ') : 'No known gaps'}</dd></div>
          </dl>
        </div>
      </aside>
    </section>
  );
}
