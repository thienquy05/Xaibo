// XAIBO-PROD-108 (P1-T10): Claude backfill + tail with subagents linked; partial lines; rotation; kill/restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { Writer, type Batch } from '../../src/service/store/writer.ts';
import { claudeProfile, count, until } from '../helpers/claude-profile.ts';

const BETA = '00000000-0000-4000-8000-000000002000';
const transcript = (root: string) => join(root, 'projects', '-tmp-xaibo-fixture-identifiers', `${BETA}.jsonl`);
const userLine = (n: number) => JSON.stringify({ parentUuid: null, type: 'user', uuid: `00000000-0000-4000-8000-00000000250${n}`,
  timestamp: `2026-01-01T00:01:0${n}.000Z`, cwd: '/tmp/xaibo-fixture/beta', sessionId: BETA, message: { role: 'user', content: `more ${n}` } }) + '\n';

test('backfill: sessions, events, subagent linked, cwd and entrypoint from records', async () => {
  const p = await claudeProfile(['identifiers', 'usage-basic']);
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start();
  a.stop();
  assert.equal(count(p.db, 'SELECT count(*) FROM sessions'), 2);
  assert.equal(count(p.db, 'SELECT count(*) FROM events'), 4 + 2 + 9);
  assert.equal(count(p.db, 'SELECT count(*) FROM source_files'), 3);
  assert.equal(count(p.db, "SELECT count(*) FROM subagents s JOIN sessions x ON x.id = s.session_id WHERE x.native_session_id = ? AND s.native_id = '00000000-0000-4000-8000-000000002100' AND s.file_id IS NOT NULL", BETA), 1);
  assert.equal(count(p.db, "SELECT count(*) FROM events WHERE subagent_native_id = '00000000-0000-4000-8000-000000002100'"), 2);
  const s = p.db.prepare('SELECT cwd, entrypoint, last_activity FROM sessions WHERE native_session_id = ?').get(BETA) as Record<string, unknown>;
  assert.deepEqual({ ...s }, { cwd: '/tmp/xaibo-fixture/beta', entrypoint: 'sdk-cli', last_activity: Date.parse('2026-01-01T00:00:13.000Z') });
});

test('tail: appends arrive once; a partial line waits for its newline', async () => {
  const p = await claudeProfile(['identifiers']);
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start();
  const base = count(p.db, 'SELECT count(*) FROM events');
  appendFileSync(transcript(p.root), userLine(1));
  const half = userLine(2);
  appendFileSync(transcript(p.root), half.slice(0, 40));
  await a.wake();
  await until(() => count(p.db, 'SELECT count(*) FROM events') === base + 1, 2000);
  appendFileSync(transcript(p.root), half.slice(40));
  await a.wake();
  await until(() => count(p.db, 'SELECT count(*) FROM events') === base + 2, 2000);
  await a.wake();
  a.stop();
  assert.equal(count(p.db, 'SELECT count(*) FROM events'), base + 2);
  assert.equal(count(p.db, 'SELECT count(*) FROM quarantine'), 0);
});

test('EC-13 end to end: rotation and same-size replacement reparse with zero duplicates', async () => {
  const p = await claudeProfile(['identifiers']);
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start();
  const base = count(p.db, 'SELECT count(*) FROM events');
  const f = transcript(p.root);
  const text = readFileSync(f);
  renameSync(f, `${f}.old`);
  writeFileSync(f, text); // new inode, same content
  rmSync(`${f}.old`);
  await a.wake();
  writeFileSync(f, Buffer.concat([text, Buffer.from(userLine(3))])); // same inode, grown
  await a.wake();
  await until(() => count(p.db, 'SELECT count(*) FROM events') === base + 1, 2000);
  a.stop();
  assert.equal(count(p.db, 'SELECT count(*) FROM events'), base + 1);
  assert.equal(count(p.db, 'SELECT count(*) FROM (SELECT native_id FROM events GROUP BY session_id, native_id HAVING count(*) > 1)'), 0);
});

class DyingWriter extends Writer {
  #left: number;
  constructor(db: ConstructorParameters<typeof Writer>[0], left: number) { super(db); this.#left = left; }
  override enqueue(batch: Batch, live: boolean) {
    return this.#left-- > 0 ? super.enqueue(batch, live) : Promise.reject(new Error('service killed'));
  }
}

test('kill/restart mid-backfill: committed rows survive, nothing duplicates, the rest arrives', async () => {
  const p = await claudeProfile(['usage-basic', 'identifiers']);
  const dying = new ClaudeAdapter({ db: p.db, writer: new DyingWriter(p.db, 2), profileId: 'p1', root: p.root, eventsPerBatch: 2, intervalMs: 60_000 });
  await dying.start();
  dying.stop();
  const partial = count(p.db, 'SELECT count(*) FROM events');
  assert.ok(partial > 0 && partial < 15, `partial ${partial}`);
  const again = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, eventsPerBatch: 2, intervalMs: 60_000 });
  await again.start();
  again.stop();
  assert.equal(count(p.db, 'SELECT count(*) FROM events'), 15);
  assert.equal(count(p.db, 'SELECT sum(record_count) FROM sessions'), 15);
});

