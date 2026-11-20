// XAIBO-PROD-525 (P5-T16; FR-52, Q-5.8, EC-105, design §6.6/§5.4): Clear usage history in the packaged app. Synthetic
// Claude transcripts in two months show in the monthly ledger; Settings > Usage history > Clear usage history asks for
// confirmation (Cancel changes nothing and returns focus to the button); confirming clears: the ledger has no
// observations, a transcript written afterwards appears alone, and after a restart the cleared usage stays gone.
// G5g-3 (P5-T16, EC-105, FR-52): the monthly chart and table totals stay identical across Move to Trash (Session list row
// menu), Restore and Purge (Trash, after its confirmation); the service side is also covered at I level
// (test/integration/usage-clear.test.ts). Synthetic ids and paths only.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openSessions, shot, test } from './fixtures.ts';

const CWD = '/tmp/xaibo-fixture/usage-clear';
const sid = (i: number) => `00000000-0000-4000-8000-0000000fc0${String(i).padStart(2, '0')}`;
const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthAgo = (n: number) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() - n, 10, 12); };
const label = (d: Date) => `${NAMES[d.getMonth()]} ${d.getFullYear()}`;
const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** One session's transcript: a prompt and `replies` assistant replies, each 1,000 input + 500 output tokens. */
function transcript(home: string, i: number, at: Date, replies: number, prompt = 'Summarize the notes') {
  const project = path.join(home, '.claude', 'projects', CWD.replaceAll('/', '-'));
  mkdirSync(project, { recursive: true });
  const base = (type: string, k: number) => ({ parentUuid: null, isSidechain: false, type, uuid: `00000000-0000-4000-8000-0000000fc${i}${String(k).padStart(2, '0')}`,
    timestamp: new Date(at.getTime() + k * 1000).toISOString(), userType: 'external', entrypoint: 'cli', cwd: CWD, sessionId: sid(i), version: '2.1.319' });
  const lines = [{ ...base('user', 0), message: { role: 'user', content: prompt } }];
  for (let k = 1; k <= replies; k++) {
    lines.push({ ...base('assistant', k), message: { model: 'claude-opus-5-5', id: `msg_clear_${i}_${k}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }],
      usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, service_tier: 'standard', speed: 'standard' } } } as never);
  }
  writeFileSync(path.join(project, `${sid(i)}.jsonl`), `${lines.map((x) => JSON.stringify(x)).join('\n')}\n`);
}

async function ledger(page: Page) {
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('group', { name: 'Dashboard view' }).getByRole('button', { name: 'Usage and history' }).click();
  const panel = page.getByRole('region', { name: 'Monthly usage', exact: true });
  const month = (d: Date) => panel.getByRole('group', { name: 'Months' }).locator(`[data-month="${ym(d)}"]`);
  /** Refetches (Reset) until `check` passes: the ledger recomputes after each commit. */
  const until = (check: () => Promise<void>) => expect(async () => { await panel.getByRole('button', { name: 'Reset' }).click(); await check(); }).toPass({ timeout: 30_000 });
  return { panel, month, until };
}

test('Clear usage history: confirmation, empty ledger, later usage appears alone, still cleared after a restart', async ({ xaibo }) => {
  test.setTimeout(180_000);
  const [one, now] = [monthAgo(1), new Date(Date.now() - 120_000)];
  xaibo.touchStore(() => { transcript(xaibo.home, 1, one, 1); transcript(xaibo.home, 2, now, 1); });
  const dataDir = path.join(path.dirname(xaibo.home), 'data-uc');
  const run = await xaibo.launch({ dataDir });
  const page = await xaibo.window(run);
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 900));
  let l = await ledger(page);
  await l.until(() => expect(l.month(one)).toHaveText(`${label(one)}: 1.5k`, { timeout: 2_000 }));

  // Settings > Usage history: Cancel changes nothing and returns focus to the button
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeFocused();
  const section = page.getByRole('region', { name: 'Usage history' });
  const clear = section.getByRole('button', { name: 'Clear usage history' });
  await clear.click();
  const dialog = page.getByRole('dialog', { name: 'Clear usage history?' });
  await expect(dialog).toBeVisible();
  await shot(page, 'usage-clear-confirm');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(clear).toBeFocused();
  l = await ledger(page);
  await expect(l.month(one)).toHaveText(`${label(one)}: 1.5k`);

  // confirm: cleared, focus back on the button, the outcome in words
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Settings' }).click();
  await clear.click();
  await dialog.getByRole('button', { name: 'Clear usage history' }).click();
  await expect(section).toContainText('Usage history cleared. Usage observed from now on will appear.');
  await expect(clear).toBeFocused();
  await shot(page, 'usage-clear-done');
  l = await ledger(page);
  await l.until(() => expect(l.panel).toContainText('No observations yet.', { timeout: 2_000 }));

  // usage observed afterwards counts, alone
  xaibo.touchStore(() => transcript(xaibo.home, 3, new Date(), 2));
  await l.until(() => expect(l.month(new Date())).toHaveText(`${label(new Date())} · month to date: 3k`, { timeout: 2_000 }));
  await expect(l.month(one)).toHaveCount(0);
  await xaibo.quit(run);

  // restart: the cleared usage stays gone, the later usage stays
  const again = await xaibo.launch({ dataDir });
  const p2 = await xaibo.window(again);
  await again.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 900));
  const l2 = await ledger(p2);
  await l2.until(() => expect(l2.month(new Date())).toHaveText(`${label(new Date())} · month to date: 3k`, { timeout: 2_000 }));
  await expect(l2.month(one)).toHaveCount(0);
  await xaibo.quit(again);
});

// G5g-3 (EC-105): Trash, Restore and Purge never change the monthly totals (FR-52: a purge settles its usage first).
test('Monthly totals unchanged across Move to Trash, Restore and Purge', async ({ xaibo }) => {
  test.setTimeout(180_000);
  const one = monthAgo(1);
  xaibo.touchStore(() => { transcript(xaibo.home, 4, one, 1, 'Draft the ledger summary'); transcript(xaibo.home, 5, one, 2, 'Plan the archive check'); });
  const run = await xaibo.launch({ dataDir: path.join(path.dirname(xaibo.home), 'data-ec105') });
  const page = await xaibo.window(run);
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 900));
  const records = page.getByRole('list', { name: 'Sessions' }).getByRole('listitem');
  const modes = page.getByRole('group', { name: 'Session list mode' });
  const menu = page.getByRole('menu', { name: 'More actions' });
  const note = page.getByRole('region', { name: 'Session list' }).locator('.x-action-note');
  const target = 'archive check'; // the 2-reply session: 3,000 of the month's 4,500 tokens

  let l = await ledger(page);
  await l.until(() => expect(l.month(one)).toHaveText(`${label(one)}: 4.5k`, { timeout: 2_000 }));
  const row = () => l.panel.getByRole('table').first().getByRole('row', { name: new RegExp(label(one)) }); // the values table
  await expect(row()).toContainText('4,500');
  // EC-105 compares the totals; the month label may gain 'some details expired' after a purge (US-20, design §6.1.1)
  const cells = await row().locator('td').allTextContents();
  /** The month's chart value and table row read exactly as before (refetched until the ledger has recomputed). */
  const unchanged = async (detail = '') => {
    l = await ledger(page);
    await l.until(async () => {
      await expect(l.month(one)).toHaveText(`${label(one)}${detail}: 4.5k`, { timeout: 2_000 });
      await expect(row().locator('td')).toHaveText(cells, { timeout: 2_000 });
    });
  };
  const moveToTrash = async () => {
    await openSessions(page);
    await modes.getByRole('button', { name: 'All sessions' }).click();
    await page.getByRole('button', { name: new RegExp(`^More actions for .*${target}`) }).click();
    await menu.getByRole('menuitem', { name: 'Move to Trash' }).click();
    await expect(records.filter({ hasText: target })).toHaveCount(0);
  };

  await openSessions(page);
  await expect(records.filter({ hasText: target })).toHaveCount(1, { timeout: 20_000 });
  await moveToTrash();
  await unchanged();

  await openSessions(page);
  await modes.getByRole('button', { name: 'Trash' }).click();
  await page.getByRole('button', { name: new RegExp(`^Restore .*${target}`) }).click();
  await expect(note).toHaveText('Restored from Trash.');
  await unchanged();

  await moveToTrash();
  await modes.getByRole('button', { name: 'Trash' }).click();
  await page.getByRole('button', { name: new RegExp(`^Purge .*${target}`) }).click();
  const dialog = page.getByRole('dialog', { name: 'Purge Xaibo copy?' });
  await dialog.getByRole('button', { name: 'Purge' }).click();
  await expect(dialog).toBeHidden();
  await expect(records.filter({ hasText: target })).toHaveCount(0);
  await unchanged(' · some details expired'); // the purged session's details are gone; its totals stay
  await xaibo.quit(run);
});
