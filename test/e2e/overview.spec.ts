// XAIBO-PROD-407 (P4-T04c; design §6.0-§6.2; US-1, US-4, FR-46, §6.9): the packaged app opens on the Dashboard. A
// synthetic hook stream and a transcript append drive the Live sessions view; Needs attention lists the confirmed
// request before the heuristic wait; an agy profile's quota reads exactly "Unavailable from passive sources" with no
// percentage or reset; a killed service qualifies every live label as Last known until the collector runs again.
// Synthetic ids and paths only; assertions are on accessible text.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { claudeProfile, deliver } from '../helpers/hook-socket.ts';
import { expect, openSessions, servicePid, test, type Xaibo } from './fixtures.ts';
import type { Page } from '@playwright/test';

const HOOKED = '00000000-0000-4000-8000-0000000f4401';
const FILE_ONLY = '00000000-0000-4000-8000-0000000f4402';
const project = (home: string) => path.join(home, '.claude', 'projects', '-tmp-xaibo-fixture-project');
const liveRow = (page: Page, folder: string) => page.getByRole('list', { name: 'Live sessions' }).getByRole('listitem').filter({ hasText: folder });
const view = (page: Page, name: RegExp) => page.getByRole('group', { name: 'Dashboard view' }).getByRole('button', { name });

async function start(xaibo: Xaibo, o: { serviceKills?: number } = {}) {
  const dataDir = path.join(path.dirname(xaibo.home), 'data-ov'); // short: the socket path
  mkdirSync(path.join(xaibo.home, '.gemini', 'antigravity-cli'), { recursive: true }); // an agy profile root (catalog default)
  const run = await xaibo.launch({ dataDir, ...o });
  const page = await xaibo.window(run);
  await expect(page.getByRole('status')).toContainText('Collection: Running');
  let profile: string | null = null;
  await expect.poll(() => (profile = claudeProfile(dataDir)), { timeout: 15_000 }).toBeTruthy();
  await expect.poll(() => existsSync(path.join(dataDir, 'run', 'token')), { timeout: 15_000 }).toBe(true);
  const hook = async (event: string, payload: Record<string, unknown> = {}) => {
    const ack = await deliver(dataDir, { v: 1, delivery_id: randomUUID(), agent: 'claude', profile_key: profile!, event, session_id: HOOKED,
      cwd: '/tmp/xaibo-fixture/ov-live', received_ts: Date.now(), payload: { hook_event_name: event, session_id: HOOKED, ...payload } });
    expect(ack).toMatchObject({ status: 'accepted' });
  };
  return { run, page, hook };
}

