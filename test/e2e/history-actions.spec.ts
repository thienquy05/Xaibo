// XAIBO-PROD-532 (P5-T18 part 3b-3; design §6.4, §5.1, §5.4; look D-P5-09): Session list row actions in the packaged
// app. Synthetic Claude sessions: the More menu (keyboard per §5.1: first item focused, arrows, Home/End, typeahead,
// Escape back to the trigger; placed at its trigger), Pin/Keep/Archive as checked menu items with a polite outcome and
// row lines, an unarchive that leaves Archived (heading fallback), Move to Trash with the Undo notice and the following
// record focused, the Trash row in Trash mode, and Undo bringing the record back with focus on it.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openSessions, shot, test } from './fixtures.ts';

const sid = (i: number) => `00000000-0000-4000-8000-00000000ac${String(i).padStart(2, '0')}`;
function claude(home: string, i: number, cwd: string, prompt: string) {
  const dir = path.join(home, '.claude', 'projects', cwd.replaceAll('/', '-'));
  mkdirSync(dir, { recursive: true });
  const line = { parentUuid: null, type: 'user', uuid: `00000000-0000-4000-8000-00000000ce${String(i).padStart(2, '0')}`, timestamp: `2026-11-1${i}T10:00:00.000Z`,
    cwd, sessionId: sid(i), entrypoint: 'cli', message: { role: 'user', content: prompt } };
  writeFileSync(path.join(dir, `${sid(i)}.jsonl`), `${JSON.stringify(line)}\n`);
}
const records = (page: Page) => page.getByRole('list', { name: 'Sessions' }).getByRole('listitem');
const modes = (page: Page) => page.getByRole('group', { name: 'Session list mode' });
const more = (page: Page, text: string) => page.getByRole('button', { name: new RegExp(`^More actions for .*${text}`) });

