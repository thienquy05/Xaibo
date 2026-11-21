// XAIBO-PROD-413 (P4-T05d; design §6.3 as amended by D-P4-06): one open session. Fixed header (title, chips, Details),
// fixed section tabs, a section body that scrolls on its own, a fixed bottom bar, and a Details drawer over the body.
// A live session opens on its latest page, anything else at its first turn; later activity is appended at the end
// without moving the reading position.
import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import type { CostDetail, FileItem, HistoryRow, ModelMarker, SessionDetail, SessionRow, SubagentItem, TCursor, ToolItem, TranscriptItem } from '../../shared/ipc.ts';
import { doneText, errorText, headerItems, headerTrashNote, NOTICE, opOf, retentionLine, sharedRow, type Shared, type Toggle } from '../history/actions.ts';
import { Menu, type MenuEntry } from '../components/Menu.tsx';
import { MoveDialog, type MoveTarget } from '../history/MoveDialog.tsx';
import { PurgeDialog, type PurgeTarget } from '../history/PurgeDialog.tsx';
import { trashBanner } from '../history/trash.ts';
import type { Client } from '../client.ts';
import { contextText, costText, formatTime, markers as rowMarkers, originText } from '../model.ts';
import { RetryNotice } from '../components/RetryNotice.tsx';
import { Title } from '../SessionList.tsx';
import { rovingKey } from '../components/virtual-list-model.ts';
import { retryIdle, retryStep } from '../retry.ts';
import { Icon, StatusLine } from '../status/StatusBadge.tsx';
import { visible } from '../text.ts';
import { ContextPane } from './context/ContextSection.tsx';
import { CostPane } from './cost/CostSection.tsx';
import { Conversation, Files, MarkerNotice, Subagents, Timeline, Tools, type Anchor, type Paged, type SliceFn } from './sections.tsx';
import { mergeTimeline } from './timeline.ts';
import { compactStatus, countText, incompleteReasons, initialAt, liveAction, liveAppend, loadAnchor, loadPages, MARKER_PAGES, reloadPlan, retryRequest, settled, trimWindow, WINDOW_MAX, type PageStart } from './view.ts';

import type { WorkspaceApi } from './workspace-api.ts';
export type { WorkspaceApi };
const PAGE = 50;
const OPEN_MENU = 'open-session-menu';
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

/** A forward-paged list loaded on mount (up to `pages` pages) and reloaded when `key` changes. Review M2: a reload never
 *  drops pages the user loaded; XAIBO-PROD-457: what it refetches is bounded by reloadPlan. Review L5: Retry after a
 *  failed (re)load reloads instead of appending page 1 again. */
function usePaged<T, C>(fetch: (c: C | null) => Promise<{ items: T[]; next: C | null }>, pages: number, key: unknown): Paged<T> {
  const [s, setS] = useState<{ items: T[]; next: C | null; loading: boolean; failed: boolean; reloadFailed: boolean }>({ items: [], next: null, loading: true, failed: false, reloadFailed: false });
  const [retry, setRetry] = useState(0);
  const [rt, rtDo] = useReducer(retryStep, retryIdle); // XAIBO-PROD-438: Retry state for the notice
  const gen = useRef(0);
  const starts = useRef<PageStart<C>[]>([]); // the pages currently shown
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  useEffect(() => {
    const g = ++gen.current;
    const plan = reloadPlan(pages, starts.current);
    setS((x) => ({ ...x, loading: true }));
    loadPages((c: C | null) => fetchRef.current(c), plan.want, () => gen.current === g, plan.from).then((r) => {
      if (!r) return;
      starts.current = [...starts.current.slice(0, plan.keep), ...r.starts.map((p) => ({ from: p.from, at: p.at + plan.at }))];
      setS((x) => ({ items: [...x.items.slice(0, plan.at), ...r.items], next: r.next, loading: false, failed: false, reloadFailed: false }));
      rtDo({ type: 'ok' });
    }, () => { if (gen.current === g) { setS((x) => ({ ...x, loading: false, failed: true, reloadFailed: true })); rtDo({ type: 'fail', at: Date.now() }); } });
  }, [key, pages, retry]);
  const loadMore = () => {
    if (s.loading) return;
    if (s.failed) rtDo({ type: 'start' }); // a Retry: disabled until it settles
    if (s.reloadFailed) { setRetry((r) => r + 1); return; }
    if (s.next === null) return;
    const g = gen.current;
    const start = { from: s.next, at: s.items.length }; // items stay put while loading: no reload or Load more lands
    setS((x) => ({ ...x, loading: true }));
    fetchRef.current(s.next).then((p) => {
      if (gen.current !== g) return;
      starts.current = [...starts.current, start];
      setS((x) => ({ items: [...x.items, ...p.items], next: p.next, loading: false, failed: false, reloadFailed: false }));
      rtDo({ type: 'ok' });
    }, () => { if (gen.current === g) { setS((x) => ({ ...x, loading: false, failed: true })); rtDo({ type: 'fail', at: Date.now() }); } });
  };
  return { items: s.items, more: s.next !== null, loading: s.loading, failed: s.failed, loadMore, retry: rt };
}

