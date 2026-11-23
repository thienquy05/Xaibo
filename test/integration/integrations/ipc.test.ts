// XAIBO-PROD-558 (P6-T03 part 1b): the service's Connect IPC handler over the part 1a core, on a synthetic disposable
// profile. A preview belongs to the port that asked (another port's apply is refused and consumes it), including the new
// preview after a mismatch; an unknown profile, a read-only store and a service still starting are refused with a reply;
// a handler that throws still replies; missing helpers are refused before the owner confirms; an over-bound preview is
// refused, never truncated; replies carry no ops.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnect, type ConnectContext } from '../../../src/service/integrations/connect.ts';
import { answerIntegrations, type IntegrationsDeps } from '../../../src/service/integrations-ipc.ts';
import { parsePortMessage, type PortMessage } from '../../../src/shared/ipc.ts';
import type { Profile } from '../../../src/service/catalog/detect.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const iso = mkdtempSync(join(tmpdir(), 'xipc-env-'));
dirs.push(iso);
for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR']) process.env[k] = join(iso, k.toLowerCase());

const PID = '00000000-0000-4000-8000-0000000000a1', OTHER = '00000000-0000-4000-8000-0000000000c3';
function world(o: { helpers?: boolean } = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xipc-')));
  dirs.push(base);
  const claude = join(base, 'home', '.claude'), helpers = join(base, 'helpers'), managed = join(base, 'managed'), dataDir = join(base, 'data');
  for (const d of [claude, helpers, managed, dataDir]) mkdirSync(d, { recursive: true, mode: 0o755 });
  const file = join(claude, 'settings.json');
  writeFileSync(file, '{\n  "cleanupPeriodDays": 10\n}\n');
  if (o.helpers !== false) for (const h of ['xaibo-hook', 'xaibo-report', 'xaibo-forwarder', 'xaibo-statusline']) writeFileSync(join(helpers, h), '#!/bin/sh\nexit 0\n');
  const ctx: ConnectContext = { dataDir, denied: [join(base, 'real')], allowed: [base], claudeManagedDir: managed,
    helpers: { hook: join(helpers, 'xaibo-hook'), forwarder: join(helpers, 'xaibo-forwarder'), statusline: join(helpers, 'xaibo-statusline') } };
  const profile: Profile = { id: PID, agent: 'claude', root: claude, origin: 'default' };
  const c = createConnect(ctx);
  const deps: IntegrationsDeps = { readOnly: false, connect: () => c, profile: (id) => (id === PID ? profile : undefined) };
  return { base, file, dataDir, ctx, deps, c };
}
type R = { status: string; [k: string]: unknown };
/** Every reply goes through the renderer-side parser too (bounded, no ops). */
function ask(deps: IntegrationsDeps, m: object, owner: object): R {
  const out = answerIntegrations(deps, { v: 1, id: 7, ...m } as never, owner) as PortMessage & { result: R };
  assert.ok(parsePortMessage(out), `parsePortMessage accepts ${JSON.stringify(out).slice(0, 200)}`);
  return out.result;
}
const A = {}, B = {};
const SEL = { retention: true, tee: false };

test('preview, apply and disconnect through the IPC handler; the retention offer has no ops', () => {
  const w = world();
  const pv = ask(w.deps, { type: 'connectPreview', profileId: PID, selections: SEL }, A);
  assert.equal(pv.status, 'preview');
  assert.deepEqual(pv['retention'], { offered: true, from: 10, to: 45, layer: 'user' });
  assert.equal(ask(w.deps, { type: 'connectApply', previewId: pv['previewId'] }, A).status, 'applied');
  assert.equal(JSON.parse(readFileSync(w.file, 'utf8')).cleanupPeriodDays, 45);
  assert.equal(ask(w.deps, { type: 'disconnect', profileId: PID }, A).status, 'disconnected');
  assert.equal(readFileSync(w.file, 'utf8'), '{\n  "cleanupPeriodDays": 10\n}\n');
});

test('a preview belongs to its port: another port is refused and the preview is consumed; the new preview after a mismatch too', () => {
  const w = world();
  const pv = ask(w.deps, { type: 'connectPreview', profileId: PID, selections: SEL }, A);
  assert.deepEqual(ask(w.deps, { type: 'connectApply', previewId: pv['previewId'] }, B), { status: 'refused', code: 'preview-invalid' });
  assert.deepEqual(ask(w.deps, { type: 'connectApply', previewId: pv['previewId'] }, A), { status: 'refused', code: 'preview-invalid' }, 'consumed');
  const pv2 = ask(w.deps, { type: 'connectPreview', profileId: PID, selections: SEL }, A);
  writeFileSync(w.file, '{\n  "cleanupPeriodDays": 11\n}\n');
  const r = ask(w.deps, { type: 'connectApply', previewId: pv2['previewId'] }, A);
  assert.equal(r.status, 'needs-preview');
  const fresh = r['preview'] as R;
  assert.deepEqual(ask(w.deps, { type: 'connectApply', previewId: fresh['previewId'] }, B), { status: 'refused', code: 'preview-invalid' });
});

