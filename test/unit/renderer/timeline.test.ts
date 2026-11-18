// XAIBO-PROD-412 (P4-T05c; design §6.3 Timeline/Tools/Subagents/Files; plan P4-T05 U): the Activity sequence merges
// transcript items (service source order, never re-sorted by clock), tool records, model markers and subagent
// start/end; a tool appears once whatever its provenance; time-placed entries never reorder on page loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalText, durationLabel, FILE_KIND_TEXT, groupFiles, lifecycleText, mergeTimeline, resultText, toolTitle, type TimelineInput } from '../../../src/renderer/workspace/timeline.ts';
import type { FileItem, ModelMarker, SubagentItem, ToolItem, TranscriptItem } from '../../../src/shared/ipc.ts';

const T = Date.parse('2026-01-02T00:00:00.000Z');
const item = (event: number, kind: TranscriptItem['kind'], ts: number | null, callId: string | null = null): TranscriptItem =>
  ({ event, seq: event, ts, kind, preview: null, length: 0, reasoning: false, callId });
const tool = (call: number, o: Partial<ToolItem> = {}): ToolItem => ({ call, callId: `toolu_${call}`, tool: 'Read', sources: ['transcript'], argsEvent: null, resultEvent: null,
  ts: null, durationMs: null, approval: null, error: null, ...o });
const marker = (turn: number, ts: number, model = 'model-a'): ModelMarker => ({ turn, ts, model });
const sub = (id: number, start: number | null, end: number | null, lifecycle: SubagentItem['lifecycle']): SubagentItem =>
  ({ id, nativeId: `agent-${id}`, agentType: null, model: 'Model unavailable', start, end, records: 1, lifecycle });
const input = (o: Partial<TimelineInput>): TimelineInput => ({ items: [], tools: [], markers: [], subagents: [], moreBefore: false, moreAfter: false, ...o });
const keys = (i: TimelineInput) => mergeTimeline(i).map((e) => e.key);

test('source order is kept even when clocks disagree; compaction and interruption are their own entries', () => {
  const items = [item(1, 'prompt', T + 50), item(2, 'response', T + 10), item(3, 'compaction', null), item(4, 'interrupted', T + 60)];
  const out = mergeTimeline(input({ items }));
  assert.deepEqual(out.map((e) => [e.key, e.kind]), [['e:1', 'prompt'], ['e:2', 'response'], ['e:3', 'compaction'], ['e:4', 'interrupted']]);
});

test('a tool appears once: call item + tool record merge, its result folds in; transcript, hook or both provenance', () => {
  const items = [item(1, 'prompt', T), item(2, 'tool-call', T + 1, 'toolu_10'), item(3, 'tool-result', T + 2, 'toolu_10'),
    item(4, 'tool-call', T + 3, 'toolu_11'), item(5, 'tool-result', T + 4, 'toolu_11'), item(6, 'tool-call', T + 5, null), item(7, 'tool-result', T + 6, null)];
  const both = tool(10, { argsEvent: 2, resultEvent: 3, sources: ['transcript', 'hook'], ts: T + 1 });
  const viaCallId = tool(11, { argsEvent: null, resultEvent: null, ts: T + 3 }); // no sliceable ids: joined by call id, not time-placed again
  const hookOnly = tool(12, { callId: 'toolu_12', sources: ['hook'], ts: T + 4 }); // no transcript item: placed by time
  const out = mergeTimeline(input({ items, tools: [both, viaCallId, hookOnly] }));
  assert.deepEqual(out.map((e) => e.key), ['e:1', 'e:2', 'e:4', 'c:12', 'e:6', 'e:7']); // review L5: a call item keeps its event key
  const t10 = out[1]!;
  assert.ok(t10.kind === 'tool' && t10.tool === both && t10.item?.event === 2);
  const t12 = out[3]!;
  assert.ok(t12.kind === 'tool' && t12.item === null && t12.tool === hookOnly);
  const lone = out[4]!;
  assert.ok(lone.kind === 'tool' && lone.tool === null && lone.item?.event === 6); // a call item without a record is still a tool
  assert.equal(new Set(out.map((e) => e.key)).size, out.length);
});

test('a result whose call item is not loaded stays its own entry, unless the call has no transcript item at all', () => {
  const items = [item(5, 'tool-result', T + 2, 'toolu_10'), item(6, 'tool-result', T + 3, 'toolu_11')];
  const inEarlierPage = tool(10, { argsEvent: 4, resultEvent: 5, ts: T + 1 });
  const noCallItem = tool(11, { argsEvent: null, resultEvent: 6, sources: ['hook', 'transcript'], ts: null }); // untimed: its result is its only position
  const out = mergeTimeline(input({ items, tools: [inEarlierPage, noCallItem], moreBefore: true }));
  assert.deepEqual(out.map((e) => [e.key, e.kind]), [['e:5', 'tool-result'], ['e:6', 'tool']]);
});

test('markers, hook-only tools and subagent start/end go before the first item at or after their time, in a stable tie order', () => {
  const items = [item(1, 'prompt', T + 10), item(2, 'response', T + 20), item(3, 'prompt', T + 30)];
  const out = keys(input({
    items,
    markers: [marker(1, T + 10), marker(2, T + 30, 'model-b')],
    tools: [tool(20, { sources: ['hook'], ts: T + 20 })],
    subagents: [sub(7, T + 20, T + 25, 'ended'), sub(8, T + 21, T + 22, 'running'), sub(9, null, null, null)],
  }));
  assert.deepEqual(out, ['m:1', 'e:1', 's:7:start', 'c:20', 'e:2', 's:8:start', 's:7:end', 'm:2', 'e:3']);
});

