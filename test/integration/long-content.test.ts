// XAIBO-PROD-421 (P4-T09a; EC-56, PRD §5.7, design §5.2): a Claude line above the parse cap (EC-15: a head row plus
// content chunks) is a 'large' transcript item whose text is served as UTF-8-safe slices of at most 16 KiB through an
// opaque byte cursor across the chunks; chunk rows never page as records, so paging past the line reads no chunk text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { answerSlice, answerTranscript, transcriptStats } from '../../src/service/api.ts';
import { SLICE_BYTES, type PortRequest } from '../../src/shared/ipc.ts';
import { claudeProfile, count } from '../helpers/claude-profile.ts';

const SID = '00000000-0000-4000-8000-00000000f501';
const CAP = 64 * 1024;
// ASCII, 2-, 3- and 4-byte characters, NUL and ESC, repeated past several 64 KiB chunks and 16 KiB slices.
const UNIT = 'line of tool output é € 😀 \u0000 \u001b[31m ';
const BIG = UNIT.repeat(Math.ceil((300 * 1024) / Buffer.byteLength(UNIT)));
const rec = (o: object) => JSON.stringify({ parentUuid: null, isSidechain: false, cwd: '/tmp/xaibo-fixture/long', sessionId: SID, version: '2.1.319', entrypoint: 'cli', ...o });

async function ingest() {
  const p = await claudeProfile([]);
  const dir = join(p.root, 'projects', '-tmp-xaibo-fixture-long');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), [
    rec({ type: 'user', uuid: '00000000-0000-4000-8000-00000000f511', timestamp: '2026-01-04T10:00:00.000Z', message: { role: 'user', content: 'Run the build' } }),
    rec({ type: 'user', uuid: '00000000-0000-4000-8000-00000000f512', timestamp: '2026-01-04T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_long', content: BIG, is_error: false }] } }),
    rec({ type: 'assistant', uuid: '00000000-0000-4000-8000-00000000f513', timestamp: '2026-01-04T10:00:02.000Z',
      message: { model: 'claude-opus-5-5', id: 'msg_long', role: 'assistant', content: [{ type: 'text', text: 'After the long output' }] } }),
    // Review M2: an oversized line with no readable field (raw chunks only) still shows, with no text.
    rec({ type: 'progress', uuid: '00000000-0000-4000-8000-00000000f514', timestamp: '2026-01-04T10:00:03.000Z', data: { ticks: Array.from({ length: 40_000 }, (_, i) => i) } }),
  ].join('\n') + '\n');
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000, maxLineBytes: CAP });
  await a.start();
  a.stop();
  return p;
}
const session = (db: DatabaseSync) => (db.prepare('SELECT id FROM sessions WHERE native_session_id = ?').get(SID) as { id: number }).id;
const page = (db: DatabaseSync, s: number) => answerTranscript(db, { v: 1, type: 'transcript', id: 1, session: s, at: 'first', limit: 50 } as PortRequest & { type: 'transcript' });
const slice = (db: DatabaseSync, s: number, event: number, offset: number, part: 'text' | 'reasoning' = 'text') =>
  answerSlice(db, { v: 1, type: 'slice', id: 2, session: s, event, part, offset });

test('a line above the parse cap is one Large record item; its chunk rows are never read as records', async () => {
  const p = await ingest();
  assert.ok(count(p.db, "SELECT count(*) FROM events WHERE kind = 'content-chunk'") >= 4, 'the line was stored as content chunks');
  const s = session(p.db);
  const r = page(p.db, s);
  assert.deepEqual(r.items.map((i) => i.kind), ['prompt', 'large', 'response', 'large']);
  const large = r.items[1]!;
  assert.deepEqual([large.length, large.preview, large.reasoning, large.callId], [Buffer.byteLength(BIG), null, false, null], 'byte size, no preview');
  assert.equal(r.items[3]!.length, 0, 'review M2: no readable text, still listed');
  assert.equal(transcriptStats.rowsRead, 4, 'no chunk row was iterated');
  assert.equal(r.next, null);
  // Review: the latest page and its cursors skip chunk rows too.
  const latest = answerTranscript(p.db, { v: 1, type: 'transcript', id: 1, session: s, at: 'latest', limit: 50 } as PortRequest & { type: 'transcript' });
  assert.deepEqual([latest.items.map((i) => i.kind), latest.prev, latest.next], [['prompt', 'large', 'response', 'large'], null, null]);
  assert.equal(slice(p.db, s, r.items[3]!.event, 0).text, '');
});

test('slices walk the whole text through the byte cursor: UTF-8 safe, at most 16 KiB, always progressing', async () => {
  const p = await ingest();
  const s = session(p.db);
  const large = page(p.db, s).items.find((i) => i.kind === 'large')!;
  let text = '', offset: number | null = 0, n = 0;
  while (offset !== null) {
    const r = slice(p.db, s, large.event, offset);
    assert.ok(r.text.length > 0 && Buffer.byteLength(r.text) <= SLICE_BYTES, `slice ${n} within 16 KiB`);
    assert.ok(r.next === null || r.next > offset, 'the cursor progresses');
    assert.ok(!r.text.includes('�'), 'no code point was split');
    text += r.text;
    offset = r.next;
    n++;
  }
  assert.equal(text, BIG, 'the slices rebuild the text exactly, NUL and ESC included');
  assert.ok(n >= Math.ceil(Buffer.byteLength(BIG) / SLICE_BYTES));

  const euro = Buffer.from(BIG).indexOf(Buffer.from('€'));
  assert.deepEqual(slice(p.db, s, large.event, euro + 1), { v: 1, type: 'slice', id: 2, text: '', next: null }, 'a cursor inside a code point');
  for (const at of [Buffer.byteLength(BIG), Buffer.byteLength(BIG) + 1, -1, 1.5]) assert.deepEqual(slice(p.db, s, large.event, at).text, '', `cursor ${at}`);
  assert.deepEqual(slice(p.db, s, large.event, 0, 'reasoning').text, '', 'no reasoning');
  const chunk = (p.db.prepare("SELECT id FROM events WHERE kind = 'content-chunk' LIMIT 1").get() as { id: number }).id;
  assert.equal(slice(p.db, s, chunk, 0).text, '', 'a chunk row is not a sliceable record');
});
