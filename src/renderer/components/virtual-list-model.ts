// Pure model behind VirtualList (P4-T03; design §5.1 virtualized record list, §5.2): roving focus within the loaded
// range, a once-per-edge page fetch, and the scroll shift that keeps the record in view put when rows change above it.

/** The next focused index for a navigation key, -1 for an empty list, null for any other key. */
export function nextFocus(index: number, key: string, count: number, axis: 'vertical' | 'horizontal' = 'vertical'): number | null {
  // P4-T04c: a horizontal group (Dashboard view buttons) uses Left/Right where a list uses Up/Down.
  const [back, forward] = axis === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
  if (key !== forward && key !== back && key !== 'Home' && key !== 'End') return null;
  if (count === 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (index < 0) return 0;
  return Math.min(count - 1, Math.max(0, index + (key === forward ? 1 : -1)));
}

/** A horizontal roving group (Dashboard views, Session sections): Left/Right/Home/End move focus among `count` refs. */
export function rovingKey(e: { key: string; preventDefault(): void }, index: number, count: number, refs: readonly ({ focus(): void } | null | undefined)[]): void {
  const n = nextFocus(index, e.key, count, 'horizontal');
  if (n === null || n < 0) return;
  e.preventDefault();
  refs[n]?.focus();
}

/** ArrowDown on the last loaded record with more available asks for the next page once per edge (End only jumps). */
export function createEdgeFetch() {
  let firedAt: unknown = -1;
  // XAIBO-PROD-575 review M1: latched on the last record's key when given, since a page dropped from the front keeps the count
  return (key: string, index: number, count: number, hasMore: boolean, last: unknown = count): boolean => {
    if (key !== 'ArrowDown' || !hasMore || index !== count - 1 || firedAt === last) return false;
    firedAt = last;
    return true;
  };
}

/** Pixels to add to the scroll offset so the anchor record stays where it was: the measured height above it now
 * minus before. Zero when the anchor is gone (the list falls back to its natural position). */
export function anchorShift<K>(prev: readonly K[], next: readonly K[], anchor: K, size: (k: K) => number): number {
  const before = prev.indexOf(anchor);
  const after = next.indexOf(anchor);
  if (before < 0 || after < 0) return 0;
  const sum = (keys: readonly K[], end: number) => keys.slice(0, end).reduce((n, k) => n + size(k), 0);
  return sum(next, after) - sum(prev, before);
}

/** Review M1/L1: the focused record's index by key; when it is gone, the nearest following record, then the previous. */
export function focusIndex<K>(keys: readonly K[], focusedKey: K | null, lastIndex: number): number {
  if (focusedKey === null || keys.length === 0) return -1;
  const i = keys.indexOf(focusedKey);
  return i >= 0 ? i : Math.min(Math.max(lastIndex, 0), keys.length - 1);
}

/** Review M2: the first record in view that kept its place: every record above it before is still above it now (a
 * record that jumped to the head, or one removed, cannot anchor). Null when none qualifies. */
export function pickAnchor<K>(prev: readonly K[], next: readonly K[], inView: readonly K[]): K | null {
  const at = new Map(next.map((k, i) => [k, i]));
  for (const k of inView) {
    const here = at.get(k);
    if (here === undefined) continue;
    const above = prev.slice(0, prev.indexOf(k));
    if (above.every((a) => { const j = at.get(a); return j === undefined || j < here; })) return k;
  }
  return null;
}

/** Review M4: the polite pagination announcement; never an invented total. */
export function pageAnnouncement(before: number, count: number, loading: boolean): string {
  if (loading) return 'Loading next page';
  const added = count - before;
  return added > 0 ? `${added} more record${added === 1 ? '' : 's'} loaded` : '';
}

/** XAIBO-PROD-439 (design §2.3/§2.4): the scroll that brings an item fully inside a scrollport with `pad` px of room for
 *  its focus ring; 0 when it is already inside; an item taller than the port shows its top. */
export function revealDelta(item: { top: number; bottom: number }, port: { top: number; bottom: number }, pad = 8): number {
  if (item.top - pad < port.top) return item.top - pad - port.top;
  if (item.bottom + pad > port.bottom) return Math.min(item.bottom + pad - port.bottom, item.top - pad - port.top);
  return 0;
}

/** XAIBO-PROD-439 review HIGH: only a layout change of the list (width or text metrics) with the same records brings the
 *  focused record back; rows measured while the user scrolls, or a change of records, never move the scroll. */
export const shouldReveal = <K>(focused: K | null, layoutChanged: boolean, recordsChanged: boolean): boolean =>
  layoutChanged && !recordsChanged && focused !== null;

/** What a re-measure caused by layout depends on: the list's width and its text metrics (text spacing, size, zoom). */
export const layoutSignature = (m: { width: number; fontSize: string; lineHeight: string; letterSpacing: string; wordSpacing: string }): string =>
  `${m.width}|${m.fontSize}|${m.lineHeight}|${m.letterSpacing}|${m.wordSpacing}`;

/** XAIBO-PROD-439: rows re-measure over several commits after one layout change; a change opens a 500 ms window in which
 *  every re-measure keeps the focused record in view. The first measurement (no previous signature) is no change. */
export function revealDue(prevSig: string, sig: string, now: number, until: number): { due: boolean; until: number } {
  if (prevSig !== '' && sig !== prevSig) return { due: true, until: now + 500 };
  return { due: now < until, until };
}

/** XAIBO-PROD-439: the part of a scroller a focused record must sit in: the scroller clipped to the window, below the
 *  sticky top frame's padding (`padTop`, from --x-frame-pad). */
export const revealPort = (scroller: { top: number; bottom: number }, windowHeight: number, padTop: number): { top: number; bottom: number } =>
  ({ top: Math.max(scroller.top, padTop), bottom: Math.min(scroller.bottom, windowHeight) });

/** XAIBO-PROD-530 (D-P5-11): a focused element starting above the reveal port (under the sticky top band). A record
 *  taller than the room there keeps its top hidden under the browser's nearest-edge focus scroll; it is shown from its
 *  start instead. Half a pixel of rounding is not hidden. `moved`: focus came from another element; the window
 *  regaining focus (review M1) never undoes the user's own scrolling. */
export const startHidden = (el: { top: number }, port: { top: number }, moved: boolean): boolean => moved && el.top < port.top - 0.5;

/** XAIBO-PROD-439: whether the window (or the sticky frame's padding) clips a list's scroller; only then does arrow-key
 *  focus also move the page, otherwise the virtualizer's own scroll is left alone. */
export const scrollerClipped = (scroller: { top: number; bottom: number }, windowHeight: number, padTop: number): boolean =>
  scroller.top < padTop || scroller.bottom > windowHeight;
