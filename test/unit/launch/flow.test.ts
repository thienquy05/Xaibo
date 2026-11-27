// XAIBO-PROD-623 (P7-T04 slice D; design §6.7, EC-76, EC-84, EC-85): main's launch flow. Options come from the service's launch
// info (only the default profile launches: Terminal cannot be handed a profile directory); a preview builds the exact command
// in main (P7-T02) with a pre-allocated id where the template has one; Launch takes the preview once, re-reads the launch info,
// asks for a launch grant or its renewal in a native warning dialog (Cancel default; a click within 750 ms counts as Cancel),
// opens Terminal through the spawner (P7-T03 revalidation inside) and registers the provisional row, started or failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from '../../helpers/tmp.ts';
import { launchFlow, type LaunchDialog } from '../../../src/main/launch/flow.ts';
import { parseLaunchAsk, parseLaunchReply, type LaunchAgentInfo, type ProvisionalRow } from '../../../src/shared/ipc.ts';

const UUID = '00000000-0000-4000-8000-0000000d0001';
function world(over: Partial<{ open: boolean; confirm: boolean; clickMs: number }> = {}) {
  const root = realpathSync(tempDir('xlflow-'));
  const bin = path.join(root, 'bin'); mkdirSync(bin);
  const exe = path.join(bin, 'claude');
  writeFileSync(exe, '#!/bin/sh\necho synthetic\n'); chmodSync(exe, 0o755);
  const cwd = path.join(root, 'proj dir'); mkdirSync(cwd);
  const dataDir = path.join(root, 'data'); mkdirSync(dataDir, { mode: 0o700 });
  let info: LaunchAgentInfo[] = [
    { agent: 'claude', name: 'Claude Code', version: '2.1.332', executable: exe, names: ['claude'], launch: { args: ['--session-id', '{id}'], preallocatedId: true },
      profiles: [{ id: 'p1', label: 'Default profile', default: true, envKey: null }, { id: 'p2', label: '~/alt', default: false, envKey: null },
        { id: 'p3', label: '~/env-root', default: false, envKey: 'CLAUDE_CONFIG_DIR' }] },
    { agent: 'codex', name: 'Codex', version: null, executable: null, names: ['codex'], launch: { args: [], preallocatedId: false }, profiles: [] },
    { agent: 'agy', name: 'Antigravity', version: '1.0.0', executable: exe, names: ['agy'], launch: { disabled: 'agy interactive launch not verified' }, profiles: [] },
  ];
  const dialogs: LaunchDialog[] = [], opened: string[] = [], rows: ProvisionalRow[] = [];
  let mono = 0, ids = 0;
  const flow = launchFlow({
    dataDir, info: async () => info, uuid: () => (ids++ === 0 ? UUID : `00000000-0000-4000-8000-${(0xd0001 + ids).toString(16).padStart(12, '0')}`), now: () => 5_000, mono: () => mono,
    confirm: async (d) => { dialogs.push(d); mono += over.clickMs ?? 1_000; return over.confirm ?? true; },
    spawner: { open: async (f) => { opened.push(f); return over.open ?? true; } },
    register: (r) => rows.push(r),
  });
  return { flow, exe, cwd, dataDir, dialogs, opened, rows, tick: (ms: number) => { mono += ms; }, setInfo: (f: (i: LaunchAgentInfo[]) => LaunchAgentInfo[]) => { info = f(info); } };
}

test('options: enabled agents, disabled with reasons, only the default profile launches', async () => {
  const w = world();
  assert.deepEqual(await w.flow.options(), { status: 'ok', agents: [
    { agent: 'claude', name: 'Claude Code', version: '2.1.332', disabled: null, preallocatedId: true,
      profiles: [{ id: 'p1', label: 'Default profile', disabled: null }, { id: 'p2', label: '~/alt', disabled: 'Launch from this profile is not supported yet' },
        { id: 'p3', label: '~/env-root', disabled: null }] },
    { agent: 'codex', name: 'Codex', version: null, disabled: 'Not detected', preallocatedId: false, profiles: [] },
    { agent: 'agy', name: 'Antigravity', version: '1.0.0', disabled: 'agy interactive launch not verified', preallocatedId: false, profiles: [] },
  ] });
});