test('Session list row actions: menu keys, Pin, Keep, Archive, Move to Trash and Undo', async ({ xaibo }) => {
  test.setTimeout(150_000);
  xaibo.touchStore(() => {
    claude(xaibo.home, 1, '/tmp/xaibo-fixture/atlas', 'Add a token bucket rate limiter');
    claude(xaibo.home, 2, '/tmp/xaibo-fixture/notes', 'Summarize the meeting notes');
    claude(xaibo.home, 3, '/tmp/xaibo-fixture/docs', 'Draft the release checklist');
  });
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  await openSessions(page);
  const pane = page.getByRole('region', { name: 'Session list' });
  for (const x of ['rate limiter', 'meeting notes', 'release checklist']) await expect(records(page).filter({ hasText: x })).toHaveCount(1, { timeout: 20_000 });
  const n = await records(page).count(); // the fixture home may hold sessions of its own
  const note = pane.locator('.x-action-note');

  // the menu from the keyboard: Enter opens it at its trigger; the first item takes focus once the fresh row is read
  const trigger = more(page, 'rate limiter');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'More actions' });
  const pin = menu.getByRole('menuitemcheckbox', { name: 'Pin' });
  await expect(pin).toBeFocused();
  await expect(pin).toHaveAttribute('aria-checked', 'false');
  const [t, m] = [await trigger.boundingBox(), await menu.boundingBox()];
  expect(Math.abs(m!.y - (t!.y + t!.height)) < 12 || Math.abs(m!.y + m!.height - t!.y) < 12, 'the menu sits at its trigger').toBe(true);
  await shot(page, 'history-actions-menu');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Archive' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Move to Trash' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(pin).toBeFocused();
  await page.keyboard.press('k');
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Keep' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  // Pin: the record moves first with its pin; the outcome is polite; the menu shows it checked
  await page.keyboard.press('Enter');
  await expect(pin).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(note).toHaveText('Pinned.');
  await expect(records(page).first()).toContainText('Pinned: ');
  await expect(records(page).first()).toContainText('rate limiter');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(pin).toHaveAttribute('aria-checked', 'true');
  // Keep: the record's line says Keep
  await menu.getByRole('menuitemcheckbox', { name: 'Keep' }).click();
  await expect(note).toHaveText('Kept. Retention will not purge this session.');
  await expect(records(page).first().locator('[data-field="history"]')).toContainText('Keep');

  // Archive: All keeps archived records; in Archived, unarchiving the only record leaves the heading focused
  await more(page, 'meeting notes').click();
  await menu.getByRole('menuitemcheckbox', { name: 'Archive' }).click();
  await expect(note).toHaveText('Archived.');
  await expect(records(page).filter({ hasText: 'meeting notes' }).locator('[data-field="history"]')).toContainText('Archived');
  await modes(page).getByRole('button', { name: 'Archived' }).click();
  await expect(records(page)).toHaveCount(1);
  await more(page, 'meeting notes').click();
  await menu.getByRole('menuitemcheckbox', { name: 'Archive' }).click();
  await expect(note).toHaveText('Unarchived.');
  await expect(pane.getByText('No archived sessions.')).toBeVisible();
  await expect(pane.getByRole('heading', { name: 'Archived' })).toBeFocused();

  // Move to Trash: the record leaves All; the following record takes focus; the Undo notice names the Xaibo copy
  await modes(page).getByRole('button', { name: 'All sessions' }).click();
  await expect(records(page)).toHaveCount(n);
  const order = await records(page).allTextContents();
  const i = order.findIndex((x) => x.includes('meeting notes'));
  const following = order[i + 1] ?? order[i - 1]!;
  await more(page, 'meeting notes').focus();
  await page.keyboard.press('Enter');
  await expect(pin).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const undo = page.locator('.x-undo').filter({ hasText: 'Moved to Trash.' });
  await expect(undo).toContainText('Only the Xaibo copy is affected; native files are untouched.');
  await expect(records(page)).toHaveCount(n - 1);
  await expect(records(page).filter({ hasText: 'meeting notes' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent ?? '')).toContain(following.slice(0, 20));
  await shot(page, 'history-actions-undo');
  await modes(page).getByRole('button', { name: 'Trash' }).click();
  await expect(records(page)).toHaveCount(1);
  await expect(records(page).first().locator('[data-field="history"]')).toContainText('Trashed');
  await expect(more(page, 'meeting notes')).toHaveCount(0); // Trash rows offer Restore and Purge instead (3b unit after this)

  // Undo from All: the record returns in order and takes focus
  await modes(page).getByRole('button', { name: 'All sessions' }).click();
  await expect(records(page)).toHaveCount(n - 1);
  await undo.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.x-undo').filter({ hasText: 'Restored from Trash.' })).toBeVisible();
  await expect(records(page)).toHaveCount(n);
  await expect(page.locator('.x-list-pane .x-srow').filter({ hasText: 'meeting notes' })).toBeFocused();
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('.x-undo').filter({ hasText: 'Restored from Trash.' })).toHaveCount(0);

  // XAIBO-PROD-533: the open session's retention line and Keep toggle; a change in either place reaches the other
  await page.locator('.x-list-pane .x-srow').filter({ hasText: 'rate limiter' }).click();
  const head = page.locator('.x-open-head');
  const retention = head.locator('[data-field="retention"]');
  const keep = head.getByRole('button', { name: 'Keep' });
  await expect(retention).toHaveText('Kept');
  await expect(keep).toHaveAttribute('aria-pressed', 'true');
  await shot(page, 'history-actions-open-keep');
  await keep.click();
  await expect(head.locator('.x-action-note')).toHaveText('Keep removed.');
  await expect(keep).toHaveAttribute('aria-pressed', 'false');
  await expect(retention).toHaveText(/^Purge scheduled \d{4}-\d{2}-\d{2}$/);
  await expect(records(page).filter({ hasText: 'rate limiter' }).locator('[data-field="history"]')).not.toContainText('Keep');
  await more(page, 'rate limiter').click();
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Keep' })).toHaveAttribute('aria-checked', 'false');
  await menu.getByRole('menuitemcheckbox', { name: 'Keep' }).click();
  await expect(retention).toHaveText('Kept');
  await expect(keep).toHaveAttribute('aria-pressed', 'true');

  // XAIBO-PROD-534: Trash records' Restore and Purge; Purge asks first (Cancel returns to its trigger); a purged record
  // leaves the list with the heading focused when nothing is left
  for (const text of ['release checklist', 'meeting notes']) {
    await more(page, text).click();
    await menu.getByRole('menuitem', { name: 'Move to Trash' }).click();
    await expect(records(page).filter({ hasText: text })).toHaveCount(0);
  }
  await modes(page).getByRole('button', { name: 'Trash' }).click();
  await expect(records(page)).toHaveCount(2);
  await page.getByRole('button', { name: /^Restore .*release checklist/ }).click();
  await expect(note).toHaveText('Restored from Trash.');
  await expect(records(page)).toHaveCount(1);
  const purge = page.getByRole('button', { name: /^Purge .*meeting notes/ });
  await purge.click();
  const dialog = page.getByRole('dialog', { name: 'Purge Xaibo copy?' });
  await expect(dialog).toContainText('1 session.');
  await expect(dialog).toContainText('Native files are untouched. This is logical deletion, not forensic secure erasure.');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await shot(page, 'history-actions-purge');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(purge).toBeFocused();
  // the open session of a Trash row shows the Trash banner; a purge from it closes the conversation
  await records(page).filter({ hasText: 'meeting notes' }).locator('.x-srow').click();
  const banner = page.getByRole('region', { name: 'In Trash' });
  await expect(banner).toContainText('Only the Xaibo copy is affected; native files are untouched.');
  await expect(banner).toContainText(/Moved to Trash \d{4}-\d{2}-\d{2}\. Auto-empty \d{4}-\d{2}-\d{2}\./);
  await shot(page, 'history-actions-banner');
  await banner.getByRole('button', { name: 'Purge' }).click();
  await dialog.getByRole('button', { name: 'Purge' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Choose a session to read its conversation')).toBeVisible();
  await expect(pane.getByText('Trash is empty.')).toBeVisible();
  await expect(pane.getByRole('heading', { name: 'Trash' })).toBeFocused();
  // the Undo notice for the purged session explains instead of offering Undo (design §5.1)
  await expect(page.locator('.x-undo')).toContainText('This session is no longer available, so it cannot be restored.');
  await expect(page.locator('.x-undo').getByRole('button', { name: /Undo/ })).toHaveCount(0);
});
