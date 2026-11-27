// XAIBO-PROD-619 (P7-T05; OQ-P7-3): the MVP lock is Xaibo-side only: a second Xaibo launch or resume of the same session is
// blocked while one is pending, or while a session Xaibo launched has live evidence; external clients cannot be locked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeGuard } from '../../../src/main/launch/resume.ts';

test('a second resume while one is pending is locked; ending it frees the session; live evidence locks only what Xaibo launched', () => {
  const g = resumeGuard();
  assert.equal(g.begin('s1', { liveness: 'uncertain', launchedHere: false }), 'ok');
  assert.equal(g.begin('s1', { liveness: 'uncertain', launchedHere: false }), 'locked', 'pending');
  assert.equal(g.begin('s2', { liveness: 'not-live', launchedHere: false }), 'ok', 'another session');
  g.end('s1');
  assert.equal(g.begin('s1', { liveness: 'not-live', launchedHere: false }), 'ok');
  g.end('s1');
  assert.equal(g.begin('s3', { liveness: 'live', launchedHere: true }), 'locked', 'Xaibo launched it and it is live');
  assert.equal(g.begin('s4', { liveness: 'live', launchedHere: false }), 'ok', 'external: warned, never locked');
  g.end('unknown-key'); // no throw
});
