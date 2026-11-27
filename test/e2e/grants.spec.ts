// XAIBO-PROD-598 (P6-T08a slice C; D-P6-20, SEC5): the grants fieldset in the packaged app over the real service, keyboard
// only. A synthetic catalog entry is imported through main's (stubbed) file dialog, then the app restarts with one disposable
// allowed root (XAIBO_TEST_ALLOWED_ROOT, honoured only with the fixture's isolated HOME). Main's native confirmation is stubbed:
// Cancel grants nothing (the store is byte-identical); the grant button approves exactly the folder shown; a probe pick alone
// grants nothing until confirmed; revoking the folder clears the probe under it; the wizard's Profile and grants step and the
// integration panel both work without a profile; without the allowed root every grant waits with its reason. Nothing runs.
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, shot, test } from './fixtures.ts';

const SANDBOX = 'The granted program runs with your access. This grant is not a sandbox.';
const NOT_ALLOWED = 'Imported profile folders cannot be approved in this version of Xaibo, so nothing can be granted.';
type Box = { title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number };

/** Main's native dialogs: the open dialog returns globalThis.xaiboPick; the message box records its options and answers
 *  globalThis.xaiboAnswer after 900 ms (main counts a grant click within 750 ms of opening as Cancel). */
const stub = (app: ElectronApplication) => app.evaluate(({ dialog }) => {
  const g = globalThis as unknown as { xaiboPick: string; xaiboAnswer: number; xaiboBoxes: unknown[] };
  g.xaiboAnswer = 0;
  g.xaiboBoxes = [];
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [g.xaiboPick] })) as typeof dialog.showOpenDialog;
  dialog.showMessageBox = (async (...args: unknown[]) => {
    g.xaiboBoxes.push(args.at(-1));
    await new Promise((r) => setTimeout(r, 900));
    return { response: g.xaiboAnswer, checkboxChecked: false };
  }) as typeof dialog.showMessageBox;
});
const set = (app: ElectronApplication, o: { pick?: string; answer?: number }) => app.evaluate((_e, v) => {
  const g = globalThis as unknown as { xaiboPick: string; xaiboAnswer: number };
  if (v.pick !== undefined) g.xaiboPick = v.pick;
  if (v.answer !== undefined) g.xaiboAnswer = v.answer;
}, o);
/** Startup detection settled: the Agents list shows the row (the wizard's first read otherwise meets "still being detected"). */
const settled = async (page: Page, name: RegExp) => {
  await page.getByRole('group', { name: 'Agent Map view' }).getByRole('button', { name: 'Agents' }).press('Space');
  await expect(page.getByRole('list', { name: 'Agents and profiles' }).getByRole('listitem', { name })).toHaveCount(1, { timeout: 30_000 });
};
const boxes = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { xaiboBoxes: Box[] }).xaiboBoxes);

