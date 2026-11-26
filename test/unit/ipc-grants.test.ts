// XAIBO-PROD-597 (P6-T08a slice B; D-P6-20, SEC5): the grant wire contract. The renderer asks main with ids only; only main
// sends grantOffer/grantConfirm to the service (never the renderer port); offers and results coming back are bounded and never
// reach a renderer port; revoke is an ids-only port request; outcomes for the renderer are a closed set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGrantAsk, parseGrantOutcome, parsePortMessage, parsePortRequest, parseServiceCommand, parseServiceEvent } from '../../src/shared/ipc.ts';

const BIND = 'a'.repeat(64);
const FILE = '/tmp/xaibo-fixture/home/.synthagent/bin/synthagent';
const OFFER = { action: 'probe', agent: 'synthagent', name: 'Synthetic Agent', id: 'main', root: '/tmp/xaibo-fixture/home/.synthagent', path: FILE,
  argv: [FILE, '--version'], ops: null, binding: BIND };

test('grant asks from the renderer: ids only, exact keys; never a file, binding or confirmed flag', () => {
  for (const ok of [{ action: 'root', agent: 'synthagent', root: 'user' }, { action: 'probe', agent: 'synthagent', binary: 'main' }, { action: 'setup', agent: 'synthagent' }]) {
    assert.deepEqual(parseGrantAsk(ok), ok);
  }
  for (const bad of [{ action: 'root', agent: 'synthagent', root: 'user', confirmed: true }, { action: 'root', agent: 'synthagent', root: 'user', binding: BIND },
    { action: 'probe', agent: 'synthagent', binary: 'main', file: FILE }, { action: 'setup', agent: 'synthagent', root: 'user' }, { action: 'root', agent: 'synthagent' },
    { action: 'root', agent: 'Synth!', root: 'user' }, { action: 'root', agent: 'synthagent', root: '../x' }, { action: 'launch', agent: 'synthagent' }, null, 'root', []]) {
    assert.equal(parseGrantAsk(bad), null, JSON.stringify(bad));
  }
});

test('grantOffer and grantConfirm are main-to-service commands with a correlated id; the renderer port accepts neither', () => {
  const offer = { v: 1, type: 'grantOffer', id: 1, request: { action: 'probe', agent: 'synthagent', binary: 'main', file: FILE } };
  assert.deepEqual(parseServiceCommand(offer), offer);
  const confirm = { v: 1, type: 'grantConfirm', id: 2, request: { action: 'root', agent: 'synthagent', root: 'user' }, binding: BIND };
  assert.deepEqual(parseServiceCommand(confirm), confirm);
  for (const bad of [{ ...confirm, binding: 'z'.repeat(64) }, { ...confirm, binding: 'a'.repeat(63) }, { ...confirm, extra: 1 }, { ...confirm, id: -1 },
    { ...offer, request: { action: 'probe', agent: 'synthagent', binary: 'main', file: 'bin/synthagent' } },
    { ...offer, request: { action: 'probe', agent: 'synthagent', binary: 'main', file: '/tmp/x\u{0}y' } },
    { ...offer, request: { action: 'probe', agent: 'synthagent', binary: 'main' } }, { ...offer, request: { action: 'root', agent: 'synthagent', root: 'user', file: FILE } }]) {
    assert.equal(parseServiceCommand(bad), null, JSON.stringify(bad));
  }
  assert.equal(parsePortRequest(offer), null, 'never from the renderer port');
  assert.equal(parsePortRequest(confirm), null, 'never from the renderer port');
});

test('grant events: a bounded offer or a confirm result, main only; anything else is dropped', () => {
  const ev = (result: unknown) => ({ v: 1, type: 'grant', id: 7, result });
  assert.deepEqual(parseServiceEvent(ev({ status: 'offer', offer: OFFER })), ev({ status: 'offer', offer: OFFER }));
  const setup = { ...OFFER, action: 'setup', id: null, argv: null, path: '/tmp/xaibo-fixture/home/.synthagent/config.json', ops: [{ pointer: '/xaibo/on', value: 'true' }] };
  assert.ok(parseServiceEvent(ev({ status: 'offer', offer: setup })));
  for (const r of [{ status: 'refused', code: 'root-unavailable' }, { status: 'granted' }, { status: 'refused', code: 'stale' }]) assert.deepEqual(parseServiceEvent(ev(r)), ev(r));
  for (const bad of [{ status: 'offer', offer: { ...OFFER, name: 'x'.repeat(65) } }, { status: 'offer', offer: { ...OFFER, argv: Array(6).fill(FILE) } },
    { status: 'offer', offer: { ...setup, ops: Array(17).fill({ pointer: '/a', value: 'true' }) } }, { status: 'offer', offer: { ...setup, ops: [{ pointer: '/a', value: 'x'.repeat(257) }] } },
    { status: 'offer', offer: { ...OFFER, binding: 'x' } }, { status: 'offer', offer: { ...OFFER, path: 'relative' } }, { status: 'offer', offer: { ...OFFER, extra: 1 } },
    { status: 'refused', code: 'nope' }, { status: 'granted', extra: 1 }]) {
    assert.equal(parseServiceEvent(ev(bad)), null, JSON.stringify(bad));
  }
  assert.equal(parsePortMessage(ev({ status: 'offer', offer: OFFER })), null, 'a renderer never accepts a grant event');
});

test('grantRevoke: ids only over the renderer port; the reply is a closed set', () => {
  for (const target of [{ kind: 'root', id: 'user' }, { kind: 'probe', id: 'main' }, { kind: 'setup' }]) {
    const m = { v: 1, type: 'grantRevoke', id: 3, agent: 'synthagent', target };
    assert.deepEqual(parsePortRequest(m), m);
  }
  for (const bad of [{ target: { kind: 'setup', id: 'user' } }, { target: { kind: 'launch', id: 'x' } }, { target: { kind: 'root', id: 'user' }, path: FILE },
    { target: { kind: 'root', id: 'User!' } }, { agent: 'Synth!', target: { kind: 'setup' } }]) {
    assert.equal(parsePortRequest(Object.assign({ v: 1, type: 'grantRevoke', id: 3, agent: 'synthagent', target: { kind: 'setup' } }, bad)), null, JSON.stringify(bad));
  }
  for (const result of ['revoked', 'unchanged', 'not-found', 'unavailable']) {
    assert.deepEqual(parsePortMessage({ v: 1, type: 'grantRevoke', id: 3, result }), { v: 1, type: 'grantRevoke', id: 3, result });
  }
  assert.equal(parsePortMessage({ v: 1, type: 'grantRevoke', id: 3, result: 'deleted' }), null);
});

test('grant outcomes for the renderer: granted, cancelled or a known refusal code', () => {
  for (const ok of [{ status: 'granted' }, { status: 'cancelled' }, { status: 'refused', code: 'busy' }, { status: 'refused', code: 'stale' },
    { status: 'refused', code: 'invalid' }, { status: 'refused', code: 'unknown' }, { status: 'refused', code: 'oversize' }]) {
    assert.deepEqual(parseGrantOutcome(ok), ok);
  }
  for (const bad of [{ status: 'refused', code: 'nope' }, { status: 'granted', binding: BIND }, { status: 'offer' }, null]) assert.equal(parseGrantOutcome(bad), null, JSON.stringify(bad));
});
