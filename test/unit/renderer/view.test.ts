// XAIBO-PROD-413 (P4-T05d; design §6.3 as amended by D-P4-06): pure helpers behind the Session workspace. Tool rows
// never claim success without evidence; a live session opens on its latest page; coverage codes name what is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argFor, clock, compactStatus, countText, incompleteReasons, initialAt, isoTime, liveAction, openChange, sizeText, toolMeta, toolTone, trimWindow, appendLive, WINDOW_MAX } from '../../../src/renderer/workspace/view.ts';
import type { FileItem, LiveStatus, ModelMarker, SessionRow, SubagentItem, ToolItem, TranscriptItem } from '../../../src/shared/ipc.ts';
import type { SessionChanges } from '../../../src/renderer/workspace/view.ts';

const tool = (o: Partial<ToolItem> = {}): ToolItem => ({ call: 1, callId: 'toolu_1', tool: 'Read', sources: ['transcript'], argsEvent: 2, resultEvent: null,
  ts: null, durationMs: null, approval: null, error: null, ...o });
const live = (lifecycle: LiveStatus['lifecycle']): LiveStatus => ({ lifecycle, confidence: 'confirmed', health: 'connected', reason: null, outcome: null, findings: [], since: null });

test('tool tone: denied or an error is bad; a pending request warns; only evidence of a result is ok; otherwise muted', () => {
  assert.equal(toolTone(tool({ approval: 'denied' })), 'bad');
  assert.equal(toolTone(tool({ error: true })), 'bad');
  assert.equal(toolTone(tool({ approval: 'requested' })), 'warn');
  assert.equal(toolTone(tool({ error: false })), 'ok');
  // Review M4: a result without a reported outcome is not success (sources without is_error)
  assert.equal(toolTone(tool({ approval: 'approved', resultEvent: 9 })), 'muted');
  assert.equal(toolTone(tool({ approval: 'approved' })), 'muted'); // approved, no result seen: not success
  assert.equal(toolTone(tool()), 'muted');
  assert.equal(toolTone(null), 'muted');
});

test('tool meta: known approval, then duration (unavailable when unknown); an unknown approval is not shown as one', () => {
  assert.deepEqual(toolMeta(tool({ approval: 'approved', durationMs: 1200 })), ['Approved', '1 s']);
  assert.deepEqual(toolMeta(tool({ approval: 'requested' })), ['Approval requested', 'Duration unavailable']);
  assert.deepEqual(toolMeta(tool()), ['Duration unavailable']);
  assert.deepEqual(toolMeta(null), ['Duration unavailable']);
});

test('a live, not ended session opens on its latest page; ended, unknown or untracked at its first turn', () => {
  assert.equal(initialAt({ live: live('busy') }), 'latest');
  assert.equal(initialAt({ live: live('idle') }), 'latest');
  assert.equal(initialAt({ live: live('ended') }), 'first');
  assert.equal(initialAt({ live: null }), 'first');
});

test('Content incomplete reasons come from the coverage codes; drift is its own notice, not missing content', () => {
  assert.deepEqual(incompleteReasons(['compressed', 'quarantined', 'oversized', 'hook-gap', 'drift']),
    ['A transcript file is compressed and not imported', 'Some records could not be read', 'A record is too large to store', 'Some hook events were lost']);
  assert.deepEqual(incompleteReasons(['drift']), []);
  assert.deepEqual(incompleteReasons([]), []);
});

test('a tool row argument is the file it touched when known; counts mark a page cap; times are local HH:mm', () => {
  const touches: FileItem[] = [{ path: '/w/a.ts', kind: 'read', callId: 'toolu_1', call: 1 }, { path: '/w/a.ts', kind: 'write_attempted', callId: 'toolu_2', call: 2 }];
  assert.equal(argFor('toolu_2', touches), '/w/a.ts');
  assert.equal(argFor('toolu_9', touches), null);
  assert.equal(argFor(null, touches), null);
  assert.equal(countText(3, false), '3');
  assert.equal(countText(100, true), '100+');
  const at = new Date(2026, 0, 2, 9, 5).getTime();
  assert.equal(clock(at), '09:05');
  assert.equal(clock(null), 'Time unknown');
});

