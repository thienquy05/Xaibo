// XAIBO-PROD-600 (P6-T12 slice 2; D-P6-21; plan and security review .handoff/p6-t12-slice2-plan.md): main's native confirmation
// of a real-class apply. One flow at a time (taken before any await); the service's offer must match the ask (kind, preview
// id); it becomes a native warning dialog (Cancel first and default, every value quoted and escaped, a size budget refused,
// never cut); only the apply button sends applyConfirm with the offer's binding, not within 750 ms of the dialog opening, and
// only while that flow is current; a restart answers unavailable, or unknown once the confirm was sent. Parsers: exact keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDialog, applyFlow, type ApplyDeps } from '../../src/main/apply-confirm.ts';
import { parseApplyAsk, parsePortRequest, parseServiceCommand, parseServiceEvent, type ApplyOffer, type ServiceCommand, type ServiceEvent } from '../../src/shared/ipc.ts';

const PID = '00000000-0000-4000-8000-0000000a9901';
const FILE = '/tmp/xaibo-fixture/home/.codex/hooks.json';
const OFFER: ApplyOffer = { kind: 'connect', previewId: PID, items: [['agent', 'codex'], ['folder', '/tmp/xaibo-fixture/home/.codex'], ['file', FILE], ['change', 'codex-hooks: modify']], binding: 'b'.repeat(64) };
const q = (s: string) => JSON.stringify(s);
const BS = String.fromCharCode(92), RLO = String.fromCodePoint(0x202e);

test('the dialog: warning, Cancel first and default, each item as a quoted line, the edit sentence in the message and last', () => {
  const d = applyDialog(OFFER)!;
  assert.deepEqual([d.type, d.buttons, d.defaultId, d.cancelId, d.noLink], ['warning', ['Cancel', 'Apply'], 0, 0, true]);
  const lines = d.detail.split('\n');
  for (const l of ['Agent: ' + q('codex'), 'Profile folder: ' + q('/tmp/xaibo-fixture/home/.codex'), 'File: ' + q(FILE), 'Change: ' + q('codex-hooks: modify')]) assert.ok(lines.includes(l), l);
  assert.ok(d.message.includes("Xaibo will change this agent's own configuration files."));
  assert.equal(lines.at(-1), "Xaibo will change this agent's own configuration files.");
  assert.deepEqual(applyDialog({ ...OFFER, kind: 'removal' })!.buttons, ['Cancel', 'Disconnect']);
  assert.deepEqual(applyDialog({ ...OFFER, kind: 'cleanup' })!.buttons, ['Cancel', 'Clean up']);
  assert.equal(applyDialog({ ...OFFER, items: [['file', 'a' + RLO + 'b\nc']] })!.detail.split('\n')[0], 'File: "a' + BS + 'u{202E}b' + BS + 'nc"', 'escaped, one line');
  assert.equal(applyDialog({ ...OFFER, items: Array.from({ length: 64 }, () => ['file', 'x'.repeat(200)] as [string, string]) as ApplyOffer['items'] }), null, 'over budget: refused, never cut');
});

function harness() {
  const sent: ServiceCommand[] = [];
  let t = 0, timers: (() => void)[] = [];
  let answer: (v: boolean) => void = () => {};
  const deps: ApplyDeps = {
    confirm: () => new Promise<boolean>((r) => { answer = r; }),
    send: (c) => { sent.push(c); },
    setTimer: (fn) => { timers.push(fn); return timers.length - 1; },
    clearTimer: () => {},
    now: () => t,
  };
  const flow = applyFlow(deps);
  const id = (i: number) => (sent[i] as { id: number }).id;
  const ev = (i: number, result: unknown) => flow.receive({ v: 1, type: 'apply', id: id(i), result } as Extract<ServiceEvent, { type: 'apply' }>);
  return { sent, flow, ev, click: (yes: boolean, after = 1000) => { t += after; answer(yes); }, tick: () => new Promise((r) => setImmediate(r)), fire: () => { const f = timers; timers = []; f.forEach((x) => x()); } };
}

