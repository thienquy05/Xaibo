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

/** ArrowDown on the last loaded record with more available asks for the next page once per edge (End only jumps). */
export function createEdgeFetch() {
  let firedAt = -1;
  return (key: string, index: number, count: number, hasMore: boolean): boolean => {
    if (key !== 'ArrowDown' || !hasMore || index !== count - 1 || firedAt === count) return false;
    firedAt = count;
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
