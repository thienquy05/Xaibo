// XAIBO-PROD-576 (P6-T10 unit 3; design .handoff/p6-t10-design.md R1/R4/R5 and the plan security review H1/M1/M2/L1-L5):
// previewed Disconnect, Full Uninstall and cleanup through the IPC handler on synthetic disposable Claude profiles. A
// preview writes nothing and reads no real or out-of-bounds target; apply is owner-bound and single use, and writes nothing
// when anything in scope changed (target bytes or mode, the manifest entries, the reconcile state or profile mapping),
// returning a fresh preview instead; one held preview per scope; cleanup removes only records of entries a fresh reconcile
// reports removed.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeContext } from '../../helpers/fake-claude.ts';
import { createConnect, type ConnectContext } from '../../../src/service/integrations/connect.ts';
import { afterDispatch, answerIntegrations, type IntegrationsDeps } from '../../../src/service/integrations-ipc.ts';
import { parsePortMessage, type PortMessage } from '../../../src/shared/ipc.ts';
import type { Profile } from '../../../src/service/catalog/detect.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { chmodSync(d, 0o700); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });
const iso = mkdtempSync(join(tmpdir(), 'xrm-env-'));
dirs.push(iso);
for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR']) process.env[k] = join(iso, k.toLowerCase());

const P1 = '00000000-0000-4000-8000-0000000c7601', P2 = '00000000-0000-4000-8000-0000000c7602', NONE = '00000000-0000-4000-8000-0000000c76ff';
const ORIGINAL = '{\n  "cleanupPeriodDays": 10\n}\n';
async function world() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xrm-')));
  dirs.push(base);
  const helpers = join(base, 'helpers'), managed = join(base, 'managed'), dataDir = join(base, 'data');
  const roots = [join(base, 'a', '.claude'), join(base, 'b', '.claude')];
  for (const d of [...roots, helpers, managed, dataDir]) mkdirSync(d, { recursive: true, mode: 0o755 });
  for (const r of roots) writeFileSync(join(r, 'settings.json'), ORIGINAL);
  for (const h of ['xaibo-hook', 'xaibo-report', 'xaibo-forwarder', 'xaibo-statusline']) writeFileSync(join(helpers, h), '#!/bin/sh\nexit 0\n');
  const ctx: ConnectContext = { dataDir, denied: [join(base, 'real')], allowed: [base], claudeManagedDir: managed, ...await claudeContext(),
    helpers: { hook: join(helpers, 'xaibo-hook'), forwarder: join(helpers, 'xaibo-forwarder'), statusline: join(helpers, 'xaibo-statusline') } };
  const profiles: Profile[] = [{ id: P1, agent: 'claude', root: roots[0]!, origin: 'default' }, { id: P2, agent: 'claude', root: roots[1]!, origin: 'manual' }];
  const c = createConnect(ctx);
  const live = { profiles };
  const deps: IntegrationsDeps = { readOnly: false, connect: () => c, profile: (id) => live.profiles.find((p) => p.id === id), profiles: () => live.profiles };
  return { base, dataDir, deps, c, live, file: (i: number) => join(roots[i]!, 'settings.json') };
}
type R = { status: string; [k: string]: unknown };
async function ask(deps: IntegrationsDeps, m: object, owner: object): Promise<R> {
  const out = await answerIntegrations(deps, { v: 1, id: 9, ...m } as never, owner) as PortMessage & { result: R };
  assert.ok(parsePortMessage(out), `parsePortMessage accepts ${JSON.stringify(out).slice(0, 200)}`);
  return out.result;
}
const A = {}, B = {};
async function connect(w: Awaited<ReturnType<typeof world>>, profileId: string) {
  const pv = await ask(w.deps, { type: 'connectPreview', profileId, selections: { retention: true, tee: false } }, A);
  assert.equal((await ask(w.deps, { type: 'connectApply', previewId: pv['previewId'] }, A)).status, 'applied');
}
const manifest = (w: { dataDir: string }) => JSON.parse(readFileSync(join(w.dataDir, 'integrations', 'manifest.json'), 'utf8')) as { v: number; entries: { id: string; target: string; route: string }[] };