test('P4-T08b (EC-102): isoTime is the machine-readable time of a known instant, null when unknown or invalid', () => {
  assert.equal(isoTime(Date.UTC(2026, 0, 2, 9, 5, 7, 12)), '2026-01-02T09:05:07.012Z');
  for (const x of [null, Number.NaN, Number.POSITIVE_INFINITY, 8.65e15]) assert.equal(isoTime(x), null);
});

test('XAIBO-PROD-424: a change to the open session waits for a load, appends at the end, else offers New activity available', () => {
  const w = (o: Partial<{ loaded: boolean; loading: boolean; next: unknown; items: number }>) => ({ loaded: true, loading: false, next: null, items: 3, ...o });
  assert.equal(liveAction(w({ loaded: false })), 'later', 'not loaded yet: handled when the first load settles');
  assert.equal(liveAction(w({ loading: true })), 'later', 'a load in flight: handled when it settles');
  assert.equal(liveAction(w({})), 'append', 'the window reaches the end');
  assert.equal(liveAction(w({ next: { seq: 1, id: 2 } })), 'notice', 'scrolled back: never moves the anchor');
  assert.equal(liveAction(w({ items: 0 })), 'reload', 'an empty loaded window reloads its target');
  assert.equal(liveAction({ ...w({}), appending: true }), 'later', 'review M2: an append in flight holds the change');
});

test('XAIBO-PROD-424 review H1/L5: only a frame after the one seen counts; a resync counts however frames interleave', () => {
  const row = (id: number) => ({ id }) as unknown as SessionRow;
  const c = (o: Partial<SessionChanges>): SessionChanges => ({ rows: [], resync: 0, n: 0, ...o });
  assert.deepEqual(openChange(c({ rows: [row(7)], resync: 1, n: 3 }), { n: 3, resync: 1 }, 7), { row: null, bump: false }, 'the frame at mount is not a change');
  assert.deepEqual(openChange(c({ rows: [row(7)], resync: 1, n: 4 }), { n: 3, resync: 1 }, 7), { row: row(7), bump: true });
  assert.deepEqual(openChange(c({ rows: [row(8)], resync: 1, n: 4 }), { n: 3, resync: 1 }, 7), { row: null, bump: false }, 'another session');
  assert.deepEqual(openChange(c({ rows: [row(8)], resync: 2, n: 5 }), { n: 3, resync: 1 }, 7), { row: null, bump: true }, 'a resync, even if a delta frame followed it');
});

test('P4-T09a (EC-56): sizeText names a large record in decimal KB or MB', () => {
  assert.deepEqual([sizeText(307_200), sizeText(1e6), sizeText(52_428_800), sizeText(999_999)], ['307.2 KB', '1.0 MB', '52.4 MB', '1.0 MB']);
});

test('workspace components emphasise with <strong>, never <b> (the untrusted-content E2E treats any <b> in main as injected)', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../../../src/renderer/workspace/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
    assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /<b[ >]/, f);
  }
});

test('compact status: one line with the label, reasons and health/outcome words, plus a dot tone (no evidence detail line)', () => {
  assert.deepEqual(compactStatus(null), { text: 'Unknown · heuristic', tone: 'muted' });
  assert.deepEqual(compactStatus({ ...live('busy'), reason: 'Finishing…', health: 'stale' }), { text: 'Busy · confirmed · Finishing… · Stale', tone: 'busy' });
  assert.deepEqual(compactStatus({ ...live('waiting-for-permission'), confidence: 'heuristic', reason: 'Probably waiting' }), { text: 'Probably waiting · heuristic', tone: 'warn' });
  assert.deepEqual(compactStatus({ ...live('error'), outcome: 'interrupted' }), { text: 'Error · confirmed · Last turn interrupted', tone: 'bad' });
  assert.deepEqual(compactStatus(live('ended')), { text: 'Ended · confirmed', tone: 'muted' });
});

