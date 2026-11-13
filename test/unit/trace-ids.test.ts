// XAIBO-PROD-320 (P3-T16a, D-P3-18; P3-T10 review L2 note): the test-only perf trace writes ids, never content. Record
// ids come from untrusted files, so only derived shapes are traced: UUIDs, Codex file identity + byte offset, and agy
// line/step + content hash. Anything else (paths, free text, oversized numbers) is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceableIds } from '../../src/service/trace-ids.ts';

test('traced: UUIDs, Codex <16 hex>:<offset>, agy line|step:<n>:<16 hex>', () => {
  const ok = ['00000000-0000-4000-8000-0000000f1112', '0123456789abcdef:0', '0123456789abcdef:123456', 'line:42:0123456789abcdef', 'step:7:fedcba9876543210'];
  assert.deepEqual(traceableIds(ok), ok);
});

test('dropped: paths, free text, other shapes and oversized offsets', () => {
  const bad = ['/tmp/xaibo-fixture/a.jsonl', 'synthetic prompt', 'h:0123456789abcdef', '0123456789ABCDEF:1', '0123456789abcdef:', 'line:1:0123',
    `0123456789abcdef:${'9'.repeat(16)}`, 'step:x:0123456789abcdef', '0123456789abcdef:1\n{"ev":"x"}'];
  assert.deepEqual(traceableIds(bad), []);
});