test('Grants: import, cancel grants nothing, approve root, probe, revoke cascade, wizard and panel; disabled without an allowed root', async ({ xaibo }) => {
  test.setTimeout(240_000);
  const root = path.dirname(xaibo.home);
  const dataDir = path.join(root, 'data-grants');
  mkdirSync(dataDir, { mode: 0o700 });
  const entry = path.join(root, 'entry.json');
  // the fixture entry with its profile folder one level down: a folder must sit strictly inside an allowed root, and the
  // allowed root strictly inside the isolated HOME
  const def = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'catalog', 'valid', 'synthagent.json'), 'utf8')) as { agents: [{ profileRoots: [{ relative: string }] }] };
  def.agents[0].profileRoots[0].relative = ['grants-work', '.synthagent'].join('/');
  writeFileSync(entry, JSON.stringify(def));
  const store = path.join(dataDir, 'catalog', 'imports.json');
  const press = (loc: Locator, key = 'Enter') => loc.press(key);

  // import (granting nothing), then restart to list it
  const first = await xaibo.launch({ dataDir });
  const p1 = await xaibo.window(first);
  await stub(first.app!);
  await set(first.app!, { pick: entry });
  await press(p1.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Agent Map' }));
  await settled(p1, /^Codex/);
  await press(p1.getByRole('button', { name: 'Add agent' }));
  await press(p1.getByRole('button', { name: 'Import catalog entry' }));
  await expect(p1.locator('[aria-labelledby="add-agent-step"]')).toContainText('Imported synthagent.', { timeout: 20_000 });
  await xaibo.quit(first);

  // the disposable allowed root under the isolated HOME, with the entry's evidence file and a private executable
  mkdirSync(path.join(xaibo.home, 'grants-work'), { mode: 0o700 });
  const allowed = realpathSync(path.join(xaibo.home, 'grants-work'));
  const folder = path.join(allowed, '.synthagent');
  mkdirSync(folder, { mode: 0o700 });
  writeFileSync(path.join(folder, 'config.json'), '{}\n');
  const exe = path.join(folder, 'synthagent');
  writeFileSync(exe, '#!/bin/sh\necho "synthagent 1.0.0"\n');
  chmodSync(exe, 0o755);

  // HOME as its real path (a declared folder must resolve to its own real path; macOS temp folders sit under the /var link),
  // and Gemini's home apart from it: every agent home is on the write denylist, and the fixture's Gemini home is HOME itself
  const geminiHome = path.join(root, 'gemini-home');
  mkdirSync(geminiHome, { mode: 0o700 });
  const run = await xaibo.launch({ dataDir, env: { HOME: realpathSync(xaibo.home), GEMINI_CLI_HOME: geminiHome, XAIBO_TEST_ALLOWED_ROOT: allowed } });
  const page = await xaibo.window(run);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await stub(run.app!);
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  await press(page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Agent Map' }));

  // wizard: Synthetic Agent (not detected) -> Profile and grants, with no profile yet (after startup detection settled)
  await settled(page, /^Synthetic Agent/);
  await press(page.getByRole('button', { name: 'Add agent' }));
  const step = (name: string) => page.getByRole('heading', { name, level: 3 });
  const synth = page.getByRole('radio', { name: /^Synthetic Agent: / });
  await expect(synth).toBeVisible({ timeout: 20_000 });
  await press(synth, 'Space');
  await press(page.getByRole('button', { name: 'Next' }));
  await expect(step('Prerequisites and coverage')).toBeFocused();
  await press(page.getByRole('button', { name: 'Next' }));
  await expect(step('Profile and grants')).toBeFocused();
  const grants = page.getByRole('group', { name: 'Grants' });
  const item = (label: string) => grants.getByRole('listitem').filter({ hasText: label });
  await expect(item('Profile folder user')).toContainText('Profile folder user: Not approved', { timeout: 20_000 });
  await expect(item('Version probe main')).toContainText('Not granted');
  await expect(item('Version probe main').getByRole('button', { name: 'Grant probe' })).toHaveAttribute('aria-disabled', 'true');
  await expect(grants).not.toContainText(allowed); // no paths in the renderer

  // Cancel in main's confirmation: nothing granted, store byte-identical
  const before = readFileSync(store);
  const approve = item('Profile folder user').getByRole('button', { name: 'Approve root' });
  await press(approve);
  await expect(grants).toContainText('Cancelled. Nothing was granted.', { timeout: 20_000 });
  expect(readFileSync(store).equals(before)).toBe(true);
  const [box] = await boxes(run.app!);
  expect(box!.title).toBe('Approve profile root');
  expect(box!.buttons).toEqual(['Cancel', 'Approve root']);
  expect([box!.defaultId, box!.cancelId]).toEqual([0, 0]);
  expect(box!.detail).toContain(JSON.stringify(folder));
  expect(box!.detail.endsWith(SANDBOX)).toBe(true);
  await expect(approve).toBeFocused(); // focus back on the row

  // confirm: exactly this folder is approved; focus moves to its Revoke
  await set(run.app!, { answer: 1 });
  await press(approve);
  await expect(grants).toContainText('Profile folder approved.', { timeout: 30_000 });
  await expect(item('Profile folder user')).toContainText('Profile folder user: Approved');
  await expect(item('Profile folder user').getByRole('button', { name: 'Revoke' })).toBeFocused();
  expect(readFileSync(store).equals(before)).toBe(false);

  // probe: the picked executable is shown, then granted only by the grant button
  await set(run.app!, { pick: exe, answer: 0 });
  const probe = item('Version probe main').getByRole('button', { name: 'Grant probe' });
  await expect(probe).not.toHaveAttribute('aria-disabled', 'true');
  await press(probe);
  await expect(grants).toContainText('Cancelled. Nothing was granted.', { timeout: 20_000 });
  await expect(item('Version probe main')).toContainText('Not granted');
  await set(run.app!, { answer: 1 });
  await press(probe);
  await expect(grants).toContainText('Version probe granted.', { timeout: 30_000 });
  await expect(item('Version probe main')).toContainText('Version probe main: Granted');
  await shot(page, 'grants-wizard');
  const probeBox = (await boxes(run.app!)).at(-1)!;
  expect(probeBox.title).toBe('Grant executable probe');
  expect(probeBox.detail).toContain(JSON.stringify(exe));
  expect(probeBox.detail).toContain('Command: [');

  // revoking the folder clears the probe under it, and the profile it listed (chosen here) is no longer offered (code review M1)
  const listed = page.getByRole('radio', { name: 'Default profile' });
  await press(listed, 'Space');
  await expect(listed).toBeChecked();
  await press(item('Profile folder user').getByRole('button', { name: 'Revoke' }));
  await expect(grants).toContainText('Revoked.', { timeout: 30_000 });
  await expect(item('Profile folder user')).toContainText('Profile folder user: Not approved');
  await expect(item('Version probe main')).toContainText('Version probe main: Not granted');
  await expect(item('Profile folder user').getByRole('button', { name: 'Approve root' })).toBeFocused();
  await expect(listed).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');

  // the integration panel shows the same fieldset; a grant there works too
  await press(page.getByRole('button', { name: 'Cancel' }));
  await expect(page.getByRole('button', { name: 'Add agent' })).toBeFocused(); // Cancel restores focus on the next frame
  const row = page.getByRole('list', { name: 'Agents and profiles' }).getByRole('listitem', { name: /^Synthetic Agent/ }).first();
  await press(row);
  const pane = page.getByRole('region', { name: 'Integration: Synthetic Agent' });
  await expect(pane.getByRole('heading', { level: 2, name: 'Integration: Synthetic Agent' })).toBeFocused();
  const pg = pane.getByRole('group', { name: 'Grants' });
  const pitem = (label: string) => pg.getByRole('listitem').filter({ hasText: label });
  await press(pitem('Profile folder user').getByRole('button', { name: 'Approve root' }));
  await expect(pg).toContainText('Profile folder approved.', { timeout: 30_000 });
  await expect(pitem('Profile folder user')).toContainText('Profile folder user: Approved');
  await expect(pitem('Profile folder user').getByRole('button', { name: 'Revoke' })).toBeFocused(); // kept across the move to the listed profile
  await shot(page, 'grants-panel');
  await press(pitem('Profile folder user').getByRole('button', { name: 'Revoke' }));
  await expect(pg).toContainText('Revoked.', { timeout: 30_000 });
  await expect(pitem('Profile folder user')).toContainText('Not approved');
  expect(errors).toEqual([]);
  await xaibo.quit(run);

  // production policy (no allowed root): every grant waits with its reason
  const prod = await xaibo.launch({ dataDir });
  const pp = await xaibo.window(prod);
  await press(pp.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Agent Map' }));
  await press(pp.getByRole('group', { name: 'Agent Map view' }).getByRole('button', { name: 'Agents' }), 'Space');
  await press(pp.getByRole('list', { name: 'Agents and profiles' }).getByRole('listitem', { name: /^Synthetic Agent/ }).first());
  const prodGrants = pp.getByRole('region', { name: 'Integration: Synthetic Agent' }).getByRole('group', { name: 'Grants' });
  await expect(prodGrants).toContainText(NOT_ALLOWED, { timeout: 20_000 });
  await expect(prodGrants).toContainText('Profile folder user: Unavailable');
  await expect(prodGrants.getByRole('button', { name: 'Approve root' })).toHaveAttribute('aria-disabled', 'true');
  await expect(prodGrants.getByRole('button', { name: 'Approve root' })).toHaveAccessibleDescription(NOT_ALLOWED);
  await prod.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 640));
  await expect(prodGrants).toBeVisible();
  await shot(pp, 'grants-production-narrow');
  await xaibo.quit(prod);
});
