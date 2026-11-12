// XAIBO-PROD-203 (P2-T03): Codex discovery, backfill, tail, kill/restart, archive move, filename mismatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer, type Batch } from '../../src/service/store/writer.ts';
import { count, until } from '../helpers/claude-profile.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0');
const DATED = join('sessions', '2026', '01', '01');
const rollout = (c: string) => readdirSync(join(FIX, c)).find((f) => f.startsWith('rollout-'))!;
const lineCount = (c: string) => readFileSync(join(FIX, c, rollout(c)), 'utf8').split('\n').filter(Boolean).length;
const sid = (n: string) => `00000000-0000-4000-8000-0000000c${n}`;

interface Home { root: string; db: DatabaseSync; writer: Writer }
async function codexHome(active: string[], archived: string[] = []): Promise<Home> {
  const tmp = mkdtempSync(join(tmpdir(), 'xcodex-'));
  const root = join(tmp, 'codex');
  mkdirSync(join(root, DATED), { recursive: true });
  mkdirSync(join(root, 'archived_sessions'), { recursive: true });
  for (const c of active) copyFileSync(join(FIX, c, rollout(c)), join(root, DATED, rollout(c)));
  for (const c of archived) copyFileSync(join(FIX, c, rollout(c)), join(root, 'archived_sessions', rollout(c)));
  const { db } = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'codex', ?, 'default')").run(root);
  return { root, db, writer: new Writer(db) };
}
const adapter = (h: Home, extra: Partial<ConstructorParameters<typeof CodexAdapter>[0]> = {}) =>
  new CodexAdapter({ db: h.db, writer: h.writer, profileId: 'p1', root: h.root, intervalMs: 60_000, ...extra });
const session = (db: DatabaseSync, id: string) => ({ ...(db.prepare('SELECT cwd, entrypoint, originator, native_archived FROM sessions WHERE native_session_id = ?').get(id) as object) }) as Record<string, unknown>;

test('backfill: dated and archived rollouts, every record once, session fields, archived flag', async () => {
  const h = await codexHome(['simple-turn', 'mirrored', 'compacted'], ['identifiers']);
  const a = adapter(h);
  await a.start();
  a.stop();
  const total = ['simple-turn', 'mirrored', 'compacted', 'identifiers'].reduce((n, c) => n + lineCount(c), 0);
  assert.equal(count(h.db, "SELECT count(*) FROM events WHERE source = 'rollout'"), total);
  assert.equal(count(h.db, 'SELECT sum(record_count) FROM sessions'), total);
  assert.equal(count(h.db, 'SELECT count(*) FROM sessions'), 4);
  assert.deepEqual(session(h.db, sid('0030')), { cwd: '/tmp/xaibo-fixture/alpha', entrypoint: 'cli', originator: 'codex-tui', native_archived: 0 });
  assert.deepEqual(session(h.db, sid('0031')), { cwd: '/tmp/xaibo-fixture/beta', entrypoint: 'exec', originator: 'codex_exec', native_archived: 0 });
  assert.equal(session(h.db, sid('0002')).native_archived, 1, 'rollout under archived_sessions');
  assert.equal(count(h.db, "SELECT count(*) FROM events WHERE kind = 'message'"), 3 + 3 + 2 + 2, 'mirrors never add a message');
  assert.ok(count(h.db, "SELECT count(*) FROM event_fts WHERE event_fts MATCH 'synthetic'") > 0);
  assert.equal(count(h.db, 'SELECT count(*) FROM quarantine'), 0);
});

