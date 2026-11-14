// P3-T03 (EC-64): every hook template and engine-generated entry is a command pointing at the Xaibo shim; never a
// prompt or agent hook (they add tokens); async wherever the agent supports it (Stop stays synchronous, S3). The command
// must be exactly `'<shim>' hook <agent> <profile_key>`: the agent runs it through a shell (security review 379 #12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintHooks } from '../../src/service/config/hook-lint.ts';

const SHIM = '/tmp/xaibo-fixture/app/integrations/bin/xaibo-hook';
const cmd = (event: string, extra: Record<string, unknown> = {}) => ({ type: 'command', command: `'${SHIM}' hook claude p1`, ...extra, _e: event });
const claude = (entries: Record<string, unknown[]>) => ({
  hooks: Object.fromEntries(Object.entries(entries).map(([e, hs]) => [e, [{ hooks: hs.map((h) => { const { _e, ...rest } = h as Record<string, unknown>; void _e; return rest; }) }]])),
});

test('a valid Claude-shaped template passes: async everywhere but Stop', () => {
  const t = claude({ SessionStart: [cmd('SessionStart', { async: true })], Stop: [cmd('Stop')] });
  assert.deepEqual(lintHooks(t, { shim: SHIM, asyncRequired: true }), []);
});

test('a valid agy-shaped template passes (named group, direct and matcher entries)', () => {
  const t = { xaibo: { Stop: [{ type: 'command', command: `'${SHIM}' hook agy p2`, timeout: 10 }], PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `'${SHIM}' hook agy p2` }] }] } };
  assert.deepEqual(lintHooks(t, { shim: SHIM, asyncRequired: false }), []);
});

test('prompt and agent hooks are rejected (EC-64)', () => {
  for (const type of ['prompt', 'agent']) {
    assert.ok(lintHooks({ hooks: { Stop: [{ hooks: [{ type, prompt: 'x' }] }] } }, { shim: SHIM, asyncRequired: false }).includes('forbidden-type'), type);
  }
});

test('non-command types, missing async and foreign commands are rejected', () => {
  const opts = { shim: SHIM, asyncRequired: true };
  assert.ok(lintHooks({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://localhost/x' }] }] } }, opts).includes('not-command'));
  assert.ok(lintHooks(claude({ PreToolUse: [cmd('PreToolUse')] }), opts).includes('async-required'));
  assert.ok(lintHooks(claude({ Stop: [{ type: 'command', command: '/tmp/xaibo-fixture/other.sh' }] }), opts).includes('not-shim'));
  for (const command of [`'${SHIM}-evil' hook claude p1`, `${SHIM} hook claude p1`, `'${SHIM}' hook claude p1; curl x`, `'${SHIM}' hook claude p1 && x`, `'${SHIM}' hook claude $(id)`, `'${SHIM}' hook Claude p1`]) {
    assert.ok(lintHooks(claude({ Stop: [{ type: 'command', command }] }), opts).includes('not-shim'), command);
  }
  assert.throws(() => lintHooks({}, { shim: "/tmp/xaibo-fixture/it's/xaibo-hook", asyncRequired: false }), /quote/);
  assert.ok(lintHooks({ hooks: {} }, opts).includes('empty'), 'a template with no hook entry is a bug');
});