test('Disconnect: a preview writes nothing and names each entry; apply reverts that profile only; single use', async () => {
  const w = await world();
  await connect(w, P1);
  await connect(w, P2);
  const before = [readFileSync(w.file(0), 'utf8'), readFileSync(w.file(1), 'utf8'), readFileSync(join(w.dataDir, 'integrations', 'manifest.json'), 'utf8')];
  const pv = await ask(w.deps, { type: 'removalPreview', profileId: P1 }, A);
  assert.equal(pv.status, 'preview');
  assert.equal(pv['profileId'], P1);
  const items = pv['items'] as { entry: string; route: string; profileId: string | null; state: string; reason: string | null }[];
  assert.ok(items.length >= 2, 'hooks and retention');
  assert.ok(items.every((x) => x.profileId === P1 && x.state === 'connected' && x.reason === null));
  assert.deepEqual([readFileSync(w.file(0), 'utf8'), readFileSync(w.file(1), 'utf8'), readFileSync(join(w.dataDir, 'integrations', 'manifest.json'), 'utf8')], before, 'a preview writes nothing');
  const r = await ask(w.deps, { type: 'removalApply', previewId: pv['previewId'] }, A);
  assert.equal(r.status, 'disconnected');
  assert.equal(readFileSync(w.file(0), 'utf8'), ORIGINAL);
  assert.equal(readFileSync(w.file(1), 'utf8'), before[1], 'the other profile is untouched');
  assert.deepEqual(await ask(w.deps, { type: 'removalApply', previewId: pv['previewId'] }, A), { status: 'refused', code: 'preview-invalid' }, 'single use');
  assert.deepEqual(await ask(w.deps, { type: 'removalPreview', profileId: P1 }, A), { status: 'refused', code: 'not-connected' });
});

test('owner-bound: another port is refused and consumes the preview; a closed port drops it', async () => {
  const w = await world();
  await connect(w, P1);
  const pv = await ask(w.deps, { type: 'removalPreview', profileId: P1 }, A);
  assert.deepEqual(await ask(w.deps, { type: 'removalApply', previewId: pv['previewId'] }, B), { status: 'refused', code: 'preview-invalid' });
  assert.deepEqual(await ask(w.deps, { type: 'removalApply', previewId: pv['previewId'] }, A), { status: 'refused', code: 'preview-invalid' });
  const again = await ask(w.deps, { type: 'removalPreview', profileId: P1 }, A);
  w.c.dropOwner(A);
  assert.deepEqual(await ask(w.deps, { type: 'removalApply', previewId: again['previewId'] }, A), { status: 'refused', code: 'preview-invalid' });
  assert.notEqual(readFileSync(w.file(0), 'utf8'), ORIGINAL, 'nothing removed');
});

test('any change after the preview: nothing written, a fresh preview instead (bytes, mode, profile mapping)', async () => {
  const w = await world();
  await connect(w, P1);
  const connected = readFileSync(w.file(0), 'utf8');
  const edited = connected.replace('"cleanupPeriodDays": 45', '"cleanupPeriodDays": 46');
  const pv = await ask(w.deps, { type: 'removalPreview', profileId: P1 }, A);
  writeFileSync(w.file(0), edited);
  const r = await ask(w.deps, { type: 'removalApply', previewId: pv['previewId'] }, A);
  assert.equal(r.status, 'needs-preview');
  assert.equal(readFileSync(w.file(0), 'utf8'), edited, 'nothing written');
  const fresh = r['preview'] as R;
  assert.equal(fresh.status, 'preview');
  writeFileSync(w.file(0), connected);
  const pv2 = await ask(w.deps, { type: 'removalPreview', profileId: P1 }, A);
  chmodSync(w.file(0), 0o600); // plan review L1: a mode change too
  assert.equal((await ask(w.deps, { type: 'removalApply', previewId: pv2['previewId'] }, A)).status, 'needs-preview');
  assert.equal(readFileSync(w.file(0), 'utf8'), connected);
  // plan review M1: Full Uninstall previewed with both profiles; one is no longer synced at apply: its entries changed state
  await connect(w, P2);
  const all = await ask(w.deps, { type: 'removalPreview', profileId: null }, A);
  assert.equal(all['profileId'], null);
  w.live.profiles = w.live.profiles.filter((p) => p.id !== P2);
  assert.equal((await ask(w.deps, { type: 'removalApply', previewId: all['previewId'] }, A)).status, 'needs-preview');
  assert.notEqual(readFileSync(w.file(0), 'utf8'), ORIGINAL, 'nothing written');
});

