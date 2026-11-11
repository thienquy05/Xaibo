// XAIBO-PROD-110 (P1-T12; US-1, FR-09, S-29; T06 health, T08 strip): the read-only list in the packaged app.
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { formatTime } from '../../src/renderer/model.ts';
import { expect, servicePid, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

const SESSION = '00000000-0000-4000-8000-000000001000';
const project = (home: string) => path.join(home, '.claude', 'projects', '-tmp-xaibo-fixture-project');
const userLine = (sessionId: string, uuid: string, timestamp: string, cwd: string) =>
  JSON.stringify({ parentUuid: null, type: 'user', uuid, timestamp, cwd, sessionId, entrypoint: 'cli', message: { role: 'user', content: 'x' } }) + '\n';
const rowsOf = (page: Page) => page.getByRole('table', { name: 'Sessions' }).locator('tbody tr');
const sessionCount = (dataDir: string) => {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true });
    return Number(Object.values(db.prepare('SELECT count(*) FROM sessions').get() ?? {})[0]);
  } catch { return -1; } finally { db?.close(); }
};

test('backfill rows, health and the agent strip; a live append updates the row', async ({ xaibo }) => {
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  const rows = rowsOf(page);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('/tmp/xaibo-fixture/alpha');
  await expect(rows.first()).toContainText('sdk-cli');
  await expect(rows.first()).toContainText('Untitled');
  await expect(page.getByRole('status')).toContainText('Running');
  const agents = page.getByRole('region', { name: 'Agents' });
  await expect(agents).toContainText('Claude Code');
  await expect(agents).toContainText('2.1.319');
  await expect(agents).toContainText('0.160.0');

  const ts = '2026-01-01T05:00:00.000Z';
  xaibo.touchStore(() => appendFileSync(path.join(project(xaibo.home), `${SESSION}.jsonl`), userLine(SESSION, '00000000-0000-4000-8000-0000000010e3', ts, '/tmp/xaibo-fixture/alpha')));
  await expect(rows.first().getByRole('cell').nth(4)).toHaveText(formatTime(Date.parse(ts)), { timeout: 15_000 });
});

test('Load more pages without duplicates (keyboard)', async ({ xaibo }) => {
  xaibo.touchStore(() => {
    for (let i = 1; i <= 60; i++) {
      const id = `00000000-0000-4000-8000-0000000b${String(i).padStart(4, '0')}`;
      writeFileSync(path.join(project(xaibo.home), `${id}.jsonl`),
        userLine(id, `00000000-0000-4000-8000-0000000c${String(i).padStart(4, '0')}`, `2026-01-02T01:${String(i - 1).padStart(2, '0')}:00.000Z`, `/tmp/xaibo-fixture/s${i}`));
    }
  });
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  await expect.poll(() => sessionCount(run.dataDir), { timeout: 20_000 }).toBe(61);
  const rows = rowsOf(page);
  await expect(rows).toHaveCount(50);
  const more = page.getByRole('button', { name: 'Load more' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(61);
  const folders = await rows.evaluateAll((trs) => trs.map((tr) => tr.children[2]!.textContent));
  expect(new Set(folders).size).toBe(61);
  await expect(more).toHaveCount(0);
});

test('health shows Restarting, then Running, after a service kill; the list comes back', async ({ xaibo }) => {
  const run = await xaibo.launch({ serviceKills: 1 });
  const page = await xaibo.window(run);
  const status = page.getByRole('status');
  await expect(status).toContainText('Running');
  await expect(rowsOf(page)).toHaveCount(1);
  await page.evaluate(() => {
    const el = document.querySelector('[role=status]')!;
    const seen: string[] = [];
    (window as unknown as { seen: string[] }).seen = seen;
    new MutationObserver(() => seen.push(el.textContent ?? '')).observe(el, { subtree: true, childList: true, characterData: true });
  });
  process.kill(await servicePid(run.app!), 'SIGKILL');
  await expect.poll(() => page.evaluate(() => (window as unknown as { seen: string[] }).seen.join('|')), { timeout: 15_000 })
    .toMatch(/Restarting \(attempt 1\).*Running/);
  await expect(rowsOf(page)).toHaveCount(1);
});

test('Set path… stores a manual executable and the strip shows its version', async ({ xaibo }) => {
  const alt = path.join(xaibo.home, 'alt', 'claude');
  mkdirSync(path.dirname(alt), { recursive: true });
  writeFileSync(alt, '#!/bin/sh\necho "2.1.400 (Claude Code)"\n');
  chmodSync(alt, 0o755);
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  const agents = page.getByRole('region', { name: 'Agents' });
  await expect(agents).toContainText('2.1.319');
  await run.app!.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as unknown as typeof dialog.showOpenDialog;
  }, alt);
  await page.getByRole('button', { name: 'Set path for Claude Code' }).click();
  await expect(agents).toContainText('2.1.400');
});
