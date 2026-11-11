// XAIBO-PROD-110 (P1-T12, EC-55, SEC3): hostile transcript strings (HTML, script, markdown, ANSI, bidi) in the cwd and
// entrypoint render as text only: textContent equals the visible form of the raw string, no element is created from
// them, a sentinel global stays unset and no CSP violation fires. Titles stay "Untitled" in Phase 1 (title record
// shapes unverified, S9), so the cwd and entrypoint carry the case.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { visible } from '../../src/renderer/text.ts';
import { expect, test } from './fixtures.ts';

const SESSION = '00000000-0000-4000-8000-00000000e550';
const CWD = '/tmp/xaibo-fixture/<img src=x onerror="window.__xss=1">**bold** [l](javascript:alert(1)) \u001b[31mred<script>window.__xss=2</script>';
const ENTRY = '<b onmouseover="window.__xss=3">cli</b>‮gnp.exe';

test('EC-55: injected markup, markdown, ANSI and bidi render as escaped text', async ({ xaibo }) => {
  xaibo.touchStore(() => {
    const dir = path.join(xaibo.home, '.claude', 'projects', '-tmp-xaibo-fixture-hostile');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${SESSION}.jsonl`), JSON.stringify({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-00000000e551',
      timestamp: '2026-01-03T00:00:00.000Z', cwd: CWD, entrypoint: ENTRY, sessionId: SESSION, message: { role: 'user', content: 'x' } }) + '\n');
  });
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  // Count CSP violations from a clean load: install the listener for every document, then reload.
  await run.app!.context().addInitScript(() => {
    const w = window as unknown as { violations: number };
    w.violations = 0;
    document.addEventListener('securitypolicyviolation', () => { w.violations++; });
  });
  await page.reload();
  const row = page.getByRole('table', { name: 'Sessions' }).locator('tbody tr', { hasText: 'xaibo-fixture/<img' });
  await expect(row).toHaveCount(1);
  expect(await row.getByRole('cell').nth(2).textContent()).toBe(visible(CWD));
  expect(await row.getByRole('cell').nth(1).textContent()).toBe(visible(ENTRY));
  expect(await page.locator('img').count()).toBe(0);
  expect(await page.locator('main b, main script, table b, table script').count()).toBe(0);
  expect(await page.locator('script').evaluateAll((s) => s.filter((x) => (x.textContent ?? '').includes('__xss')).length)).toBe(0);
  await row.hover();
  expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
  expect(await page.evaluate(() => (window as unknown as { violations: number }).violations)).toBe(0);
});
