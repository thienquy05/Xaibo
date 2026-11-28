// XAIBO-PROD-624 (P7-T04, EC-85, EC-76 E part; design §6.7): Session → Launch with the stubbed Terminal spawner
// (XAIBO_LAUNCH_STUB=1 records the script instead of opening Terminal). The dialog opens on Agent; the preview is main's exact
// command; Launch asks main's native grant (stubbed: Cancel-first warning answering Grant after the click guard); the
// provisional Starting… row and its status-only detail open (ownership unavailable, no session evidence yet); a synthetic
// transcript with the pre-allocated id binds it into one session; Remove provisional row drops an unbound one; Cancel restores
// the Launch button.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, shot, test } from './fixtures.ts';

const stubGrant = (app: ElectronApplication) => app.evaluate(({ dialog: d }) => {
  const g = globalThis as unknown as { xaiboBoxes: unknown[] };
  g.xaiboBoxes = [];
  d.showMessageBox = (async (...args: unknown[]) => {
    g.xaiboBoxes.push(args.at(-1));
    await new Promise((r) => setTimeout(r, 900));
    return { response: 1, checkboxChecked: false };
  }) as typeof d.showMessageBox;
});
async function openLaunch(page: Page, cwd: string) {
  await page.getByRole('link', { name: 'Session' }).click();
  await page.getByRole('button', { name: 'Launch', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Launch an agent' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Agent' })).toBeFocused();
  await expect(dialog.getByRole('combobox', { name: 'Agent' })).toHaveValue('claude', { timeout: 20_000 });
  await dialog.getByRole('textbox', { name: 'Working directory' }).fill(cwd);
  await expect(dialog.getByRole('textbox', { name: 'Working directory' })).toHaveValue(cwd);
  return dialog;
}

test('Launch: preview from main, native grant, Starting… row, bound by the pre-allocated id into one session', async ({ xaibo }) => {
  const run = await xaibo.launch({ env: { XAIBO_LAUNCH_STUB: '1' } });
  const page = await xaibo.window(run);
  const errors: string[] = []; // Gate 7 (e4): the flow logs no console or page error
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const cwd = path.join(xaibo.home, 'launch project');
  mkdirSync(cwd);
  const real = realpathSync(cwd);
  await stubGrant(run.app!);
  const dialog = await openLaunch(page, cwd);
  await expect(dialog.getByRole('combobox', { name: 'Agent' }).locator('option[disabled]')).toContainText(['agy interactive launch not verified']);
  const preview = dialog.getByRole('region', { name: 'Command preview' });
  await expect(preview).toContainText("'--session-id' '", { timeout: 20_000 });
  await expect(preview).toContainText(path.join(xaibo.home, 'bin'));
  await expect(dialog).toContainText(`In: ${real}`);
  await shot(page, 'launch-dialog');
  await dialog.getByRole('button', { name: 'Launch in terminal' }).click();

  const heading = page.getByRole('heading', { name: 'Starting…', level: 2 });
  await expect(heading).toBeFocused({ timeout: 20_000 });
  const pane = page.locator('.x-provisional-pane');
  await expect(pane).toContainText('Ownership unavailable — awaiting session evidence');
  await expect(pane).toContainText('No session evidence yet');
  await expect(page.locator('.x-provisional')).toContainText('Starting…');
  await shot(page, 'launch-provisional');
  const boxes = await run.app!.evaluate(() => (globalThis as unknown as { xaiboBoxes: { type: string; title: string; buttons: string[]; defaultId: number; cancelId: number; detail: string }[] }).xaiboBoxes);
  expect(boxes.map((b) => [b.type, b.title, b.buttons, b.defaultId, b.cancelId])).toEqual([['warning', 'Grant launch', ['Cancel', 'Grant launch'], 0, 0]]);
  expect(boxes[0]!.detail).toContain('This grant is not a sandbox.');

  // the recorded script: a fixed env, the agent's own executable, the pre-allocated id, the cwd entered with cd --
  const stub = path.join(run.dataDir, 'logs', 'launch-stub.jsonl');
  await expect.poll(() => existsSync(stub)).toBe(true);
  const script = (JSON.parse(readFileSync(stub, 'utf8').trim().split('\n').at(-1)!) as { script: string }).script;
  expect(script).toContain(`cd -- '${real}' || exit 1`);
  expect(script).toContain('exec /usr/bin/env -i ');
  const id = /'--session-id' '([0-9a-f-]{36})'/.exec(script)?.[1];
  expect(id).toBeTruthy();

  // evidence: the session's transcript with that id binds the row into the session (focus on its heading, one row)
  const dir = path.join(xaibo.home, '.claude', 'projects', real.replace(/[^A-Za-z0-9]/g, '-'));
  xaibo.touchStore(() => mkdirSync(dir, { recursive: true }));
  const t = new Date().toISOString();
  xaibo.touchStore(() => writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: '00000000-0000-4000-8000-0000000f0001', timestamp: t,
    userType: 'external', entrypoint: 'cli', cwd: real, sessionId: id, version: '2.1.319', message: { role: 'user', content: 'launch fixture prompt' } })}\n`));
  await expect(page.locator('#open-session-title')).toBeFocused({ timeout: 30_000 });
  await expect(page.locator('.x-provisional')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Starting…' })).toHaveCount(0);
  await expect(page.locator('#open-session-title')).toContainText('launch fixture prompt'); // Gate 7 (e2): the launched session, once
  await expect(page.locator('.x-srow', { hasText: 'launch fixture prompt' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Launch: Cancel restores the trigger; Remove provisional row drops an unbound row', async ({ xaibo }) => {
  const run = await xaibo.launch({ env: { XAIBO_LAUNCH_STUB: '1' } });
  const page = await xaibo.window(run);
  const cwd = path.join(xaibo.home, 'second');
  mkdirSync(cwd);
  await stubGrant(run.app!);
  let dialog = await openLaunch(page, cwd);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Launch', exact: true })).toBeFocused();
  dialog = await openLaunch(page, cwd);
  await expect(dialog.getByRole('region', { name: 'Command preview' })).toContainText("'--session-id'", { timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Launch in terminal' }).click();
  await expect(page.getByRole('heading', { name: 'Starting…', level: 2 })).toBeFocused({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Remove provisional row' }).click();
  await expect(page.locator('.x-provisional')).toHaveCount(0);
  await expect(page.locator('#sessions-heading')).toBeFocused();
});
