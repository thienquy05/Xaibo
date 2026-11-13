// XAIBO-PROD-111 (P1-T13, EC-35): every shipped egress path in the registry has its canary test, titled
// `canary: <id>`, in the test file the registry names. MCP, OTLP and export join the registry when they ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EGRESS } from '../../src/shared/egress.ts';

const root = join(import.meta.dirname, '..', '..');

test('the registry lists the Phase 1 egress paths', () => {
  assert.deepEqual(EGRESS.map((e) => e.id).sort(), ['diagnostics', 'error-records', 'logs', 'test-artifacts', 'usage-account']);
});

test('each registered path has a canary test', () => {
  for (const e of EGRESS) {
    const src = readFileSync(join(root, e.test), 'utf8');
    assert.ok(src.includes(`test('canary: ${e.id}'`), `${e.test} has no "canary: ${e.id}" test`);
  }
});
