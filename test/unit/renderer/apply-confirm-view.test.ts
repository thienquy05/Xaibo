// XAIBO-PROD-601 (P6-T12 slice 3; D-P6-21): when the service answers needs-confirmation to an apply, the renderer asks main for
// its native confirmation (kind and preview id only) and maps the outcome onto the dialog's reply; any other reply passes
// through and main is not asked. A malformed or thrown result is unknown (the apply may have run: reread, never retry).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmedApply, refusalText } from '../../../src/renderer/agent-map/integration-dialog.ts';
import { parseApplyOutcome, type ConnectReply } from '../../../src/shared/ipc.ts';

const PID = '00000000-0000-4000-8000-0000000a9a01';
const NEEDS: ConnectReply = { status: 'refused', code: 'needs-confirmation' };
const APPLIED: ConnectReply = { status: 'applied', entries: [], trustSteps: [] };

test('a reply other than needs-confirmation passes through; main is not asked', async () => {
  let asked = 0;
  const bridge = async () => { asked++; return { status: 'cancelled' }; };
  assert.deepEqual(await confirmedApply('connect', PID, async () => APPLIED, bridge), APPLIED);
  assert.deepEqual(await confirmedApply('removal', PID, async (): Promise<ConnectReply> => ({ status: 'refused', code: 'busy' }), bridge), { status: 'refused', code: 'busy' });
  assert.equal(asked, 0);
});

test('needs-confirmation asks main with the kind and the preview id only; the outcome maps onto the reply', async () => {
  const seen: unknown[] = [];
  const bridge = (out: unknown) => async (r: unknown) => { seen.push(r); return out; };
  assert.deepEqual(await confirmedApply('connect', PID, async () => NEEDS, bridge({ status: 'done', kind: 'connect', reply: APPLIED })), APPLIED);
  assert.deepEqual(seen[0], { kind: 'connect', previewId: PID });
  assert.deepEqual(await confirmedApply('cleanup', PID, async () => NEEDS, bridge({ status: 'cancelled' })), { status: 'refused', code: 'cancelled' });
  assert.deepEqual(await confirmedApply('removal', PID, async () => NEEDS, bridge({ status: 'refused', code: 'stale' })), { status: 'refused', code: 'stale' });
  assert.deepEqual(await confirmedApply('connect', PID, async () => NEEDS, undefined), { status: 'refused', code: 'unavailable' }, 'no bridge: nothing sent');
  assert.deepEqual(await confirmedApply('connect', PID, async () => NEEDS, bridge({ status: 'done', kind: 'connect', reply: { status: 'applied' } })), { status: 'refused', code: 'unknown' }, 'malformed');
  assert.deepEqual(await confirmedApply('connect', PID, async () => NEEDS, async () => { throw new Error('gone'); }), { status: 'refused', code: 'unknown' }, 'thrown');
  assert.deepEqual(await confirmedApply('connect', PID, async () => NEEDS, bridge({ status: 'done', kind: 'removal', reply: { status: 'disconnected', reverted: [], conflicts: [], remaining: [] } })), { status: 'refused', code: 'unknown' }, 'another kind');
});

test('parseApplyOutcome: cancelled, done through its kind parser, refused from the closed set', () => {
  assert.deepEqual(parseApplyOutcome({ status: 'cancelled' }), { status: 'cancelled' });
  assert.equal(parseApplyOutcome({ status: 'cancelled', extra: 1 }), null);
  assert.equal(parseApplyOutcome({ status: 'refused', code: 'made-up' }), null);
  assert.equal(parseApplyOutcome({ status: 'offer', offer: {} }), null, 'never an offer');
});

test('texts for the new codes', () => {
  for (const [code, text] of [
    ['unsafe-profile', "Xaibo can't change this profile safely (another agent's folder, a shared or linked folder, or a folder chosen by hand). Nothing was changed."],
    ['cancelled', 'Cancelled in the confirmation dialog. Nothing was changed. A click right as the dialog opens counts as Cancel.'],
    ['unknown', "Xaibo couldn't confirm the result; the change may have been applied. Check the panel before trying again."],
    ['stale', 'The change no longer matches what the confirmation showed. Close and open it again.'],
    ['needs-confirmation', "This change needs your confirmation in Xaibo's dialog."],
    ['oversize', 'This change is too large to show in the confirmation dialog. Nothing was changed.'],
  ] as const) assert.equal(refusalText(code), text, code);
  assert.equal(refusalText('real-profile'), "This profile isn't one of Xaibo's disposable test profiles; real-profile changes stay off until Gate 6.", 'unchanged while the flag is off');
});
