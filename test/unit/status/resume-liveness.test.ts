// XAIBO-PROD-619 (P7-T05; EC-20, EC-01): resume concurrency. Live elsewhere = recent hook activity (an active lifecycle with
// connected health in the status engine), a live process (pid, start time and executable match) or a known owner (Controlled
// here); only an ended lifecycle is not live; silence (idle, unknown, stale or detached health, no evidence) is uncertain and
// still warns, because silence does not prove the session is safe to resume. A pid alone never ends a session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeLiveness } from '../../../src/service/status/resume-liveness.ts';

test('recent hook -> live; silence -> uncertain; known owner -> live; ended -> not live', () => {
  const c = (lifecycle: string, health = 'connected') => ({ lifecycle, health }) as never;
  assert.equal(resumeLiveness({ status: c('busy') }), 'live', 'recent hook activity');
  assert.equal(resumeLiveness({ status: c('waiting-for-permission') }), 'live');
  assert.equal(resumeLiveness({ status: c('needs-input') }), 'live');
  assert.equal(resumeLiveness({ status: c('busy', 'stale') }), 'uncertain', 'the last known state, not recent activity');
  assert.equal(resumeLiveness({ status: c('idle') }), 'uncertain', 'silence');
  assert.equal(resumeLiveness({ status: c('unknown') }), 'uncertain');
  assert.equal(resumeLiveness({ status: null }), 'uncertain', 'no evidence at all');
  assert.equal(resumeLiveness({ status: c('idle'), ownership: 'controlled-here' }), 'live', 'known owner');
  assert.equal(resumeLiveness({ status: c('ended') }), 'not-live');
  assert.equal(resumeLiveness({ status: c('ended'), ownership: 'controlled-here' }), 'live', 'live control held here outranks an ended lifecycle');
});
