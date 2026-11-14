// P4-T03 (from the P4-T02 review): a cursor resync refetches the rows the user had loaded, not just the first page,
// in as few requests as the page size allows; it stops early when the store has fewer rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reloadWindow } from '../../../src/renderer/data/pages.ts';
import type { Cursor, Page, SessionRow } from '../../../src/shared/ipc.ts';

const row = (id: number) => ({ id, lastActivity: 1_000 - id }) as unknown as SessionRow;
function store(total: number) {
  const calls: { cursor: Cursor | null; limit: number }[] = [];
  const fetch = async (cursor: Cursor | null, limit: number): Promise<Page> => {
    calls.push({ cursor, limit });
    const from = cursor ? cursor.id : 0;
    const rows = Array.from({ length: Math.max(0, Math.min(limit, total - from)) }, (_, i) => row(from + i + 1));
    const last = rows.at(-1);
    return { rows, next: rows.length === limit && last && last.id < total ? { lastActivity: last.lastActivity, id: last.id } : null };
  };
  return { fetch, calls };
}

test('refetches the loaded count in page-size requests and keeps the continuation cursor', async () => {
  const s = store(500);
  const p = await reloadWindow(130, s.fetch, 50);
  assert.equal(p.rows.length, 130);
  assert.deepEqual(s.calls.map((c) => c.limit), [50, 50, 30]);
  assert.deepEqual(p.next, { lastActivity: 1_000 - 130, id: 130 });
});

test('at least one page; stops early when the store runs out (no next)', async () => {
  const a = store(500);
  assert.equal((await reloadWindow(0, a.fetch, 50)).rows.length, 50);
  const b = store(70);
  const p = await reloadWindow(150, b.fetch, 50);
  assert.equal(p.rows.length, 70);
  assert.equal(p.next, null);
  assert.equal(b.calls.length, 2);
});

test('review L3: a later page failing keeps the fresh pages already fetched (and their cursor)', async () => {
  const s = store(500);
  let n = 0;
  const flaky = (cursor: Cursor | null, limit: number) => (++n === 3 ? Promise.reject(new Error('gone')) : s.fetch(cursor, limit));
  const p = await reloadWindow(150, flaky, 50);
  assert.equal(p.rows.length, 100);
  assert.deepEqual(p.next, { lastActivity: 1_000 - 100, id: 100 });
  await assert.rejects(reloadWindow(150, () => Promise.reject(new Error('down')), 50), /down/, 'the first page failing still fails');
});