test('Full Uninstall names every profile and entry; a target outside the writable roots is never read and stays', async () => {
  const w = await world();
  await connect(w, P1);
  await connect(w, P2);
  // plan review H1: an entry recorded for a real profile (denied root), its file unreadable: the preview must not read it
  const real = join(w.base, 'real', '.claude');
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'settings.json'), ORIGINAL);
  chmodSync(join(real, 'settings.json'), 0o000);
  const m = manifest(w);
  const foreign = { ...m.entries[0]!, id: NONE, target: join(real, 'settings.json') };
  writeFileSync(join(w.dataDir, 'integrations', 'manifest.json'), JSON.stringify({ ...m, entries: [foreign, ...m.entries] }), { mode: 0o600 });
  const pv = await ask(w.deps, { type: 'removalPreview', profileId: null }, A);
  assert.equal(pv.status, 'preview');
  const items = pv['items'] as { entry: string; profileId: string | null; state: string; reason: string | null }[];
  assert.deepEqual(new Set(items.map((x) => x.profileId)), new Set([null, P1, P2]));
  assert.deepEqual(items.find((x) => x.entry === NONE), { entry: NONE, route: foreign.route, profileId: null, state: 'unreadable', reason: 'refused' });
  const r = await ask(w.deps, { type: 'removalApply', previewId: pv['previewId'] }, A) as R & { remaining: { entry: string; reason: string }[] };
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.remaining.map((x) => [x.entry, x.reason]), [[NONE, 'refused']]);
  assert.equal(readFileSync(w.file(0), 'utf8'), ORIGINAL);
  assert.equal(readFileSync(w.file(1), 'utf8'), ORIGINAL);
});

test('a real or unknown profile is refused before any read; one held preview per scope', async () => {
  const w = await world();
  await connect(w, P1);
  const realRoot = join(w.base, 'real', '.claude');
  mkdirSync(realRoot, { recursive: true });
  w.live.profiles = [...w.live.profiles, { id: NONE, agent: 'claude', root: realRoot, origin: 'manual' }];
  assert.deepEqual(await ask(w.deps, { type: 'removalPreview', profileId: NONE }, A), { status: 'refused', code: 'unsafe-profile' });
  assert.deepEqual(await ask(w.deps, { type: 'removalPreview', profileId: '00000000-0000-4000-8000-0000000c76fe' }, A), { status: 'refused', code: 'profile-not-found' });
  const first = await ask(w.deps, { type: 'removalPreview', profileId: P1 }, A);
  const second = await ask(w.deps, { type: 'removalPreview', profileId: P1 }, A);
  assert.notEqual(first['previewId'], second['previewId']);
  assert.deepEqual(await ask(w.deps, { type: 'removalApply', previewId: first['previewId'] }, A), { status: 'refused', code: 'preview-invalid' }, 'plan review M2: replaced');
  for (let i = 0; i < 40; i++) assert.equal((await ask(w.deps, { type: 'removalPreview', profileId: P1 }, A)).status, 'preview', 'repeating one scope never fills the cap');
});

test('cleanup: only records of entries a fresh reconcile reports removed; nothing to clean is said', async () => {
  const w = await world();
  await connect(w, P1);
  assert.deepEqual(await ask(w.deps, { type: 'cleanupPreview', profileId: P1 }, A), { status: 'refused', code: 'nothing-to-clean' });
  writeFileSync(w.file(0), ORIGINAL); // removed outside Xaibo
  const pv = await ask(w.deps, { type: 'cleanupPreview', profileId: P1 }, A);
  assert.equal(pv.status, 'preview');
  const ids = (pv['items'] as { entry: string; cleanup: string[] }[]).map((x) => x.entry);
  assert.ok(ids.length >= 1 && (pv['items'] as { cleanup: string[] }[]).every((x) => x.cleanup.includes('manifest-entry')));
  assert.deepEqual(await ask(w.deps, { type: 'cleanupApply', previewId: pv['previewId'] }, B), { status: 'refused', code: 'preview-invalid' });
  const pv2 = await ask(w.deps, { type: 'cleanupPreview', profileId: P1 }, A);
  const r = await ask(w.deps, { type: 'cleanupApply', previewId: pv2['previewId'] }, A);
  assert.equal(r.status, 'cleaned');
  assert.equal(manifest(w).entries.filter((e) => ids.includes(e.id)).length, 0);
  assert.equal(readFileSync(w.file(0), 'utf8'), ORIGINAL, 'no agent file written');
});

