// XAIBO-PROD-410 (P4-T05b1; design §5.2, §6.3; PRD US-3, US-15): one session's detail (row + fixed coverage codes),
// its transcript in source order by keyset cursor from either end, and bounded text slices. Only the session's own
// current, non-injected main-transcript records appear; subagent, hook and other sessions' records never do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerSession, answerSlice, answerTranscript, RAW_BUDGET, SCAN_MAX, TRANSCRIPT_MAX, transcriptStats } from '../../src/service/api.ts';
import { openStore } from '../../src/service/store/db.ts';
import type { PortRequest } from '../../src/shared/ipc.ts';

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
