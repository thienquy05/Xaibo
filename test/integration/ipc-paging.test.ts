// P4-T02 (FR-09, S-29, M4/M12): keyset paging stays exact while sessions are inserted between pages, and the service
// pushes live session deltas only to ports whose window is visible ("live"); a hidden window resyncs by cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub, listSessions } from '../../src/service/api.ts';
import { openStore } from '../../src/service/store/db.ts';
import { IPC_VERSION, parsePortRequest, type PortMessage } from '../../src/shared/ipc.ts';

const sid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

test('inserts between pages: every row behind the cursor is seen once, newer rows never duplicate, the cursor progresses', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xpaging-'));
  const { db } = await openStore({ file: join(tmp, 'xaibo.db'), backupDir: join(tmp, 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  const ins = db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id, cwd, last_activity) VALUES ('claude', 'p1', ?, '/tmp/xaibo-fixture/p', ?)");
  for (let i = 1; i <= 40; i++) ins.run(sid(i), 1_000 + (i % 7 === 0 ? 0 : i)); // ties at 1000
  let next = 1_000;
  const seen: number[] = [];
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const p = listSessions(db, cursor, 7);
    assert.ok(p.rows.length <= 7, 'page size bounded');
    seen.push(...p.rows.map((r) => r.id));
    if (!p.next) break;
    ins.run(sid(next++), 10_000 + page); // newer than everything: belongs before the cursor (a delta shows it)
    ins.run(sid(next++), 500 - page); // older than everything: behind the cursor, must still be paged
    assert.notDeepEqual(p.next, cursor, 'the cursor progresses');
    cursor = p.next;
  }
  assert.equal(new Set(seen).size, seen.length, 'no duplicates');
  const older = (db.prepare('SELECT id FROM sessions WHERE last_activity < 1000').all() as { id: number }[]).map((r) => r.id);
  const original = (db.prepare('SELECT id FROM sessions WHERE last_activity BETWEEN 1000 AND 1040').all() as { id: number }[]).map((r) => r.id);
  for (const id of [...original, ...older]) assert.ok(seen.includes(id), `no gap: ${id}`);
  db.close();
});

test('hub: session deltas go only to live ports; other pushes reach every port; a closed port gets nothing', () => {
  const got = { a: [] as string[], b: [] as string[] };
  const a = { postMessage: (m: PortMessage) => got.a.push(m.type) };
  const b = { postMessage: (m: PortMessage) => got.b.push(m.type) };
  const hub = createHub<typeof a>();
  hub.add(a); hub.add(b);
  assert.equal(hub.anyLive(), true);
  hub.setLive(b, false);
  hub.sessions({ v: IPC_VERSION, type: 'sessions', rows: [] });
  hub.broadcast({ v: IPC_VERSION, type: 'coverage', banners: [] });
  assert.deepEqual(got, { a: ['sessions', 'coverage'], b: ['coverage'] });
  hub.setLive(a, false);
  assert.equal(hub.anyLive(), false, 'no live window: the service can skip building deltas');
  hub.setLive(b, true);
  hub.remove(b);
  hub.sessions({ v: IPC_VERSION, type: 'sessions', rows: [] });
  assert.deepEqual(got.b, ['coverage']);
});

test('the live request is validated: boolean only', () => {
  assert.deepEqual(parsePortRequest({ v: 1, type: 'live', on: false }), { v: 1, type: 'live', on: false });
  assert.deepEqual(parsePortRequest({ v: 1, type: 'live', on: true }), { v: 1, type: 'live', on: true });
  for (const on of [1, 'true', null, undefined]) assert.equal(parsePortRequest({ v: 1, type: 'live', on }), null);
  assert.equal(parsePortRequest({ v: 1, type: 'listSessions', id: 1, cursor: null, limit: 5 })?.type, 'listSessions');
});