test('review M3: the transcript window keeps at most 3 pages; the trimmed side gets a cursor at its new edge', () => {
  const item = (i: number): TranscriptItem => ({ event: i, seq: i * 10, ts: null, kind: 'prompt', preview: null, length: 0, reasoning: false, callId: null });
  const items = Array.from({ length: WINDOW_MAX + 50 }, (_, i) => item(i + 1));
  const small = { items: items.slice(0, 3), prev: null, next: { seq: 30, id: 3 } };
  assert.equal(trimWindow(small, 'end'), small);
  const end = trimWindow({ items, prev: null, next: { seq: 1, id: 1 } }, 'end'); // appended at the end: drop from the start
  assert.equal(end.items.length, WINDOW_MAX);
  assert.equal(end.items[0]!.event, 51);
  assert.deepEqual(end.prev, { seq: 510, id: 51 });
  assert.deepEqual(end.next, { seq: 1, id: 1 });
  const start = trimWindow({ items, prev: { seq: 1, id: 1 }, next: null }, 'start'); // prepended: drop from the end
  assert.equal(start.items.length, WINDOW_MAX);
  assert.equal(start.items.at(-1)!.event, WINDOW_MAX);
  assert.deepEqual(start.next, { seq: WINDOW_MAX * 10, id: WINDOW_MAX });
  assert.deepEqual(start.prev, { seq: 1, id: 1 });
  assert.equal(WINDOW_MAX, 150);
});

test('re-review: live activity never trims the window; a full window gets a cursor at its end instead of new records', () => {
  const item = (i: number): TranscriptItem => ({ event: i, seq: i * 10, ts: null, kind: 'prompt', preview: null, length: 0, reasoning: false, callId: null });
  const small = { items: [item(1), item(2)], prev: null, next: null };
  assert.deepEqual(appendLive(small, { items: [item(3)], next: null }).items.map((i) => i.event), [1, 2, 3]);
  const full = { items: Array.from({ length: WINDOW_MAX }, (_, i) => item(i + 1)), prev: null, next: null };
  const after = appendLive(full, { items: [item(WINDOW_MAX + 1)], next: null });
  assert.equal(after.items, full.items); // the records being read stay
  assert.deepEqual(after.next, { seq: WINDOW_MAX * 10, id: WINDOW_MAX }); // More records available
});

// XAIBO-PROD-436 (P4-T14b; owner decision D-P4-09): after a service restart a transcript that failed with nothing loaded
// reloads by itself on the next change (the reconnect resync); one that still shows records keeps its anchor.
test('a failed window with no records reloads on the next change; with records it keeps its anchor; a pending load waits', async () => {
  const { settled } = await import('../../../src/renderer/workspace/view.ts');
  const w = (o: Partial<{ loaded: boolean; loading: boolean; failed: boolean; next: unknown; items: number }>) => ({ loaded: true, loading: false, failed: false, next: null, items: 3, ...o });
  assert.equal(liveAction(w({ loaded: false, failed: true, items: 0 })), 'reload', 'the first load failed: reload');
  assert.equal(liveAction(w({ failed: true, items: 0 })), 'reload', 'a later replacing load failed on an empty window');
  assert.equal(liveAction(w({ loaded: false, loading: true, failed: true, items: 0 })), 'later', 'a retry in flight');
  assert.equal(liveAction(w({ failed: true, next: { seq: 1, id: 2 } })), 'notice', 'records shown: the anchor never moves');
  assert.equal(liveAction(w({ failed: true })), 'append');
  // a change held during a load runs once the load settles, whether it loaded or failed
  assert.deepEqual([settled(w({ loaded: false, loading: true })), settled(w({ loaded: false, failed: true })), settled(w({})), settled(w({ loaded: false }))],
    [false, true, true, false]);
});

