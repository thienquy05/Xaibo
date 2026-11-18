// The one list primitive (P4-T03; design §5.1 virtualized record list, §5.2): @tanstack/react-virtual with variable
// heights and overscan 3; a semantic list whose DOM holds the viewport records plus overscan and the tab-stop record;
// one roving tab stop that follows its record by key; Arrow/Home/End within the loaded range; ArrowDown at the loaded
// end fetches once; explicit Load more keeps focus and announces politely; rows changing above the record in view keep
// it in place. Offsets are CSSOM style properties, which the CSP allows (no inline style blocks).
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { anchorShift, createEdgeFetch, focusIndex, layoutSignature, nextFocus, pageAnnouncement, pickAnchor, revealDelta, revealDue, revealPort, scrollerClipped, shouldReveal } from './virtual-list-model.ts';

type Key = string | number; // our keys; the library's own key type also allows bigint

export interface VirtualListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string | number;
  render: (item: T, index: number) => ReactNode;
  label: string;
  /** XAIBO-PROD-437 (design §8.1): each focusable row's short, stable name (never its whole content). */
  itemLabel: (item: T) => string;
  /** XAIBO-PROD-437 review M1: the row that starts as the tab stop (kept mounted, so focus can be restored to it). */
  initialFocusKey?: Key | null;
  estimateSize: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  /** XAIBO-PROD-450 (G4d-2; design §6.3): a request to show the first or last item; each new `n` scrolls once, after
   *  the items it came with render (a list mounted with a request applies it once it has items). */
  anchor?: { to: 'start' | 'end'; n: number } | null;
}

const OVERSCAN = 3;

/** A record outside its scroller's visible part (clipped to the window, below the sticky frame's padding). */
const framePadPx = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--x-frame-pad')) || 8;
function outOfView(el: HTMLElement, scroller: HTMLElement): boolean {
  return revealDelta(el.getBoundingClientRect(), revealPort(scroller.getBoundingClientRect(), innerHeight, framePadPx())) !== 0;
}