test('time-placed entries outside the loaded range are left out while more transcript lies there, so page loads never reorder', () => {
  const page1 = [item(1, 'prompt', T + 10), item(2, 'response', T + 20)];
  const page2 = [item(3, 'prompt', T + 30), item(4, 'response', T + 40)];
  const markers = [marker(1, T + 5), marker(2, T + 30, 'model-b'), marker(3, T + 50, 'model-c')];
  const first = keys(input({ items: page1, markers, moreAfter: true }));
  assert.deepEqual(first, ['m:1', 'e:1', 'e:2']);
  const both = keys(input({ items: [...page1, ...page2], markers }));
  assert.deepEqual(both, ['m:1', 'e:1', 'e:2', 'm:2', 'e:3', 'e:4', 'm:3']);
  assert.deepEqual(both.slice(0, first.length), first); // the earlier entries keep their order
  // Review L3: at the first loaded item's time an entry may still belong before an earlier item of the same millisecond.
  assert.deepEqual(keys(input({ items: page2, markers, moreBefore: true })), ['e:3', 'e:4', 'm:3']);
  assert.deepEqual(keys(input({ items: page2, markers: [marker(1, T + 5)], moreBefore: true })), ['e:3', 'e:4']);
  assert.deepEqual(keys(input({ markers })), ['m:1', 'm:2', 'm:3']); // nothing loaded and nothing more: all shown
  assert.deepEqual(keys(input({ markers, moreBefore: true })), []); // review L4: nothing loaded, more before: none placed
});

test('review M1/L5: a timed call without a transcript item stays at its time when its result loads later; keys never change', () => {
  const hook = tool(12, { sources: ['hook', 'transcript'], resultEvent: 30, ts: T + 4 });
  const page1 = [item(1, 'prompt', T), item(2, 'response', T + 20)];
  const page2 = [item(30, 'tool-result', T + 25, 'toolu_12'), item(31, 'response', T + 40)];
  const before = keys(input({ items: page1, tools: [hook], moreAfter: true }));
  assert.deepEqual(before, ['e:1', 'c:12', 'e:2']);
  const after = keys(input({ items: [...page1, ...page2], tools: [hook] }));
  assert.deepEqual(after, ['e:1', 'c:12', 'e:2', 'e:31']); // the result folds into the timed call
  // While the timed call is out of range, its result stays visible as its own entry.
  assert.deepEqual(keys(input({ items: page2, tools: [hook], moreBefore: true })), ['e:30', 'e:31']);
  // Two call items naming one call id give two entries, never a duplicate key.
  const twice = mergeTimeline(input({ items: [item(1, 'tool-call', T, 'toolu_9'), item(2, 'tool-call', T + 1, 'toolu_9')], tools: [tool(9, { argsEvent: 1 })] }));
  assert.deepEqual(twice.map((e) => e.key), ['e:1', 'e:2']);
  assert.deepEqual(twice.map((e) => (e.kind === 'tool' ? e.tool?.call ?? null : 'x')), [9, null]); // re-review: the record belongs to its own call item only
});

test('labels never claim success or zero for unknown values', () => {
  assert.equal(toolTitle(tool(1)), 'Tool call — Read');
  assert.equal(toolTitle(tool(1, { tool: null })), 'Tool call — Unknown tool');
  assert.deepEqual([null, 'not_requested', 'requested', 'approved', 'denied'].map((a) => approvalText(a as ToolItem['approval'])),
    ['Approval unknown', 'No approval requested', 'Approval requested', 'Approved', 'Denied']);
  assert.equal(durationLabel(null), 'Duration unavailable');
  assert.equal(durationLabel(0), '<1 s');
  assert.equal(durationLabel(65_000), '1 min 5 s');
  assert.equal(resultText(tool(1, { error: true })), 'Error');
  assert.equal(resultText(tool(1, { error: false })), 'Completed');
  assert.equal(resultText(tool(1, { resultEvent: 9 })), 'Result recorded');
  assert.equal(resultText(tool(1)), 'Result unavailable');
  assert.deepEqual([lifecycleText('running'), lifecycleText('ended'), lifecycleText(null)], ['Running', 'Ended', 'Unknown']);
  assert.deepEqual(FILE_KIND_TEXT, { read: 'Read', write_attempted: 'Write attempted', write_confirmed: 'Write confirmed' });
});

test('files group by path in first-seen order with each kind once, in a fixed kind order', () => {
  const f = (path: string, kind: FileItem['kind'], call: number): FileItem => ({ path, kind, callId: `toolu_${call}`, call });
  const groups = groupFiles([f('/w/b.ts', 'write_confirmed', 2), f('/w/a.ts', 'read', 1), f('/w/b.ts', 'write_attempted', 2), f('/w/b.ts', 'read', 3), f('/w/b.ts', 'read', 4)]);
  assert.deepEqual(groups.map((g) => [g.path, g.kinds, g.touches.length]), [['/w/b.ts', ['read', 'write_attempted', 'write_confirmed'], 4], ['/w/a.ts', ['read'], 1]]);
});
