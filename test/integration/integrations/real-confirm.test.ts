// XAIBO-PROD-600 (P6-T12 slice 2; D-P6-21; plan and security review .handoff/p6-t12-slice2-plan.md): a real-class apply only
// through main's native confirmation. A renderer-port apply of a real-class preview (decided at preview and again at apply)
// is refused needs-confirmation before the preview is consumed, writing nothing; main's applyOffer returns the dialog items
// and an HMAC binding over them and the held preview; applyConfirm re-derives it and applies through the existing rechecks.
// Synthetic HOME as in real-profile.test.ts (its agent folders are the denylist and the real roots); realProfiles on.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnect, type ConnectContext } from '../../../src/service/integrations/connect.ts';
import { answerApply, answerIntegrations, type IntegrationsDeps } from '../../../src/service/integrations-ipc.ts';
import { claudeContext } from '../../helpers/fake-claude.ts';
import type { Profile } from '../../../src/service/catalog/detect.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { chmodSync(d, 0o700); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });
const iso = mkdtempSync(join(tmpdir(), 'xconfirm-env-'));
dirs.push(iso);
for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR']) process.env[k] = join(iso, k.toLowerCase());

const sha = (f: string) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'absent');
const CLAUDE = `${JSON.stringify({ cleanupPeriodDays: 10 }, null, 2)}\n`;
const CODEX = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-notify' }] }] } }, null, 2)}\n`;
const CLAUDE_ID = '00000000-0000-4000-8000-0000000c1a01', CODEX_ID = '00000000-0000-4000-8000-0000000c0d01', DISP_ID = '00000000-0000-4000-8000-0000000d1501';

async function world() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xconfirm-')));
  dirs.push(base);
  const home = join(base, 'home'), disp = join(base, 'disp'), managed = join(base, 'managed'), helpers = join(base, 'helpers'), dataDir = join(base, 'data');
  const claudeDir = join(home, '.claude'), codexDir = join(home, '.codex'), dispCodex = join(disp, '.codex');
  for (const d of [claudeDir, codexDir, dispCodex, managed, helpers, dataDir]) mkdirSync(d, { recursive: true, mode: 0o755 });
  chmodSync(disp, 0o700);
  const files = { claude: join(claudeDir, 'settings.json'), codex: join(codexDir, 'hooks.json'), disp: join(dispCodex, 'hooks.json') };
  writeFileSync(files.claude, CLAUDE);
  writeFileSync(files.codex, CODEX);
  writeFileSync(files.disp, CODEX);
  for (const h of ['xaibo-hook', 'xaibo-report', 'xaibo-forwarder', 'xaibo-statusline']) writeFileSync(join(helpers, h), '#!/bin/sh\nexit 0\n');
  const clock = { t: 1_000 };
  const ctx: ConnectContext = { ...await claudeContext(), dataDir, denied: ['.claude', '.codex', '.gemini', '.claude.json'].map((n) => join(home, n)), allowed: [disp],
    claudeManagedDir: managed, now: () => clock.t, realProfiles: true,
    realRoots: { claude: [claudeDir], codex: [codexDir], gemini: [join(home, '.gemini')], agy: [join(home, '.gemini')] },
    helpers: { hook: join(helpers, 'xaibo-hook'), forwarder: join(helpers, 'xaibo-forwarder'), statusline: join(helpers, 'xaibo-statusline') } };
  const live = { profiles: [
    { id: CLAUDE_ID, agent: 'claude', root: claudeDir, origin: 'default' },
    { id: CODEX_ID, agent: 'codex', root: codexDir, origin: 'default' },
    { id: DISP_ID, agent: 'codex', root: dispCodex, origin: 'default' },
  ] as Profile[] };
  const c = createConnect(ctx);
  const deps: IntegrationsDeps = { readOnly: false, connect: () => c, profile: (id) => live.profiles.find((p) => p.id === id), profiles: () => live.profiles };
  return { base, home, disp, dataDir, files, clock, live, c, deps };
}
type W = Awaited<ReturnType<typeof world>>;
type R = { status: string; [k: string]: unknown };
const A = {};
const port = async (w: W, m: object): Promise<R> => ((await answerIntegrations(w.deps, { v: 1, id: 7, ...m } as never, A)) as unknown as { result: R }).result;
const offer = (w: W, kind: string, previewId: unknown) => answerApply(w.deps, { type: 'applyOffer', ask: { kind, previewId } } as never) as Promise<R>;
const confirm = (w: W, kind: string, previewId: unknown, binding: string) => answerApply(w.deps, { type: 'applyConfirm', ask: { kind, previewId }, binding } as never) as Promise<R>;
const manifestSha = (w: W) => sha(join(w.dataDir, 'integrations', 'manifest.json'));
const items = (r: R) => ((r['offer'] as { items: [string, string][] }).items);
const binding = (r: R) => (r['offer'] as { binding: string }).binding;

