// XAIBO-PROD-422 (P4-T09b; EC-56, design §5.2): the text slices of one open item held in renderer memory, at most
// MAX_SLICES. Cursors come from the service and stay opaque; the window only remembers where each slice started, so
// Load previous can fetch an evicted slice back and Load more text can refetch one evicted at the end.
export const MAX_SLICES = 4;
export interface SliceWindow { slices: { at: number; text: string }[]; next: number | null; earlier: number[] }
export interface Slice { text: string; next: number | null }

/** A preview (start) is the first slice, its remainder starts at `from`; with no preview the first fetch is at `from`. */
export const openWindow = (start: string, from: number | null): SliceWindow =>
  ({ slices: start === '' ? [] : [{ at: 0, text: start }], next: from, earlier: [] });

/** The cursor Load previous fetches, or null when nothing was evicted at the start. */
export const previousAt = (w: SliceWindow): number | null => w.earlier.at(-1) ?? null;

/** Load more text: the slice fetched at `at` joins the end; past MAX_SLICES the earliest is evicted, its cursor kept. */
export function appendSlice(w: SliceWindow, at: number, s: Slice): SliceWindow {
  const slices = [...w.slices, { at, text: s.text }];
  const earlier = slices.length > MAX_SLICES ? [...w.earlier, slices.shift()!.at] : w.earlier;
  return { slices, next: s.next, earlier };
}

/** Load previous: the slice fetched at `at` joins the start; past MAX_SLICES the last is evicted and its cursor becomes
 *  `next`. A slice refetched where a shorter preview once started is cut where the following slice starts (only a
 *  preview can be shorter, and preview cursors are code units, as the slice text). */
export function prependSlice(w: SliceWindow, at: number, s: Slice): SliceWindow {
  const following = w.slices[0];
  const text = following && s.next !== null && s.next > following.at ? s.text.slice(0, following.at - at) : s.text;
  const slices = [{ at, text }, ...w.slices];
  const earlier = previousAt(w) === at ? w.earlier.slice(0, -1) : w.earlier;
  const next = slices.length > MAX_SLICES ? slices.pop()!.at : w.next;
  return { slices, next, earlier };
}
