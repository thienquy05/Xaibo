// XAIBO-PROD-627 (P7-T05, P7-T09, EC-20, FR-13, FR-21, FR-22; design §6.7–§6.8): Resume, Fork and Open in VS Code from the open
// session header with the stubbed Terminal spawner. A print-mode (sdk-cli) session is not resumable and says why; an interactive
// one opens the concurrency warning (Cancel focused; Escape returns to Resume), Resume anyway asks the native grant and records
// a script that runs the agent's resume in the session's folder; new evidence binds the provisional row back into the session;
// Fork records the fork template; Open in VS Code stays disabled with its reason (no verified VS Code row).
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, shot, test } from './fixtures.ts';

const ID = '00000000-0000-4000-8000-0000000c7001';
const stubGrant = (app: ElectronApplication) => app.evaluate(({ dialog: d }) => {
  d.showMessageBox = (async () => { await new Promise((r) => setTimeout(r, 900)); return { response: 1, checkboxChecked: false }; }) as typeof d.showMessageBox;
});
const line = (cwd: string, uuid: string, text: string) => `${JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid, timestamp: new Date().toISOString(),
  userType: 'external', entrypoint: 'cli', cwd, sessionId: ID, version: '2.1.319', message: { role: 'user', content: text } })}\n`;
const scripts = (dataDir: string) => { const f = path.join(dataDir, 'logs', 'launch-stub.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { script: string }).script) : []; };
async function openTitled(page: Page, title: RegExp) {
  await page.getByRole('link', { name: 'Session' }).click();
  await page.locator('.x-srow', { hasText: title }).first().click({ timeout: 30_000 });
  await expect(page.locator('#open-session-title')).toContainText(title);
}

test('Resume and Fork from the header: warning, grant, recorded scripts, binding; print mode and VS Code say why not', async ({ xaibo }) => {
  const run = await xaibo.launch({ env: { XAIBO_LAUNCH_STUB: '1', XAIBO_EXTERNAL_STUB: '1' } });
  const page = await xaibo.window(run);
  await stubGrant(run.app!);
  const cwd = path.join(xaibo.home, 'resume project');
  mkdirSync(cwd);
  const real = realpathSync(cwd);
  const dir = path.join(xaibo.home, '.claude', 'projects', real.replace(/[^A-Za-z0-9]/g, '-'));
  const file = path.join(dir, `${ID}.jsonl`);
  xaibo.touchStore(() => { mkdirSync(dir, { recursive: true }); writeFileSync(file, line(real, '00000000-0000-4000-8000-0000000c7101', 'resume fixture prompt')); });

  // the shared fixture session is print mode (sdk-cli): not resumable, with its reason
  await openTitled(page, /(?<!resume )fixture prompt/);
  const head = page.locator('.x-open-head');
  await page.getByRole('button', { name: 'Details' }).click();
  await expect(page.locator('[data-field="resume"]')).toHaveText('Transcript only, not resumable. Resume: Print mode (-p) needs a prompt; not offered as an interactive resume; Fork: Fork not verified for this agent; Open in VS Code: VS Code history visibility: unverified for 2.1.319', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(head.getByRole('button', { name: 'Resume' })).toHaveCount(0);

  await openTitled(page, /resume fixture prompt/);
  const resume = head.getByRole('button', { name: 'Resume' });
  await expect(resume).not.toHaveAttribute('aria-disabled', 'true', { timeout: 20_000 });
  await expect(head.getByRole('button', { name: 'Open in VS Code' })).toHaveCount(0); // an unverified route is no escape hatch (§6.8)
  await shot(page, 'resume-header');
  await resume.click();
  const warn = page.getByRole('dialog', { name: 'Resume may create concurrent work' });
  await expect(warn).toBeVisible();
  await expect(warn.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(warn).toContainText('Silence does not prove the session is safe to resume.');
  await expect(warn.getByRole('button', { name: 'Open in VS Code' })).toHaveAttribute('aria-disabled', 'true');
  await shot(page, 'resume-warning');
  await page.keyboard.press('Escape');
  await expect(warn).toBeHidden();
  await expect(resume).toBeFocused();

  await resume.press('Enter');
  await warn.getByRole('button', { name: 'Resume anyway' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Starting…', level: 2 })).toBeFocused({ timeout: 20_000 });
  await expect.poll(() => scripts(run.dataDir).length, { timeout: 10_000 }).toBe(1);
  expect(scripts(run.dataDir)[0]).toContain(`cd -- '${real}' || exit 1`);
  expect(scripts(run.dataDir)[0]).toMatch(new RegExp(`'--resume' '${ID}'\\n`));
  // new evidence for the session binds the provisional row back into it
  xaibo.touchStore(() => appendFileSync(file, line(real, '00000000-0000-4000-8000-0000000c7102', 'resumed prompt')));
  await expect(page.locator('#open-session-title')).toBeFocused({ timeout: 30_000 });
  await expect(page.locator('.x-provisional')).toHaveCount(0);

  // Fork: no warning (a new session); the fork template
  await page.waitForTimeout(2_100); // launches are 2 s apart
  await head.getByRole('button', { name: 'Fork', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Starting…', level: 2 })).toBeFocused({ timeout: 20_000 });
  await expect.poll(() => scripts(run.dataDir).length, { timeout: 10_000 }).toBe(2);
  expect(scripts(run.dataDir)[1]).toContain(`'--resume' '${ID}' '--fork-session'`);
  await page.getByRole('button', { name: 'Remove provisional row' }).click();
});
