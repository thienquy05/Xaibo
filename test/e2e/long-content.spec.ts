// XAIBO-PROD-422 (P4-T09b; EC-56 E, design §5.2): a synthetic 50 MB single-line tool output (above the 8 MiB parse cap,
// so a Large record served in 16 KiB slices) and a NUL/control-byte blob in the packaged app. Expanding, Load more text
// and Load previous work by keyboard; at most 4 slices stay in the DOM; controls show as escapes while newline and tab
// stay layout; no main-thread long task over 100 ms (PerformanceObserver longtask) from launch to the end.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, openSessions, test } from './fixtures.ts';

const SID = '00000000-0000-4000-8000-00000000e601';
const CWD = '/tmp/xaibo-fixture/long-content';
// Review M1/M2: every line is numbered (slices are distinguishable) and carries NUL, ESC and a bidi override, so the
// longtask measurement covers escaped text at full size.
const line = (i: number) => `line ${String(i).padStart(7, '0')} é € 😀 \u0000\u001b[31m‮ ok\n`;
const BIG = (() => {
  const parts: string[] = [];
  for (let i = 0, bytes = 0; bytes < 50e6; i++) { const l = line(i); parts.push(l); bytes += Buffer.byteLength(l); }
  return parts.join('');
})();
const BLOB = 'Control blob:\u0000\u001b[31mred\u001b[0m‮evil\ttabbed\nsecond line';
const LAST = '00000000-0000-4000-8000-00000000e004'; // the blob response, after the 50 MB line
/** True once the store holds the record (read-only, as the hook-socket helper reads the profile). */
const stored = (dataDir: string, uuid: string) => {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true });
    return db.prepare('SELECT 1 FROM events WHERE native_id = ?').get(uuid) !== undefined;
  } catch { return false; } finally { db?.close(); }
};
let n = 0;
const rec =(type: 'user' | 'assistant', s: number, message: object) => JSON.stringify({ parentUuid: null, isSidechain: false, type,
  uuid: `00000000-0000-4000-8000-00000000e${String(++n).padStart(3, '0')}`, timestamp: `2026-01-05T10:00:0${s}.000Z`, userType: 'external',
  entrypoint: 'cli', cwd: CWD, sessionId: SID, version: '2.1.319', message });

