// XAIBO-PROD-424 (P4-T05 carry-over; design §5.2/§6.3): an open conversation takes in records stored after it opened,
// even when their timestamps are older than the session's last activity (an import or backfill); a window that does
// not reach the end offers New activity available with Go to latest instead of moving the anchor.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, openSessions, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

const SHORT = '00000000-0000-4000-8000-00000000e701', LONG = '00000000-0000-4000-8000-00000000e702';
const cwd = (sid: string) => `/tmp/xaibo-fixture/refresh-${sid.slice(-3)}`;
let n = 0;
// Every record is dated 2026-01-06, long before now: appends never raise the session's last activity.
const rec = (sid: string, s: number, text: string) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user',
  uuid: `00000000-0000-4000-8000-0000000f${String(++n).padStart(4, '0')}`, timestamp: new Date(Date.UTC(2026, 0, 6, 10, 0, s)).toISOString(),
  userType: 'external', entrypoint: 'cli', cwd: cwd(sid), sessionId: sid, version: '2.1.319', message: { role: 'user', content: text } });
const open = async (page: Page, sid: string) => {
  await page.getByRole('list', { name: 'Sessions' }).getByRole('button').filter({ hasText: cwd(sid) }).click();
  await expect(page.locator('#open-session-title')).toBeFocused();
};

test('records stored after a conversation opened appear at its end; a scrolled-back window offers New activity available', async ({ xaibo }) => {
  const project = (sid: string) => path.join(xaibo.home, '.claude', 'projects', `-tmp-xaibo-fixture-refresh-${sid.slice(-3)}`);
  const file = (sid: string) => path.join(project(sid), `${sid}.jsonl`);
  xaibo.touchStore(() => {
    for (const sid of [SHORT, LONG]) mkdirSync(project(sid), { recursive: true });
    writeFileSync(file(SHORT), [rec(SHORT, 30, 'First prompt'), rec(SHORT, 40, 'Second prompt')].join('\n') + '\n');
    writeFileSync(file(LONG), Array.from({ length: 70 }, (_, i) => rec(LONG, 50, `Long prompt ${i}`)).join('\n') + '\n'); // > one 50-item page
  });
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  await openSessions(page);
  await expect(page.getByRole('list', { name: 'Sessions' }).getByRole('button').filter({ hasText: cwd(LONG) })).toHaveCount(1, { timeout: 20_000 });
  const convo = page.getByRole('list', { name: 'Conversation' });

  // A window at the end: an old-timestamped append shows without reopening, and no notice is offered.
  await open(page, SHORT);
  await expect(convo).toContainText('Second prompt');
  xaibo.touchStore(() => appendFileSync(file(SHORT), `${rec(SHORT, 10, 'Imported later, dated earlier')}\n`));
  await expect(convo).toContainText('Imported later, dated earlier', { timeout: 15_000 });
  await page.waitForTimeout(1_500); // review: a notice that would appear late (the side refresh is throttled to 1 s)
  await expect(page.locator('p.x-earlier').filter({ hasText: 'New activity available' })).toHaveCount(0);

  // A window that does not reach the end (an ended session opens at its first turn): the anchor stays, a notice offers
  // Go to latest, which loads the new record.
  await open(page, LONG);
  await expect(convo).toContainText('Long prompt 0');
  xaibo.touchStore(() => appendFileSync(file(LONG), `${rec(LONG, 20, 'Newest long prompt')}\n`));
  const notice = page.locator('p.x-earlier').filter({ hasText: 'New activity available' }); // polite live text; the one status role is health
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(convo).toContainText('Long prompt 0'); // the anchor did not move
  await notice.getByRole('button', { name: 'Go to latest' }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.locator('.x-foot').getByRole('button', { name: 'Go to latest' })).toBeFocused(); // review M4: focus kept on a stable control
  await expect.poll(async () => convo.evaluate((el) => { const s = el.parentElement!; s.scrollTop = s.scrollHeight; return el.textContent ?? ''; }))
    .toContain('Newest long prompt');
});
