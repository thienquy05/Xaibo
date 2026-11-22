// XAIBO-PROD-555 (D-P5-17 part 2; design §6.4 Filters, §6.1.1 month detail -> retained sessions; semantics D-P6-05): in the
// packaged app, a ledger month filtered to one model opens Session with that month, model and agent applied (focus on the
// results heading), Remove model filter widens it, Return to Dashboard restores Usage and history at that month control
// with the ledger as left; the Session list's Cwd (folder and below, not a sibling prefix) and date range filters, and a
// half-filled range says so on Apply. Synthetic ids and paths only.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, shot, test } from './fixtures.ts';

const APP = '/tmp/xaibo-fixture/filters/app', APPLE = '/tmp/xaibo-fixture/filters/apple';
const sid = (i: number) => `00000000-0000-4000-8000-0000000fc0${String(i).padStart(2, '0')}`;
const lastMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() - 1, 10, 12); };
const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const iso = (d: Date) => `${ym(d)}-${String(d.getDate()).padStart(2, '0')}`;

/** One session: a prompt and one assistant reply on `model` (1,000 input + 500 output tokens). */
function transcript(home: string, i: number, cwd: string, at: Date, model: string, prompt: string) {
  const project = path.join(home, '.claude', 'projects', cwd.replaceAll('/', '-'));
  mkdirSync(project, { recursive: true });
  const base = (type: string, k: number) => ({ parentUuid: null, isSidechain: false, type, uuid: `00000000-0000-4000-8000-0000000fc${i}${String(k).padStart(2, '0')}`,
    timestamp: new Date(at.getTime() + k * 1000).toISOString(), userType: 'external', entrypoint: 'cli', cwd, sessionId: sid(i), version: '2.1.319' });
  const lines = [{ ...base('user', 0), message: { role: 'user', content: prompt } },
    { ...base('assistant', 1), message: { model, id: `msg_filters_${i}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }],
      usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, service_tier: 'standard', speed: 'standard' } } }];
  writeFileSync(path.join(project, `${sid(i)}.jsonl`), `${lines.map((x) => JSON.stringify(x)).join('\n')}\n`);
}
const rows = (page: Page) => page.getByRole('list', { name: 'Sessions' }).getByRole('listitem');
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });

test('Session list filters and the ledger month link: month/model query, Remove model filter, Return to Dashboard, cwd, date range', async ({ xaibo }) => {
  test.setTimeout(150_000);
  const t = new Date(), one = lastMonth(), now = new Date(Math.max(t.getTime() - 60_000, new Date(t.getFullYear(), t.getMonth(), 1).getTime() + 1_000)); // review L7: inside this month
  xaibo.touchStore(() => {
    transcript(xaibo.home, 1, APP, one, 'claude-opus-5-5', 'Draft the opus migration plan');
    transcript(xaibo.home, 2, APPLE, new Date(one.getTime() + 3_600_000), 'claude-sonnet-5-5', 'Review the sonnet changelog');
    transcript(xaibo.home, 3, APP, now, 'claude-opus-5-5', 'Tidy the current release notes');
  });
  const run = await xaibo.launch({ dataDir: path.join(path.dirname(xaibo.home), 'data-hf') });
  const page = await xaibo.window(run);
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 900));
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('group', { name: 'Dashboard view' }).getByRole('button', { name: 'Usage and history' }).click();
  const panel = page.getByRole('region', { name: 'Monthly usage', exact: true });
  const month = panel.getByRole('group', { name: 'Months' }).locator(`[data-month="${ym(one)}"]`);
  await expect(async () => {
    await panel.getByRole('button', { name: 'Reset' }).click(); // refetch until the import lands
    await expect(month).toHaveText(/: 3k$/, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  // the month detail, filtered to one model, opens its retained sessions in Session
  await panel.getByLabel('Model').selectOption({ label: 'claude-sonnet-5-5' });
  await panel.getByRole('button', { name: 'Apply' }).click();
  await expect(month).toHaveText(/: 1\.5k$/);
  await month.click();
  await panel.getByRole('button', { name: 'Open retained sessions' }).scrollIntoViewIfNeeded();
  await shot(page, 'history-filters-month-detail');
  await panel.getByRole('button', { name: 'Open retained sessions' }).click();
  const pane = page.getByRole('region', { name: 'Session list' });
  await expect(page.locator('#results-heading')).toBeFocused();
  await expect(row(page, 'sonnet changelog')).toHaveCount(1, { timeout: 20_000 });
  await expect(row(page, 'opus migration')).toHaveCount(0);
  await expect(row(page, 'current release')).toHaveCount(0);
  await expect(pane.locator('summary', { hasText: 'Filters' })).toContainText('Model claude-sonnet-5-5');
  await pane.locator('summary', { hasText: 'Filters' }).click();
  await shot(page, 'history-filters-month-link');

  // Remove model filter keeps the month: the other model's session in that month appears, this month's does not
  await pane.getByRole('button', { name: 'Remove model filter' }).click();
  await expect(row(page, 'opus migration')).toHaveCount(1);
  await expect(row(page, 'current release')).toHaveCount(0);

  // Return to Dashboard: Usage and history, the ledger as left (model filter, detail open), focus on that month's control
  await pane.getByRole('button', { name: 'Return to Dashboard' }).click();
  await expect(month).toBeFocused();
  await expect(month).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByLabel('Model')).toHaveValue('v:claude-sonnet-5-5');

  // the Areas link starts Session unfiltered, with no Return
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Session' }).click();
  await expect(row(page, 'current release')).toHaveCount(1, { timeout: 20_000 });
  await expect(pane.getByRole('button', { name: 'Return to Dashboard' })).toHaveCount(0);
  await pane.locator('summary', { hasText: 'Filters' }).click();

  // Cwd: the folder and below, never the sibling that shares its prefix
  await pane.getByLabel('Cwd').fill(APP);
  await pane.getByRole('button', { name: 'Apply' }).last().click();
  await expect(row(page, 'sonnet changelog')).toHaveCount(0);
  await expect(row(page, 'opus migration')).toHaveCount(1);
  await expect(row(page, 'current release')).toHaveCount(1);

  // a half-filled range is refused with its reason; a full one keeps the sessions active in it
  const from = pane.getByLabel('From', { exact: true });
  await from.fill(iso(one));
  await pane.getByRole('button', { name: 'Apply' }).last().click();
  await expect(pane.getByText('Enter both dates, with From on or before To.')).toBeVisible();
  await expect(from).toBeFocused();
  await expect(from).toHaveAttribute('aria-invalid', 'true');
  await shot(page, 'history-filters-date-error');
  await pane.getByLabel('To', { exact: true }).fill(iso(one));
  await pane.getByRole('button', { name: 'Apply' }).last().click();
  await expect(row(page, 'current release')).toHaveCount(0);
  await expect(row(page, 'opus migration')).toHaveCount(1);
  await expect(pane.getByText('Enter both dates, with From on or before To.')).toHaveCount(0);
  await pane.getByRole('button', { name: 'Reset' }).click();
  await expect(row(page, 'sonnet changelog')).toHaveCount(1);
});