export function VirtualList<T>({ items, getKey, render, label, itemLabel, initialFocusKey = null, estimateSize, hasMore, loading, onLoadMore, anchor = null }: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const endRef = useRef<HTMLParagraphElement>(null);
  const keys = useMemo(() => items.map(getKey), [items, getKey]);
  const count = items.length;

  // Focus follows its record by key (review M1); a removed record hands focus to its neighbour (L1).
  const [focusedKey, setFocusedKey] = useState<Key | null>(initialFocusKey);
  const lastIndex = useRef(-1);
  const focused = focusIndex(keys, focusedKey, lastIndex.current);
  lastIndex.current = focused;
  const listHadFocus = useRef(false);
  const pendingFocus = useRef<Key | null>(null);
  const tabStop = focused >= 0 ? focused : count > 0 ? 0 : -1;
  const edge = useMemo(createEdgeFetch, []);

  const rangeExtractor = useCallback((range: Range) => {
    const r = defaultRangeExtractor(range);
    return tabStop >= 0 && !r.includes(tabStop) ? [...r, tabStop].sort((a, b) => a - b) : r; // the tab stop stays mounted (M3)
  }, [tabStop]);
  const getItemKey = useCallback((i: number) => keys[i]!, [keys]); // stable unless keys change (L5)
  const v = useVirtualizer({ count, getScrollElement: () => scrollRef.current, estimateSize: () => estimateSize, overscan: OVERSCAN, getItemKey, rangeExtractor });

  // XAIBO-PROD-439 (design §2.4): rows re-measured with the same records (text spacing, text size, width) can push the
  // focused record out of view; bring it back, but only one that was in view before (review HIGH: never fight the
  // user's scrolling) and never for a change of records (live deltas, paging).
  const total = v.getTotalSize();
  const measuredKeys = useRef(keys);
  const layoutSig = useRef('');
  const revealUntil = useRef(0);
  useLayoutEffect(() => {
    const changed = measuredKeys.current !== keys;
    measuredKeys.current = keys;
    const list = listRef.current;
    if (!list) return;
    const cs = getComputedStyle(list);
    const sig = layoutSignature({ width: list.clientWidth, fontSize: cs.fontSize, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, wordSpacing: cs.wordSpacing });
    const due = revealDue(layoutSig.current, sig, performance.now(), revealUntil.current);
    layoutSig.current = sig;
    revealUntil.current = due.until;
    if (!shouldReveal(focusedKey, due.due, changed)) return;
    const el = document.activeElement as HTMLElement | null;
    const sc = scrollRef.current;
    if (!el || !sc || !listRef.current?.contains(el)) return;
    if (outOfView(el, sc)) el.scrollIntoView({ block: 'nearest' });
  }, [total, keys]);

  // Scroll anchor (M2): the keys in view and measured sizes as of the last render.
  // ponytail: O(loaded rows) per scroll frame (measurementsCache copy); fine while the window is a few pages, revisit
  // with eviction (design §5.2: at most 3 pages kept).
  const prev = useRef<{ keys: readonly Key[]; inView: Key[]; sizes: Map<Key, number> }>({ keys: [], inView: [], sizes: new Map() });
  const record = () => {
    const el = scrollRef.current;
    const top = el?.scrollTop ?? 0;
    const bottom = top + (el?.clientHeight ?? 0);
    const inView = v.getVirtualItems().filter((x) => x.end > top && x.start < bottom).map((x) => x.key as Key);
    prev.current = { keys, inView, sizes: new Map(v.measurementsCache.map((m) => [m.key as Key, m.size])) };
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const p = prev.current;
    if (!el || el.scrollTop <= 0 || p.keys === keys) return;
    const anchor = pickAnchor(p.keys, keys, p.inView);
    if (anchor === null) return;
    const shift = anchorShift(p.keys, keys, anchor, (k) => p.sizes.get(k) ?? estimateSize);
    if (shift) el.scrollTop += shift;
  }, [keys, estimateSize]);
  // XAIBO-PROD-450: after the record-keeping anchor above, so a replaced window lands at its requested edge
  const anchored = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!anchor || anchored.current === anchor.n || count === 0) return;
    anchored.current = anchor.n;
    v.scrollToIndex(anchor.to === 'end' ? count - 1 : 0, { align: anchor.to });
  }, [anchor?.n, count]);
  useEffect(() => {
    record();
    if (focusedKey !== null && !keys.includes(focusedKey) && focused >= 0 && listHadFocus.current) { // L1: neighbour
      pendingFocus.current = keys[focused]!;
      setFocusedKey(keys[focused]!);
    }
    if (pendingFocus.current !== null) {
      const i = keys.indexOf(pendingFocus.current);
      const el = i >= 0 ? listRef.current?.querySelector<HTMLElement>(`[data-index="${i}"]`) : null;
      if (el) {
        el.focus({ preventScroll: true });
        pendingFocus.current = null;
        // XAIBO-PROD-439: scrollToIndex moves only this list's scroller; a list inside a scrolling page (the Dashboard)
        // also needs the page moved, or the focused record stays below the window
        // (only when the page clips the scroller: inside a scroller that fits, scrolling here fought scrollToIndex)
        const sc = scrollRef.current;
        if (sc && scrollerClipped(sc.getBoundingClientRect(), innerHeight, framePadPx()) && outOfView(el, sc)) el.scrollIntoView({ block: 'nearest' });
      }
    }
  });

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    // Only the list's own records, unmodified keys (L4): nested controls keep their keys.
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.target as Element).parentElement !== listRef.current) return;
    const n = nextFocus(focused, e.key, count);
    if (n === null) return;
    e.preventDefault();
    pendingFocus.current = null;
    if (!loading && edge(e.key, focused, count, hasMore)) onLoadMore(); // latch only when it fetches (L2)
    if (n < 0 || n === focused) return;
    pendingFocus.current = keys[n]!;
    setFocusedKey(keys[n]!);
    v.scrollToIndex(n, { align: 'auto' });
  };

  // Continuation (M4): Load more stays focusable while loading; a polite status announces; when the last page arrives
  // and the button goes away, focus moves to the end text instead of the body.
  const moreFocused = useRef(false);
  const loadStart = useRef<number | null>(null);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    if (loading) { if (loadStart.current === null) loadStart.current = count; setAnnounce(pageAnnouncement(count, count, true)); return; }
    if (loadStart.current !== null) { setAnnounce(pageAnnouncement(loadStart.current, count, false)); loadStart.current = null; }
  }, [loading, count]);
  useEffect(() => {
    if (!hasMore && moreFocused.current) { moreFocused.current = false; endRef.current?.focus(); }
  }, [hasMore]);

  return (
    <>
      <div className="x-vlist" ref={scrollRef} onScroll={record}>
        <ul
          className="x-vlist-items" ref={listRef} aria-label={label} data-count={count} onKeyDown={onKeyDown}
          onFocus={() => { listHadFocus.current = true; }} onBlur={(e) => { if (!listRef.current?.contains(e.relatedTarget as Node | null)) listHadFocus.current = false; }}
          style={{ height: `${v.getTotalSize()}px` }}
        >
          {v.getVirtualItems().map((vi) => (
            <li
              key={vi.key} data-index={vi.index} ref={v.measureElement} className="x-vlist-item"
              tabIndex={vi.index === tabStop ? 0 : -1} aria-posinset={vi.index + 1} aria-setsize={hasMore ? -1 : count} aria-label={itemLabel(items[vi.index]!)}
              onFocus={() => setFocusedKey(keys[vi.index]!)} style={{ transform: `translateY(${vi.start}px)` }}
            >
              {render(items[vi.index]!, vi.index)}
            </li>
          ))}
        </ul>
      </div>
      {hasMore ? (
        <p className="x-vlist-end">
          More records available{' '}
          <button
            type="button" className="x-button" aria-disabled={loading || undefined}
            onClick={() => { if (!loading) onLoadMore(); }}
            onFocus={() => { moreFocused.current = true; }} onBlur={(e) => { if (e.relatedTarget) moreFocused.current = false; }} // removal blurs with no target
          >{loading ? 'Loading next page' : 'Load more'}</button>
        </p>
      ) : count > 0 ? <p className="x-vlist-end" ref={endRef} tabIndex={-1}>End of available records</p> : null}
      <p className="x-sr-only" aria-live="polite">{announce}</p>{/* polite, without taking the page's status role (health) */}
    </>
  );
}
