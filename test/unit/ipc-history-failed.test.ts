// Gate 5 G5b2-5: the history, projects and folders replies say failed when the store could not answer (a closed store or
// an SQL error), as search, map groups and markers already do, so the renderer keeps what it shows and offers Retry. The
// port parser keeps `failed: true` (only on an empty page, review L1 of search) and rejects any other value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortMessage } from '../../src/shared/ipc.ts';

const replies = [
  { v: 1, type: 'history', id: 1, rows: [], next: null },
  { v: 1, type: 'projects', id: 2, projects: [], next: null },
  { v: 1, type: 'folders', id: 3, folders: [], next: null },
] as const;

test('G5b2-5: history, projects and folders replies keep failed: true through the port parser', () => {
  for (const r of replies) {
    assert.deepEqual(parsePortMessage(r), r, `${r.type}: an ok reply without the flag`);
    assert.deepEqual(parsePortMessage({ ...r, failed: true }), { ...r, failed: true }, `${r.type}: failed is kept`);
    assert.equal(parsePortMessage({ ...r, failed: 'yes' }), null, `${r.type}: failed is true or absent`);
    assert.equal(parsePortMessage({ ...r, failed: false }), null, `${r.type}: failed: false is not a value`);
  }
  assert.equal(parsePortMessage({ v: 1, type: 'projects', id: 4, projects: [{ id: 1, name: 'Atlas' }], next: null, failed: true }), null,
    'a failed page carries nothing');
});

// Gate 5 round 3 review H1: a page of hidden matches only ends capped with next.session 0 (no visible session yet), and
// the next request sends that cursor back; both directions must survive the port parsers.
test('round 3 H1: a search key with session 0 crosses the port both ways', async () => {
  const { parsePortRequest } = await import('../../src/shared/ipc.ts');
  const key = { rank: -1.5, session: 0, event: 7 };
  const reply = { v: 1, type: 'search', id: 5, hits: [], next: key, capped: true } as const;
  assert.deepEqual(parsePortMessage(reply), reply, 'reply keeps session 0');
  const req = { v: 1, type: 'search', id: 6, query: 'x', filter: { mode: 'all', agent: null, project: null, folder: null }, cursor: key, limit: 50 } as const;
  assert.deepEqual(parsePortRequest(req), req, 'request keeps session 0');
  assert.equal(parsePortMessage({ ...reply, next: { ...key, session: -1 } }), null, 'a negative session is still rejected');
  assert.equal(parsePortMessage({ ...reply, next: { ...key, event: 0 } }), null, 'event stays positive');
});
