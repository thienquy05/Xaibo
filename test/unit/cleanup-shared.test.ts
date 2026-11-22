// XAIBO-PROD-501 (Phase 5 cleanup unit A, D-P4-13): one shared isObj, one evidence-row parse, session-detail's
// message() shared, no test-only exports, fs-private without its own write loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isObj } from '../../src/shared/ipc.ts';
import { parseEvidence } from '../../src/service/status/engine.ts';
import * as detail from '../../src/service/session-detail.ts';
import * as fsPrivate from '../../src/service/fs-private.ts';

test('isObj: a plain object only', () => {
  assert.equal(isObj({}), true);
  assert.equal(isObj({ a: 1 }), true);
  for (const v of [null, undefined, [], [1], 'x', 1, true]) assert.equal(isObj(v), false);
});

// The SEA mains (src/forwarder/*) must stay self-contained, so they keep their own copy.
test('src/ defines isObj once (plus the SEA main copy)', () => {
  const src = join(import.meta.dirname, '..', '..', 'src');
  const found = (readdirSync(src, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => /\b(?:const|function)\s+isObj(?:ect)?\b/.test(readFileSync(join(src, f), 'utf8')))
    .sort();
  assert.deepEqual(found, ['forwarder/statusline-tee.ts', 'shared/ipc.ts']);
});

test('parseEvidence: a JSON array of objects with a string k, else null', () => {
  assert.deepEqual(parseEvidence(JSON.stringify([{ k: 'session.start' }])), [{ k: 'session.start' }]);
  assert.deepEqual(parseEvidence('[]'), []);
  for (const bad of ['{bad', '{}', 'null', '"s"', '[[]]', '[{"k":1}]', '[null]', '[{"k":"a"},[]]']) assert.equal(parseEvidence(bad), null, bad);
});

test('session-detail: message() shared; test-only exports gone', () => {
  assert.deepEqual(detail.message(JSON.stringify({ message: { content: 'x' } })), { content: 'x' });
  for (const bad of ['{bad', '[]', JSON.stringify({ message: 5 }), JSON.stringify({ message: [] })]) assert.equal(detail.message(bad), undefined);
  assert.equal('claudeMessageParts' in detail, false);
  assert.equal('subagentModel' in detail, false);
});

test('fs-private: no own write loop', () => {
  assert.equal('writeAll' in fsPrivate, false);
});
