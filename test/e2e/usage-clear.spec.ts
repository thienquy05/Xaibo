// XAIBO-PROD-525 (P5-T16; FR-52, Q-5.8, EC-105, design §6.6/§5.4): Clear usage history in the packaged app. Synthetic
// Claude transcripts in two months show in the monthly ledger; Settings > Usage history > Clear usage history asks for
// confirmation (Cancel changes nothing and returns focus to the button); confirming clears: the ledger has no
// observations, a transcript written afterwards appears alone, and after a restart the cleared usage stays gone.
// Deviation (disclosed in the progress ledger): Trash/restore and purge have no UI before P5-T18; their "totals
// unchanged" part is covered at I level (test/integration/usage-clear.test.ts) and joins the history E2E in P5-T18.
// Synthetic ids and paths only.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, shot, test } from './fixtures.ts';

const CWD = '/tmp/xaibo-fixture/usage-clear';
const sid = (i: number) => `00000000-0000-4000-8000-0000000fc0${String(i).padStart(2, '0')}`;
const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthAgo = (n: number) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() - n, 10, 12); };
const label = (d: Date) => `${NAMES[d.getMonth()]} ${d.getFullYear()}`;
const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** One session's transcript: a prompt and `replies` assistant replies, each 1,000 input + 500 output tokens. */
function transcript(home: string, i: number, at: Date, replies: number) {
  const project = path.join(home, '.claude', 'projects', CWD.replaceAll('/', '-'));
  mkdirSync(project, { recursive: true });
  const base = (type: string, k: number) => ({ parentUuid: null, isSidechain: false, type, uuid: `00000000-0000-4000-8000-0000000fc${i}${String(k).padStart(2, '0')}`,
    timestamp: new Date(at.getTime() + k * 1000).toISOString(), userType: 'external', entrypoint: 'cli', cwd: CWD, sessionId: sid(i), version: '2.1.319' });
  const lines = [{ ...base('user', 0), message: { role: 'user', content: 'Summarize the notes' } }];
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
