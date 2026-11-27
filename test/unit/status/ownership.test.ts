// XAIBO-PROD-618 (P7-T06; FR-23, design §3.2 and §6.9): the ownership badge state. Observation never grants control: only
// authoritative, live and fresh control held by this Xaibo is "Controlled here"; launch origin, stale or unknown authority never
// is (EC-76 stale case); Detached only on authoritative evidence; a provisional launch row has no ownership yet; every other
// session, including one Xaibo launched in an external terminal, is "Observed externally".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABOUT_OWNERSHIP, canControl, ownership, OWNERSHIP_TEXT } from '../../../src/service/status/ownership.ts';

test('never controlled from launch origin, stale or unknown authority; only live, fresh control held here', () => {
  assert.equal(ownership({}), 'observed-externally');
  assert.equal(ownership({ launchOrigin: 'xaibo-terminal' }), 'observed-externally', 'a launch from Xaibo into Terminal');
  assert.equal(ownership({ launchOrigin: 'xaibo-terminal', control: { holder: 'this-xaibo', live: true, fresh: false } }), 'observed-externally', 'stale authority');
  assert.equal(ownership({ control: { holder: 'this-xaibo', live: false, fresh: true } }), 'observed-externally', 'the holder is gone');
  assert.equal(ownership({ control: { holder: 'other', live: true, fresh: true } }), 'observed-externally');
  assert.equal(ownership({ control: { holder: 'this-xaibo', live: true, fresh: true } }), 'controlled-here');
  assert.equal(ownership({ detached: { authoritative: false } }), 'observed-externally', 'non-authoritative detached evidence is not ownership');
  assert.equal(ownership({ control: { holder: 'this-xaibo', live: true, fresh: true }, detached: { authoritative: true } }), 'detached', 'review LOW: contradictory evidence fails closed');
  assert.equal(ownership({ detached: { authoritative: true } }), 'detached');
  assert.equal(ownership({ provisional: true, control: { holder: 'this-xaibo', live: true, fresh: true } }), 'unavailable', 'not yet a session');
  assert.deepEqual((['observed-externally', 'controlled-here', 'detached', 'unavailable'] as const).filter(canControl), ['controlled-here']);
});

test('badge and explanation texts follow the design', () => {
  assert.deepEqual(OWNERSHIP_TEXT, { 'observed-externally': 'Observed externally', 'controlled-here': 'Controlled here', detached: 'Ownership: Detached', unavailable: 'Ownership unavailable — awaiting session evidence' });
  assert.equal(ABOUT_OWNERSHIP, 'Observation does not grant control. Sessions opened in an external terminal are observed externally, including launches from Xaibo.');
});
