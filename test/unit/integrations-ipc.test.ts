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
  // XAIBO-PROD-576 (P6-T10 unit 3, review R1/R4): removal and cleanup are previewed; a bare Disconnect or Uninstall is gone
  assert.deepEqual(req({ type: 'removalPreview', profileId: P }), { v: 1, type: 'removalPreview', id: 3, profileId: P });
  assert.deepEqual(req({ type: 'removalPreview', profileId: null }), { v: 1, type: 'removalPreview', id: 3, profileId: null });
  assert.deepEqual(req({ type: 'removalApply', previewId: V }), { v: 1, type: 'removalApply', id: 3, previewId: V });
  assert.deepEqual(req({ type: 'cleanupPreview', profileId: P }), { v: 1, type: 'cleanupPreview', id: 3, profileId: P });
  assert.deepEqual(req({ type: 'cleanupApply', previewId: V }), { v: 1, type: 'cleanupApply', id: 3, previewId: V });
  assert.equal(req({ type: 'disconnect', profileId: P }), null, 'R1: no write without a preview');
  assert.equal(req({ type: 'uninstall' }), null, 'R1');
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
    { type: 'removalPreview', profileId: 'all' },
    { type: 'removalPreview' },
    { type: 'removalPreview', profileId: P, route: 'claude-tee' },
    { type: 'removalPreview', profileId: P, entries: [V] },
    { type: 'removalApply', previewId: 'x' },
    { type: 'removalApply', previewId: V, selected: [V] },
    { type: 'cleanupPreview', profileId: null },
    { type: 'cleanupPreview', profileId: P, entries: [V] },
    { type: 'cleanupApply', previewId: V, all: true },
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
  assert.ok(reply('removalApply', { status: 'partial', reverted: [{ entry: V, route: 'claude-tee', result: 'restored' }], conflicts: [{ entry: V, route: 'claude-retention', pointer: '/cleanupPeriodDays' }], remaining: [{ entry: V, route: 'claude-settings-fallback', reason: 'blocked' }] }));
  assert.ok(reply('removalPreview', { status: 'refused', code: 'bounds-unavailable' }));
  assert.equal(reply('disconnect', { status: 'refused', code: 'failed' }), null, 'R1: no such reply type');
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

// XAIBO-PROD-576 (plan review L4): removal and cleanup replies: ids and enums only, at most 256 items (the core's cap)
test('removal and cleanup replies: bounded, fixed states and codes, no paths', () => {
  const item = { entry: V, route: 'claude-tee', profileId: P, state: 'connected', reason: null };
  const rp = (o: object = {}) => ({ status: 'preview', previewId: V, profileId: P, ttlMs: 300_000, items: [item], ...o });
  assert.ok(reply('removalPreview', rp()));
  assert.ok(reply('removalPreview', rp({ profileId: null, items: [{ ...item, profileId: null, state: 'unreadable', reason: 'refused' }] })));
  assert.ok(reply('removalPreview', rp({ items: Array(256).fill(item) })));
  assert.ok(reply('removalApply', { status: 'needs-preview', preview: rp() }));
  assert.ok(reply('removalApply', { status: 'needs-preview', preview: { status: 'refused', code: 'busy' } }));
  assert.ok(reply('removalApply', { status: 'disconnected', reverted: [{ entry: V, route: 'claude-tee', result: 'restored' }], conflicts: [], remaining: [] }));
  assert.ok(reply('cleanupPreview', { status: 'preview', previewId: V, ttlMs: 300_000, items: [{ entry: V, cleanup: ['manifest-entry', 'backup'] }] }));
  assert.ok(reply('cleanupApply', { status: 'cleaned', removed: [V], left: [] }));
  assert.ok(reply('cleanupApply', { status: 'needs-preview' }));
  assert.ok(reply('cleanupApply', { status: 'partial', removed: [], left: [], code: 'failed' }));
  for (const [type, bad] of [
    ['removalPreview', rp({ items: Array(257).fill(item) })],
    ['removalPreview', rp({ items: [{ ...item, state: 'guess' }] })],
    ['removalPreview', rp({ items: [{ ...item, reason: 'Permission denied: /tmp/x' }] })],
    ['removalPreview', rp({ items: [{ ...item, target: '/tmp/p/.claude/settings.json' }] })],
    ['removalPreview', rp({ profileId: 'claude' })],
    ['removalPreview', preview()],
    ['removalApply', { status: 'needs-preview', preview: preview() }],
    ['removalApply', { status: 'applied', entries: [V], trustSteps: [] }],
    ['cleanupPreview', { status: 'preview', previewId: V, ttlMs: 1, items: [{ entry: V, cleanup: ['everything'] }] }],
    ['cleanupPreview', { status: 'preview', previewId: V, ttlMs: 1, items: Array(257).fill({ entry: V, cleanup: [] }) }],
    ['cleanupApply', { status: 'needs-preview', preview: { status: 'refused', code: 'busy' } }],
    ['cleanupApply', { status: 'cleaned', removed: ['x'], left: [] }],
  ] as const) assert.equal(reply(type, bad), null, `${type} ${JSON.stringify(bad).slice(0, 100)}`);
});

test('main always sets the service helper folder itself: packaged resources/bin, unpackaged empty (the repo helpers)', () => {
  const inherited = { PATH: '/bin', XAIBO_BIN: '/elsewhere/bin' };
  assert.deepEqual(serviceEnv(inherited, { dataDir: '/d', packaged: false, resourcesPath: '/R' }), { PATH: '/bin', XAIBO_BIN: '', XAIBO_DATA_DIR: '/d' });
  assert.deepEqual(serviceEnv(inherited, { dataDir: '/d', packaged: true, resourcesPath: '/R' }), { PATH: '/bin', XAIBO_BIN: '/R/bin', XAIBO_DATA_DIR: '/d' });
});

// XAIBO-PROD-560 (P6-T03 part 2b; review H2): the plugin step crosses the wire with the version, the argv with the plugin
// folder as a placeholder and the CLI write surfaces relative to the profile; never an absolute path or a parent segment.
test('2b plugin step: bounded cli view, placeholders and relative write surfaces only', () => {
  const step = (cli: object) => ({ route: 'claude-plugin', target: '/tmp/p/.claude/settings.json', diff: [{ pointer: '/enabledPlugins/xaibo-hooks@xaibo', new: true }], cli });
  const ok = { version: '2.1.319', argv: [['plugin', 'marketplace', 'add', '<plugin-dir>'], ['plugin', 'install', 'xaibo-hooks@xaibo', '-s', 'user']], writes: ['settings.json', '.claude.json', 'plugins/known_marketplaces.json', 'plugins/installed_plugins.json', 'plugins/cache/'] };
  assert.ok(reply('connectPreview', preview({ steps: [step(ok)] })));
  for (const bad of [
    { ...ok, argv: [['plugin', 'marketplace', 'add', '/tmp/x/integrations/claude-plugin/p1']] },
    { ...ok, writes: ['/tmp/p/.claude/settings.json'] },
    { ...ok, writes: ['../settings.json'] },
    { ...ok, version: 'latest' },
    { ...ok, argv: Array.from({ length: 5 }, () => ['plugin']) },
    { ...ok, argv: [Array.from({ length: 9 }, () => 'x')] },
    { ...ok, path: '/opt/claude' },
  ]) assert.equal(reply('connectPreview', preview({ steps: [step(bad)] })), null, JSON.stringify(bad).slice(0, 120));
  assert.equal(reply('connectPreview', preview({ steps: [{ ...preview().steps[0], cli: ok }] })), null, 'only the plugin step carries a cli view');
});