test('flow: offer, dialog, apply button: only then applyConfirm with the binding; the reply goes back', async () => {
  const h = harness();
  const out = h.flow.ask({ kind: 'connect', previewId: PID });
  await h.tick();
  assert.deepEqual(h.sent[0], { v: 1, type: 'applyOffer', id: (h.sent[0] as { id: number }).id, ask: { kind: 'connect', previewId: PID } });
  h.ev(0, { status: 'offer', offer: OFFER });
  await h.tick();
  h.click(true);
  await h.tick();
  assert.deepEqual(h.sent[1], { v: 1, type: 'applyConfirm', id: (h.sent[1] as { id: number }).id, ask: { kind: 'connect', previewId: PID }, binding: OFFER.binding });
  const reply = { status: 'applied', entries: [], trustSteps: [] };
  h.ev(1, { status: 'done', kind: 'connect', reply });
  assert.deepEqual(await out, { status: 'done', kind: 'connect', reply });
});

test('flow: Cancel and an early click send no confirm; a mismatched offer is refused; one flow at a time', async () => {
  for (const [yes, after] of [[false, 1000], [true, 100]] as const) {
    const h = harness();
    const out = h.flow.ask({ kind: 'connect', previewId: PID });
    await h.tick();
    h.ev(0, { status: 'offer', offer: OFFER });
    await h.tick();
    h.click(yes, after);
    assert.deepEqual(await out, { status: 'cancelled' });
    assert.equal(h.sent.length, 1);
  }
  const h = harness();
  const out = h.flow.ask({ kind: 'removal', previewId: PID });
  assert.deepEqual(await h.flow.ask({ kind: 'connect', previewId: PID }), { status: 'refused', code: 'busy' });
  await h.tick();
  h.ev(0, { status: 'offer', offer: OFFER }); // a connect offer for a removal ask
  assert.deepEqual(await out, { status: 'refused', code: 'failed' });
});

test('flow: a restart answers unavailable before the confirm and unknown after it; a lost reply too', async () => {
  const a = harness();
  const out = a.flow.ask({ kind: 'connect', previewId: PID });
  await a.tick();
  a.flow.reset();
  assert.deepEqual(await out, { status: 'refused', code: 'unavailable' });
  const b = harness();
  const out2 = b.flow.ask({ kind: 'connect', previewId: PID });
  await b.tick();
  b.ev(0, { status: 'offer', offer: OFFER });
  await b.tick();
  b.click(true);
  await b.tick();
  b.flow.reset();
  assert.deepEqual(await out2, { status: 'refused', code: 'unknown' });
  const c = harness();
  const out3 = c.flow.ask({ kind: 'connect', previewId: PID });
  await c.tick();
  c.ev(0, { status: 'offer', offer: OFFER });
  await c.tick();
  c.click(true);
  await c.tick();
  c.fire();
  assert.deepEqual(await out3, { status: 'refused', code: 'unknown' });
});

test('flow (code review): a done reply of another kind, an oversize offer and a lost offer are refused; a late reply is ignored', async () => {
  const h = harness();
  const out = h.flow.ask({ kind: 'connect', previewId: PID });
  await h.tick();
  h.ev(0, { status: 'offer', offer: OFFER });
  await h.tick();
  h.click(true);
  await h.tick();
  const removed = { status: 'disconnected', reverted: [], conflicts: [], remaining: [] };
  h.ev(1, { status: 'done', kind: 'removal', reply: removed });
  assert.deepEqual(await out, { status: 'refused', code: 'failed' });
  h.ev(1, { status: 'done', kind: 'connect', reply: { status: 'applied', entries: [], trustSteps: [] } }); // late: ignored
  const o = harness();
  const out2 = o.flow.ask({ kind: 'connect', previewId: PID });
  await o.tick();
  o.ev(0, { status: 'offer', offer: { ...OFFER, items: Array.from({ length: 64 }, () => ['file', 'x'.repeat(200)]) } });
  assert.deepEqual(await out2, { status: 'refused', code: 'oversize' });
  assert.equal(o.sent.length, 1, 'no confirm');
  const t = harness();
  const out3 = t.flow.ask({ kind: 'connect', previewId: PID });
  await t.tick();
  t.fire();
  assert.deepEqual(await out3, { status: 'refused', code: 'unavailable' });
});