interface Window { items: TranscriptItem[]; prev: TCursor | null; next: TCursor | null; loading: boolean; failed: boolean; loaded: boolean }
const SECTIONS = ['conversation', 'timeline', 'tools', 'subagents', 'files', 'context', 'cost'] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_TEXT: Record<Section, string> = { conversation: 'Conversation', timeline: 'Timeline', tools: 'Tools', subagents: 'Subagents', files: 'Files', context: 'Context', cost: 'Cost' };

export function OpenSession({ row, changed, api, lastKnown, listShown, onShowList, onBack, onReturn, returnTo = 'Dashboard', history = null, onHistory, onTrashed }: {
  row: SessionRow; changed: number; api: WorkspaceApi; lastKnown: boolean; listShown: boolean; onShowList: () => void; onBack: () => void;
  /** XAIBO-PROD-437 (design §6.3 Return to source): set when the session was opened from the Dashboard or (XAIBO-PROD-539)
   *  the Agent Map, which `returnTo` names. */
  onReturn?: () => void; returnTo?: 'Dashboard' | 'Agent Map';
  /** XAIBO-PROD-533: a history row refreshed elsewhere (the list), and the way to share one refreshed here. */
  history?: Shared | null; onHistory?: (id: number, r: HistoryRow | null) => void;
  /** Gate 5 G5d-3: a header Move to Trash that succeeded; the Session list shows its Undo notice. */
  onTrashed?: (id: number) => void;
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
  const [detailRt, detailRtDo] = useReducer(retryStep, retryIdle); // XAIBO-PROD-438
  useEffect(() => {
    let on = true;
    api.session(id).then((d) => { if (!on) return; if (d) setDetail(d); setDetailFailed(d === null); detailRtDo(d === null ? { type: 'fail', at: Date.now() } : { type: 'ok' }); },
      () => { if (on) { setDetailFailed(true); detailRtDo({ type: 'fail', at: Date.now() }); } });
    return () => { on = false; };
  }, [api, id, activity, detailRetry]);
  // XAIBO-PROD-533 (design §6.3): retention line and Keep from the session's fresh history row (on open, activity, Retry,
  // and when the list refreshed it); unknown says unavailable (design security review L3)
  const [hist, setHist] = useState<{ row: HistoryRow | null; failed: boolean } | undefined>(undefined);
  const [histRetry, setHistRetry] = useState(0);
  const [keepNote, setKeepNote] = useState<string | null>(null);
  const [keepBusy, setKeepBusy] = useState(false);
  // Gate 5 review L (G5d-3): a header Trash note shown while the list was hidden goes once the list (with its Undo notice) is
  const shownBefore = useRef(listShown);
  useEffect(() => { if (listShown && !shownBefore.current) setKeepNote((n) => (n === NOTICE ? null : n)); shownBefore.current = listShown; }, [listShown]);
  useEffect(() => {
    let on = true;
    api.historyRow(id).then((r) => { if (on) setHist({ row: r, failed: false }); }, () => { if (on) setHist((h) => ({ row: h?.row ?? null, failed: true })); });
    return () => { on = false; };
  }, [api, id, activity, histRetry]);
  const histNow = useRef(hist);
  histNow.current = hist;
  const seenHistory = useRef(history?.n);
  useEffect(() => {
    if (!history || seenHistory.current === history.n) return;
    seenHistory.current = history.n;
    const s = sharedRow(history, id, histNow.current);
    if (s) { setHist(s); setKeepNote(null); } // review #2: an earlier Keep outcome no longer describes the row
  }, [history, id]);
  /** The fresh row read again and shared (null = gone: Workspace closes this conversation). */
  const reread = async () => {
    try {
      const fresh = await api.historyRow(id);
      setHist({ row: fresh, failed: false });
      onHistory?.(id, fresh);
    } catch { setHist((h) => ({ row: h?.row ?? null, failed: true })); }
  };
  /** Keep, (XAIBO-PROD-534) Restore from the Trash banner, or (XAIBO-PROD-535) a header More actions toggle: one overlay
   *  op, then the refreshed row (shared). */
  const runOp = async (r: HistoryRow, kind: Toggle | 'restore') => {
    if (keepBusy) return;
    setKeepBusy(true);
    setKeepNote(null);
    const op = kind === 'restore' ? { kind: 'trash' as const, session: r.id, on: false } : opOf(kind, r);
    const on = 'on' in op && op.on;
    const res = await api.overlay(op).catch(() => null);
    if (!res) setKeepNote('The result is unavailable.'); // a lost reply never means success
    else if (!res.ok) setKeepNote(errorText(res.error));
    // below 800 px an open session hides the list slot (tokens.css), so the list being shown is not enough. ponytail: decided
    // at the Trash; a resize across 800 px afterwards can show the notice twice or not at all; follow matchMedia if that matters
    else if (kind === 'trash' && onTrashed) { onTrashed(r.id); setKeepNote(headerTrashNote(listShown && !!document.querySelector('.x-list-slot')?.checkVisibility())); }
    else setKeepNote(kind === 'restore' ? 'Restored from Trash.' : kind === 'trash' ? NOTICE : doneText(kind, on));
    await reread();
    setKeepBusy(false);
  };
  const retention = retentionLine(hist, row.live);
  const keepRow = hist && !hist.failed && hist.row && hist.row.trashedAt === null ? hist.row : null;
  // XAIBO-PROD-534 (design §6.4): a Trash row's conversation stays readable under an explicit Trash banner
  const trashRow = hist && !hist.failed && hist.row && hist.row.trashedAt !== null ? hist.row : null;
  const banner = trashRow ? trashBanner(trashRow) : null;
  const [purgeTarget, setPurgeTarget] = useState<PurgeTarget>(null);
  // XAIBO-PROD-535 (design §6.3): header More actions (Move to…, Pin, Archive, Move to Trash) from the fresh row
  const [moveTarget, setMoveTarget] = useState<MoveTarget>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  // review L4 (re-review: after the commit that removed it): Move to Trash unmounts the focused More button; the title takes focus
  useEffect(() => { if (!keepRow && document.activeElement === document.body) titleRef.current?.focus(); }, [keepRow]);
  const moreEntries: MenuEntry[] = keepRow ? headerItems(keepRow).map((i) => ({ key: i.kind, label: i.label, checked: i.checked,
    onSelect: () => (i.kind === 'move' ? setMoveTarget({ row: keepRow, trigger: moreRef.current }) : void runOp(keepRow, i.kind)) })) : [];
  // P4-T07b: the cost breakdown is fetched only while the Cost tab is shown, and again on activity or Retry.
  const [cost, setCost] = useState<CostDetail | null | undefined>(undefined);
  const [costFailed, setCostFailed] = useState(false);
  const [costRetry, setCostRetry] = useState(0);
  const [costRt, costRtDo] = useReducer(retryStep, retryIdle); // XAIBO-PROD-438
  useEffect(() => {
    if (section !== 'cost') return;
    let on = true;
    api.cost(id).then((c) => { if (on) { setCost(c); setCostFailed(false); costRtDo({ type: 'ok' }); } }, () => { if (on) { setCostFailed(true); costRtDo({ type: 'fail', at: Date.now() }); } });
    return () => { on = false; };
  }, [api, id, activity, section, costRetry]);

  const tools = usePaged<ToolItem, number>((c) => api.tools(id, c, LEDGER_PAGE).then((r) => ({ items: r.calls, next: r.next })), TOOL_PAGES, activity);
  const files = usePaged<FileItem, number>((c) => api.files(id, c, LEDGER_PAGE).then((r) => ({ items: r.touches, next: r.next })), 1, activity);
  const subagents = usePaged<SubagentItem, number>((c) => api.subagents(id, c, LEDGER_PAGE).then((r) => ({ items: r.subagents, next: r.next })), 1, activity);
  const markers = usePaged((c: { ts: number; id: number } | null) => api.markers(id, c, LEDGER_PAGE).then((r) => ({ items: r.markers as ModelMarker[], next: r.next })), MARKER_PAGES, activity);

  // The transcript window: replaced by Go to first turn / Go to latest, grown by Load earlier / Load more.
  const [tr, setTr] = useState<Window>({ items: [], prev: null, next: null, loading: true, failed: false, loaded: false });
  const trGen = useRef(0);
  const [trRt, trRtDo] = useReducer(retryStep, retryIdle); // XAIBO-PROD-438
  const trRef = useRef(tr);
  trRef.current = tr;
  const [fresh, setFresh] = useState(false); // New activity available
  const notice = fresh && tr.next !== null; // review L6: never once the window reaches the end again
  const latestRef = useRef<HTMLButtonElement>(null);
  const autoReloaded = useRef(false); // XAIBO-PROD-436: the failed window already reloaded itself once
  const [anchor, setAnchor] = useState<Anchor>(null); // XAIBO-PROD-450: first/latest land at the range's start/end
  const lastReq = useRef<'first' | 'latest' | 'after' | 'before'>('first'); // XAIBO-PROD-452: what Retry repeats
  const loadAt = (at: 'first' | 'latest') => {
    const g = ++trGen.current;
    lastReq.current = at;
    setFresh(false);
    if (trRef.current.failed) trRtDo({ type: 'start' }); // a (re)load after a failure: the notice shows Retrying…
    setTr((s) => ({ ...s, loading: true }));
    api.transcript(id, at, PAGE).then((p) => { if (trGen.current === g) { autoReloaded.current = false; trRtDo({ type: 'ok' }); setTr({ items: p.items, prev: p.prev, next: p.next, loading: false, failed: false, loaded: true }); setAnchor((a) => ({ to: loadAnchor(at)!, n: (a?.n ?? 0) + 1 })); } },
      () => { if (trGen.current === g) { trRtDo({ type: 'fail', at: Date.now() }); setTr((s) => ({ ...s, loading: false, failed: true })); } });
  };
  const grow = (dir: 'after' | 'before') => {
    const s = trRef.current;
    const c = dir === 'after' ? s.next : s.prev;
    if (!c || s.loading) return;
    const g = trGen.current;
    lastReq.current = dir;
    if (s.failed) trRtDo({ type: 'start' });
    setTr((x) => ({ ...x, loading: true }));
    api.transcript(id, dir === 'after' ? { after: c } : { before: c }, PAGE).then((p) => {
      if (trGen.current !== g) return;
      setTr((x) => (dir === 'after' ? trimWindow({ ...x, items: [...x.items, ...p.items], next: p.next, loading: false, failed: false }, 'end')
        : trimWindow({ ...x, items: [...p.items, ...x.items], prev: p.prev, loading: false, failed: false }, 'start')));
      trRtDo({ type: 'ok' });
    }, () => { if (trGen.current === g) { trRtDo({ type: 'fail', at: Date.now() }); setTr((x) => ({ ...x, loading: false, failed: true })); } });
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
          if (trGen.current !== g) return; // XAIBO-PROD-451: an empty page still carries its continuation cursor
          setTr((x) => liveAppend(x, last, p));
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
  const slice: SliceFn = (event, part, offset, call) => api.slice(id, event, part, offset, call);
  const coverage = detail?.coverage ?? [];
  const gaps = incompleteReasons(coverage);
  const drift = coverage.includes('drift');

  const openDrawer = (on: boolean) => {
    setDrawer(on);
    requestAnimationFrame(() => (on ? closeRef.current : detailsRef.current)?.focus());
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && drawer) { e.stopPropagation(); openDrawer(false); } };
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKey = (e: KeyboardEvent, i: number) => rovingKey(e, i, SECTIONS.length, tabRefs.current);
  const count = (s: Section) => (s === 'tools' ? tools : s === 'subagents' ? subagents : s === 'files' ? files : null);
  const status = compactStatus(row.live);

  return (
    <section className="x-pane x-open" aria-labelledby="open-session-title" onKeyDown={onKey}>
      <div className="x-open-head" inert={drawer}>
        <div className="x-open-title">
          <button type="button" className="x-btn x-btn-quiet x-icon-btn x-narrow-only" aria-label="Back to session list" onClick={onBack}><Icon id="back" /></button>
          {!listShown ? <button type="button" className="x-btn x-btn-quiet x-icon-btn x-wide-only" aria-label="Show session list" onClick={onShowList}><Icon id="session" /></button> : null}
          {onReturn ? <button type="button" className="x-btn x-btn-quiet x-return" onClick={onReturn}><Icon id={returnTo === 'Dashboard' ? 'dashboard' : 'branch'} />Return to {returnTo}</button> : null}
          <h2 id="open-session-title" ref={titleRef} tabIndex={-1}><Title row={row} /></h2>
        </div>
        <div className="x-actions">
          <button type="button" ref={detailsRef} className="x-btn x-btn-quiet" aria-expanded={drawer} aria-controls="session-details" onClick={() => openDrawer(!drawer)}><Icon id="information" />Details</button>
          {keepRow ? <button type="button" ref={moreRef} className="x-btn x-btn-quiet x-icon-btn" popoverTarget={OPEN_MENU} aria-haspopup="menu" aria-label="More actions for this session"
            aria-disabled={keepBusy || undefined}><Icon id="more" /></button> : null}
        </div>
        <div className="x-chips">
          <span className="x-chip" data-field="status"><span className={`x-dot x-dot-${status.tone}`} aria-hidden="true" />{lastKnown ? 'Last known: ' : null}{status.text}</span>
          {gaps.length ? <span className="x-chip x-chip-warn"><Icon id="finding" />Content incomplete</span> : null}
          {drift ? <span className="x-chip x-chip-warn"><Icon id="finding" />Source format drift detected</span> : null}
          <span className="x-chip">{visible(row.model)}</span>
          <span className="x-chip">{visible(row.agent)}</span>
        </div>
        {trashRow && banner ? ( // design §5.1 Banner: glyph, heading, explanation, actions
          <section className="x-banner" aria-labelledby="trash-banner-heading">
            <Icon id="trash" />
            <div>
              <h3 id="trash-banner-heading">In Trash</h3>
              <p>{banner.trashed}. {banner.autoEmpty}. Only the Xaibo copy is affected; native files are untouched.</p>
              <div className="x-acts">
                <button type="button" className="x-btn x-btn-secondary" aria-disabled={keepBusy || undefined} onClick={() => void runOp(trashRow, 'restore')}>Restore</button>
                <button type="button" className="x-btn x-btn-danger" onClick={(e) => setPurgeTarget({ id, trigger: e.currentTarget })}>Purge</button>
              </div>
              <span className="x-action-note" aria-live="polite">{keepNote}</span>
            </div>
          </section>
        ) : retention !== null ? ( // design §6.3: retention, then the Keep toggle (aria-pressed; §5.4 polite outcome)
          <div className="x-retention">
            <span data-field="retention">{retention}</span>
            {keepRow ? (
              <button type="button" className="x-btn x-btn-quiet x-keep" aria-pressed={keepRow.keep} aria-disabled={keepBusy || undefined}
                onClick={() => void runOp(keepRow, 'keep')}>{keepRow.keep ? <Icon id="check" /> : null}Keep</button>
            ) : null}
            {hist?.failed ? <button type="button" className="x-btn x-btn-quiet" onClick={() => setHistRetry((n) => n + 1)}>Retry</button> : null}
            <span className="x-action-note" aria-live="polite">{keepNote}</span>
          </div>
        ) : null}
      </div>
      <Menu id={OPEN_MENU} label="More actions" entries={moreEntries} note={null} />
      <MoveDialog target={moveTarget} api={api} onClosed={() => setMoveTarget(null)} onDone={(_s, to) => {
        if (to.note) setKeepNote(to.note);
        // design §5.4: the record (this header) stays shown; review M3: a lost reply or not-found reads the row too;
        // review L1: only a result that closed its dialog places focus
        if (to.refresh) void reread().then(() => { if (to.close) moreRef.current?.focus(); });
      }} />
      <PurgeDialog target={purgeTarget} purge={(s) => api.purge(s)} onClosed={() => setPurgeTarget(null)}
        onDone={(s, to) => { if (to.note) setKeepNote(to.note); if (to.gone) onHistory?.(s, null); }} />{/* gone: Workspace closes this conversation */}
      <div className="x-tabs" role="group" aria-label="Session section" inert={drawer}>
        {SECTIONS.map((s, i) => {
          const p = count(s);
          return (
            // XAIBO-PROD-437 (design §8.1): one tab stop; Left/Right/Home/End move in DOM order, Enter/Space activate
            <button key={s} ref={(el) => { tabRefs.current[i] = el; }} type="button" aria-pressed={section === s} aria-controls="session-section-body"
              tabIndex={section === s ? 0 : -1} onKeyDown={(e) => onTabKey(e, i)} onClick={() => setSection(s)}>
              {SECTION_TEXT[s]}{p && (p.items.length || p.more) ? <span className="x-count">{countText(s === 'files' ? new Set(p.items.map((f) => (f as FileItem).path)).size : p.items.length, p.more)}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="x-open-body" id="session-section-body" aria-label={SECTION_TEXT[section]} role="region" inert={drawer}>
        {section === 'conversation' ? <Conversation entries={entries} touches={files.items} slice={slice} gaps={gaps} prev={tr.prev !== null} onPrev={() => grow('before')} next={tr.next !== null} onNext={() => grow('after')} loading={tr.loading} anchor={anchor} />
          : section === 'timeline' ? <Timeline entries={entries} next={tr.next !== null} onNext={() => grow('after')} loading={tr.loading} anchor={anchor} />
            : section === 'tools' ? <div className="x-scroll"><Tools tools={tools} touches={files.items} /></div>
              : section === 'subagents' ? <div className="x-scroll"><Subagents subagents={subagents} /></div>
                : section === 'files' ? <div className="x-scroll"><Files files={files} tools={tools.items} /></div>
                  // ponytail: Stale is evaluated at render (detail reloads on activity); a quiet live session shows it
                  // only on its next render. Add a minute tick if a quiet session must flip to Stale on its own.
                  : section === 'context' ? <div className="x-scroll"><ContextPane row={row} detail={detail} failed={detailFailed} retry={detailRt} onRetry={() => { detailRtDo({ type: 'start' }); setDetailRetry((n) => n + 1); }} now={Date.now()} /></div>
                    : <div className="x-scroll"><CostPane cost={cost} failed={costFailed} retry={costRt} onRetry={() => { costRtDo({ type: 'start' }); setCostRetry((n) => n + 1); }} /></div>}
        {/* review M4: a live region present from the start, so the notice is announced; review L6: only while more follows */}
        <p className="x-sr-only" aria-live="polite">{notice ? 'New activity available' : ''}</p>
        {notice && (section === 'conversation' || section === 'timeline') ? (
          <p className="x-earlier">New activity available <button type="button" className="x-btn x-btn-secondary"
            onClick={() => { loadAt('latest'); latestRef.current?.focus(); }}>Go to latest</button></p>
        ) : null}
        {tr.failed && (section === 'conversation' || section === 'timeline') ? <RetryNotice thing="transcript" retry={trRt} onRetry={() => { const r = retryRequest(lastReq.current); if ('load' in r) loadAt(r.load); else grow(r.grow); }} /> : null}
        {/* XAIBO-PROD-451/454 (G4d-3): a failed or unfinished marker load is said, never silent */}
        {section === 'conversation' || section === 'timeline' ? <MarkerNotice markers={markers} /> : null}
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
            <div><dt>Status</dt><dd><StatusLine status={row.live} lastKnown={lastKnown} /></dd></div>
            <div><dt>Model</dt><dd>{visible(row.model)}</dd></div>
            <div><dt>Last activity</dt><dd>{formatTime(row.lastActivity)}</dd></div>
            <div><dt>Context</dt><dd>{contextText(row.contextPct)}</dd></div>
            <div><dt>Estimated cost</dt><dd>{costText(row.costUsd, row.costCoverage)}</dd></div>
            <div><dt>Coverage</dt><dd>{gaps.length || rowMarkers(row).length
              ? [...gaps.map((g) => `Content incomplete: ${g}`), ...rowMarkers(row)].join('; ') : 'No known gaps'}</dd></div>
          </dl>
        </div>
      </aside>
    </section>
  );
}
