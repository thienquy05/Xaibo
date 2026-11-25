// XAIBO-PROD-580 (P6-T10 unit 6a; design .handoff/p6-t10-design.md R6): the separate status-line tee through the IPC handler
// on synthetic disposable Claude profiles. Tee on is a tee-only Connect (teePreview, applied by connectApply): only the
// statusLine changes, a foreign command is wrapped and kept, hooks and retention are never added. Tee off is the removal
// preview limited to the claude-tee entry (teeRemovalPreview, applied by removalApply): the statusLine comes back
// byte-identical and every other entry stays. Previews write nothing; non-Claude and unknown profiles are refused.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeContext } from '../../helpers/fake-claude.ts';
import { createConnect, type ConnectContext } from '../../../src/service/integrations/connect.ts';
import { afterDispatch, answerIntegrations, type IntegrationsDeps } from '../../../src/service/integrations-ipc.ts';
import { parsePortMessage, type PortMessage } from '../../../src/shared/ipc.ts';
import type { Profile } from '../../../src/service/catalog/detect.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) { try { chmodSync(d, 0o700); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });
const iso = mkdtempSync(join(tmpdir(), 'xtee-env-'));
dirs.push(iso);
for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR']) process.env[k] = join(iso, k.toLowerCase());

const P1 = '00000000-0000-4000-8000-0000000c8001', P2 = '00000000-0000-4000-8000-0000000c8002', CX = '00000000-0000-4000-8000-0000000c8003', NONE = '00000000-0000-4000-8000-0000000c80ff';
const FOREIGN = '{\n  "statusLine": {\n    "type": "command",\n    "command": "echo mine",\n    "padding": 2\n  }\n}\n';
async function world() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xtee-')));
  dirs.push(base);
  const helpers = join(base, 'helpers'), managed = join(base, 'managed'), dataDir = join(base, 'data');
  const roots = [join(base, 'a', '.claude'), join(base, 'b', '.claude'), join(base, 'c', '.codex')];
  for (const d of [...roots, helpers, managed, dataDir]) mkdirSync(d, { recursive: true, mode: 0o755 });
  writeFileSync(join(roots[0]!, 'settings.json'), '{\n  "cleanupPeriodDays": 10\n}\n');
  writeFileSync(join(roots[1]!, 'settings.json'), FOREIGN);
  for (const h of ['xaibo-hook', 'xaibo-report', 'xaibo-forwarder', 'xaibo-statusline']) writeFileSync(join(helpers, h), '#!/bin/sh\nexit 0\n');
  const ctx: ConnectContext = { dataDir, denied: [join(base, 'real')], allowed: [base], claudeManagedDir: managed, ...await claudeContext(),
    helpers: { hook: join(helpers, 'xaibo-hook'), forwarder: join(helpers, 'xaibo-forwarder'), statusline: join(helpers, 'xaibo-statusline') } };
  const profiles: Profile[] = [{ id: P1, agent: 'claude', root: roots[0]!, origin: 'default' }, { id: P2, agent: 'claude', root: roots[1]!, origin: 'manual' }, { id: CX, agent: 'codex', root: roots[2]!, origin: 'manual' }];
  const c = createConnect(ctx);
  const deps: IntegrationsDeps = { readOnly: false, connect: () => c, profile: (id) => profiles.find((p) => p.id === id), profiles: () => profiles };
  return { dataDir, deps, file: (i: number) => join(roots[i]!, 'settings.json') };
}
type R = { status: string; [k: string]: unknown };
async function ask(deps: IntegrationsDeps, m: object, owner: object): Promise<R> {
  const out = await answerIntegrations(deps, { v: 1, id: 9, ...m } as never, owner) as PortMessage & { result: R };
  assert.ok(parsePortMessage(out), `parsePortMessage accepts ${JSON.stringify(out).slice(0, 200)}`);
  return out.result;
}
const A = {}, B = {};
const manifest = (w: { dataDir: string }) => { try { return (JSON.parse(readFileSync(join(w.dataDir, 'integrations', 'manifest.json'), 'utf8')) as { entries: { id: string; route: string }[] }).entries; } catch { return []; } };
const read = (f: string) => readFileSync(f, 'utf8');