async function connectReal(w: W, profileId: string, selections = { retention: false, tee: false }) {
  const pv = await port(w, { type: 'connectPreview', profileId, selections });
  assert.equal(pv.status, 'preview', JSON.stringify(pv));
  const o = await offer(w, 'connect', pv['previewId']);
  assert.equal(o.status, 'offer', JSON.stringify(o));
  const r = await confirm(w, 'connect', pv['previewId'], binding(o));
  assert.equal(r.status, 'done', JSON.stringify(r));
  return r;
}

test('a renderer-port apply of a real-class Connect preview is refused needs-confirmation, writes nothing and keeps the preview', async () => {
  const w = await world();
  const before = [sha(w.files.codex), manifestSha(w)];
  const pv = await port(w, { type: 'connectPreview', profileId: CODEX_ID, selections: { retention: false, tee: false } });
  assert.equal(pv.status, 'preview');
  assert.deepEqual(await port(w, { type: 'connectApply', previewId: pv['previewId'] }), { status: 'refused', code: 'needs-confirmation' });
  assert.deepEqual([sha(w.files.codex), manifestSha(w)], before);
  assert.equal((await offer(w, 'connect', pv['previewId'])).status, 'offer', 'not consumed');
});

test('applyOffer names the agent, profile, folder, file and change, the helper, retention and tee; applyConfirm applies once', async () => {
  const w = await world();
  const pv = await port(w, { type: 'connectPreview', profileId: CLAUDE_ID, selections: { retention: true, tee: true } });
  const o = await offer(w, 'connect', pv['previewId']);
  assert.equal(o.status, 'offer', JSON.stringify(o));
  const it = items(o);
  for (const want of [['agent', 'claude'], ['profile', CLAUDE_ID], ['folder', w.live.profiles[0]!.root], ['file', w.files.claude], ['tee', 'on']]) {
    assert.ok(it.some(([l, v]) => l === want[0] && v === want[1]), JSON.stringify(want));
  }
  assert.ok(it.some(([l, v]) => l === 'retention' && v.includes('10')), 'retention from');
  assert.ok(it.some(([l]) => l === 'change'));
  assert.ok(it.some(([l, v]) => l === 'helper' && v.endsWith('xaibo-hook')));
  // code review 1: each value written is shown (pointer = JSON value), the hook command included
  assert.ok(it.some(([l, v]) => l === 'value' && v.startsWith('/hooks/') && v.includes('xaibo-hook')), JSON.stringify(it.filter(([l]) => l === 'value')));
  assert.ok(it.some(([l, v]) => l === 'value' && /^\/cleanupPeriodDays = \d+$/.test(v)), 'the retention value');
  assert.match(binding(o), /^[0-9a-f]{64}$/);
  const r = await confirm(w, 'connect', pv['previewId'], binding(o));
  assert.equal(r.status, 'done', JSON.stringify(r));
  assert.equal(r['kind'], 'connect');
  assert.equal((r['reply'] as R).status, 'applied');
  assert.notEqual(readFileSync(w.files.claude, 'utf8'), CLAUDE);
  assert.deepEqual(await confirm(w, 'connect', pv['previewId'], binding(o)), { status: 'refused', code: 'preview-invalid' }, 'single use');
});

