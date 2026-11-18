// Cursor paging helpers (P4-T03): a resync refetches the rows the user had loaded (at least one page), page by page; a
// later page failing keeps what was fetched (review L3).
import type { Cursor, Page } from '../../shared/ipc.ts';

export async function reloadWindow(count: number, fetch: (cursor: Cursor | null, limit: number) => Promise<Page>, page: number): Promise<Page> {
  const want = Math.max(count, page);
  const rows: Page['rows'] = [];
  let cursor: Cursor | null = null;
  do {
    let p: Page;
    try { p = await fetch(cursor, Math.min(page, want - rows.length)); } catch (e) {
      if (!rows.length) throw e;
      break; // keep the fresh pages already fetched; the cursor continues after them
    }
    rows.push(...p.rows);
    cursor = p.next;
  } while (cursor && rows.length < want);
  return { rows, next: cursor };
}

/** P4-T10c1 review M1: runs `run` one at a time; calls made during a run collapse into one more run after it, so a burst
 *  of resyncs costs at most two reloads and the last state is always fetched. A failed run still releases the flight. */
export function singleFlight(run: () => Promise<unknown>): () => void {
  let busy = false, again = false;
  const go = (): void => {
    if (busy) { again = true; return; }
    busy = true;
    void run().catch(() => undefined).finally(() => { busy = false; if (again) { again = false; go(); } });
  };
  return go;
}

/** XAIBO-PROD-447 (G4c-1): a reload of several pages can resolve after deltas flushed while a later page was pending;
 *  page 1's older copy of such a row must not replace it. Each `hold` keeps the rows `push`ed while its load is in
 *  flight (latest per id, at most `max`) and returns them to be replayed on the result. Past `max` the hold is dropped,
 *  its result resolves to null (not applied) and `overflow` asks for a resync; a failed load discards its hold. */
export function createHolds<V extends { id: number }>(max: number, overflow: () => void) {
  const active = new Set<Map<number, V>>();
  return {
    push(rows: readonly V[]): void {
      for (const h of [...active]) { // a copy: an overflow resync may start a new hold
        for (const r of rows) { h.delete(r.id); h.set(r.id, r); }
        if (h.size > max) { active.delete(h); h.clear(); overflow(); }
      }
    },
    async hold<T>(load: Promise<T>): Promise<{ value: T; held: V[] } | null> {
      const h = new Map<number, V>();
      active.add(h);
      try {
        const value = await load;
        return active.has(h) ? { value, held: [...h.values()] } : null;
      } finally { active.delete(h); }
    },
  };
}
