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