test('Dashboard: live stream updates Live sessions; queue lists confirmed before heuristic; agy quota unavailable from passive sources', async ({ xaibo }) => {
  const { page, hook } = await start(xaibo);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(view(page, /^Live sessions$/)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');

  await hook('SessionStart', { source: 'startup' });
  await hook('UserPromptSubmit', { prompt: 'fixture prompt' });
  const status = () => liveRow(page, '/tmp/xaibo-fixture/ov-live').locator('[data-field="status"]');
  await expect(status()).toContainText('Busy · confirmed', { timeout: 15_000 });
  await hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/tmp/xaibo-fixture/ov-live/a' }, tool_use_id: 'w1' });
  await hook('PermissionRequest', { tool_name: 'Write' });
  await expect(status()).toContainText('Waiting for permission · confirmed');
  await expect(page.getByRole('region', { name: 'Live-session set' })).toContainText('Active agents');

  // No hooks for this session: a pending tool call with no transcript writes for > 5 s is a heuristic wait.
  const now = new Date().toISOString();
  const line = (o: object) => `${JSON.stringify({ parentUuid: null, isSidechain: false, cwd: '/tmp/xaibo-fixture/ov-file', sessionId: FILE_ONLY, version: '2.1.319', timestamp: now, ...o })}\n`;
  xaibo.touchStore(() => appendFileSync(path.join(project(xaibo.home), `${FILE_ONLY}.jsonl`),
    line({ type: 'user', uuid: '00000000-0000-4000-8000-0000000f4501', message: { role: 'user', content: 'fixture prompt' } })
    + line({ type: 'assistant', uuid: '00000000-0000-4000-8000-0000000f4502', message: { id: 'msg_fixture_ov', role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_fixture_ov', name: 'Bash', input: { command: 'npm run build' } }], stop_reason: 'tool_use' } })));
  await expect(liveRow(page, '/tmp/xaibo-fixture/ov-file').locator('[data-field="status"]')).toContainText('Probably waiting · heuristic', { timeout: 20_000 });

  await view(page, /^Needs attention/).click();
  await expect(view(page, /^Needs attention 2$/)).toHaveAttribute('aria-pressed', 'true');
  const groups = page.locator('#view-attention h3');
  await expect(groups).toHaveText(['Confirmed requests', 'Probably waiting']);
  await expect(page.getByRole('list', { name: 'Confirmed requests' })).toContainText('Since ');
  await expect(page.getByRole('list', { name: 'Probably waiting' })).toContainText('Probably waiting · heuristic');

  // Left/Right rove the view group; Enter selects and keeps focus on the button.
  await view(page, /^Needs attention/).focus();
  await page.keyboard.press('ArrowRight');
  await expect(view(page, /^Usage and history$/)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(view(page, /^Usage and history$/)).toHaveAttribute('aria-pressed', 'true');
  const agy = page.getByRole('region', { name: /^Antigravity CLI · / });
  await expect(agy).toContainText('Unavailable from passive sources', { timeout: 15_000 });
  await expect(agy).not.toContainText('%');
  await expect(agy).not.toContainText('Resets');
  await expect(agy.locator('meter')).toHaveCount(0);
});

test('collector loss: every live label reads Last known until the collector runs again', async ({ xaibo }) => {
  const { run, page, hook } = await start(xaibo, { serviceKills: 2 });
  await hook('SessionStart', { source: 'startup' });
  await hook('UserPromptSubmit', { prompt: 'fixture prompt' });
  await expect(liveRow(page, '/tmp/xaibo-fixture/ov-live').locator('[data-field="status"]')).toContainText('Busy · confirmed', { timeout: 15_000 });
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { seen: string[] }).seen = seen;
    new MutationObserver(() => {
      const main = document.getElementById('main')?.textContent ?? '';
      const band = document.querySelector('[role=status]')?.textContent ?? '';
      seen.push(`${band}|${main.includes('Last known live sessions') && main.includes('Last known: ') ? 'qualified' : main.includes('Live sessions') ? 'live' : 'none'}`);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  process.kill(await servicePid(run.app!), 'SIGKILL');
  await expect.poll(() => page.evaluate(() => (window as unknown as { seen: string[] }).seen.join('\n')), { timeout: 15_000 })
    .toMatch(/Collection: Restarting \(attempt 1\)\|qualified[\s\S]*Collection: Running\|live/);
  const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
  expect(seen.filter((s) => !s.includes('Running') && s.endsWith('|live')), 'no unqualified live label while not running').toEqual([]);
  await expect(page.getByRole('heading', { name: 'Live sessions', exact: true })).toBeVisible();

  // Review M2: the Session area's records are qualified too.
  await openSessions(page);
  await expect(page.getByRole('list', { name: 'Sessions' }).getByRole('listitem').filter({ hasText: '/tmp/xaibo-fixture/ov-live' })).toContainText('Busy · confirmed');
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { seen2: string[] }).seen2 = seen;
    new MutationObserver(() => {
      const band = document.querySelector('[role=status]')?.textContent ?? '';
      seen.push(`${band}|${(document.getElementById('main')?.textContent ?? '').includes('Last known: ') ? 'qualified' : 'plain'}`);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  process.kill(await servicePid(run.app!), 'SIGKILL');
  await expect.poll(() => page.evaluate(() => (window as unknown as { seen2: string[] }).seen2.join('\n')), { timeout: 15_000 })
    .toMatch(/Collection: Restarting \(attempt \d+\)\|qualified[\s\S]*Collection: Running\|plain/); // the supervisor's attempt count may carry over
  const seen2 = await page.evaluate(() => (window as unknown as { seen2: string[] }).seen2);
  expect(seen2.filter((x) => !x.includes('Running') && x.endsWith('|plain')), 'Session records qualified while not running').toEqual([]);
});