test('preview: the exact quoted command and cwd from main; refusals before any write', async () => {
  const w = world();
  const p = await w.flow.preview({ agent: 'claude', profileId: 'p1', cwd: w.cwd });
  assert.equal(p.status, 'ok');
  if (p.status !== 'ok') return;
  assert.equal(p.command, `'${w.exe}' '--session-id' '${UUID}'`);
  assert.equal(p.cwd, w.cwd);
  assert.deepEqual(p.env, ['PATH', 'HOME', 'LANG', 'TERM', 'USER', 'SHELL', 'TMPDIR']);
  assert.deepEqual(await w.flow.preview({ agent: 'claude', profileId: 'p2', cwd: w.cwd }), { status: 'refused', code: 'profile' });
  const env = await w.flow.preview({ agent: 'claude', profileId: 'p3', cwd: w.cwd });
  assert.deepEqual(env.status === 'ok' && env.env.at(-1), 'CLAUDE_CONFIG_DIR', '624: an env-chosen profile passes its variable name through');
  assert.deepEqual(await w.flow.preview({ agent: 'agy', profileId: 'p1', cwd: w.cwd }), { status: 'refused', code: 'disabled' });
  assert.deepEqual(await w.flow.preview({ agent: 'codex', profileId: 'p1', cwd: w.cwd }), { status: 'refused', code: 'not-detected' });
  assert.deepEqual(await w.flow.preview({ agent: 'claude', profileId: 'p1', cwd: path.join(w.cwd, 'missing') }), { status: 'refused', code: 'cwd' });
  assert.deepEqual(await w.flow.preview({ agent: 'nope', profileId: 'p1', cwd: w.cwd }), { status: 'refused', code: 'invalid' });
  assert.deepEqual(w.opened, []);
});

test('launch: grant dialog first (cancel = nothing), then Terminal and a starting row; a preview is used once', async () => {
  const no = world({ confirm: false });
  const p0 = await no.flow.preview({ agent: 'claude', profileId: 'p1', cwd: no.cwd });
  assert.deepEqual(await no.flow.launch(p0.status === 'ok' ? p0.previewId : ''), { status: 'cancelled' });
  assert.deepEqual([no.opened, no.rows], [[], []]);
  const d = no.dialogs[0]!;
  assert.deepEqual([d.type, d.buttons, d.defaultId, d.cancelId, d.title], ['warning', ['Cancel', 'Grant launch'], 0, 0, 'Grant launch']);
  assert.match(d.detail, /Executable: ".*claude"/);
  assert.match(d.detail, /SHA-256: [0-9a-f]{12}…/);
  assert.match(d.detail, /Template: \["--session-id","\{id\}"\]/);
  assert.match(d.detail, /This grant is not a sandbox\.$/);
  assert.match(d.detail, /In: ".*proj dir"/, '623 review: the dialog names the working directory');

  const w = world();
  const p = await w.flow.preview({ agent: 'claude', profileId: 'p1', cwd: w.cwd });
  const id = p.status === 'ok' ? p.previewId : '';
  const r = await w.flow.launch(id);
  assert.equal(r.status, 'started');
  assert.equal(w.opened.length, 1);
  assert.deepEqual(w.rows, [{ key: r.status === 'started' ? r.key : '', agent: 'claude', profileId: 'p1', cwd: w.cwd, nativeId: UUID, startedAt: 5_000, state: 'starting', reason: null }]);
  w.tick(2_000);
  assert.deepEqual(await w.flow.launch(id), { status: 'refused', code: 'expired' }, 'single use');
  const p2 = await w.flow.preview({ agent: 'claude', profileId: 'p1', cwd: w.cwd });
  assert.equal((await w.flow.launch(p2.status === 'ok' ? p2.previewId : '')).status, 'started');
  assert.equal(w.dialogs.length, 1, 'granted once: no second dialog');
});

