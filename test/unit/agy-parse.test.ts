// XAIBO-PROD-211 (P2-T11): agy 1.5.6 transcript_full.jsonl records (T00 schema) -> records. Identity is
// (step_index, line hash), so a rewritten step gets a new id and an unchanged replay the same one; unknown types are
// kept raw; records without a step index never take part in revisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLine } from '../../src/service/adapters/agy/parse.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'agy', '1.5.6', 'basic', 'brain', '00000000-0000-4000-8000-0000000a0001',
  '.system_generated', 'logs', 'transcript_full.jsonl');
const ctx = { offset: 0, fileMtime: 5, receivedTs: 9 };
const parse = (line: string, offset = 0) => parseLine(Buffer.from(line), { ...ctx, offset });
const ok = (line: string) => { const r = parse(line); assert.ok(r?.ok); return r.record; };

test('fixture records map to kinds, roles, steps, timestamps and content', () => {
  const recs = readFileSync(FIX, 'utf8').split('\n').filter(Boolean).map(ok);
  assert.deepEqual(recs.map((r) => [r.kind, r.role, r.step, r.sourceSeq]), [
    ['user', 'user', 0, 0], ['system', 'system', 1, 1], ['assistant', 'assistant', 2, 2], ['tool_output', 'tool', 3, 3], ['assistant', 'assistant', 4, 4],
  ]);
  assert.equal(recs[0]!.sourceTs, Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(recs[1]!.injected, true, 'system messages are injected context, never a prompt');
  assert.equal(recs[0]!.injected, false);
  assert.equal(recs[3]!.content, 'fixture notes: alpha bravo');
  assert.deepEqual(recs[2]!.usage, { input_tokens: 1200, cache_read_tokens: 800, output_tokens: 40 });
  assert.equal(recs[3]!.usage, undefined);
  assert.deepEqual(recs[2]!.toolNames, ['read_file'], 'tool calls have no id in transcripts: names only');
  assert.deepEqual(recs[4]!.toolNames, []);
  assert.equal(recs[2]!.fileMtime, 5);
  assert.equal(recs[2]!.receivedTs, 9);
});

test('identity: same step and bytes -> same id at any offset; changed content -> a new id', () => {
  const a = '{"step_index":2,"type":"PLANNER_RESPONSE","content":"one"}';
  const b = '{"step_index":2,"type":"PLANNER_RESPONSE","content":"two"}';
  const ra = parse(a, 0);
  const rb = parse(a, 999);
  assert.ok(ra?.ok && rb?.ok);
  assert.equal(ra.record.nativeId, rb.record.nativeId);
  assert.match(ra.record.nativeId, /^step:2:[0-9a-f]{16}$/);
  const rc = parse(b);
  assert.ok(rc?.ok);
  assert.notEqual(rc.record.nativeId, ra.record.nativeId);
});

test('unknown types are kept raw as unknown; missing step index -> no revision identity', () => {
  const u = ok('{"step_index":7,"type":"FUTURE_TYPE","content":"x"}');
  assert.equal(u.kind, 'unknown');
  assert.equal(u.raw, '{"step_index":7,"type":"FUTURE_TYPE","content":"x"}');
  for (const line of ['{"type":"USER_INPUT","content":"x"}', '{"step_index":-1,"type":"USER_INPUT"}', '{"step_index":1.5,"type":"USER_INPUT"}']) {
    const r = ok(line);
    assert.equal(r.step, null);
    assert.equal(r.sourceSeq, -1);
    assert.match(r.nativeId, /^line:/);
  }
  assert.equal(ok('{"step_index":1,"type":"USER_INPUT","created_at":"not a date"}').sourceTs, undefined);
});

test('malformed or non-object lines are reported; blank lines skipped', () => {
  assert.deepEqual(parse('{"step_index":'), { ok: false, reason: 'malformed' });
  assert.deepEqual(parse('[1,2]'), { ok: false, reason: 'malformed' });
  assert.equal(parse('   '), null);
  const noNumbers = ok('{"step_index":2,"type":"PLANNER_RESPONSE","input_tokens":"many"}');
  assert.deepEqual(noNumbers.usage, {}, 'non-numeric token fields are dropped (NULL later), never coerced');
});
