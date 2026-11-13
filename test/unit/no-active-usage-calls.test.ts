// XAIBO-PROD-319 (P3-T15, FR-44, PRD §1.4 zero tokens): usage, context and quota come only from passive sources.
// Static guard over every shipped TypeScript source: no context or token-count commands, no headless agent runs and no
// URL literal other than loopback (quota/usage endpoints included). The runtime side (network) is the S10/P1-T05 audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const sources = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
  .filter((f) => /\.tsx?$/.test(f) && !f.split('/').includes('.cache'))
  .map((f) => join(ROOT, 'src', f));

const FORBIDDEN: [string, RegExp][] = [
  ['/context slash command', /['"`]\/context\b/],
  ['get_context_usage', /get_context_usage/],
  ['count_tokens', /count_tokens/],
  ['claude -p', /claude\s+-p\b/],
  ['codex exec', /codex\s+exec\b/],
  ['non-loopback URL', /\b(?:https?|wss?):\/\/(?!(?:127\.0\.0\.1|localhost|\[::1\])[:/])/],
];

test('FR-44: no active usage, context or token-count call in src/', () => {
  assert.ok(sources.length > 50, 'the scan sees the source tree');
  const hits = sources.flatMap((f) => {
    const text = readFileSync(f, 'utf8');
    return FORBIDDEN.filter(([, re]) => re.test(text)).map(([name]) => `${relative(ROOT, f)}: ${name}`);
  });
  assert.deepEqual(hits, []);
});

test('the guard itself catches each pattern', () => {
  for (const s of ["run('/context')", 'get_context_usage()', 'count_tokens', 'claude  -p x', 'codex exec "x"', 'fetch("https://example.invalid/usage")']) {
    assert.ok(FORBIDDEN.some(([, re]) => re.test(s)), s);
  }
  assert.ok(!FORBIDDEN.some(([, re]) => re.test("import x from './usage/context.ts'; fetch('http://127.0.0.1/')")));
});