test('a wrong binding, an expired preview, a dropped owner or an evicted preview write nothing', async () => {
  const w = await world();
  const before = [sha(w.files.codex), manifestSha(w)];
  const pv = await port(w, { type: 'connectPreview', profileId: CODEX_ID, selections: { retention: false, tee: false } });
  const o = await offer(w, 'connect', pv['previewId']);
  assert.deepEqual(await confirm(w, 'connect', pv['previewId'], 'f'.repeat(64)), { status: 'refused', code: 'stale' });
  assert.deepEqual(await confirm(w, 'removal', pv['previewId'], binding(o)), { status: 'refused', code: 'preview-invalid' }, 'another kind');
  const again = await port(w, { type: 'connectPreview', profileId: CODEX_ID, selections: { retention: false, tee: false } }); // evicts the first
  assert.deepEqual(await confirm(w, 'connect', pv['previewId'], binding(o)), { status: 'refused', code: 'preview-invalid' }, 'evicted');
  const o2 = await offer(w, 'connect', again['previewId']);
  w.clock.t += 5 * 60_000 + 1;
  assert.deepEqual(await confirm(w, 'connect', again['previewId'], binding(o2)), { status: 'refused', code: 'preview-expired' });
  const third = await port(w, { type: 'connectPreview', profileId: CODEX_ID, selections: { retention: false, tee: false } });
  const o3 = await offer(w, 'connect', third['previewId']);
  w.c.dropOwner(A);
  assert.deepEqual(await confirm(w, 'connect', third['previewId'], binding(o3)), { status: 'refused', code: 'preview-invalid' }, 'owner port closed');
  assert.deepEqual([sha(w.files.codex), manifestSha(w)], before);
});

test('a target changed between offer and confirm answers needs-preview and is not written', async () => {
  const w = await world();
  const pv = await port(w, { type: 'connectPreview', profileId: CODEX_ID, selections: { retention: false, tee: false } });
  const o = await offer(w, 'connect', pv['previewId']);
  const changed = CODEX.replace('other-notify', 'owner-edit');
  writeFileSync(w.files.codex, changed);
  const r = await confirm(w, 'connect', pv['previewId'], binding(o));
  assert.equal(r.status, 'done', JSON.stringify(r));
  assert.equal((r['reply'] as R).status, 'needs-preview');
  assert.equal(readFileSync(w.files.codex, 'utf8'), changed);
});

test('disposable previews keep the port path; applyOffer refuses them not-real', async () => {
  const w = await world();
  const pv = await port(w, { type: 'connectPreview', profileId: DISP_ID, selections: { retention: false, tee: false } });
  assert.equal(pv.status, 'preview', JSON.stringify(pv));
  assert.deepEqual(await offer(w, 'connect', pv['previewId']), { status: 'refused', code: 'not-real' });
  assert.equal((await port(w, { type: 'connectApply', previewId: pv['previewId'] })).status, 'applied');
});

test('review H1: a disposable preview whose folder now resolves to a real root is refused at the port apply', async () => {
  const w = await world();
  const link = join(w.disp, 'linked');
  symlinkSync(join(w.disp, '.codex'), link);
  w.live.profiles.push({ id: '00000000-0000-4000-8000-0000000d1502', agent: 'codex', root: link, origin: 'default' });
  const pv = await port(w, { type: 'connectPreview', profileId: '00000000-0000-4000-8000-0000000d1502', selections: { retention: false, tee: false } });
  assert.equal(pv.status, 'preview', JSON.stringify(pv));
  unlinkSync(link);
  symlinkSync(join(w.home, '.codex'), link);
  const before = sha(w.files.codex);
  assert.deepEqual(await port(w, { type: 'connectApply', previewId: pv['previewId'] }), { status: 'refused', code: 'needs-confirmation' });
  assert.equal(sha(w.files.codex), before);
});

