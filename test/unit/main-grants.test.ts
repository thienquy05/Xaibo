// XAIBO-PROD-597 (P6-T08a slice B; D-P6-20, SEC5; security review H1-H4, M6-M9): main owns the grant confirmation. One flow
// at a time (taken before any await); a probe picks its executable first and main resolves its real path; the service's offer
// must match the request; it becomes a native warning dialog with Cancel as default, the not-a-sandbox sentence in the message
// and at the end, every untrusted string quoted and escaped, within a size budget; only the grant button sends grantConfirm,
// with the offer's binding, and only while that flow is still current. Injected dialogs, sender and timers; no Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantDialog, grantFlow, type GrantDialog } from '../../src/main/grants.ts';
import type { GrantOffer, ServiceCommand } from '../../src/shared/ipc.ts';

const SANDBOX = 'The granted program runs with your access. This grant is not a sandbox.';
const ROOT_DIR = '/tmp/xaibo-fixture/home/.synthagent', FILE = ROOT_DIR + '/bin/synthagent';
const ROOT_OFFER: GrantOffer = { action: 'root', agent: 'synthagent', name: 'Synthetic Agent', id: 'user', root: ROOT_DIR, path: ROOT_DIR, argv: null, ops: null, binding: 'b'.repeat(64) };
const PROBE_OFFER: GrantOffer = { ...ROOT_OFFER, action: 'probe', id: 'main', path: FILE, argv: [FILE, '--version'] };
const SETUP_OFFER: GrantOffer = { ...ROOT_OFFER, action: 'setup', id: null, path: ROOT_DIR + '/config.json',
  ops: [{ pointer: '/xaibo/helper', value: '<report-helper>' }, { pointer: '/xaibo/on', value: 'true' }] };
const q = (s: string) => JSON.stringify(s);
const lines = (d: GrantDialog) => d.detail.split('\n');

test('the dialogs: warning, Cancel first and default, the sentence in the message and at the end, exact entry, id and paths', () => {
  const root = grantDialog(ROOT_OFFER)!;
  assert.deepEqual([root.type, root.buttons, root.defaultId, root.cancelId], ['warning', ['Cancel', 'Approve root'], 0, 0]);
  assert.equal(root.title, 'Approve profile root');
  assert.ok(root.message.includes(SANDBOX), 'in the message');
  assert.equal(lines(root).at(-1), SANDBOX, 'and the last detail line');
  for (const line of ['Entry: ' + q('Synthetic Agent'), 'Agent ID: synthagent', 'Root ID: user', 'Folder: ' + q(ROOT_DIR), 'Approves this folder only. Executable probing and setup writes need separate grants.']) {
    assert.ok(lines(root).includes(line), line);
  }
  const probe = grantDialog(PROBE_OFFER)!;
  assert.deepEqual(probe.buttons, ['Cancel', 'Grant probe']);
  assert.equal(probe.title, 'Grant executable probe');
  for (const line of ['Binary ID: main', 'Executable: ' + q(FILE), 'In approved folder: ' + q(ROOT_DIR), 'Command: ' + JSON.stringify([FILE, '--version']),
    'Allows bounded version probes during detection and rescans. Grants no setup writes or launch permission.']) {
    assert.ok(lines(probe).includes(line), line);
  }
  const setup = grantDialog(SETUP_OFFER)!;
  assert.deepEqual(setup.buttons, ['Cancel', 'Grant setup']);
  assert.equal(setup.title, 'Grant setup writes');
  for (const line of ['File: ' + q(ROOT_DIR + '/config.json'), '  ' + q('/xaibo/helper') + ' = ' + q('<report-helper>'), '  ' + q('/xaibo/on') + ' = ' + q('true'),
    'Allows only these declared changes. Connect still shows its configuration diff and needs Apply. Nothing changes now.']) {
    assert.ok(lines(setup).includes(line), line);
  }
});

