// P1-T04 E specs, run in P1-T05 (SEC1, P2, EC-55 CSP part): no Node in the renderer, no popups, no navigation away,
// permissions denied, and the CSP stops an injected inline script.
import { expect, test } from './fixtures.ts';

test('renderer: no Node globals, window.open denied, navigation blocked, media permission denied', async ({ xaibo }) => {
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  expect(await page.evaluate(() => [typeof (globalThis as Record<string, unknown>).require, typeof (globalThis as Record<string, unknown>).process]))
    .toEqual(['undefined', 'undefined']);
  expect(await page.evaluate(() => window.open('https://example.invalid/') === null)).toBe(true);
  await page.evaluate(() => { location.href = 'https://example.invalid/'; });
  await page.waitForTimeout(500);
  expect(page.url()).toBe('app://xaibo/index.html');
  expect(await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e: Error) => e.name))).not.toBe('granted');
});

test('CSP: an injected inline script does not run and raises a violation', async ({ xaibo }) => {
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  const r = await page.evaluate(() => new Promise<{ ran: boolean; violation: string }>((resolve) => {
    let violation = '';
    document.addEventListener('securitypolicyviolation', (e) => { violation = e.violatedDirective; });
    const s = document.createElement('script');
    s.textContent = 'window.__xaiboInline = true';
    document.body.append(s);
    setTimeout(() => resolve({ ran: (window as unknown as Record<string, unknown>).__xaiboInline === true, violation }), 200);
  }));
  expect(r.ran).toBe(false);
  expect(r.violation).toMatch(/^script-src/);
});
