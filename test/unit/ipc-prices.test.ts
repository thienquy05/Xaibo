// XAIBO-PROD-568 (P6-T11; review R5/R8): the prices request and reply are validated like every port message; the reply's
// bounds equal the price schema's (32 fallbacks, 64 models, 8 cache classes), so a schema-valid override always gets through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortMessage, parsePortRequest, type PriceView } from '../../src/shared/ipc.ts';

const view = (o: Partial<PriceView> = {}): PriceView => ({ source: 'override', revision: 'owner-1', pricesAsOf: '2026-11-12', error: null, fallbacks: [], ...o });
const reply = (v: unknown, check: unknown = null) => parsePortMessage({ v: 1, type: 'prices', id: 3, view: v, check });

test('prices request: a count id and one of get, validate, reload', () => {
  for (const op of ['get', 'validate', 'reload']) assert.deepEqual(parsePortRequest({ v: 1, type: 'prices', id: 1, op }), { v: 1, type: 'prices', id: 1, op });
  for (const bad of [{ op: 'apply' }, { op: 'get', id: -1 }, { op: 'get', id: 1.5 }, {}]) assert.equal(parsePortRequest({ v: 1, type: 'prices', id: 1, ...bad }), null, JSON.stringify(bad));
});

test('prices reply: a view at the schema maximum parses; check values are fixed', () => {
  const rates = { input: 0, output: 100000, cache_read: 0.0000001, cache_write: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`${i + 1}m`, 1])) };
  const fallbacks = Array.from({ length: 32 }, (_, i) => ({ models: Array.from({ length: 64 }, (_, j) => `m${i}-${j}`), agent: i % 2 ? 'codex' : null, rates }));
  const big = view({ fallbacks, revision: 'r'.repeat(64) });
  assert.deepEqual(reply(big), { v: 1, type: 'prices', id: 3, view: big, check: null });
  for (const check of ['absent', 'valid', 'override_json']) assert.equal((reply(view(), check) as { check: unknown } | null)?.check, check);
  assert.deepEqual(reply(null), { v: 1, type: 'prices', id: 3, view: null, check: null });
  assert.equal(reply(view(), 'maybe'), null);
});

test('prices reply: shapes and bounds outside the schema are dropped', () => {
  const r = { input: 1, output: 2 };
  for (const [why, v] of [
    ['source', view({ source: 'remote' as never })],
    ['revision too long', view({ revision: 'r'.repeat(65) })],
    ['empty revision', view({ revision: '' })],
    ['date pattern', view({ pricesAsOf: '12 Nov 2026' })],
    ['error code', view({ error: 'boom' as never })],
    ['33 fallbacks', view({ fallbacks: Array.from({ length: 33 }, () => ({ models: ['m'], agent: null, rates: r })) })],
    ['65 models', view({ fallbacks: [{ models: Array.from({ length: 65 }, (_, i) => `m${i}`), agent: null, rates: r }] })],
    ['no models', view({ fallbacks: [{ models: [], agent: null, rates: r }] })],
    ['model id pattern', view({ fallbacks: [{ models: ['bad id'], agent: null, rates: r }] })],
    ['agent pattern', view({ fallbacks: [{ models: ['m'], agent: 'Codex!', rates: r }] })],
    ['non-finite rate', view({ fallbacks: [{ models: ['m'], agent: null, rates: { input: Infinity, output: 1 } }] })],
    ['negative rate', view({ fallbacks: [{ models: ['m'], agent: null, rates: { input: -1, output: 1 } }] })],
    ['rate above max', view({ fallbacks: [{ models: ['m'], agent: null, rates: { input: 100001, output: 1 } }] })],
    ['cache class name', view({ fallbacks: [{ models: ['m'], agent: null, rates: { ...r, cache_write: { 'five minutes': 1 } } }] })],
    ['9 cache classes', view({ fallbacks: [{ models: ['m'], agent: null, rates: { ...r, cache_write: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`${i + 1}h`, 1])) } }] })],
    ['extra key', { ...view(), extra: 1 }],
  ] as const) assert.equal(reply(v), null, why);
});