// diff review M1: one unreadable disposable target never blocks the rest; it is named with its reason and stays
test('Full Uninstall with one target that cannot be read safely: the others are removed, that one stays, named', async () => {
  const w = await world();
  await connect(w, P1);
  await connect(w, P2);
  const kept = readFileSync(w.file(1), 'utf8');
  writeFileSync(join(w.base, 'elsewhere.json'), kept);
  unlinkSync(w.file(1));
  symlinkSync(join(w.base, 'elsewhere.json'), w.file(1));
  const pv = await ask(w.deps, { type: 'removalPreview', profileId: null }, A);
  assert.equal(pv.status, 'preview');
  const items = pv['items'] as { entry: string; profileId: string | null; state: string; reason: string | null }[];
  const bad = manifest(w).entries.filter((e) => e.target === w.file(1)).map((e) => e.id);
  assert.ok(bad.length && items.filter((x) => bad.includes(x.entry)).every((x) => x.state === 'unreadable' && x.reason === 'symlink'));
  const r = await ask(w.deps, { type: 'removalApply', previewId: pv['previewId'] }, A) as R & { remaining: { entry: string; reason: string }[] };
  assert.equal(r.status, 'partial');
  assert.deepEqual(new Set(r.remaining.map((x) => x.entry)), new Set(bad));
  assert.equal(readFileSync(w.file(0), 'utf8'), ORIGINAL, 'the readable profile is removed');
  assert.equal(readFileSync(join(w.base, 'elsewhere.json'), 'utf8'), kept, 'nothing written through the link');
});

// diff review L2: a profile whose root changed since the preview (same id) gets a fresh preview of its current target
test('a profile root changed since the preview: nothing written, the fresh preview is of the current root', async () => {
  const w = await world();
  await connect(w, P1);
  await connect(w, P2);
  const pv = await ask(w.deps, { type: 'removalPreview', profileId: P1 }, A);
  const moved = { ...w.live.profiles[0]!, root: w.live.profiles[1]!.root };
  w.live.profiles = [moved, w.live.profiles[1]!];
  const r = await ask(w.deps, { type: 'removalApply', previewId: pv['previewId'] }, A);
  assert.equal(r.status, 'needs-preview');
  const fresh = r['preview'] as R & { items: { entry: string }[] };
  assert.deepEqual(new Set(fresh.items.map((x) => x.entry)), new Set(manifest(w).entries.filter((e) => e.target === w.file(1)).map((e) => e.id)));
  assert.notEqual(readFileSync(w.file(0), 'utf8'), ORIGINAL, 'nothing written');
});

// diff review L3: the reply after an escaped rejection always parses in the request's own shape
test('the after-dispatch reply parses for every request type', () => {
  for (const type of ['connectPreview', 'connectApply', 'removalPreview', 'removalApply', 'cleanupPreview', 'cleanupApply'] as const) {
    assert.ok(parsePortMessage({ v: 1, type, id: 1, result: afterDispatch(type) }), type);
  }
});

test('refusals that still reply for every new request', async () => {
  const w = await world();
  for (const m of [{ type: 'removalPreview', profileId: P1 }, { type: 'removalPreview', profileId: null }, { type: 'removalApply', previewId: NONE },
    { type: 'cleanupPreview', profileId: P1 }, { type: 'cleanupApply', previewId: NONE }]) {
    assert.deepEqual(await ask({ ...w.deps, readOnly: true }, m, A), { status: 'refused', code: 'read-only' });
    assert.deepEqual(await ask({ ...w.deps, connect: () => null }, m, A), { status: 'refused', code: 'starting' });
    assert.deepEqual(await ask({ ...w.deps, connect: () => 'unavailable' }, m, A), { status: 'refused', code: 'unavailable' });
  }
  assert.deepEqual(await ask(w.deps, { type: 'cleanupPreview', profileId: NONE }, A), { status: 'refused', code: 'profile-not-found' });
});