test('parsers: exact keys, a UUID preview id, a 64-hex binding; the renderer port has neither command', () => {
  assert.deepEqual(parseApplyAsk({ kind: 'connect', previewId: PID }), { kind: 'connect', previewId: PID });
  for (const bad of [{ kind: 'connect', previewId: PID, confirmed: true }, { kind: 'apply', previewId: PID }, { kind: 'connect', previewId: 'x' }]) assert.equal(parseApplyAsk(bad), null);
  const ok = parseServiceCommand({ v: 1, type: 'applyConfirm', id: 3, ask: { kind: 'removal', previewId: PID }, binding: 'a'.repeat(64) });
  assert.deepEqual(ok, { v: 1, type: 'applyConfirm', id: 3, ask: { kind: 'removal', previewId: PID }, binding: 'a'.repeat(64) });
  assert.equal(parseServiceCommand({ v: 1, type: 'applyConfirm', id: 3, ask: { kind: 'removal', previewId: PID }, binding: 'a'.repeat(63) }), null);
  assert.equal(parseServiceCommand({ v: 1, type: 'applyOffer', id: 3, ask: { kind: 'removal', previewId: PID }, extra: 1 }), null);
  assert.equal(parsePortRequest({ v: 1, type: 'applyOffer', id: 3, ask: { kind: 'removal', previewId: PID } }), null);
  assert.equal(parsePortRequest({ v: 1, type: 'applyConfirm', id: 3, ask: { kind: 'removal', previewId: PID }, binding: 'a'.repeat(64) }), null);
  assert.ok(parseServiceEvent({ v: 1, type: 'apply', id: 3, result: { status: 'offer', offer: OFFER } }));
  assert.equal(parseServiceEvent({ v: 1, type: 'apply', id: 3, result: { status: 'offer', offer: { ...OFFER, items: [['secret', 'x']] } } }), null, 'labels from a closed set');
  assert.ok(parseServiceEvent({ v: 1, type: 'apply', id: 3, result: { status: 'done', kind: 'connect', reply: { status: 'refused', code: 'needs-preview' } } }));
});

// XAIBO-PROD-613: the Clear stale lock confirmation (design texts); the kind round-trips the parsers
test('lock-clear: its own question, button and closing sentence; the ask and the outcome parse', () => {
  const d = applyDialog({ kind: 'lock-clear', previewId: PID, items: [['scope', 'Every integration in this Xaibo data folder'], ['file', '/tmp/xaibo-fixture/data/integrations/operation.lock']], binding: 'c'.repeat(64) })!;
  assert.deepEqual([d.type, d.title, d.buttons, d.defaultId, d.cancelId], ['warning', 'Clear a stale lock', ['Cancel', 'Clear lock'], 0, 0]);
  const last = 'This affects all integrations in this Xaibo data folder. Xaibo will check for unfinished changes afterward. Agent configuration, records and backups are kept.';
  assert.equal(d.message, `Clear this stale integration lock?\n\n${last}`);
  assert.equal(d.detail.split('\n').at(-1), last);
  assert.deepEqual(parseApplyAsk({ kind: 'lock-clear', previewId: PID }), { kind: 'lock-clear', previewId: PID });
  assert.deepEqual(parseServiceEvent({ v: 1, type: 'apply', id: 1, result: { status: 'done', kind: 'lock-clear', reply: { status: 'cleared' } } }), { v: 1, type: 'apply', id: 1, result: { status: 'done', kind: 'lock-clear', reply: { status: 'cleared' } } });
  assert.deepEqual(parseServiceEvent({ v: 1, type: 'apply', id: 1, result: { status: 'done', kind: 'lock-clear', reply: { status: 'refused', code: 'lock-changed' } } }), { v: 1, type: 'apply', id: 1, result: { status: 'done', kind: 'lock-clear', reply: { status: 'refused', code: 'lock-changed' } } });
  assert.equal(parseServiceEvent({ v: 1, type: 'apply', id: 1, result: { status: 'done', kind: 'lock-clear', reply: { status: 'applied' } } }), null);
});