// XAIBO-PROD-437 (design §8.1): a focusable Conversation/Activity entry is named by its kind and clock time, never by
// its content.
test('entryLabel: kind and time per entry; tool by its name; no message content', async () => {
  const { entryLabel } = await import('../../../src/renderer/workspace/view.ts');
  const ts = new Date(2026, 0, 2, 9, 5).getTime();
  const item = (kind: TranscriptItem['kind'], extra: Partial<TranscriptItem> = {}) => ({ seq: 1, event: 1, ts, kind, preview: 'secret prompt text', length: 18, callId: null, reasoning: false, ...extra }) as TranscriptItem;
  assert.equal(entryLabel({ key: 'a', kind: 'prompt', item: item('prompt') }), 'Owner prompt · 09:05');
  assert.equal(entryLabel({ key: 'b', kind: 'response', item: item('response') }), 'Agent response · 09:05');
  assert.equal(entryLabel({ key: 'c', kind: 'tool', item: null, tool: { tool: 'Write', ts } as ToolItem }), 'Tool Write · 09:05');
  assert.equal(entryLabel({ key: 'd', kind: 'tool', item: null, tool: null }), 'Unknown tool · Time unknown');
  assert.equal(entryLabel({ key: 'e', kind: 'compaction', item: item('compaction') }), 'Compaction · 09:05');
  assert.equal(entryLabel({ key: 'f', kind: 'model', marker: { model: 'Opus', ts } as ModelMarker }), 'Model Opus · 09:05');
  assert.equal(entryLabel({ key: 'g', kind: 'subagent-start', subagent: { agentType: 'explorer', nativeId: 'n1', start: ts } as SubagentItem }), 'Subagent started · explorer · 09:05');
  for (const e of [entryLabel({ key: 'a', kind: 'prompt', item: item('prompt') })]) assert.doesNotMatch(e, /secret/);
});

test('XAIBO-PROD-437 review L4: entryLabel bounds tool, model and subagent names', async () => {
  const { entryLabel } = await import('../../../src/renderer/workspace/view.ts');
  const ts = new Date(2026, 0, 2, 9, 5).getTime();
  const name = entryLabel({ key: 'c', kind: 'tool', item: null, tool: { tool: 'W'.repeat(500), ts } as ToolItem }).split(' · ')[0]!;
  assert.equal(Array.from(name).length, 'Tool '.length + 60);
  assert.equal(Array.from(entryLabel({ key: 'f', kind: 'model', marker: { model: 'M'.repeat(500), ts } as ModelMarker }).split(' · ')[0]!).length, 'Model '.length + 60);
});

// XAIBO-PROD-450 (G4d-2; design §6.3): Go to first turn anchors the loaded range at its start, Go to latest (and a live
// session's open) at its end; paging keeps the reading position (no anchor).
test('the anchor after a transcript load: first at the start, latest at the end, paging none', async () => {
  const { loadAnchor } = await import('../../../src/renderer/workspace/view.ts');
  assert.equal(loadAnchor('first'), 'start');
  assert.equal(loadAnchor('latest'), 'end');
  assert.equal(loadAnchor('after'), null);
  assert.equal(loadAnchor('before'), null);
});

// XAIBO-PROD-451 (G4d-4): a live continuation page can be empty with a cursor (the service's scan budget met bookkeeping
// records); the window keeps that cursor, so paging continues and New activity available shows.
test('a live append keeps an empty page continuation cursor; a window whose end moved is left alone', async () => {
  const { liveAppend } = await import('../../../src/renderer/workspace/view.ts');
  const item = (e: number): TranscriptItem => ({ event: e, seq: e * 10, ts: null, kind: 'prompt', preview: 'p', length: 1, reasoning: false, callId: null });
  const w = { items: [item(1), item(2)], prev: null, next: null };
  const cur = { seq: 990, id: 99 };
  const empty = liveAppend(w, w.items[1]!, { items: [], next: cur });
  assert.deepEqual(empty.items, w.items);
  assert.deepEqual(empty.next, cur);
  assert.deepEqual(liveAppend(w, w.items[1]!, { items: [item(3)], next: null }).items.map((i) => i.event), [1, 2, 3]);
  assert.equal(liveAppend(w, item(7), { items: [item(3)], next: cur }), w, 'the window changed since the append started');
});

// XAIBO-PROD-452 (G4d-N1; design §6.3): Retry repeats the request that failed; a failed page keeps the window it grew.
test('the transcript Retry repeats the failed request', async () => {
  const { retryRequest } = await import('../../../src/renderer/workspace/view.ts');
  assert.deepEqual(retryRequest('first'), { load: 'first' });
  assert.deepEqual(retryRequest('latest'), { load: 'latest' });
  assert.deepEqual(retryRequest('after'), { grow: 'after' });
  assert.deepEqual(retryRequest('before'), { grow: 'before' });
});