test('removal and cleanup of real entries need the confirmation too; the offer counts real entries', async () => {
  const w = await world();
  await connectReal(w, CODEX_ID);
  const connected = sha(w.files.codex);
  const rp = await port(w, { type: 'removalPreview', profileId: CODEX_ID });
  assert.equal(rp.status, 'preview', JSON.stringify(rp));
  assert.deepEqual(await port(w, { type: 'removalApply', previewId: rp['previewId'] }), { status: 'refused', code: 'needs-confirmation' });
  assert.equal(sha(w.files.codex), connected);
  const o = await offer(w, 'removal', rp['previewId']);
  assert.equal(o.status, 'offer', JSON.stringify(o));
  for (const want of [['entries', '1'], ['real-entries', '1'], ['file', w.files.codex]]) assert.ok(items(o).some(([l, v]) => l === want[0] && v === want[1]), JSON.stringify(want));
  const r = await confirm(w, 'removal', rp['previewId'], binding(o));
  assert.equal((r['reply'] as R).status, 'disconnected', JSON.stringify(r));
  assert.equal(readFileSync(w.files.codex, 'utf8'), CODEX);
  // cleanup: an entry removed outside Xaibo
  await connectReal(w, CODEX_ID);
  writeFileSync(w.files.codex, CODEX);
  const cp = await port(w, { type: 'cleanupPreview', profileId: CODEX_ID });
  assert.equal(cp.status, 'preview', JSON.stringify(cp));
  const m = manifestSha(w);
  assert.deepEqual(await port(w, { type: 'cleanupApply', previewId: cp['previewId'] }), { status: 'refused', code: 'needs-confirmation' });
  assert.equal(manifestSha(w), m);
  const co = await offer(w, 'cleanup', cp['previewId']);
  assert.ok(items(co).some(([l, v]) => l === 'records' && v === '1'), JSON.stringify(co));
  assert.equal(((await confirm(w, 'cleanup', cp['previewId'], binding(co)))['reply'] as R).status, 'cleaned');
});

test('code review: a removal target changed between offer and confirm answers needs-preview and is not written', async () => {
  const w = await world();
  await connectReal(w, CODEX_ID);
  const rp = await port(w, { type: 'removalPreview', profileId: CODEX_ID });
  const o = await offer(w, 'removal', rp['previewId']);
  const edited = readFileSync(w.files.codex, 'utf8').replace('other-notify', 'owner-edit');
  writeFileSync(w.files.codex, edited);
  const r = await confirm(w, 'removal', rp['previewId'], binding(o));
  assert.equal((r['reply'] as R).status, 'needs-preview', JSON.stringify(r));
  assert.equal(readFileSync(w.files.codex, 'utf8'), edited);
});

test('code review: answerApply always replies: read-only, starting, unavailable, and unknown after a thrown confirm', async () => {
  const w = await world();
  const ask = { kind: 'connect', previewId: CLAUDE_ID };
  assert.deepEqual(await answerApply({ ...w.deps, readOnly: true }, { type: 'applyOffer', ask } as never), { status: 'refused', code: 'read-only' });
  assert.deepEqual(await answerApply({ ...w.deps, connect: () => null }, { type: 'applyOffer', ask } as never), { status: 'refused', code: 'starting' });
  assert.deepEqual(await answerApply({ ...w.deps, connect: () => 'unavailable' }, { type: 'applyOffer', ask } as never), { status: 'refused', code: 'unavailable' });
  const throwing = { ...w.c, applyConfirmed: () => Promise.reject(new Error('boom')) };
  assert.deepEqual(await answerApply({ ...w.deps, connect: () => throwing as never }, { type: 'applyConfirm', ask, binding: 'a'.repeat(64) } as never), { status: 'refused', code: 'unknown' });
});