test('renewal names what changed; a too-quick click cancels; a changed launch info or a failed open', async () => {
  const w = world();
  const go = async () => { const p = await w.flow.preview({ agent: 'claude', profileId: 'p1', cwd: w.cwd }); return w.flow.launch(p.status === 'ok' ? p.previewId : ''); };
  await go();
  w.tick(2_000);
  writeFileSync(w.exe, '#!/bin/sh\necho changed\n');
  assert.equal((await go()).status, 'started');
  assert.equal(w.dialogs[1]!.title, 'Renew launch grant');
  assert.match(w.dialogs[1]!.detail, /Changed: the executable's contents/);

  const quick = world({ clickMs: 100 });
  const p = await quick.flow.preview({ agent: 'claude', profileId: 'p1', cwd: quick.cwd });
  assert.deepEqual(await quick.flow.launch(p.status === 'ok' ? p.previewId : ''), { status: 'cancelled' });

  const ch = world();
  const pc = await ch.flow.preview({ agent: 'claude', profileId: 'p1', cwd: ch.cwd });
  ch.setInfo((i) => i.map((a) => (a.agent === 'claude' ? { ...a, launch: { args: ['--other'], preallocatedId: false } } : a)));
  assert.deepEqual(await ch.flow.launch(pc.status === 'ok' ? pc.previewId : ''), { status: 'refused', code: 'changed' });

  const f = world({ open: false });
  const pf = await f.flow.preview({ agent: 'claude', profileId: 'p1', cwd: f.cwd });
  const rf = await f.flow.launch(pf.status === 'ok' ? pf.previewId : '');
  assert.equal(rf.status, 'failed');
  assert.deepEqual(f.rows.map((x) => [x.state, x.reason]), [['failed', 'open']]);
});

test('launch asks and replies parse with exact keys', () => {
  assert.deepEqual(parseLaunchAsk({ op: 'options' }), { op: 'options' });
  assert.deepEqual(parseLaunchAsk({ op: 'preview', agent: 'claude', profileId: 'p1', cwd: '/x' }), { op: 'preview', agent: 'claude', profileId: 'p1', cwd: '/x' });
  assert.deepEqual(parseLaunchAsk({ op: 'launch', previewId: UUID }), { op: 'launch', previewId: UUID });
  for (const bad of [{ op: 'launch', previewId: 'x' }, { op: 'preview', agent: 'claude', profileId: 'p1', cwd: 'rel' }, { op: 'options', extra: 1 }, { op: 'run' }])
    assert.equal(parseLaunchAsk(bad), null, JSON.stringify(bad));
  assert.deepEqual(parseLaunchReply({ status: 'started', key: UUID }), { status: 'started', key: UUID });
  assert.equal(parseLaunchReply({ status: 'started', key: UUID, argv: [] }), null);
});

test('623 reviews: one launch at a time, 2 s apart, 5 s after a cancel; expiry by time; no launch info', async () => {
  const w = world();
  const pv = async () => { const p = await w.flow.preview({ agent: 'claude', profileId: 'p1', cwd: w.cwd }); return p.status === 'ok' ? p.previewId : ''; };
  const a = await pv(), b = await pv();
  const r1 = await w.flow.launch(a);
  assert.equal(r1.status, 'started');
  assert.deepEqual(await w.flow.launch(b), { status: 'refused', code: 'busy' }, 'within 2 s of the last launch');
  w.tick(2_000);
  assert.equal((await w.flow.launch(b)).status, 'started', 'the busy refusal kept the preview');

  const c = world({ confirm: false });
  const pc = async () => { const p = await c.flow.preview({ agent: 'claude', profileId: 'p1', cwd: c.cwd }); return p.status === 'ok' ? p.previewId : ''; };
  assert.deepEqual(await c.flow.launch(await pc()), { status: 'cancelled' });
  assert.deepEqual(await c.flow.launch(await pc()), { status: 'refused', code: 'busy' }, 'cooldown after a cancel');
  c.tick(5_000);
  assert.deepEqual(await c.flow.launch(await pc()), { status: 'cancelled' });

  const e = world();
  const pe = await e.flow.preview({ agent: 'claude', profileId: 'p1', cwd: e.cwd });
  e.tick(10 * 60_000 + 1);
  assert.deepEqual(await e.flow.launch(pe.status === 'ok' ? pe.previewId : ''), { status: 'refused', code: 'expired' });

  const n = world();
  n.setInfo(() => null as unknown as LaunchAgentInfo[]);
  assert.deepEqual(await n.flow.options(), { status: 'refused', code: 'unavailable' });
});

test('624 security review: only a profile directory variable is passed through, never NODE_OPTIONS or DYLD_*', async () => {
  const w = world();
  for (const bad of ['NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV']) {
    w.setInfo((i) => i.map((a) => (a.agent === 'claude' ? { ...a, profiles: [{ id: 'p9', label: '~/x', default: false, envKey: bad }] } : a)));
    assert.deepEqual(await w.flow.preview({ agent: 'claude', profileId: 'p9', cwd: w.cwd }), { status: 'refused', code: 'profile' }, bad);
    const o = await w.flow.options();
    assert.equal(o.status === 'ok' && o.agents[0]!.profiles[0]!.disabled, 'Launch from this profile is not supported yet');
  }
});
