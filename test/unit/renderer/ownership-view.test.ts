// XAIBO-PROD-625 (P7-T06; design §3.2, §6.9, C27): the ownership badge's view model. Each state has its design icon and exact
// words; every MVP session is Observed externally (no authoritative control or detached evidence exists yet); a provisional
// launch row is Ownership unavailable until evidence binds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNERSHIP_ICON, ownershipOf, ownershipLabel, spokenPrefix } from '../../../src/renderer/status/ownership-view.ts';
import { ICON_IDS } from '../../../src/renderer/status/icons.ts';
import type { SessionRow } from '../../../src/shared/ipc.ts';

test('ownership view: icons from the design set, exact words, sessions observed externally', () => {
  assert.deepEqual(OWNERSHIP_ICON, { 'observed-externally': 'external', 'controlled-here': 'control', detached: 'unlink', unavailable: 'unknown' });
  for (const id of Object.values(OWNERSHIP_ICON)) assert.ok(ICON_IDS.includes(id), id);
  assert.deepEqual([ownershipLabel('observed-externally'), ownershipLabel('controlled-here'), ownershipLabel('detached'), ownershipLabel('unavailable')],
    ['Observed externally', 'Controlled here', 'Ownership: Detached', 'Ownership unavailable — awaiting session evidence']);
  const row = { id: 1, agent: 'claude', live: { lifecycle: 'idle', confidence: 'confirmed', health: 'detached' } } as unknown as SessionRow;
  assert.equal(ownershipOf(row), 'observed-externally', 'health Detached never becomes ownership');
});

test('625 a11y review: every badge reads as the Ownership field (a hidden prefix where the words lack it)', () => {
  assert.deepEqual([spokenPrefix('observed-externally'), spokenPrefix('controlled-here'), spokenPrefix('detached'), spokenPrefix('unavailable')], ['Ownership: ', 'Ownership: ', '', '']);
});
