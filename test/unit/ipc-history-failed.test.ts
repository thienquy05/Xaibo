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
