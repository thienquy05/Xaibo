// XAIBO-PROD-558 (P6-T03 part 1b; design review .handoff/p6-t03-design.md): the Connect IPC at the renderer trust boundary.
// Requests carry only a profile id, selections or a preview id, in exact shapes; replies are bounded and carry no ops;
// main always sets the helper folder for the service itself (an inherited XAIBO_BIN never reaches it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortMessage, parsePortRequest } from '../../src/shared/ipc.ts';
import { serviceEnv } from '../../src/main/app-paths.ts';

const P = '00000000-0000-4000-8000-0000000000a1', V = '00000000-0000-4000-8000-0000000000b2';
const req = (m: object) => parsePortRequest({ v: 1, id: 3, ...m });

test('requests: exact shapes only; never paths, ops, routes or plans', () => {
  assert.deepEqual(req({ type: 'connectPreview', profileId: P, selections: { retention: true, tee: false } }), { v: 1, type: 'connectPreview', id: 3, profileId: P, selections: { retention: true, tee: false } });
  assert.deepEqual(req({ type: 'connectApply', previewId: V }), { v: 1, type: 'connectApply', id: 3, previewId: V });
  assert.deepEqual(req({ type: 'disconnect', profileId: P }), { v: 1, type: 'disconnect', id: 3, profileId: P });
  assert.deepEqual(req({ type: 'uninstall' }), { v: 1, type: 'uninstall', id: 3 });
  for (const m of [
    { type: 'connectPreview', profileId: 'claude-1', selections: { retention: true, tee: false } }, // not a UUID
    { type: 'connectPreview', profileId: P, selections: { retention: 1, tee: false } },
    { type: 'connectPreview', profileId: P, selections: { retention: true } },
    { type: 'connectPreview', profileId: P, selections: { retention: true, tee: false, ops: [] } },
    { type: 'connectPreview', profileId: P, selections: { retention: true, tee: false }, target: '/x' },
    { type: 'connectApply', previewId: 'not-a-uuid' },
    { type: 'connectApply', previewId: V, plan: {} },
    { type: 'disconnect', profileId: P, route: 'claude-tee' },
    { type: 'uninstall', all: true },
  ]) assert.equal(req(m), null, JSON.stringify(m));
  assert.equal(parsePortRequest(JSON.parse(`{"v":1,"id":3,"type":"connectApply","previewId":"${V}","__proto__":{"x":1}}`)), null, 'an own __proto__ key');
});

const preview = (o: object = {}) => ({
  status: 'preview', previewId: V, profileId: P, ttlMs: 300_000,
  steps: [{ route: 'claude-retention', target: '/tmp/p/.claude/settings.json', diff: [{ pointer: '/cleanupPeriodDays', new: 45, replaced: { type: 'number', sha256: 'a1b2c3d4e5f6' } }] }],
  retention: { offered: true, from: 10, to: 45, layer: 'user' }, trustSteps: [], ...o,
});
const reply = (type: string, result: object) => parsePortMessage({ v: 1, type, id: 3, result });

test('replies: bounded, no ops anywhere', () => {
  assert.ok(reply('connectPreview', preview()));
  assert.ok(reply('connectApply', { status: 'applied', entries: [V], trustSteps: ['Open Codex once'] }));
  assert.ok(reply('connectApply', { status: 'needs-preview', preview: preview() }));
  assert.ok(reply('connectApply', { status: 'needs-preview', preview: { status: 'refused', code: 'duplicate' } }));
  assert.ok(reply('disconnect', { status: 'partial', reverted: [{ entry: V, route: 'claude-tee', result: 'restored' }], conflicts: [{ entry: V, route: 'claude-retention', pointer: '/cleanupPeriodDays' }], remaining: [{ entry: V, route: 'claude-settings-fallback', reason: 'blocked' }] }));
  assert.ok(reply('uninstall', { status: 'refused', code: 'bounds-unavailable' }));
  for (const bad of [
    preview({ retention: { offered: true, from: 10, to: 45, layer: 'user', ops: [{ op: 'set', pointer: '/x', value: 1 }] } }),
    preview({ steps: [1, 2, 3, 4].map(() => preview().steps[0]) }),
    preview({ steps: [{ route: 'claude-retention', target: '/x', diff: Array.from({ length: 65 }, () => ({ pointer: '/a', new: 1 })) }] }),
    preview({ steps: [{ route: 'claude-retention', target: '/x', diff: [{ pointer: '/a', new: 'x'.repeat(16_385) }] }] }),
    preview({ steps: [{ route: 'bogus', target: '/x', diff: [] }] }),
    preview({ plan: {} }),
    // code review (run 192) L-3, L-4: a diff value nested past the depth cap; a hash that is not a string
    preview({ steps: [{ route: 'claude-retention', target: '/x', diff: [{ pointer: '/a', new: JSON.parse('['.repeat(40) + ']'.repeat(40)) }] }] }),
    preview({ steps: [{ route: 'claude-retention', target: '/x', diff: [{ pointer: '/a', new: 1, replaced: { type: 'number', sha256: 123456789012 } }] }] }),
  ]) assert.equal(reply('connectPreview', bad), null, JSON.stringify(bad).slice(0, 120));
  assert.equal(reply('connectApply', { status: 'refused', code: 'Not A Code!' }), null);
});

test('main always sets the service helper folder itself: packaged resources/bin, unpackaged empty (the repo helpers)', () => {
  const inherited = { PATH: '/bin', XAIBO_BIN: '/elsewhere/bin' };
  assert.deepEqual(serviceEnv(inherited, { dataDir: '/d', packaged: false, resourcesPath: '/R' }), { PATH: '/bin', XAIBO_BIN: '', XAIBO_DATA_DIR: '/d' });
  assert.deepEqual(serviceEnv(inherited, { dataDir: '/d', packaged: true, resourcesPath: '/R' }), { PATH: '/bin', XAIBO_BIN: '/R/bin', XAIBO_DATA_DIR: '/d' });
});