// P1-T14 (XAIBO-PROD-112, EC-15): a record above the parse cap is ingested as a head row plus bounded content chunks
// (each one FTS item) and raw chunks; a crash mid-record and a restart give no duplicates.
test('EC-15: an oversized record becomes head, content and raw rows; searchable; restart-safe', async () => {
  const p = await claudeProfile(['identifiers']);
  const word = (i: number) => `w${i.toString(36)}`;
  const text = Array.from({ length: 60_000 }, (_, i) => word(i)).join(' ') + ' needlezeta';
  appendFileSync(transcript(p.root), JSON.stringify({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000025ee', timestamp: '2026-01-01T00:02:00.000Z',
    cwd: '/tmp/xaibo-fixture/beta', sessionId: BETA, message: { role: 'user', content: text } }) + '\n');
  appendFileSync(transcript(p.root), userLine(4));
  const opts = { profileId: 'p1', root: p.root, intervalMs: 60_000, maxLineBytes: 64 * 1024, eventsPerBatch: 3 };
  const dying = new ClaudeAdapter({ db: p.db, writer: new DyingWriter(p.db, 3), ...opts });
  await dying.start();
  dying.stop();
  const again = new ClaudeAdapter({ db: p.db, writer: p.writer, ...opts });
  await again.start();
  again.stop();
  const chunks = p.db.prepare("SELECT content FROM events WHERE kind = 'content-chunk' ORDER BY source_seq, native_id").all() as { content: string }[];
  assert.ok(chunks.length >= 5);
  assert.equal(chunks.map((c) => c.content).join(''), text);
  for (const c of chunks) assert.ok(Buffer.byteLength(c.content) <= 64 * 1024);
  assert.equal(count(p.db, "SELECT count(*) FROM events WHERE kind = 'raw-chunk'"), 1);
  assert.equal(count(p.db, "SELECT count(*) FROM events WHERE native_id = '00000000-0000-4000-8000-0000000025ee' AND kind = 'message' AND content IS NULL"), 1);
  assert.equal(count(p.db, "SELECT count(*) FROM event_fts WHERE event_fts MATCH 'needlezeta'"), 1);
  assert.equal(count(p.db, 'SELECT count(*) FROM (SELECT native_id FROM events GROUP BY session_id, native_id HAVING count(*) > 1)'), 0);
  assert.equal(count(p.db, "SELECT count(*) FROM events WHERE native_id = '00000000-0000-4000-8000-000000002504'"), 1, 'the line after it arrives');
  assert.equal(count(p.db, 'SELECT count(*) FROM quarantine'), 0);
});

// P1-T14 EC-15 measurement (D-P1-13): the default parse cap is 8 MiB; a longer line takes the bounded streaming path.
test('EC-15: with default options a line above 8 MiB is chunked, not parsed in memory', async () => {
  const p = await claudeProfile(['identifiers']);
  const text = 'ab '.repeat(Math.ceil((8 * 1024 * 1024 + 4096) / 3));
  appendFileSync(transcript(p.root), JSON.stringify({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000025ef', timestamp: '2026-01-01T00:03:00.000Z',
    cwd: '/tmp/xaibo-fixture/beta', sessionId: BETA, message: { role: 'user', content: text } }) + '\n');
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start();
  a.stop();
  assert.ok(count(p.db, "SELECT count(*) FROM events WHERE kind = 'content-chunk'") > 100);
  assert.equal(count(p.db, "SELECT count(*) FROM events WHERE native_id = '00000000-0000-4000-8000-0000000025ef' AND content IS NULL"), 1);
});

// P1-T14 review: chunk rows are storage, not records; they must not dilute the EC-04 drift ratio.
test('EC-15/EC-04: oversized chunk rows do not count as records', async () => {
  const p = await claudeProfile(['identifiers']);
  appendFileSync(transcript(p.root), JSON.stringify({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000025ed', timestamp: '2026-01-01T00:04:00.000Z',
    cwd: '/tmp/xaibo-fixture/beta', sessionId: BETA, message: { role: 'user', content: 'y '.repeat(200_000) } }) + '\n');
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000, maxLineBytes: 64 * 1024 });
  await a.start();
  a.stop();
  assert.ok(count(p.db, "SELECT count(*) FROM events WHERE kind LIKE '%-chunk'") > 5);
  assert.equal(count(p.db, 'SELECT sum(record_count) FROM sessions'), count(p.db, "SELECT count(*) FROM events WHERE kind NOT LIKE '%-chunk'"));
});