test('untrusted text is quoted and every control, format, separator and odd space shows as a code point; a long path is whole', () => {
  const d = grantDialog({ ...ROOT_OFFER, name: 'Evil\nAgent: approved\u{202E}\u{200B}\u{2028}\u{3000}' })!;
  assert.ok(lines(d).includes('Entry: "Evil\\nAgent: approved\\u{202E}\\u{200B}\\u{2028}\\u{3000}"'), d.detail);
  for (const l of lines(d)) assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{3000}]/u.test(l), 'no raw unsafe character: ' + l);
  assert.ok(!d.message.includes('Evil'), 'the question carries no untrusted text');
  const long = ROOT_DIR + '/' + 'x'.repeat(4000);
  assert.ok(grantDialog({ ...ROOT_OFFER, path: long, root: long })!.detail.includes(q(long)), 'never truncated');
  const huge = { ...SETUP_OFFER, ops: Array.from({ length: 16 }, (_, i) => ({ pointer: '/p' + i + 'x'.repeat(250), value: 'y'.repeat(256) })) };
  assert.equal(grantDialog(huge), null, 'over the budget: refused, not cut');
});

const tick = () => new Promise((r) => setImmediate(r));
function fake(o: { pick?: string | null | (() => Promise<string | null>); confirm?: boolean | (() => Promise<boolean>); real?: Record<string, string>; now?: () => number } = {}) {
  const sent: (ServiceCommand & { id: number })[] = [];
  const dialogs: GrantDialog[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let t = 0, picks = 0, clock = 0;
  const flow = grantFlow({
    pickExecutable: async () => { picks++; return typeof o.pick === 'function' ? o.pick() : o.pick === undefined ? FILE : o.pick; },
    realpath: (p) => { if (p.endsWith('/missing')) throw new Error('ENOENT'); return o.real?.[p] ?? p; },
    confirm: async (d) => { dialogs.push(d); return typeof o.confirm === 'function' ? o.confirm() : o.confirm ?? true; },
    send: (c) => { sent.push(c as ServiceCommand & { id: number }); },
    setTimer: (fn, ms) => { timers.set(++t, { fn, ms }); return t; },
    clearTimer: (id) => { timers.delete(id as number); },
    now: o.now ?? (() => (clock += 1_000)), // each look at the clock is a second later: no click is too fast
  });
  const reply = (result: unknown, id = sent.at(-1)!.id) => flow.receive({ v: 1, type: 'grant', id, result } as never);
  return { flow, sent, dialogs, timers, reply, picks: () => picks };
}
const ROOT_ASK = { action: 'root', agent: 'synthagent', root: 'user' } as const;
const PROBE_ASK = { action: 'probe', agent: 'synthagent', binary: 'main' } as const;

test('approve: offer, dialog, then grantConfirm with exactly the offer binding; no timer left', async () => {
  const f = fake();
  const p = f.flow.ask(ROOT_ASK);
  await tick();
  assert.deepEqual(f.sent, [{ v: 1, type: 'grantOffer', id: f.sent[0]!.id, request: ROOT_ASK }]);
  f.reply({ status: 'granted' }); // a confirm-shaped reply in the offer phase: ignored
  f.reply({ status: 'offer', offer: ROOT_OFFER });
  await tick();
  assert.equal(f.dialogs.length, 1);
  assert.deepEqual(f.sent[1], { v: 1, type: 'grantConfirm', id: f.sent[1]!.id, request: ROOT_ASK, binding: ROOT_OFFER.binding });
  assert.notEqual(f.sent[1]!.id, f.sent[0]!.id);
  f.reply({ status: 'granted' });
  assert.deepEqual(await p, { status: 'granted' });
  assert.equal(f.timers.size, 0);
});

test('Cancel, a cancelled picker, an unresolvable pick, a refused or oversized offer send no grantConfirm', async () => {
  const c = fake({ confirm: false });
  const p = c.flow.ask(ROOT_ASK);
  await tick();
  c.reply({ status: 'offer', offer: ROOT_OFFER });
  assert.deepEqual(await p, { status: 'cancelled' });
  assert.deepEqual(c.sent.map((m) => m.type), ['grantOffer']);

  const k = fake({ pick: null });
  assert.deepEqual(await k.flow.ask(PROBE_ASK), { status: 'cancelled' });
  assert.equal(k.sent.length, 0);
  const m = fake({ pick: ROOT_DIR + '/missing' });
  assert.deepEqual(await m.flow.ask(PROBE_ASK), { status: 'refused', code: 'executable-invalid' });
  assert.equal(m.sent.length, 0);

  const r = fake();
  const rq = r.flow.ask(ROOT_ASK);
  await tick();
  r.reply({ status: 'refused', code: 'root-unavailable' });
  assert.deepEqual(await rq, { status: 'refused', code: 'root-unavailable' });
  assert.equal(r.dialogs.length, 0);

  const o = fake();
  const oq = o.flow.ask({ action: 'setup', agent: 'synthagent' });
  await tick();
  o.reply({ status: 'offer', offer: { ...SETUP_OFFER, ops: Array.from({ length: 16 }, () => ({ pointer: '/p' + 'x'.repeat(250), value: 'y'.repeat(256) })) } });
  assert.deepEqual(await oq, { status: 'refused', code: 'oversize' });
  assert.equal(o.dialogs.length, 0);
  assert.deepEqual(o.sent.map((x) => x.type), ['grantOffer']);
});

test('a probe offers the real path of the picked file; an offer that does not match the request is refused without a dialog', async () => {
  const f = fake({ pick: ROOT_DIR + '/link', real: { [ROOT_DIR + '/link']: FILE } });
  const p = f.flow.ask(PROBE_ASK);
  await tick();
  assert.deepEqual(f.sent[0]!.type === 'grantOffer' && f.sent[0]!.request, { ...PROBE_ASK, file: FILE });
  f.reply({ status: 'offer', offer: PROBE_OFFER });
  await tick();
  assert.equal(f.dialogs.length, 1);
  f.reply({ status: 'granted' });
  assert.deepEqual(await p, { status: 'granted' });

  for (const wrong of [ROOT_OFFER, { ...PROBE_OFFER, path: ROOT_DIR + '/other' }, { ...PROBE_OFFER, agent: 'other' }, { ...PROBE_OFFER, id: 'other' }]) {
    const g = fake();
    const gq = g.flow.ask(PROBE_ASK);
    await tick();
    g.reply({ status: 'offer', offer: wrong });
    assert.deepEqual(await gq, { status: 'refused', code: 'failed' }, JSON.stringify(wrong));
    assert.equal(g.dialogs.length, 0);
  }
});

test('one flow at a time, taken before the picker opens; a restart settles it once and later events are ignored', async () => {
  const f = fake();
  const p = f.flow.ask(PROBE_ASK);
  assert.deepEqual(await f.flow.ask(ROOT_ASK), { status: 'refused', code: 'busy' }, 'busy before any await');
  await tick();
  assert.equal(f.picks(), 1, 'one picker');
  f.reply({ status: 'granted' }, 999); // another id: ignored
  f.flow.reset(); // the service restarted
  f.flow.reset();
  assert.deepEqual(await p, { status: 'refused', code: 'unavailable' });
  f.reply({ status: 'offer', offer: PROBE_OFFER }, f.sent[0]!.id); // late: ignored
  await tick();
  assert.equal(f.dialogs.length, 0);
  assert.equal(f.timers.size, 0);
});

test('a dialog that closes after its flow was settled (restart or timeout) sends nothing', async () => {
  let release: (v: boolean) => void = () => {};
  const f = fake({ confirm: () => new Promise<boolean>((r) => { release = r; }) });
  const p = f.flow.ask(ROOT_ASK);
  await tick();
  f.reply({ status: 'offer', offer: ROOT_OFFER });
  await tick();
  assert.equal(f.dialogs.length, 1, 'the dialog is open');
  f.flow.reset();
  assert.deepEqual(await p, { status: 'refused', code: 'unavailable' });
  release(true); // the owner clicks Approve on the stale dialog
  await tick();
  assert.deepEqual(f.sent.map((m) => m.type), ['grantOffer'], 'no grantConfirm');
  const again = f.flow.ask(ROOT_ASK);
  await tick();
  assert.equal(f.sent.length, 2, 'free again');
  f.reply({ status: 'refused', code: 'not-found' });
  assert.deepEqual(await again, { status: 'refused', code: 'not-found' });
});

test('a lost offer reply answers unavailable; a lost confirm reply answers unknown (the grant may have been written)', async () => {
  const g = fake();
  const q1 = g.flow.ask(ROOT_ASK);
  await tick();
  assert.equal(g.timers.size, 1);
  [...g.timers.values()][0]!.fn();
  assert.deepEqual(await q1, { status: 'refused', code: 'unavailable' });

  const h = fake();
  const q2 = h.flow.ask(ROOT_ASK);
  await tick();
  h.reply({ status: 'offer', offer: ROOT_OFFER });
  await tick();
  assert.equal(h.timers.size, 1);
  const [timer] = [...h.timers.values()];
  assert.ok(timer!.ms >= 30_000, 'the confirm waits for the refresh scan');
  timer!.fn();
  assert.deepEqual(await q2, { status: 'refused', code: 'unknown' });
  h.reply({ status: 'granted' }); // late: ignored
});

test('a stale or failed confirm is reported as refused', async () => {
  for (const code of ['stale', 'unavailable', 'failed'] as const) {
    const f = fake();
    const p = f.flow.ask({ action: 'setup', agent: 'synthagent' });
    await tick();
    f.reply({ status: 'offer', offer: SETUP_OFFER });
    await tick();
    f.reply({ status: 'refused', code });
    assert.deepEqual(await p, { status: 'refused', code });
  }
});

test('code review M: a restart after the confirm was sent answers unknown (the grant may be on disk)', async () => {
  const f = fake();
  const p = f.flow.ask(ROOT_ASK);
  await tick();
  f.reply({ status: 'offer', offer: ROOT_OFFER });
  await tick();
  assert.equal(f.sent.at(-1)!.type, 'grantConfirm');
  f.flow.reset();
  assert.deepEqual(await p, { status: 'refused', code: 'unknown' });
});

test('code review L: a grant click within 750 ms of the dialog opening counts as Cancel (no clickjacking)', async () => {
  const f = fake({ now: () => 5_000 }); // the click arrives at the same instant the dialog opened
  const p = f.flow.ask(ROOT_ASK);
  await tick();
  f.reply({ status: 'offer', offer: ROOT_OFFER });
  await tick();
  assert.deepEqual(f.sent.map((m) => m.type), ['grantOffer'], 'no grantConfirm');
  f.flow.reset(); // ends the flow either way, so a failure here never hangs the suite
  assert.deepEqual(await p, { status: 'cancelled' });
});

test('code review L: a timeout then a late reply, then a new flow that succeeds; a restart while the picker is open sends nothing', async () => {
  const f = fake();
  const p = f.flow.ask(ROOT_ASK);
  await tick();
  [...f.timers.values()][0]!.fn();
  assert.deepEqual(await p, { status: 'refused', code: 'unavailable' });
  f.reply({ status: 'offer', offer: ROOT_OFFER }, f.sent[0]!.id); // late
  const q2 = f.flow.ask(ROOT_ASK);
  await tick();
  f.reply({ status: 'offer', offer: ROOT_OFFER });
  await tick();
  f.reply({ status: 'granted' });
  assert.deepEqual(await q2, { status: 'granted' });
  assert.equal(f.dialogs.length, 1, 'only the new flow showed a dialog');

  let pick: (v: string | null) => void = () => {};
  const g = fake({ pick: () => new Promise<string | null>((r) => { pick = r; }) });
  const gq = g.flow.ask(PROBE_ASK);
  await tick();
  g.flow.reset();
  assert.deepEqual(await gq, { status: 'refused', code: 'unavailable' });
  pick(FILE);
  await tick();
  assert.equal(g.sent.length, 0, 'the late pick sends nothing');
});

test('code review L: C1 controls, private use, unassigned, lone surrogates and blank-looking letters show as code points', () => {
  const d = grantDialog({ ...ROOT_OFFER, name: 'a\u{85}b\u{E000}c\u{378}d\u{D800}e\u{3164}f\u{2800}g' })!;
  const line = lines(d).find((l) => l.startsWith('Entry: '))!;
  for (const cp of ['\\u{85}', '\\u{E000}', '\\u{378}', '\\u{3164}', '\\u{2800}']) assert.ok(line.includes(cp), cp + ' in ' + line);
  assert.ok(line.toLowerCase().includes('\\' + 'ud800'), 'the lone surrogate is escaped: ' + line);
  assert.ok(!/[\u{85}\u{E000}\u{378}\u{3164}\u{2800}]/u.test(line));
});