test('tee on: a tee-only preview writes nothing; apply sets only the statusLine tee, no hooks or retention', async () => {
  const w = await world();
  const before = read(w.file(0));
  const pv = await ask(w.deps, { type: 'teePreview', profileId: P1 }, A);
  assert.equal(pv.status, 'preview');
  assert.deepEqual((pv['steps'] as { route: string }[]).map((s) => s.route), ['claude-tee']);
  assert.equal(pv['retention'], null, 'no retention offer in a tee-only preview');
  assert.equal(read(w.file(0)), before, 'a preview writes nothing');
  assert.deepEqual(manifest(w), []);
  assert.equal((await ask(w.deps, { type: 'connectApply', previewId: pv['previewId'] }, A)).status, 'applied');
  const doc = JSON.parse(read(w.file(0))) as Record<string, unknown>;
  assert.match(String((doc['statusLine'] as { command: string }).command), /xaibo-statusline/);
  assert.equal(doc['cleanupPeriodDays'], 10, 'retention untouched');
  assert.equal(doc['hooks'], undefined, 'no settings hooks');
  assert.deepEqual(manifest(w).map((e) => e.route), ['claude-tee']);
  assert.deepEqual(await ask(w.deps, { type: 'teePreview', profileId: P1 }, A), { status: 'refused', code: 'duplicate' }, 'already on');
});

test('tee off: only the tee entry is previewed and reverted; a foreign statusLine comes back byte-identical; other entries stay', async () => {
  const w = await world();
  // hooks and retention first (a full Connect), then the tee on its own
  const c = await ask(w.deps, { type: 'connectPreview', profileId: P2, selections: { retention: true, tee: false } }, A);
  assert.equal((await ask(w.deps, { type: 'connectApply', previewId: c['previewId'] }, A)).status, 'applied');
  const connected = read(w.file(1));
  const on = await ask(w.deps, { type: 'teePreview', profileId: P2 }, A);
  assert.equal((await ask(w.deps, { type: 'connectApply', previewId: on['previewId'] }, A)).status, 'applied');
  const wrapped = JSON.parse(read(w.file(1))) as { statusLine: { command: string; padding: number } };
  assert.match(wrapped.statusLine.command, /xaibo-statusline/);
  assert.equal(wrapped.statusLine.padding, 2, 'every key but the command kept');
  const others = manifest(w).filter((e) => e.route !== 'claude-tee').map((e) => e.id);
  assert.ok(others.length >= 1);
  const off = await ask(w.deps, { type: 'teeRemovalPreview', profileId: P2 }, A);
  assert.equal(off.status, 'preview');
  assert.equal(off['profileId'], P2);
  assert.deepEqual((off['items'] as { route: string }[]).map((i) => i.route), ['claude-tee']);
  assert.match(read(w.file(1)), /xaibo-statusline/, 'a preview writes nothing');
  assert.equal((await ask(w.deps, { type: 'removalApply', previewId: off['previewId'] }, A)).status, 'disconnected');
  assert.equal(read(w.file(1)), connected, 'the statusLine as it was before the tee, byte-identical');
  assert.deepEqual(manifest(w).map((e) => e.id), others, 'hooks and retention entries stay');
  assert.deepEqual(await ask(w.deps, { type: 'teeRemovalPreview', profileId: P2 }, A), { status: 'refused', code: 'not-connected' });
  // the Disconnect preview of the same profile is its own scope: both can be held at once
  const d = await ask(w.deps, { type: 'removalPreview', profileId: P2 }, A);
  assert.equal(d.status, 'preview');
});

test('tee previews are owner-bound and single use; a change since the preview answers a fresh preview', async () => {
  const w = await world();
  const on = await ask(w.deps, { type: 'teePreview', profileId: P1 }, A);
  assert.deepEqual(await ask(w.deps, { type: 'connectApply', previewId: on['previewId'] }, B), { status: 'refused', code: 'preview-invalid' });
  const on2 = await ask(w.deps, { type: 'teePreview', profileId: P1 }, A);
  writeFileSync(w.file(0), '{\n  "cleanupPeriodDays": 11\n}\n');
  const r = await ask(w.deps, { type: 'connectApply', previewId: on2['previewId'] }, A);
  assert.equal(r.status, 'needs-preview');
  assert.deepEqual(((r['preview'] as R)['steps'] as { route: string }[]).map((s) => s.route), ['claude-tee'], 'the fresh preview is tee-only too');
  assert.doesNotMatch(read(w.file(0)), /xaibo-statusline/);
  assert.equal((await ask(w.deps, { type: 'connectApply', previewId: (r['preview'] as R)['previewId'] }, A)).status, 'applied');
  const off = await ask(w.deps, { type: 'teeRemovalPreview', profileId: P1 }, A);
  const s = JSON.parse(read(w.file(0))) as Record<string, unknown>;
  writeFileSync(w.file(0), JSON.stringify({ ...s, model: 'x' }, null, 2));
  const again = await ask(w.deps, { type: 'removalApply', previewId: off['previewId'] }, A);
  assert.equal(again.status, 'needs-preview');
  assert.deepEqual(((again['preview'] as R)['items'] as { route: string }[]).map((i) => i.route), ['claude-tee'], 'the fresh removal preview is tee-only too');
  assert.match(read(w.file(0)), /xaibo-statusline/, 'nothing written');
});

