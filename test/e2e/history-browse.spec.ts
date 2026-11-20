// XAIBO-PROD-529 (P5-T18 part 3a; design §6.4; look D-P5-09): the Session list as a history browser in the packaged app.
// Synthetic Claude sessions in two folders plus the Codex/Antigravity fixtures: the mode group (aria-pressed, roving
// arrows without activation, Enter activates), empty Archived/Trash, search with emphasized snippets, the coverage note
// and zero matches, Clear search, the agent filter, a folder group from Projects and folders, and no horizontal scroll at
// the minimum window. Pin/Keep/Trash rows need part 3b's actions (their lines are covered at U level).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openSessions, seedCodexAgy, shot, test } from './fixtures.ts';

const sid = (i: number) => `00000000-0000-4000-8000-00000000ab${String(i).padStart(2, '0')}`;
function claude(home: string, i: number, cwd: string, prompt: string) {
  const dir = path.join(home, '.claude', 'projects', cwd.replaceAll('/', '-'));
  mkdirSync(dir, { recursive: true });
  const line = { parentUuid: null, type: 'user', uuid: `00000000-0000-4000-8000-00000000cd${String(i).padStart(2, '0')}`, timestamp: `2026-11-1${i}T10:00:00.000Z`,
    cwd, sessionId: sid(i), entrypoint: 'cli', message: { role: 'user', content: prompt } };
  writeFileSync(path.join(dir, `${sid(i)}.jsonl`), `${JSON.stringify(line)}\n`);
}
const rows = (page: Page) => page.getByRole('list', { name: 'Sessions' }).getByRole('listitem');
const modes = (page: Page) => page.getByRole('group', { name: 'Session list mode' });

test('Session list browsing: modes, search, agent filter, folder group', async ({ xaibo }) => {
  test.setTimeout(150_000);
  xaibo.touchStore(() => {
    claude(xaibo.home, 1, '/tmp/xaibo-fixture/atlas', 'Add a token bucket rate limiter to the public endpoints');
    claude(xaibo.home, 2, '/tmp/xaibo-fixture/notes', 'Summarize the meeting notes');
    seedCodexAgy(xaibo.home);
  });
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  await openSessions(page);
  const pane = page.getByRole('region', { name: 'Session list' });
  await expect(rows(page).filter({ hasText: 'rate limiter' })).toHaveCount(1, { timeout: 20_000 });
  await expect(rows(page).filter({ hasText: 'meeting notes' })).toHaveCount(1);
  await expect(pane.getByRole('heading', { name: 'All sessions' })).toBeVisible();

  // the mode group: arrows move focus without activating; Enter activates and keeps focus
  const all = modes(page).getByRole('button', { name: 'All sessions' });
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await all.focus();
  await page.keyboard.press('ArrowRight');
  const live = modes(page).getByRole('button', { name: 'Live' });
  await expect(live).toBeFocused();
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('End');
  await expect(modes(page).getByRole('button', { name: 'Suppressed' })).toBeFocused(); // XAIBO-PROD-536: the last mode
  await page.keyboard.press('ArrowLeft');
  const trash = modes(page).getByRole('button', { name: 'Trash' });
  await expect(trash).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(trash).toHaveAttribute('aria-pressed', 'true');
  await expect(trash).toBeFocused();
  await expect(pane.getByText('Trash is empty.')).toBeVisible();
  await modes(page).getByRole('button', { name: 'Archived' }).click();
  await expect(pane.getByText('No archived sessions.')).toBeVisible();
  await live.click();
  await expect(pane.getByText('Search and filters apply to the other modes.')).toBeVisible();
  await all.click();
  await expect(rows(page).filter({ hasText: 'rate limiter' })).toHaveCount(1);

  // search: Apply focuses the results heading; matched terms emphasized as text; the coverage note below
  const search = pane.getByRole('searchbox', { name: 'Search sessions' });
  await expect(async () => {
    await search.fill('limiter');
    await pane.getByRole('button', { name: 'Apply' }).first().click();
    await expect(rows(page).filter({ hasText: 'rate limiter' })).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 }); // the content index fills after the import
  await expect(pane.getByRole('heading', { name: 'Matches' })).toBeFocused();
  await expect(pane.getByText('Search relevance')).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().locator('[data-field="snippet"] mark')).toHaveText(['limiter']);
  await expect(pane.getByText('Search covers retained indexed content; incomplete sources may have gaps.')).toBeVisible();
  await shot(page, 'history-search-light');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await shot(page, 'history-search-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await search.fill('zzzunmatched');
  await pane.getByRole('button', { name: 'Apply' }).first().click();
  await expect(pane.getByText('No matches. Change filters or clear search.')).toBeVisible();
  await pane.getByRole('button', { name: 'Clear search' }).click();
  await expect(rows(page).filter({ hasText: 'meeting notes' })).toHaveCount(1);

  // the agent filter
  await pane.getByText('Filters').click();
  await pane.getByLabel('Agent').selectOption('codex');
  await pane.getByRole('button', { name: 'Apply' }).last().click();
  await expect(rows(page).filter({ hasText: 'meeting notes' })).toHaveCount(0);
  await expect(rows(page).locator('[data-field="agent"]')).toHaveText([/codex/]);
  await pane.getByRole('button', { name: 'Reset' }).click();
  await expect(rows(page).filter({ hasText: 'meeting notes' })).toHaveCount(1);

  // Projects and folders: a cwd group without a repository says so; picking it filters and keeps focus on it
  await pane.getByText('Projects and folders').click();
  const atlas = pane.getByRole('button', { name: /^atlas/ });
  await expect(atlas).toBeVisible({ timeout: 15_000 });
  await expect(pane.getByText('Repository grouping unavailable').first()).toBeVisible();
  await atlas.click();
  await expect(atlas).toHaveAttribute('aria-pressed', 'true');
  await expect(atlas).toBeFocused();
  await expect(rows(page).filter({ hasText: 'meeting notes' })).toHaveCount(0);
  await expect(rows(page).filter({ hasText: 'rate limiter' })).toHaveCount(1);
  await shot(page, 'history-group-light');
  await pane.getByRole('button', { name: 'All projects' }).click();
  await expect(rows(page).filter({ hasText: 'meeting notes' })).toHaveCount(1);

  // the minimum window: no horizontal page scroll
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(640, 560));
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'history-640');
});
