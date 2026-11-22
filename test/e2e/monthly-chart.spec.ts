// XAIBO-PROD-524 (P5-T17b; design §6.1.1, US-20, FR-52): the monthly usage ledger in the packaged app, from synthetic
// Claude transcripts across three months (two months ago: two requests on one model; last month: one request on another
// model; this month: one request). The chart prints each month's value, labels the current month "month to date", the
// table carries exact values, the model filter leaves the other months "No observations" (never zero), the metric
// switch changes the series, month controls rove by arrow keys and Enter opens the month's detail, and quota peaks are
// a separate section that says the model filter does not apply. Synthetic ids and paths only.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, shot, test } from './fixtures.ts';

const CWD = '/tmp/xaibo-fixture/monthly-chart';
const sid = (i: number) => `00000000-0000-4000-8000-0000000fb0${String(i).padStart(2, '0')}`;
const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthAgo = (n: number) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() - n, 10, 12); };
const label = (d: Date) => `${NAMES[d.getMonth()]} ${d.getFullYear()}`;
const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** One session's transcript: a prompt and `replies` assistant replies on `model`, each 1,000 input + 500 output tokens. */
function transcript(home: string, i: number, at: Date, model: string, replies: number) {
  const project = path.join(home, '.claude', 'projects', CWD.replaceAll('/', '-'));
  mkdirSync(project, { recursive: true });
  const base = (type: string, k: number) => ({ parentUuid: null, isSidechain: false, type, uuid: `00000000-0000-4000-8000-0000000fb${i}${String(k).padStart(2, '0')}`,
    timestamp: new Date(at.getTime() + k * 1000).toISOString(), userType: 'external', entrypoint: 'cli', cwd: CWD, sessionId: sid(i), version: '2.1.319' });
  const lines = [{ ...base('user', 0), message: { role: 'user', content: 'Summarize the notes' } }];
  for (let k = 1; k <= replies; k++) {
    lines.push({ ...base('assistant', k), message: { model, id: `msg_monthly_${i}_${k}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }],
      usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, service_tier: 'standard', speed: 'standard' } } } as never);
  }
  writeFileSync(path.join(project, `${sid(i)}.jsonl`), `${lines.map((x) => JSON.stringify(x)).join('\n')}\n`);
}

test('monthly ledger: values per month, month to date, exact table, model filter, metric switch, keyboard months, quota section', async ({ xaibo }) => {
  test.setTimeout(120_000);
  const [two, one, now] = [monthAgo(2), monthAgo(1), new Date(Date.now() - 60_000)];
  xaibo.touchStore(() => {
    transcript(xaibo.home, 1, two, 'claude-opus-5-5', 2);
    transcript(xaibo.home, 2, one, 'claude-sonnet-5-5', 1);
    transcript(xaibo.home, 3, now, 'claude-opus-5-5', 1);
  });
  const run = await xaibo.launch({ dataDir: path.join(path.dirname(xaibo.home), 'data-mc') });
  const page = await xaibo.window(run);
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 900));
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('group', { name: 'Dashboard view' }).getByRole('button', { name: 'Usage and history' }).click();
  const panel = page.getByRole('region', { name: 'Monthly usage', exact: true });
  const months = panel.getByRole('group', { name: 'Months' });

  // values per month (the service imports the transcripts; the ledger recomputes after each commit). The fixture home
  // also holds the shared usage-basic transcript, so this test's months are found by their data-month, not by position.
  const month = (d: Date) => months.locator(`[data-month="${ym(d)}"]`);
  await expect(async () => {
    await panel.getByRole('button', { name: 'Reset' }).click(); // refetch
    await expect(month(two)).toHaveText(`${label(two)}: 3k`, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(month(two)).toHaveText(`${label(two)}: 3k`);
  await expect(month(one)).toHaveText(`${label(one)}: 1.5k`);
  await expect(month(now)).toHaveText(`${label(now)} · month to date: 1.5k`);
  await expect(panel.locator('svg.x-monthly-chart')).toContainText('3k');
  // every observed month fits on this page (the panel shows 6 at this width): no paging either way
  await expect(panel.getByRole('button', { name: 'Previous months' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Next months' })).toBeDisabled();
  await panel.scrollIntoViewIfNeeded();
  await shot(page, 'monthly-chart-tokens');
  const table = panel.getByRole('table').first(); // the values table (the quota table follows)
  await expect(table.getByRole('row', { name: new RegExp(label(two)) })).toContainText('3,000');

  // model filter: other months read "No observations", never zero
  await panel.getByLabel('Model').selectOption({ label: 'claude-sonnet-5-5' });
  await panel.getByRole('button', { name: 'Apply' }).click();
  await expect(month(two)).toHaveText(`${label(two)}: No observations`);
  await expect(month(one)).toHaveText(`${label(one)}: 1.5k`);
  await expect(panel.locator('svg.x-monthly-chart')).toContainText('No observations');

  // metric switch, then Reset
  await panel.getByLabel('Metric').selectOption('sessions');
  await expect(month(one)).toHaveText(`${label(one)}: 1`);
  await panel.getByRole('button', { name: 'Reset' }).click();
  await expect(month(two)).toHaveText(`${label(two)}: 1`);

  // keyboard: arrows rove the month controls, Enter opens the detail with provenance
  await month(two).focus();
  await page.keyboard.press('ArrowRight');
  await expect(month(one)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(month(now)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(months.getByRole('button').first()).toBeFocused();
  await month(now).focus();
  await page.keyboard.press('Enter');
  const detail = panel.getByRole('region', { name: `${label(now)} detail` });
  await expect(detail).toContainText('1,500 (input 1,000, cache read 0, cache write 0, output 500)');
  await expect(month(now)).toHaveAttribute('aria-expanded', 'true');
  await shot(page, 'monthly-chart-detail');

  // quota peaks: their own section, model filter text
  await expect(panel.getByRole('region', { name: 'Quota peaks' })).toContainText('Quota peaks are per usage scope; model filter does not apply');
  await xaibo.quit(run);
});