test('a 50 MB line and a control blob: keyboard slices, a 4-slice window, escapes, no long task over 100 ms', async ({ xaibo }) => {
  test.setTimeout(180_000);
  xaibo.touchStore(() => {
    const dir = path.join(xaibo.home, '.claude', 'projects', '-tmp-xaibo-fixture-long-content');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${SID}.jsonl`), [
      rec('user', 1, { role: 'user', content: 'Run the full build' }),
      rec('assistant', 2, { model: 'claude-opus-5-5', id: 'msg_lc_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_lc', name: 'Bash', input: { command: 'make' } }] }),
      rec('user', 3, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_lc', content: BIG, is_error: false }] }),
      rec('assistant', 4, { model: 'claude-opus-5-5', id: 'msg_lc_2', role: 'assistant', content: [{ type: 'text', text: BLOB }], stop_reason: 'end_turn' }),
    ].join('\n') + '\n');
  });
  const dataDir = path.join(path.dirname(xaibo.home), 'data-long');
  const run = await xaibo.launch({ dataDir });
  const page = await xaibo.window(run);
  await page.evaluate(() => {
    const w = window as unknown as { __longest: number };
    w.__longest = 0;
    new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__longest = Math.max(w.__longest, e.duration); }).observe({ type: 'longtask', buffered: true });
  });

  // Open only once the whole file is stored: an open conversation does not take in later records yet ("New activity
  // available" is a P4-T05 carry-over), and the 50 MB line takes a while to ingest.
  await expect.poll(() => stored(dataDir, LAST), { timeout: 120_000, intervals: [500] }).toBe(true);
  await openSessions(page);
  const open = page.getByRole('list', { name: 'Sessions' }).getByRole('button').filter({ hasText: CWD });
  await expect(open).toHaveCount(1, { timeout: 20_000 });
  await open.click();
  const convo = page.getByRole('list', { name: 'Conversation' });

  // A large record counts its size toward the page budget, so the page ends after it: continue explicitly, by keyboard.
  const next = page.getByRole('region', { name: 'Conversation' }).getByRole('button', { name: 'Load more', exact: true });
  await next.focus();
  await page.keyboard.press('Enter');

  // The blob: NUL, ESC, bidi and C1 controls are escapes; newline and tab are layout.
  const blob = convo.locator('p.x-text').filter({ hasText: 'Control blob:' });
  await expect(blob).toBeVisible({ timeout: 20_000 });
  expect((await blob.textContent()) ?? '').toContain('\\x00\\x1B[31mred\\x1B[0m\\u202Eevil\ttabbed\nsecond line');

  // The 50 MB output: expand by keyboard, then Load more text five times, then Load previous.
  const large = convo.locator('summary').filter({ hasText: 'Large record' });
  await expect(large).toContainText('MB');
  await large.focus();
  await page.keyboard.press('Enter');
  const step = convo.locator('details').filter({ has: page.locator('summary', { hasText: 'Large record' }) });
  const pre = step.locator('pre.x-code');
  await expect(pre).toContainText('line 0000000 é € 😀 \\x00\\x1B[31m\\u202E ok\nline 0000001', { timeout: 20_000 });
  const spans = pre.locator('span');
  const id = (t: string | null) => (t ?? '').slice(0, 80); // a slice's identity: its first 80 characters (numbered lines)
  const window = async () => (await spans.evaluateAll((els) => els.map((e) => e.textContent))).map(id);
  const ids = [id(await spans.first().textContent())];
  const more = step.getByRole('button', { name: 'Load more text' });
  for (let i = 0; i < 5; i++) {
    await more.focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => id(await spans.last().textContent()), { timeout: 10_000 }).not.toBe(ids.at(-1)); // the fetch landed
    ids.push(id(await spans.last().textContent()));
  }
  expect(new Set(ids).size).toBe(6);
  expect(await window()).toEqual(ids.slice(2)); // the two earliest slices were evicted
  await expect(step.getByText('More content available')).toBeVisible();
  const kept = await spans.evaluateAll((els) => els.map((e) => e.textContent!.length));
  expect(kept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4 * 16 * 1024 * 4); // 4 slices, escapes at most ~4x
  const previous = step.getByRole('button', { name: 'Load previous' });
  await previous.focus();
  await page.keyboard.press('Enter');
  await expect.poll(window, { timeout: 10_000 }).toEqual(ids.slice(1, 5)); // the latest evicted slice is back; the last went
  await expect(previous).toHaveText('Load previous'); // one more evicted slice remains
  // XAIBO-PROD-435: two activations in one tick fetch the slice once; the button then unmounts and focus moves to the
  // text (not the page body); the state change is announced in the item's live region
  await previous.evaluate((b: HTMLElement) => { b.click(); b.click(); });
  await expect.poll(window, { timeout: 10_000 }).toEqual(ids.slice(0, 4));
  await expect(previous).toHaveCount(0);
  await expect(pre).toBeFocused();
  await expect(step.locator('[aria-live="polite"]').first()).toHaveText('Earlier text loaded');
  expect(await pre.textContent()).not.toContain('�');

  const longest = await page.evaluate(() => (window as unknown as { __longest: number }).__longest);
  console.log(`long-content longest main-thread task (ms): ${longest} (entries are reported from 50 ms; 0 = none)`);
  test.info().annotations.push({ type: 'longest-task-ms', description: String(longest) });
  expect(longest).toBeLessThanOrEqual(100);
  // Control: the observer does see a long task (a deliberate 150 ms busy loop, scheduled as a real task, after the
  // measurement; code run directly by the test driver is not a scheduled task and is not reported).
  expect(await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes('longtask'))).toBe(true);
  await page.evaluate(() => { setTimeout(() => { const end = performance.now() + 150; while (performance.now() < end) { /* busy */ } }, 0); });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __longest: number }).__longest)).toBeGreaterThanOrEqual(140);
});
