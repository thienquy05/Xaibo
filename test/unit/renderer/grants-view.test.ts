// XAIBO-PROD-598 (P6-T08a slice C; D-P6-20, SEC5): the grants fieldset model in agent-map/grants-view.ts. One row per declared
// item of an imported agent (profile folder, version probe, setup writes) with its state in words, the grant action main
// confirms natively (ids only) and Revoke beside stored authority; actions wait with a reason while no folder is allowed or
// none is approved; outcome texts never claim a grant that may not exist; askGrant reads main's reply strictly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GrantState } from '../../../src/shared/ipc.ts';
import { askGrant, grantRows, grantsNote, NOT_ALLOWED, outcomeText, revokeText } from '../../../src/renderer/agent-map/grants-view.ts';

const state = (o: Partial<GrantState> = {}): GrantState => ({
  roots: [{ id: 'user', state: 'none' }], probes: [{ binary: 'main', state: 'none' }], setup: null, ...o,
});

test('rows: a folder not yet approved offers Approve root; probe and setup wait for an approved folder', () => {
  const rows = grantRows('synthagent', state({ setup: { root: 'user', state: 'none' } }));
  assert.deepEqual(rows.map((r) => [r.key, r.label, r.state]), [
    ['root:user', 'Profile folder user', 'Not approved'], ['probe:main', 'Version probe main', 'Not granted'], ['setup', 'Setup writes', 'Not granted'],
  ]);
  assert.deepEqual(rows[0]!.grant, { ask: { action: 'root', agent: 'synthagent', root: 'user' }, label: 'Approve root', disabled: null });
  assert.deepEqual(rows[1]!.grant, { ask: { action: 'probe', agent: 'synthagent', binary: 'main' }, label: 'Grant probe', disabled: 'Approve a profile folder first.' });
  assert.deepEqual(rows[2]!.grant, { ask: { action: 'setup', agent: 'synthagent' }, label: 'Grant setup', disabled: 'Approve a profile folder first.' });
  assert.deepEqual(rows.map((r) => r.revoke), [null, null, null], 'nothing stored: nothing to revoke');
  assert.equal(grantsNote(state()), null);
});

test('rows: an approved folder enables probe and setup and offers Revoke; granted items offer only Revoke', () => {
  const rows = grantRows('synthagent', state({ roots: [{ id: 'user', state: 'approved' }], probes: [{ binary: 'main', state: 'granted' }, { binary: 'helper', state: 'none' }], setup: { root: 'user', state: 'none' } }));
  assert.deepEqual(rows.map((r) => r.state), ['Approved', 'Granted', 'Not granted', 'Not granted']);
  assert.equal(rows[0]!.grant, null);
  assert.deepEqual(rows[0]!.revoke, { kind: 'root', id: 'user' });
  assert.equal(rows[1]!.grant, null);
  assert.deepEqual(rows[1]!.revoke, { kind: 'probe', id: 'main' });
  assert.deepEqual(rows[2]!.grant, { ask: { action: 'probe', agent: 'synthagent', binary: 'helper' }, label: 'Grant probe', disabled: null });
  assert.deepEqual(rows[3]!.grant, { ask: { action: 'setup', agent: 'synthagent' }, label: 'Grant setup', disabled: null });
});

test('rows: setup needs its own declared folder approved, not just any folder', () => {
  const g = state({ roots: [{ id: 'user', state: 'approved' }, { id: 'work', state: 'none' }], setup: { root: 'work', state: 'none' } });
  assert.equal(grantRows('synthagent', g).find((r) => r.key === 'setup')!.grant!.disabled, 'Approve a profile folder first.');
});

test('rows: stale authority can be granted again and revoked', () => {
  const rows = grantRows('synthagent', state({ roots: [{ id: 'user', state: 'stale' }], probes: [{ binary: 'main', state: 'stale' }], setup: { root: 'user', state: 'stale' } }));
  assert.deepEqual(rows.map((r) => r.state), ['No longer matches the folder', 'No longer matches', 'No longer matches']);
  assert.deepEqual(rows.map((r) => r.revoke), [{ kind: 'root', id: 'user' }, { kind: 'probe', id: 'main' }, { kind: 'setup' }]);
  assert.equal(rows[0]!.grant!.disabled, null);
  assert.equal(rows[1]!.grant!.disabled, 'Approve a profile folder first.', 'a stale folder is not approved');
});

test('rows: no allowed folder (production) disables every grant with one reason; stored records stay revocable', () => {
  const g = state({ roots: [{ id: 'user', state: 'unavailable' }], probes: [{ binary: 'main', state: 'stale' }], setup: { root: 'user', state: 'none' } });
  const rows = grantRows('synthagent', g);
  assert.equal(rows[0]!.state, 'Unavailable');
  assert.deepEqual(rows.map((r) => r.grant?.disabled), [NOT_ALLOWED, NOT_ALLOWED, NOT_ALLOWED]);
  assert.deepEqual(rows[1]!.revoke, { kind: 'probe', id: 'main' });
  assert.equal(grantsNote(g), NOT_ALLOWED);
  assert.doesNotMatch(NOT_ALLOWED, /P6-T|\//, 'no plan-unit names or paths in the UI');
});

test('outcome texts: only granted says granted; unknown says it may have been saved; cancel and refusals say nothing was granted', () => {
  assert.equal(outcomeText('root', { status: 'granted' }), 'Profile folder approved.');
  assert.equal(outcomeText('probe', { status: 'granted' }), 'Version probe granted.');
  assert.equal(outcomeText('setup', { status: 'granted' }), 'Setup writes granted.');
  assert.equal(outcomeText('root', { status: 'cancelled' }), 'Cancelled. Nothing was granted.');
  assert.match(outcomeText('root', { status: 'refused', code: 'unknown' }), /may have been saved/);
  for (const code of ['not-found', 'root-unavailable', 'root-not-approved', 'executable-invalid', 'stale', 'unavailable', 'failed', 'invalid', 'oversize'] as const) {
    assert.match(outcomeText('probe', { status: 'refused', code }), /Nothing was granted/, code);
  }
  assert.match(outcomeText('root', { status: 'refused', code: 'busy' }), /Another grant/);
  assert.equal(revokeText('revoked'), 'Revoked.');
  assert.equal(revokeText('unchanged'), 'Nothing was stored to revoke.');
  assert.match(revokeText('not-found'), /no longer listed/);
  assert.match(revokeText('unavailable'), /unavailable/);
});

test('askGrant: ids only to main; no bridge is unavailable (nothing sent); a malformed or failed reply is unknown (reread, never retry)', async () => {
  const ask = { action: 'root', agent: 'synthagent', root: 'user' } as const;
  assert.deepEqual(await askGrant(undefined, ask), { status: 'refused', code: 'unavailable' });
  const sent: unknown[] = [];
  assert.deepEqual(await askGrant(async (r) => { sent.push(r); return { status: 'granted' }; }, ask), { status: 'granted' });
  assert.deepEqual(sent, [ask]);
  assert.deepEqual(await askGrant(async () => ({ status: 'cancelled' }), ask), { status: 'cancelled' });
  assert.deepEqual(await askGrant(async () => ({ status: 'refused', code: 'stale' }), ask), { status: 'refused', code: 'stale' });
  assert.deepEqual(await askGrant(async () => ({ status: 'granted', extra: 1 }), ask), { status: 'refused', code: 'unknown' });
  assert.deepEqual(await askGrant(async () => { throw new Error('gone'); }, ask), { status: 'refused', code: 'unknown' });
});
