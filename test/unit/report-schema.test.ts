// XAIBO-PROD-313 (P3-T13a; PRD §5.10): report event contract v1. Every synthetic conformance line parses; an unsupported
// version is rejected with a fixed code before anything else is read; unknown event kinds are kept (coverage warning
// downstream), unknown fields and malformed values are rejected with fixed codes that never echo a value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReport } from '../../src/shared/report/schema.ts';

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'replay', 'report', 'v1');
const lines = readdirSync(ROOT).flatMap((c) => readFileSync(join(ROOT, c, 'report.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>));
const base = { v: 1, delivery_id: 'd-1', session_id: 's-1', producer_id: 'p', producer_seq: 1, event: 'turn.start', source_ts: '2026-01-01T00:00:00.000Z', payload: {} };

test('every conformance fixture line parses, keeping its fields', () => {
  assert.ok(lines.length >= 30);
  for (const l of lines) {
    const r = parseReport(l);
    assert.ok(r.ok, `${String(l['delivery_id'])}: ${r.ok ? '' : r.code}`);
    assert.deepEqual(r.event, l);
  }
});

test('unsupported version: rejected with a fixed code, nothing else read', () => {
  const evil = { ...base, v: 2, payload: { get x() { throw new Error('read'); } } };
  assert.deepEqual(parseReport(evil), { ok: false, code: 'unsupported-version' });
  assert.deepEqual(parseReport({ ...base, v: '1' }), { ok: false, code: 'unsupported-version' });
  assert.deepEqual(parseReport('{"v":1}'), { ok: false, code: 'malformed' });
  assert.deepEqual(parseReport([base]), { ok: false, code: 'malformed' });
});

test('unknown event kinds are kept; unknown fields and bad values are rejected with fixed codes', () => {
  const r = parseReport({ ...base, event: 'notification', payload: { message: 'm' } });
  assert.ok(r.ok && r.event.event === 'notification');
  const bad: [Record<string, unknown>, string][] = [
    [{ ...base, extra: 1 }, 'invalid-field'],
    [{ ...base, delivery_id: '' }, 'invalid-delivery_id'],
    [{ ...base, delivery_id: 'x'.repeat(129) }, 'invalid-delivery_id'],
    [{ ...base, session_id: 7 }, 'invalid-session_id'],
    [{ ...base, producer_seq: -1 }, 'invalid-producer_seq'],
    [{ ...base, producer_seq: 1.5 }, 'invalid-producer_seq'],
    [{ ...base, event: 'Bad Event!' }, 'invalid-event'],
    [{ ...base, source_ts: 5 }, 'invalid-source_ts'],
    [{ ...base, payload: [] }, 'invalid-payload'],
    [{ ...base, request_id: 3 }, 'invalid-request_id'],
    [{ ...base, model: { id: 'm', extra: 1 } }, 'invalid-model'],
    [{ ...base, model: { display_name: 'M' } }, 'invalid-model'],
    [{ ...base, effort: 9 }, 'invalid-effort'],
    [{ ...base, event: 'content.upsert', payload: { revision: 1, role: 'user', kind: 'message', content: 'c', chunk_index: 0, final: true } }, 'invalid-item_id'],
    [{ ...base, event: 'content.upsert', item_id: 'i', payload: { revision: 0, role: 'user', kind: 'message', content: 'c', chunk_index: 0, final: true } }, 'invalid-content'],
    [{ ...base, event: 'content.upsert', item_id: 'i', payload: { revision: 1, role: 'user', kind: 'message', content: 'c', chunk_index: -1, final: true } }, 'invalid-content'],
    [{ ...base, event: 'content.upsert', item_id: 'i', payload: { revision: 1, role: 'user', kind: 'message', content: 5, chunk_index: 0, final: true } }, 'invalid-content'],
    [{ ...base, event: 'content.upsert', item_id: 'i', payload: { revision: 1, role: 'user', kind: 'message', content: 'c', chunk_index: 0 } }, 'invalid-content'],
  ];
  for (const [x, code] of bad) assert.deepEqual(parseReport(x), { ok: false, code }, JSON.stringify(x).slice(0, 120));
  for (const [x] of bad) assert.doesNotMatch(JSON.stringify(parseReport(x)), /Bad Event|xxxx/);
});

test('optional correlation, model and effort are accepted', () => {
  const r = parseReport({ ...base, turn_id: 't', item_id: 'i', parent_id: 'p', request_id: 'r', cwd: '/tmp/x', model: { id: 'm-1', display_name: 'M 1' }, effort: 'high' });
  assert.ok(r.ok);
});
