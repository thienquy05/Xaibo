// XAIBO-PROD-306 (P3-T06, FR-31, S5, FR-51): the Codex 0.160.0 hook groups Xaibo appends (one per event, the stable
// shim, async only where S5 saw it accepted, SessionEnd synchronous) and the payload -> evidence mapping (the remainder
// raw). Recorded shapes come from the S5 key sets (spikes/s5/evidence/hooks/reduced.json); values are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_ASYNC_EVENTS, CODEX_HOOK_EVENTS } from '../../src/service/adapters/codex/hooks.ts';
import { codexHookOps } from '../../src/service/adapters/codex/setup.ts';
import { lintHooks } from '../../src/service/config/hook-lint.ts';

const REPO = join(import.meta.dirname, '..', '..');
const FIX = join(REPO, 'test', 'fixtures', 'synthetic', 'codex', '0.160.0', 'hooks');
const SHIM = '/tmp/xaibo-fixture/data/integrations/bin/xaibo-hook';
const payloads = readdirSync(FIX).flatMap((c) => {
  let text = '';
  try { text = readFileSync(join(FIX, c, 'hooks.jsonl'), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
});

test('the subscribed set is the 0.160.0 event list; async only on SessionStart and PostToolUse (S5 2.4)', () => {
  assert.deepEqual([...CODEX_HOOK_EVENTS], ['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreToolUse',
    'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'Stop', 'Interrupt']);
  assert.deepEqual([...CODEX_ASYNC_EVENTS], ['SessionStart', 'PostToolUse']);
  assert.ok(!CODEX_HOOK_EVENTS.some((e) => /ModelRequest/.test(e)), 'Pre/PostModelRequest do not exist on 0.160.0 (S5 2.6)');
});

test('ops: one appended group per event, the shim command only, async where S5 allowed, lint clean', () => {
  const ops = codexHookOps(SHIM, 'p1');
  assert.deepEqual(ops.map((o) => [o.op, o.pointer]), CODEX_HOOK_EVENTS.map((e) => ['append', `/hooks/${e}`]));
  for (const o of ops) {
    const ev = o.pointer.split('/')[2]!;
    const hook = { type: 'command', command: `'${SHIM}' hook codex p1`, ...(CODEX_ASYNC_EVENTS.includes(ev as never) ? { async: true } : {}) };
    assert.deepEqual(o.value, { hooks: [hook] }, ev);
  }
  const doc = { hooks: Object.fromEntries(ops.map((o) => [o.pointer.split('/')[2]!, [o.value]])) };
  const syncEvents = CODEX_HOOK_EVENTS.filter((e) => !CODEX_ASYNC_EVENTS.includes(e as never));
  assert.deepEqual(lintHooks(doc, { shim: SHIM, asyncRequired: true, syncEvents }), []);
  assert.throws(() => codexHookOps(SHIM, '../x'));
  assert.throws(() => codexHookOps("/tmp/it's/xaibo-hook", 'p1'));
});

test('the fixtures carry exactly the key sets S5 recorded', () => {
  const reduced = JSON.parse(readFileSync(join(REPO, 'spikes', 's5', 'evidence', 'hooks', 'reduced.json'), 'utf8')) as Record<string, { keys: object }>;
  for (const p of payloads) {
    const ev = p['hook_event_name'] as string;
    assert.ok(reduced[ev], ev);
    const want = Object.keys(reduced[ev]!.keys).filter((k) => !k.includes('.')).sort(); // top-level keys only
    assert.deepEqual(Object.keys(p).sort(), want, ev);
  }
});