test('review L4: a tee older than the hooks: tee off strips only the tee; the foreign statusLine, hooks and retention stay', async () => {
  const w = await world();
  const on = await ask(w.deps, { type: 'teePreview', profileId: P2 }, A);
  assert.equal((await ask(w.deps, { type: 'connectApply', previewId: on['previewId'] }, A)).status, 'applied');
  const c = await ask(w.deps, { type: 'connectPreview', profileId: P2, selections: { retention: true, tee: false } }, A);
  assert.equal((await ask(w.deps, { type: 'connectApply', previewId: c['previewId'] }, A)).status, 'applied');
  const withHooks = JSON.parse(read(w.file(1))) as Record<string, unknown>;
  const others = manifest(w).filter((e) => e.route !== 'claude-tee').map((e) => e.id);
  const off = await ask(w.deps, { type: 'teeRemovalPreview', profileId: P2 }, A);
  const done = await ask(w.deps, { type: 'removalApply', previewId: off['previewId'] }, A);
  assert.equal(done.status, 'disconnected');
  assert.equal((done['reverted'] as { result: string }[])[0]!.result, 'structural', 'newer entries on the file: only the tee value is stripped');
  const after = JSON.parse(read(w.file(1))) as Record<string, unknown>;
  assert.deepEqual(after['statusLine'], { type: 'command', command: 'echo mine', padding: 2 });
  assert.deepEqual({ ...after, statusLine: null }, { ...withHooks, statusLine: null }, 'everything but the statusLine unchanged');
  assert.deepEqual(manifest(w).map((e) => e.id), others);
});

test('review L2: a tee-on preview has its own scope: a held Connect preview of the same profile still applies', async () => {
  const w = await world();
  const c = await ask(w.deps, { type: 'connectPreview', profileId: P1, selections: { retention: false, tee: false } }, A);
  const on = await ask(w.deps, { type: 'teePreview', profileId: P1 }, A);
  assert.equal(on.status, 'preview');
  assert.equal((await ask(w.deps, { type: 'connectApply', previewId: c['previewId'] }, A)).status, 'applied');
});

test('refusals: a non-Claude or unknown profile before any read; read-only, starting and unavailable still reply', async () => {
  const w = await world();
  assert.deepEqual(await ask(w.deps, { type: 'teePreview', profileId: CX }, A), { status: 'refused', code: 'unsupported' });
  assert.deepEqual(await ask(w.deps, { type: 'teeRemovalPreview', profileId: CX }, A), { status: 'refused', code: 'unsupported' });
  assert.deepEqual(await ask(w.deps, { type: 'teePreview', profileId: NONE }, A), { status: 'refused', code: 'profile-not-found' });
  assert.deepEqual(await ask(w.deps, { type: 'teeRemovalPreview', profileId: NONE }, A), { status: 'refused', code: 'profile-not-found' });
  assert.deepEqual(manifest(w), []);
  for (const m of [{ type: 'teePreview', profileId: P1 }, { type: 'teeRemovalPreview', profileId: P1 }]) {
    assert.deepEqual(await ask({ ...w.deps, readOnly: true }, m, A), { status: 'refused', code: 'read-only' });
    assert.deepEqual(await ask({ ...w.deps, connect: () => null }, m, A), { status: 'refused', code: 'starting' });
    assert.deepEqual(await ask({ ...w.deps, connect: () => 'unavailable' }, m, A), { status: 'refused', code: 'unavailable' });
  }
  for (const type of ['teePreview', 'teeRemovalPreview'] as const) assert.ok(parsePortMessage({ v: 1, type, id: 1, result: afterDispatch(type) }), type);
});