test('the new preview after a mismatch applies from the same port', () => {
  const w = world();
  const pv = ask(w.deps, { type: 'connectPreview', profileId: PID, selections: SEL }, A);
  writeFileSync(w.file, '{\n  "cleanupPeriodDays": 12\n}\n');
  const fresh = ask(w.deps, { type: 'connectApply', previewId: pv['previewId'] }, A)['preview'] as R;
  assert.equal(ask(w.deps, { type: 'connectApply', previewId: fresh['previewId'] }, A).status, 'applied');
});

test('a closed port drops its previews', () => {
  const w = world();
  const pv = ask(w.deps, { type: 'connectPreview', profileId: PID, selections: SEL }, A);
  w.c.dropOwner(A);
  assert.deepEqual(ask(w.deps, { type: 'connectApply', previewId: pv['previewId'] }, A), { status: 'refused', code: 'preview-invalid' });
});

test('refusals that still reply: unknown profile, read-only store, still starting, a throwing handler, missing helpers', () => {
  const w = world();
  assert.deepEqual(ask(w.deps, { type: 'connectPreview', profileId: OTHER, selections: SEL }, A), { status: 'refused', code: 'profile-not-found' });
  assert.deepEqual(ask(w.deps, { type: 'disconnect', profileId: OTHER }, A), { status: 'refused', code: 'profile-not-found' });
  for (const m of [{ type: 'connectPreview', profileId: PID, selections: SEL }, { type: 'uninstall' }, { type: 'disconnect', profileId: PID }]) {
    assert.deepEqual(ask({ ...w.deps, readOnly: true }, m, A), { status: 'refused', code: 'read-only' });
    assert.deepEqual(ask({ ...w.deps, connect: () => null }, m, A), { status: 'refused', code: 'starting' });
    assert.deepEqual(ask({ ...w.deps, connect: () => 'unavailable' }, m, A), { status: 'refused', code: 'unavailable' }, 'review L-2: startup failed');
    assert.deepEqual(ask({ ...w.deps, connect: () => { throw new Error('no passwd entry'); } }, m, A), { status: 'refused', code: 'failed' }, 'review L-1');
  }
  const throwing = { ...w.deps, profile: () => { throw new Error('boom'); } };
  assert.deepEqual(ask(throwing, { type: 'connectPreview', profileId: PID, selections: SEL }, A), { status: 'refused', code: 'failed' });
  const bare = world({ helpers: false });
  assert.deepEqual(ask(bare.deps, { type: 'connectPreview', profileId: PID, selections: SEL }, A), { status: 'refused', code: 'helpers-unavailable' });
  assert.equal(existsSync(join(bare.dataDir, 'integrations')), false);
});

test('an over-bound preview is refused, never truncated', () => {
  const w = world();
  const huge = { ...w.deps, connect: () => ({ ...w.c, previewConnect: () => ({ status: 'preview' as const, previewId: OTHER, profileId: PID, ttlMs: 1,
    steps: [{ route: 'claude-retention' as const, target: '/x', diff: Array.from({ length: 65 }, (_, i) => ({ pointer: `/k${i}`, new: i })) }], retention: null, trustSteps: [] }) }) };
  assert.deepEqual(ask(huge, { type: 'connectPreview', profileId: PID, selections: SEL }, A), { status: 'refused', code: 'too-large' });
});

// code review (run 192) M-1: after a write, an over-bound reply never says "refused" (nothing changed): partial, re-read
test('an over-bound reply after a write is partial with too-large, never a refusal', () => {
  const w = world();
  const many = { status: 'partial' as const, reverted: [], conflicts: [], remaining: Array.from({ length: 300 }, () => ({ entry: OTHER, route: 'claude-tee' as const, reason: 'refused' })) };
  const stub = { ...w.deps, connect: () => ({ ...w.c, disconnect: () => many, uninstall: () => many,
    applyConnect: () => ({ status: 'applied' as const, entries: Array.from({ length: 9 }, () => OTHER), trustSteps: [] }) }) };
  const partial = { status: 'partial', reverted: [], conflicts: [], remaining: [], code: 'too-large' };
  assert.deepEqual(ask(stub, { type: 'disconnect', profileId: PID }, A), partial);
  assert.deepEqual(ask(stub, { type: 'uninstall' }, A), partial);
  assert.deepEqual(ask(stub, { type: 'connectApply', previewId: OTHER }, A), partial);
});
