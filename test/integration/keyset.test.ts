// XAIBO-PROD-110 (P1-T12, S-29): keyset paging over (last_activity DESC, unknown last, id), default 50 and cap 100,
// the cursor always progresses; rows by session key for deltas; requests answered as validated port messages; deltas
// coalesced to one push per window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answer, coalesce, listSessions, PAGE_DEFAULT, PAGE_MAX, sessionsByKey } from '../../src/service/api.ts';
import { parsePortMessage } from '../../src/shared/ipc.ts';
import { openStore } from '../../src/service/store/db.ts';

async function store(n: number, activity: (i: number) => number | null) {
  const tmp = mkdtempSync(join(tmpdir(), 'xkeyset-'));
  const { db } = await openStore({ file: join(tmp, 'xaibo.db'), backupDir: join(tmp, 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  const ins = db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id, cwd, last_activity) VALUES ('claude', 'p1', ?, ?, ?)");
  for (let i = 1; i <= n; i++) ins.run(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `/tmp/xaibo-fixture/${i}`, activity(i));
  return db;
}

function all(db: Awaited<ReturnType<typeof store>>, limit: number) {
  const seen: number[] = [];
  let cursor = null;
  for (let guard = 0; guard < 1000; guard++) {
    const page = listSessions(db, cursor, limit);
    seen.push(...page.rows.map((r) => r.id));
    if (!page.next) return seen;
    assert.notDeepEqual(page.next, cursor, 'the cursor progresses');
    cursor = page.next;
  }
  throw new Error('paging did not end');
}

test('pages cover every session once, in order, through ties and unknown activity', async () => {
  const db = await store(23, (i) => (i % 5 === 0 ? null : Math.floor(i / 3))); // many ties, some NULL
  const expected = (db.prepare('SELECT id FROM sessions ORDER BY last_activity IS NULL, last_activity DESC, id').all() as { id: number }[]).map((x) => x.id);
  for (const limit of [1, 2, 7, 23, 50]) assert.deepEqual(all(db, limit), expected, `limit ${limit}`);
});

test('default and cap: invalid limits clamp; the hard cap is 100', async () => {
  const db = await store(130, (i) => i);
  assert.equal(PAGE_DEFAULT, 50);
  assert.equal(PAGE_MAX, 100);
  assert.equal(listSessions(db, null, 1000).rows.length, 100);
  assert.equal(listSessions(db, null, 0).rows.length, 50);
  assert.equal(listSessions(db, null, Number.NaN).rows.length, 50);
  assert.equal(listSessions(db, null, 130).next !== null, true);
});

test('rows carry the list columns and coverage markers', async () => {
  const db = await store(2, (i) => i);
  db.prepare("UPDATE sessions SET drift = 1, quarantined_count = 3, entrypoint = 'cli' WHERE id = 1").run();
  db.prepare("INSERT INTO source_files (profile_id, session_id, path, kind, status) VALUES ('p1', 2, '/tmp/xaibo-fixture/z.jsonl.zst', 'transcript', 'compressed_not_imported')").run();
  const { rows } = listSessions(db, null, 10);
  assert.deepEqual(rows, [
    { id: 2, agent: 'claude', entrypoint: null, cwd: '/tmp/xaibo-fixture/2', title: null, lastActivity: 2, drift: false, compressed: true, quarantined: 0 },
    { id: 1, agent: 'claude', entrypoint: 'cli', cwd: '/tmp/xaibo-fixture/1', title: null, lastActivity: 1, drift: true, compressed: false, quarantined: 3 },
  ]);
  assert.deepEqual(sessionsByKey(db, [{ agent: 'claude', profileId: 'p1', nativeSessionId: '00000000-0000-4000-8000-000000000001' }]).map((r) => r.id), [1]);
});

test('answer() returns a valid page message; a store without tables answers an empty page', async () => {
  const db = await store(3, (i) => i);
  const msg = answer(db, { v: 1, type: 'listSessions', id: 4, cursor: null, limit: 2 });
  assert.deepEqual(parsePortMessage(msg), msg);
  assert.equal(msg.rows.length, 2);
  db.exec('DROP TABLE source_files');
  assert.deepEqual(answer(db, { v: 1, type: 'listSessions', id: 5, cursor: null, limit: 2 }), { v: 1, type: 'page', id: 5, rows: [], next: null });
});

test('coalesce: one flush per window with each key once', () => {
  const timers: (() => void)[] = [];
  const flushed: string[][] = [];
  const add = coalesce((keys) => flushed.push(keys), 250, (fn, ms) => { assert.equal(ms, 250); timers.push(fn); });
  add('a'); add('b'); add('a');
  assert.equal(timers.length, 1);
  timers.shift()!();
  add('c');
  timers.shift()!();
  assert.deepEqual(flushed, [['a', 'b'], ['c']]);
});
