// P4-T03 (from the P4-T02 review): a cursor resync refetches the rows the user had loaded, not just the first page,
// in as few requests as the page size allows; it stops early when the store has fewer rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reloadWindow, singleFlight } from '../../../src/renderer/data/pages.ts';
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

// P4-T10c1 review M1: back-to-back resyncs (a long backfill overflowing every window) run one reload at a time, and
// calls during a run collapse into one trailing reload, so the last state is always fetched.
test('singleFlight: one run at a time; calls during a run give exactly one more run after it; a failed run still releases', async () => {
  let runs = 0;
  const gates: (() => void)[] = [];
  const fail = [false, true, false];
  const go = singleFlight(() => new Promise<void>((resolve, reject) => { const n = runs++; gates.push(() => (fail[n] ? reject(new Error('x')) : resolve())); }));
  const tick = () => new Promise((r) => setImmediate(r));
  go(); go(); go();
  assert.equal(runs, 1, 'calls during a run wait');
  gates.shift()!(); await tick();
  assert.equal(runs, 2, 'one trailing run for all of them');
  gates.shift()!(); await tick(); // this run fails
  assert.equal(runs, 2, 'nothing was asked during it');
  go();
  assert.equal(runs, 3, 'a failed run released the flight');
  gates.shift()!(); await tick();
  assert.equal(runs, 3);
});

// XAIBO-PROD-447 (G4c-1): a reload of several pages resolved after a delta flushed while a later page was pending, and
// page 1's older copy of that row replaced it (Busy -> Needs input reverted to Busy). Each reload holds the delta rows
// flushed during it (latest per id, bounded) and they are replayed on its result.
test('createHolds: a delta flushed between page 1 and page 2 survives the reload; overflow drops the hold and resyncs once', async () => {
  const { createHolds } = await import('../../../src/renderer/data/pages.ts');
  const { applyDelta, applyPage, emptyList } = await import('../../../src/renderer/model.ts');
  const busy = (id: number, lifecycle = 'busy') => ({ ...row(id), live: { lifecycle } }) as unknown as SessionRow;
  let resyncs = 0;
  const holds = createHolds<SessionRow>(2, () => { resyncs++; });
  holds.push([busy(9, 'idle')]); // before the reload: not held
  let page2!: () => void;
  let page1Done!: () => void;
  const page1Returned = new Promise<void>((r) => { page1Done = r; });
  const fetchPage = async (cursor: Cursor | null, limit: number): Promise<Page> => {
    const from = cursor ? cursor.id : 0;
    if (from) await new Promise<void>((r) => { page2 = r; });
    else setImmediate(page1Done);
    const rows = Array.from({ length: limit }, (_, i) => busy(from + i + 1));
    return { rows, next: { lastActivity: rows.at(-1)!.lastActivity, id: rows.at(-1)!.id } };
  };
  const pending = holds.hold(reloadWindow(100, fetchPage, 50));
  await page1Returned;
  await new Promise((r) => setImmediate(r));
  holds.push([busy(1, 'waiting-for-permission')]);
  holds.push([busy(1, 'needs-input')]); // latest per id
  page2();
  const r = await pending;
  assert.ok(r);
  assert.deepEqual(r.held.map((x) => x.id), [1]);
  const list = applyDelta(applyPage(emptyList, r.value, false), r.held);
  assert.equal(list.rows.length, 100);
  assert.equal(list.rows.find((x) => x.id === 1)?.live?.lifecycle, 'needs-input', 'the delta wins over page 1');
  holds.push([busy(2)]); // after the reload: nothing holds it
  assert.equal(resyncs, 0);

  let release!: () => void;
  const over = holds.hold(new Promise<string>((res) => { release = () => res('page'); }));
  holds.push([busy(1), busy(2)]);
  holds.push([busy(3)]); // a third distinct id past max 2
  assert.equal(resyncs, 1, 'overflow asks for one resync');
  holds.push([busy(4)]);
  assert.equal(resyncs, 1, 'the dropped hold no longer counts');
  release();
  assert.equal(await over, null, 'an overflowed reload is not applied (its resync follows)');

  await assert.rejects(holds.hold(Promise.reject(new Error('down'))), /down/, 'a failed reload discards its hold');
  holds.push([busy(5), busy(6), busy(7)]);
  assert.equal(resyncs, 1, 'a failed reload holds nothing afterwards');
});
