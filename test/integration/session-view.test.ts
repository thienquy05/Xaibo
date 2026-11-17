// XAIBO-PROD-410 (P4-T05b1; design §5.2, §6.3; PRD US-3, US-15): one session's detail (row + fixed coverage codes),
// its transcript in source order by keyset cursor from either end, and bounded text slices. Only the session's own
// current, non-injected main-transcript records appear; subagent, hook and other sessions' records never do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerFiles, answerMarkers, answerSession, answerSlice, answerSubagents, answerTools, answerTranscript, EVIDENCE_MAX, RAW_BUDGET, SCAN_MAX, TRANSCRIPT_MAX, transcriptStats } from '../../src/service/api.ts';
import { openStore } from '../../src/service/store/db.ts';
import type { LiveStatus, PortRequest } from '../../src/shared/ipc.ts';

const T = Date.parse('2026-01-02T00:00:00.000Z');
const cl = (type: string, content: unknown) => JSON.stringify({ type, message: { role: type, content } });

async function store() {
  const dir = mkdtempSync(join(tmpdir(), 'xsv-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'b') });
  db.exec(`INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/home/.claude', 'default');
    INSERT INTO sessions (id, agent, profile_id, native_session_id, last_activity) VALUES (1, 'claude', 'p1', 'sess-1', ${T}), (2, 'claude', 'p1', 'sess-2', ${T});`);
  const ev = db.prepare(`INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, role, subagent_native_id, source_seq, source_ts,
    received_ts, injected, content, raw, revision_status) VALUES (?, 1, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  const put = (o: { session?: number; source?: string; kind?: string; role?: string | null; sub?: string | null; seq: number; injected?: number; content?: string | null; raw?: string | null; rev?: string }) =>
    Number(ev.run(o.session ?? 1, o.source ?? 'transcript', `n${++n}`, o.kind ?? 'message', o.role ?? null, o.sub ?? null, o.seq, T + o.seq, T + o.seq,
      o.injected ?? 0, o.content ?? null, o.raw ?? null, o.rev ?? 'current').lastInsertRowid);
  return { db, put };
}
const tr = (at: unknown, limit = 50) => ({ v: 1, type: 'transcript', id: 5, session: 1, at, limit }) as PortRequest & { type: 'transcript' };

test('transcript: source order from either end, keyset paging both ways, foreign and hidden records excluded', async () => {
  const { db, put } = await store();
  const prompt = put({ seq: 10, role: 'user', raw: cl('user', 'Fix the parser') });
  const resp = put({ seq: 20, role: 'assistant', raw: cl('assistant', [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'Looking' }]) });
  const call = put({ seq: 30, role: 'assistant', content: 'Read {"file_path":"/w/a"}', raw: cl('assistant', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/w/a' } }]) });
  const result = put({ seq: 40, role: 'user', content: 'body', raw: cl('user', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'body', is_error: false }]) });
  const compact = put({ seq: 50, kind: 'system', raw: JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) });
  put({ seq: 25, role: 'assistant', sub: 'agent-1', raw: cl('assistant', [{ type: 'text', text: 'subagent' }]) }); // subagent record
  put({ seq: 26, source: 'hook', kind: 'PreToolUse', content: 'hook' });
  put({ seq: 27, role: 'user', injected: 1, raw: cl('user', 'injected') });
  put({ seq: 28, role: 'user', raw: cl('user', 'rewound away'), rev: 'rewound' });
  put({ seq: 35, kind: 'system', raw: JSON.stringify({ type: 'system', subtype: 'informational' }) }); // skipped kind
  put({ session: 2, seq: 15, role: 'user', raw: cl('user', 'other session') });
  db.prepare(`INSERT INTO tool_calls (session_id, schema_version, sources, native_call_id, tool, tool_source, args_event_id, result_event_id)
    VALUES (1, 1, '["transcript"]', 'toolu_1', 'Read', 'transcript', ?, ?)`).run(call, result);

  const all = answerTranscript(db, tr('first'));
  assert.deepEqual(all.items.map((i) => [i.event, i.kind]), [[prompt, 'prompt'], [resp, 'response'], [call, 'tool-call'], [result, 'tool-result'], [compact, 'compaction']]);
  assert.deepEqual(all.items[1], { event: resp, seq: 20, ts: T + 20, kind: 'response', preview: 'Looking', length: 7, reasoning: true, callId: null });
  assert.equal(all.items[2]!.preview, null); // tool items stay collapsed
  assert.equal(all.items[2]!.callId, 'toolu_1');
  assert.equal(all.items[3]!.callId, 'toolu_1');
  assert.equal(all.prev, null);
  assert.equal(all.next, null);

  const head = answerTranscript(db, tr('first', 2));
  assert.deepEqual(head.items.map((i) => i.event), [prompt, resp]);
  assert.equal(head.prev, null);
  const more = answerTranscript(db, tr({ after: head.next }, 2));
  assert.deepEqual(more.items.map((i) => i.event), [call, result]);
  assert.ok(more.prev);
  const latest = answerTranscript(db, tr('latest', 2));
  assert.deepEqual(latest.items.map((i) => i.event), [result, compact]);
  assert.equal(latest.next, null);
  const back = answerTranscript(db, tr({ before: latest.prev }, 2));
  assert.deepEqual(back.items.map((i) => i.event), [resp, call]);
  assert.ok(back.prev);
  assert.ok(back.next);
  assert.equal(answerTranscript(db, tr('first', 10_000)).items.length <= TRANSCRIPT_MAX, true);
  assert.deepEqual(answerTranscript(db, { ...tr('first'), session: 99 }).items, []);
});

test('preview: at most 4 KiB of UTF-8 with the full length; slices continue in 16 KiB steps for text and reasoning', async () => {
  const { db, put } = await store();
  const long = 'é'.repeat(10_000); // 20,000 bytes
  const id = put({ seq: 1, role: 'assistant', raw: cl('assistant', [{ type: 'thinking', thinking: 'why'.repeat(10) }, { type: 'text', text: long }]) });
  const [item] = answerTranscript(db, tr('first')).items;
  assert.equal(Buffer.byteLength(item!.preview!, 'utf8'), 4096);
  assert.equal(item!.length, 10_000);
  const s1 = answerSlice(db, { v: 1, type: 'slice', id: 7, session: 1, event: id, part: 'text', offset: 0 });
  assert.equal(Buffer.byteLength(s1.text, 'utf8'), 16 * 1024);
  const s2 = answerSlice(db, { v: 1, type: 'slice', id: 7, session: 1, event: id, part: 'text', offset: s1.next! });
  assert.equal(s1.text + s2.text, long);
  assert.equal(s2.next, null);
  assert.deepEqual(answerSlice(db, { v: 1, type: 'slice', id: 7, session: 1, event: id, part: 'reasoning', offset: 0 }), { v: 1, type: 'slice', id: 7, text: 'why'.repeat(10), next: null });
  // Another session's event, an unknown event or a bad offset gives an empty slice.
  const other = put({ session: 2, seq: 2, role: 'user', raw: cl('user', 'secret of session 2') });
  for (const req of [{ event: other, offset: 0 }, { event: 9999, offset: 0 }, { event: id, offset: 1e9 }]) {
    assert.deepEqual(answerSlice(db, { v: 1, type: 'slice', id: 7, session: 1, part: 'text', event: req.event, offset: req.offset }), { v: 1, type: 'slice', id: 7, text: '', next: null });
  }
});

// XAIBO-PROD-446 (G4a-1): a tool step asks for its own call: only that tool_use (name and arguments) or tool_result.
test('XAIBO-PROD-446: a slice with a call id serves only that call\'s block of a Claude record', async () => {
  const { db, put } = await store();
  const blocks = [{ type: 'text', text: 'narration' }, { type: 'tool_use', id: 'toolu_A', name: 'Read', input: { file_path: '/w/a' } },
    { type: 'tool_use', id: 'toolu_B', name: 'Bash', input: { command: 'ls' } }];
  const args = put({ seq: 1, role: 'assistant', content: 'narration\nRead {"file_path":"/w/a"}\nBash {"command":"ls"}', raw: cl('assistant', blocks) });
  const result = put({ seq: 2, role: 'user', content: 'out A\nout B', raw: cl('user', [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'out A' },
    { type: 'tool_result', tool_use_id: 'toolu_B', content: [{ type: 'text', text: 'out B' }] }]) });
  const slice = (event: number, call?: string) => answerSlice(db, { v: 1, type: 'slice', id: 8, session: 1, event, part: 'text', offset: 0, ...(call ? { call } : {}) }).text;
  assert.equal(slice(args, 'toolu_B'), 'Bash {"command":"ls"}');
  assert.equal(slice(args, 'toolu_A'), 'Read {"file_path":"/w/a"}');
  assert.equal(slice(result, 'toolu_B'), 'out B');
  assert.equal(slice(result, 'toolu_A'), 'out A');
  assert.equal(slice(args, 'toolu_none'), '', 'no matching block: nothing, never the narration');
  assert.equal(slice(args), 'narration', 'without a call id the classified text is unchanged');
  // review LOW 1: a record the transcript hides (isMeta) gives nothing, even for a matching call
  const meta = put({ seq: 3, role: 'assistant', content: 'Bash {"command":"ls"}', raw: JSON.stringify({ type: 'assistant', isMeta: true,
    message: { role: 'assistant', content: [blocks[2]] } }) });
  assert.equal(slice(meta, 'toolu_B'), '');
});

test('review: more than SCAN_MAX skipped records give a short page whose cursor continues without gap or duplicate', async () => {
  const { db, put } = await store();
  const a = put({ seq: 1, role: 'user', raw: cl('user', 'first') });
  for (let i = 0; i < SCAN_MAX + 50; i++) put({ seq: 2 + i, kind: 'system', raw: JSON.stringify({ type: 'system', subtype: 'informational' }) });
  const b = put({ seq: SCAN_MAX + 100, role: 'user', raw: cl('user', 'second') });
  const p1 = answerTranscript(db, tr('first', 5));
  assert.deepEqual(p1.items.map((i) => i.event), [a]);
  assert.ok(p1.next);
  const p2 = answerTranscript(db, tr({ after: p1.next }, 5));
  assert.deepEqual(p2.items.map((i) => i.event), [b]);
  assert.equal(p2.next, null);
});

test('review: equal source_seq ties split across pages in both directions; limit 1', async () => {
  const { db, put } = await store();
  const ids = [1, 2, 3, 4].map((k) => put({ seq: 7, role: 'user', raw: cl('user', `tie ${k}`) }));
  const seen: number[] = [];
  let page = answerTranscript(db, tr('first', 1));
  for (;;) { seen.push(...page.items.map((i) => i.event)); if (!page.next) break; page = answerTranscript(db, tr({ after: page.next }, 1)); }
  assert.deepEqual(seen, ids);
  const back: number[] = [];
  page = answerTranscript(db, tr('latest', 1));
  for (;;) { back.unshift(...page.items.map((i) => i.event)); if (!page.prev) break; page = answerTranscript(db, tr({ before: page.prev }, 1)); }
  assert.deepEqual(back, ids);
});

test('review 3: a cursor followed only by bookkeeping records leads to an empty last page that ends cleanly', async () => {
  const { db, put } = await store();
  const a = put({ seq: 1, role: 'user', raw: cl('user', 'only') });
  put({ seq: 2, kind: 'system', raw: JSON.stringify({ type: 'system', subtype: 'informational' }) });
  const p1 = answerTranscript(db, tr('first', 1));
  assert.deepEqual(p1.items.map((i) => i.event), [a]);
  const p2 = answerTranscript(db, tr({ after: p1.next ?? { seq: 1, id: a } }, 1));
  assert.deepEqual(p2.items, []);
  assert.equal(p2.next, null);
});

test('review 1: a page stops early at the raw-byte budget with a cursor; slices stay correct when repeated', async () => {
  const { db, put } = await store();
  const big = 'x'.repeat(Math.ceil(RAW_BUDGET / 3));
  const ids = [1, 2, 3, 4, 5].map((k) => put({ seq: k, role: 'user', content: big, raw: cl('user', [{ type: 'tool_result', tool_use_id: `t${k}`, content: big }]) }));
  const p1 = answerTranscript(db, tr('first', 5));
  assert.ok(p1.items.length < 5 && p1.items.length >= 1, `page stopped at the budget (${p1.items.length})`);
  // Re-review: rows are read lazily, so the budget bounds what is loaded, not only what is classified.
  assert.equal(transcriptStats.rowsRead, 2);
  assert.ok(p1.next);
  const p2 = answerTranscript(db, tr({ after: p1.next }, 5));
  assert.deepEqual([...p1.items, ...p2.items].map((i) => i.event).slice(0, ids.length), ids.slice(0, p1.items.length + p2.items.length));
  const s = (offset: number) => answerSlice(db, { v: 1, type: 'slice', id: 1, session: 1, event: ids[0]!, part: 'text', offset });
  const first = s(0), again = s(0), second = s(first.next!);
  assert.equal(first.text, again.text);
  assert.equal(first.text + second.text, big.slice(0, first.text.length + second.text.length));
});

test('session detail: the row plus fixed coverage codes; unknown session null', async () => {
  const { db } = await store();
  db.exec(`UPDATE sessions SET drift = 1, quarantined_count = 2 WHERE id = 1;
    INSERT INTO source_files (profile_id, session_id, path, kind, status) VALUES ('p1', 1, '/tmp/xaibo-fixture/a.jsonl', 'transcript', 'oversized'),
      ('p1', 1, '/tmp/xaibo-fixture/b.jsonl.zst', 'transcript', 'compressed_not_imported');
    INSERT INTO hook_gaps (reason, agent, native_session_id, from_ts, to_ts, locator, recorded_at) VALUES ('spool-overflow', 'claude', 'sess-1', ${T}, ${T + 1}, 'gap-1', ${T});`);
  const d = answerSession(db, { v: 1, type: 'session', id: 4, session: 1 });
  assert.equal(d.detail?.row.id, 1);
  assert.deepEqual([...d.detail!.coverage].sort(), ['compressed', 'drift', 'hook-gap', 'oversized', 'quarantined']);
  assert.deepEqual(answerSession(db, { v: 1, type: 'session', id: 4, session: 2 }).detail?.coverage, []);
  assert.equal(answerSession(db, { v: 1, type: 'session', id: 4, session: 99 }).detail, null);
});

// XAIBO-PROD-414 (P4-T06a; PRD FR-47; design §6.3.1): the detail carries the newest generation's latest reading, so an
// older generation's numbers are never paired with a newer one; no reading is null (never zeros).
test('session detail: context is the newest generation\'s latest reading; none is null', async () => {
  const { db } = await store();
  const put = db.prepare(`INSERT INTO context_snapshots (session_id, schema_version, source, generation, model_id, used_tokens, window_tokens,
    window_basis, percentage, source_locator, as_of, observed_at) VALUES (1, 1, ?, ?, 'm', ?, ?, ?, NULL, 'loc', ?, ?)`);
  put.run('statusline', 0, 150000, 200000, 'reported', T, T + 1);
  put.run('statusline', 1, 9000, null, 'unavailable', null, T + 3); // newer generation (model change), window not reported yet
  put.run('statusline', 0, 160000, 200000, 'reported', T + 4, T + 5); // a later id in the OLD generation never wins
  assert.deepEqual(answerSession(db, { v: 1, type: 'session', id: 4, session: 1 }).detail?.context,
    { generation: 1, used: 9000, window: null, basis: 'unavailable', source: 'statusline', asOf: null, observedAt: T + 3 });
  put.run('compaction', 2, null, 200000, 'reported', T + 6, T + 7);
  put.run('compaction', 2, null, 200000, 'reported', T + 8, T + 9);
  assert.deepEqual(answerSession(db, { v: 1, type: 'session', id: 4, session: 1 }).detail?.context,
    { generation: 2, used: null, window: 200000, basis: 'reported', source: 'compaction', asOf: T + 8, observedAt: T + 9 });
  assert.equal(answerSession(db, { v: 1, type: 'session', id: 4, session: 2 }).detail?.context, null);
  // re-review M: an INTEGER above 2^53 - 1 makes node:sqlite throw on read; only context degrades, the detail stays.
  db.exec(`INSERT INTO context_snapshots (session_id, schema_version, source, generation, used_tokens, window_tokens, window_basis, observed_at)
    VALUES (1, 1, 'rollout', 3, 9007199254740992, 200000, 'reported', ${T})`);
  const big = answerSession(db, { v: 1, type: 'session', id: 4, session: 1 }).detail;
  assert.equal(big?.row.id, 1);
  assert.equal(big?.context, null);
});

// XAIBO-PROD-411 (P4-T05b2; design §6.3 Tools/Subagents/Files/Timeline): forward keyset pages of the session's tool
// calls, subagents, files touched and model markers. Unknown stays null; only the session's own main-thread calls.
const evidence = (db: Awaited<ReturnType<typeof store>>['db']) => {
  const ins = db.prepare(`INSERT INTO status_evidence (agent, profile_id, native_session_id, dedup, ts, rank, seq, confidence, ev) VALUES ('claude', ?, ?, ?, ?, 0, ?, ?, ?)`);
  let k = 0;
  return (ts: number, evs: unknown[], profile = 'p1', sid = 'sess-1', conf = 'confirmed') => ins.run(profile, sid, `d${++k}`, ts, k, conf, JSON.stringify(evs));
};
const page = <T extends 'tools' | 'subagents' | 'files'>(type: T, cursor: number | null, limit = 50, session = 1) => ({ v: 1, type, id: 6, session, cursor, limit }) as PortRequest & { type: T };
const use = (id: string, name: string, input: unknown = {}) => cl('assistant', [{ type: 'tool_use', id, name, input }]);
const res = (id: string, isError?: boolean) => cl('user', [{ type: 'tool_result', tool_use_id: id, content: 'out', ...(isError === undefined ? {} : { is_error: isError }) }]);
const call = (db: Awaited<ReturnType<typeof store>>['db'], o: { session?: number; callId: string; tool: string | null; sources?: string; args?: number | null; result?: number | null }) =>
  Number(db.prepare(`INSERT INTO tool_calls (session_id, schema_version, sources, native_call_id, tool, tool_source, args_event_id, result_event_id) VALUES (?, 1, ?, ?, ?, 'transcript', ?, ?)`)
    .run(o.session ?? 1, o.sources ?? '["transcript"]', o.callId, o.tool, o.args ?? null, o.result ?? null).lastInsertRowid);

test('tools: approval from status evidence, single-source duration, error flag, sliceable event ids, main-thread only', async () => {
  const { db, put } = await store();
  const ev = evidence(db);
  const a1 = put({ seq: 30, role: 'assistant', content: 'Read', raw: use('toolu_1', 'Read', { file_path: '/w/a' }) });
  const r1 = put({ seq: 40, role: 'user', content: 'out', raw: res('toolu_1', false) });
  const a2 = put({ seq: 50, role: 'assistant', content: 'Bash', raw: use('toolu_2', 'Bash') });
  const r2 = put({ seq: 60, source: 'hook', kind: 'PostToolUse', content: 'hook', raw: JSON.stringify({ hook_event_name: 'PostToolUse' }) });
  const a3 = put({ seq: 70, role: 'assistant', content: 'Grep', raw: use('toolu_3', 'Grep') });
  const aSub = put({ seq: 80, role: 'assistant', sub: 'agent-1', raw: use('toolu_sub', 'Read') });
  const aRew = put({ seq: 90, role: 'assistant', raw: use('toolu_rew', 'Read'), rev: 'rewound' });
  const aOther = put({ session: 2, seq: 30, role: 'assistant', raw: use('toolu_o', 'Read') });
  const c1 = call(db, { callId: 'toolu_1', tool: 'Read', args: a1, result: r1 });
  const c2 = call(db, { callId: 'toolu_2', tool: 'Bash', sources: '["transcript","hook"]', args: a2, result: r2 });
  const c3 = call(db, { callId: 'toolu_3', tool: 'Grep', args: a3 });
  call(db, { callId: 'toolu_sub', tool: 'Read', args: aSub });
  call(db, { callId: 'toolu_rew', tool: 'Read', args: aRew });
  call(db, { session: 2, callId: 'toolu_o', tool: 'Read', args: aOther });
  ev(T + 31, [{ k: 'tool.start', id: 'toolu_1', tool: 'Read' }]);
  ev(T + 32, [{ k: 'request', kind: 'permission', id: null }]);
  ev(T + 39, [{ k: 'tool.end', id: 'toolu_1' }]);
  ev(T + 51, [{ k: 'tool.start', id: 'toolu_2' }, { k: 'request', kind: 'permission', id: 'toolu_2' }]);
  ev(T + 52, [{ k: 'resolve', id: 'toolu_2', outcome: 'denied' }]);
  ev(T + 71, [{ k: 'tool.start', id: 'toolu_3' }, { k: 'request', kind: 'permission', id: 'toolu_3' }], 'p2'); // another profile's evidence

  const p1 = answerTools(db, page('tools', null, 2));
  assert.equal(p1.type, 'tools');
  assert.deepEqual(p1.calls[0], { call: c1, callId: 'toolu_1', tool: 'Read', sources: ['transcript'], argsEvent: a1, resultEvent: r1, ts: T + 30, durationMs: 10, approval: 'approved', error: false });
  assert.deepEqual(p1.calls[1], { call: c2, callId: 'toolu_2', tool: 'Bash', sources: ['transcript', 'hook'], argsEvent: a2, resultEvent: null, ts: T + 50, durationMs: null, approval: 'denied', error: null });
  assert.equal(p1.next, c2);
  const p2 = answerTools(db, page('tools', p1.next));
  assert.deepEqual(p2.calls.map((c) => [c.call, c.approval, c.durationMs, c.resultEvent, c.error]), [[c3, null, null, null, null]]);
  assert.equal(p2.next, null);
  // Review M4: a pending request is shown only while the session is live; otherwise its outcome is unknown.
  const a4 = put({ seq: 75, role: 'assistant', raw: use('toolu_4', 'Bash') });
  call(db, { callId: 'toolu_4', tool: 'Bash', args: a4 });
  ev(T + 76, [{ k: 'tool.start', id: 'toolu_4' }, { k: 'request', kind: 'permission', id: 'toolu_4' }]);
  const at4 = (l?: () => LiveStatus) => answerTools(db, page('tools', c3), l, T + 200).calls.map((c) => [c.callId, c.approval]);
  assert.deepEqual(at4(), [['toolu_4', null]]);
  assert.deepEqual(at4(live), [['toolu_4', 'requested']]);
  // XAIBO-PROD-444 (G4a-2): the stored confidence reaches the derivation: a transcript end sorted before the hook start
  // does not close the call, so the id-less request is shown as the engine shows it.
  const a5 = put({ seq: 77, role: 'assistant', raw: use('toolu_5', 'Write') });
  call(db, { callId: 'toolu_5', tool: 'Write', args: a5 });
  ev(T + 77, [{ k: 'tool.end', id: 'toolu_5' }], 'p1', 'sess-1', 'inferred');
  ev(T + 78, [{ k: 'tool.start', id: 'toolu_5' }]);
  ev(T + 79, [{ k: 'request', kind: 'permission', id: null }]);
  assert.deepEqual(answerTools(db, page('tools', c3), live, T + 200).calls.map((c) => [c.callId, c.approval]), [['toolu_4', 'requested'], ['toolu_5', 'requested']]);
  assert.ok(answerTools(db, page('tools', null, 10_000)).calls.length <= 100);
  assert.deepEqual(answerTools(db, page('tools', null, 50, 99)).calls, []);
});

test('tools and subagents: evidence beyond EVIDENCE_MAX leaves approval and lifecycle unknown, never a partial state', async () => {
  const { db, put } = await store();
  const ev = evidence(db);
  const a1 = put({ seq: 30, role: 'assistant', raw: use('toolu_1', 'Read') });
  call(db, { callId: 'toolu_1', tool: 'Read', args: a1 });
  db.exec(`INSERT INTO subagents (session_id, native_id, agent_type) VALUES (1, 'agent-a', NULL)`);
  ev(T, [{ k: 'tool.start', id: 'toolu_1' }, { k: 'request', kind: 'permission', id: 'toolu_1' }, { k: 'child.start', id: 'agent-a' }]);
  db.exec('BEGIN');
  for (let i = 0; i < EVIDENCE_MAX; i++) ev(T + 1 + i, [{ k: 'activity' }]);
  db.exec('COMMIT');
  assert.equal(answerTools(db, page('tools', null)).calls[0]!.approval, null);
  assert.equal(answerSubagents(db, page('subagents', null)).subagents[0]!.lifecycle, null);
});

const busy: LiveStatus = { lifecycle: 'busy', confidence: 'confirmed', health: 'connected', reason: null, outcome: null, findings: [], since: null };
const live = () => busy;

test('subagents: own model from its latest assistant record (never the parent), record span, lifecycle from evidence', async () => {
  const { db, put } = await store();
  const ev = evidence(db);
  db.exec(`UPDATE sessions SET current_model = 'parent-model' WHERE id = 1;
    INSERT INTO subagents (id, session_id, native_id, agent_type) VALUES (10, 1, 'agent-a', 'general-purpose'), (11, 1, 'agent-b', NULL), (12, 1, 'agent-c', NULL), (13, 2, 'agent-x', NULL);`);
  const m = (model: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: 'x' }] } });
  put({ seq: 100, role: 'user', sub: 'agent-a', raw: cl('user', 'task') });
  put({ seq: 110, role: 'assistant', sub: 'agent-a', raw: m('model-early') });
  put({ seq: 120, role: 'assistant', sub: 'agent-a', raw: m('model-late') });
  put({ seq: 130, role: 'assistant', sub: 'agent-a', raw: m('model-rewound'), rev: 'rewound' });
  put({ seq: 140, role: 'user', sub: 'agent-b', raw: cl('user', 'task') });
  ev(T + 99, [{ k: 'child.start', id: 'agent-a' }, { k: 'child.start', id: 'agent-b' }]);
  ev(T + 125, [{ k: 'child.end', id: 'agent-a' }]);

  const p1 = answerSubagents(db, page('subagents', null, 2), [], live, T + 200);
  assert.deepEqual(p1.subagents, [
    { id: 10, nativeId: 'agent-a', agentType: 'general-purpose', model: 'model-late', start: T + 100, end: T + 120, records: 3, lifecycle: 'ended' },
    { id: 11, nativeId: 'agent-b', agentType: null, model: 'Model unavailable', start: T + 140, end: T + 140, records: 1, lifecycle: 'running' },
  ]);
  assert.equal(p1.next, 11);
  const p2 = answerSubagents(db, page('subagents', p1.next), [], live, T + 200);
  assert.deepEqual(p2.subagents, [{ id: 12, nativeId: 'agent-c', agentType: null, model: 'Model unavailable', start: null, end: null, records: 0, lifecycle: null }]);
  assert.equal(p2.next, null);
  // Review M4: "running" only while the session is live; an ended, untracked or quiet session leaves it unknown ("ended" stays).
  for (const [l, now] of [[undefined, T + 200], [() => ({ ...busy, lifecycle: 'ended' as const }), T + 200], [live, T + 25 * 3600_000]] as const) {
    assert.deepEqual(answerSubagents(db, page('subagents', null, 2), [], l, now).subagents.map((x) => x.lifecycle), ['ended', null]);
  }
});

test('review L7: a <synthetic> placeholder model is unknown; out-of-range stored times are unknown, never a voided page', async () => {
  const { db, put } = await store();
  db.exec(`INSERT INTO subagents (id, session_id, native_id) VALUES (10, 1, 'agent-a');`);
  put({ seq: 100, role: 'assistant', sub: 'agent-a', raw: JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [] } }) });
  const a = put({ seq: 30, role: 'assistant', raw: use('toolu_1', 'Read') });
  db.prepare('UPDATE events SET source_ts = ? WHERE id = ?').run(2n ** 60n, a);
  call(db, { callId: 'toolu_1', tool: 'Read', args: a });
  db.prepare(`INSERT INTO turns (id, session_id, schema_version, source, native_turn_id, started_at, model_id) VALUES (1, 1, 1, 'transcript', 't1', ?, 'model-a'), (2, 1, 1, 'transcript', 't2', ?, 'model-b')`).run(2n ** 60n, T);
  // Re-review L: SQLite abs() raises on -2^63, so the range check must not use it.
  db.prepare('UPDATE sessions SET last_activity = ? WHERE id = 1').run(-(2n ** 63n));
  db.prepare(`INSERT INTO turns (id, session_id, schema_version, source, native_turn_id, started_at, model_id) VALUES (3, 1, 1, 'transcript', 't3', ?, 'model-c')`).run(-(2n ** 63n));
  assert.equal(answerSubagents(db, page('subagents', null)).subagents[0]!.model, 'Model unavailable');
  assert.deepEqual(answerTools(db, page('tools', null)).calls.map((c) => [c.callId, c.ts]), [['toolu_1', null]]);
  assert.deepEqual(answerMarkers(db, { v: 1, type: 'markers', id: 7, session: 1, cursor: null, limit: 50 }).markers.map((m) => m.turn), [2]);
});

test('review H1/L6: at most SCAN_MAX calls examined per request (cursor continues); a call linked to another session is not shown', async () => {
  const { db, put } = await store();
  db.exec('BEGIN');
  for (let i = 0; i < SCAN_MAX + 5; i++) call(db, { callId: `toolu_s${i}`, tool: 'Read', args: put({ seq: i, role: 'assistant', sub: 'agent-1', raw: use(`toolu_s${i}`, 'Read', { file_path: '/w/s' }) }) });
  db.exec('COMMIT');
  const foreign = put({ session: 2, seq: 1, role: 'assistant', raw: use('toolu_f', 'Read', { file_path: '/w/f' }) });
  call(db, { callId: 'toolu_f', tool: 'Read', args: foreign }); // a corrupt cross-session link on session 1
  const main = call(db, { callId: 'toolu_m', tool: 'Read', args: put({ seq: 9999, role: 'assistant', raw: use('toolu_m', 'Read', { file_path: '/w/m' }) }) });
  for (const type of ['tools', 'files'] as const) {
    const p1 = type === 'tools' ? answerTools(db, page(type, null)) : answerFiles(db, page(type, null));
    assert.deepEqual(type === 'tools' ? (p1 as { calls: unknown[] }).calls : (p1 as { touches: unknown[] }).touches, [], type);
    assert.ok(p1.next, type);
    const p2 = type === 'tools' ? answerTools(db, page(type, p1.next)) : answerFiles(db, page(type, p1.next));
    const calls = type === 'tools' ? (p2 as { calls: { call: number }[] }).calls.map((c) => c.call) : (p2 as { touches: { call: number }[] }).touches.map((c) => c.call);
    assert.deepEqual(calls, [main], type);
  }
});

test('files: Read/Write/Edit touches per call in call order, write confirmed only by a successful result, main thread only', async () => {
  const { db, put } = await store();
  const aR = put({ seq: 10, role: 'assistant', raw: use('toolu_r', 'Read', { file_path: '/w/a.ts' }) });
  const rR = put({ seq: 11, role: 'user', raw: res('toolu_r', false) });
  const aW = put({ seq: 20, role: 'assistant', raw: use('toolu_w', 'Write', { file_path: '/w/b.ts' }) });
  const rW = put({ seq: 21, role: 'user', raw: res('toolu_w', false) });
  const aB = put({ seq: 25, role: 'assistant', raw: use('toolu_b', 'Bash', { command: 'true' }) });
  const aE = put({ seq: 30, role: 'assistant', raw: use('toolu_e', 'Edit', { file_path: '/w/a.ts' }) });
  const aS = put({ seq: 40, role: 'assistant', sub: 'agent-1', raw: use('toolu_s', 'Write', { file_path: '/w/sub.ts' }) });
  const cR = call(db, { callId: 'toolu_r', tool: 'Read', args: aR, result: rR });
  const cW = call(db, { callId: 'toolu_w', tool: 'Write', args: aW, result: rW });
  call(db, { callId: 'toolu_b', tool: 'Bash', args: aB });
  const cE = call(db, { callId: 'toolu_e', tool: 'Edit', args: aE });
  call(db, { callId: 'toolu_s', tool: 'Write', args: aS });

  const p1 = answerFiles(db, page('files', null, 2));
  assert.deepEqual(p1.touches, [
    { path: '/w/a.ts', kind: 'read', callId: 'toolu_r', call: cR },
    { path: '/w/b.ts', kind: 'write_attempted', callId: 'toolu_w', call: cW },
    { path: '/w/b.ts', kind: 'write_confirmed', callId: 'toolu_w', call: cW },
  ]);
  assert.equal(p1.next, cW);
  const p2 = answerFiles(db, page('files', p1.next));
  assert.deepEqual(p2.touches, [{ path: '/w/a.ts', kind: 'write_attempted', callId: 'toolu_e', call: cE }]);
  assert.equal(p2.next, null);
});

test('markers: timed model/effort changes in turn order, across page boundaries; unknown model or effort is not a change', async () => {
  const { db } = await store();
  const turn = db.prepare(`INSERT INTO turns (id, session_id, schema_version, source, native_turn_id, started_at, model_id, effort) VALUES (?, 1, 1, 'transcript', ?, ?, ?, ?)`);
  turn.run(1, 't1', T + 1, 'model-a', null);
  turn.run(2, 't2', T + 2, 'model-a', null);
  turn.run(3, 't3', T + 3, 'model-b', null);
  turn.run(4, 't4', T + 4, null, null);
  turn.run(5, 't5', T + 5, 'model-b', 'high'); // effort becomes known: not a switch
  turn.run(6, 't6', T + 6, 'model-b', 'low');
  turn.run(7, 't7', null, 'model-c', null); // untimed: no marker
  const mk = (cursor: { ts: number; id: number } | null, limit: number) => answerMarkers(db, { v: 1, type: 'markers', id: 7, session: 1, cursor, limit });
  const p1 = mk(null, 2);
  assert.deepEqual(p1.markers, [{ turn: 1, ts: T + 1, model: 'model-a' }, { turn: 3, ts: T + 3, model: 'model-b' }]);
  assert.ok(p1.next);
  const p2 = mk(p1.next, 2);
  assert.deepEqual(p2.markers, [{ turn: 6, ts: T + 6, model: 'model-b · low' }]);
  assert.equal(p2.next, null);
  assert.deepEqual(mk(null, 50).markers.map((x) => x.turn), [1, 3, 6]);
});