test('tail: an appended line arrives once; a partial line waits for its newline', async () => {
  const h = await codexHome(['simple-turn']);
  const a = adapter(h);
  await a.start();
  const base = count(h.db, 'SELECT count(*) FROM events');
  const file = join(h.root, DATED, rollout('simple-turn'));
  const line = (n: number) => `${JSON.stringify({ timestamp: `2026-01-01T00:01:0${n}.000Z`, ordinal: 20 + n, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `more ${n}` }] } })}\n`;
  appendFileSync(file, line(1));
  const half = line(2);
  appendFileSync(file, half.slice(0, 30));
  await a.wake();
  await until(() => count(h.db, 'SELECT count(*) FROM events') === base + 1, 2000);
  appendFileSync(file, half.slice(30));
  await a.wake();
  await until(() => count(h.db, 'SELECT count(*) FROM events') === base + 2, 2000);
  a.stop();
  assert.equal(count(h.db, "SELECT count(*) FROM events WHERE content = 'more 2'"), 1);
});

class DyingWriter extends Writer {
  #left: number;
  constructor(db: DatabaseSync, left: number) { super(db); this.#left = left; }
  override enqueue(batch: Batch, live: boolean) {
    return this.#left-- > 0 ? super.enqueue(batch, live) : Promise.reject(new Error('service killed'));
  }
}

test('kill/restart mid-backfill: committed rows survive, nothing duplicates, the rest arrives', async () => {
  const h = await codexHome(['simple-turn', 'mirrored']);
  const dying = adapter(h, { writer: new DyingWriter(h.db, 2), eventsPerBatch: 2 });
  await dying.start();
  dying.stop();
  const total = lineCount('simple-turn') + lineCount('mirrored');
  const partial = count(h.db, 'SELECT count(*) FROM events');
  assert.ok(partial > 0 && partial < total, `partial ${partial}`);
  const again = adapter(h, { eventsPerBatch: 2 });
  await again.start();
  again.stop();
  assert.equal(count(h.db, 'SELECT count(*) FROM events'), total);
  assert.equal(count(h.db, 'SELECT sum(record_count) FROM sessions'), total);
});

test('moving an ingested rollout into archived_sessions adds nothing and flags the session archived', async () => {
  const h = await codexHome(['simple-turn']);
  const a = adapter(h);
  await a.start();
  const before = count(h.db, 'SELECT count(*) FROM events');
  renameSync(join(h.root, DATED, rollout('simple-turn')), join(h.root, 'archived_sessions', rollout('simple-turn')));
  await a.wake();
  await until(() => session(h.db, sid('0030')).native_archived === 1, 2000);
  a.stop();
  assert.equal(count(h.db, 'SELECT count(*) FROM events'), before, 'same file identity and offsets: zero new events');
  assert.equal(count(h.db, 'SELECT count(*) FROM sessions'), 1);
});

test('a filename id that differs from session_meta is a coverage warning; records stay with the session_meta id', async () => {
  const h = await codexHome(['simple-turn']);
  copyFileSync(join(FIX, 'simple-turn', rollout('simple-turn')), join(h.root, DATED, `rollout-2026-01-01T00-00-00-${sid('0099')}.jsonl`));
  const a = adapter(h);
  await a.start();
  a.stop();
  assert.equal(count(h.db, 'SELECT count(*) FROM sessions'), 1, 'one session: the session_meta id');
  assert.equal(count(h.db, 'SELECT count(*) FROM events'), lineCount('simple-turn'), 'the misnamed copy adds nothing');
  assert.equal(count(h.db, "SELECT count(*) FROM quarantine WHERE reason = 'session-id-mismatch'"), 1);
});

test('malformed lines are quarantined; a trailing partial line stays pending', async () => {
  const h = await codexHome(['partial-line']);
  const want = JSON.parse(readFileSync(join(FIX, 'partial-line', 'expected.json'), 'utf8')).files[sid('0005')];
  const a = adapter(h);
  await a.start();
  a.stop();
  assert.equal(count(h.db, "SELECT count(*) FROM quarantine WHERE reason = 'malformed'"), want.malformedLines.length);
  assert.equal(want.partialTrailing, true);
  const committed = count(h.db, 'SELECT offset FROM source_files');
  assert.ok(committed < readFileSync(join(h.root, DATED, rollout('partial-line'))).length, 'checkpoint stops before the partial line');
});
