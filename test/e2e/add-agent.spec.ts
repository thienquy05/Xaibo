// XAIBO-PROD-593 (P6-T08 slice D; EC-79, design §6.5.2 "Add agent", D-P6-19): the Add agent wizard in the packaged app over the
// real service, keyboard only. A synthetic codex on PATH and one disposable Codex profile under the run's TMPDIR: Add agent
// rescans and lists Codex as detected; prerequisites name installation, connection and sign-in separately and show the
// compatibility labels (VS Code unverified); Next waits for a profile, an applied preview and a receipt; the Connect diff
// dialog applies the hooks; Test receipt passes only on a lifecycle delivery made after it started; the result opens the
// integration panel. Cancel returns focus to Add agent. Nothing is installed and no agent runs.
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, shot, test } from './fixtures.ts';

const A = '00000000-0000-4000-8000-0000000c8a01', S = '00000000-0000-4000-8000-0000000c8af1';

test('Add agent, keyboard only: rescan, candidate, coverage, profile, preview and apply, receipt, result; Cancel', async ({ xaibo }) => {
  test.setTimeout(240_000);
  const root = path.dirname(xaibo.home), tmp = path.join(root, 'tmp');
  chmodSync(tmp, 0o700);
  const dataDir = path.join(root, 'data-add');
  mkdirSync(dataDir, { mode: 0o700 });
  const bin = path.join(root, 'bin-add');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho "codex-cli 0.160.0"\n');
  chmodSync(path.join(bin, 'codex'), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin` };
  const first = await xaibo.launch({ dataDir, env });
  await xaibo.window(first);
  await expect.poll(() => { try { const db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true }); try { return Number(Object.values(db.prepare('SELECT count(*) FROM profiles').get() ?? {})[0]); } finally { db.close(); } } catch { return -1; } }, { timeout: 30_000 }).toBeGreaterThan(0);
  await xaibo.quit(first);
  mkdirSync(path.join(tmp, 'profiles'), { mode: 0o700 });
  const a = path.join(tmp, 'profiles', 'codex-add');
  mkdirSync(a, { mode: 0o700 });
  const ra = realpathSync(a);
  const seed = new DatabaseSync(path.join(dataDir, 'xaibo.db'));
  try {
    seed.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES (?, 'codex', ?, 'manual')").run(A, ra);
    seed.prepare("INSERT INTO kv (key, value) VALUES ('agent.codex.roots', ?)").run(JSON.stringify([ra]));
  } finally { seed.close(); }

  const run = await xaibo.launch({ dataDir, env });
  const page = await xaibo.window(run);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  // locator.press focuses and presses in one step, after the element is attached and stable (a step's detail reload re-renders)
  const press = (loc: import('@playwright/test').Locator, key = 'Enter') => loc.press(key);
  await press(page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Agent Map' }));
  await expect(page.getByRole('heading', { name: 'Agent Map', level: 1 })).toBeFocused(); // arrival focuses the area heading
  const add = page.getByRole('button', { name: 'Add agent' });

  // Cancel returns focus to Add agent
  await press(add);
  const wizard = page.getByRole('region', { name: 'Add agent' }).first();
  await expect(page.getByRole('heading', { name: 'Rescan and candidates' })).toBeFocused();
  await press(page.getByRole('button', { name: 'Cancel' }));
  await expect(add).toBeFocused();

  // 1. rescan and candidates
  await press(add);
  const step = (name: string) => page.getByRole('heading', { name, level: 3 });
  await expect(step('Rescan and candidates')).toBeFocused();
  const next = page.getByRole('button', { name: 'Next' });
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  const codex = page.getByRole('radio', { name: /^Codex: detected, version 0\.160\.0$/ });
  await expect(codex).toBeVisible({ timeout: 20_000 });
  await press(codex, 'Space');
  await expect(codex).toBeChecked();
  await shot(page, 'add-agent-candidates');
  await press(next);

  // 2. prerequisites and coverage: installation, connection and sign-in named separately; unverified surfaces say so
  await expect(step('Prerequisites and coverage')).toBeFocused();
  const body = page.locator('[aria-labelledby="add-agent-step"]');
  await expect(body).toContainText('Detected, version 0.160.0', { timeout: 20_000 });
  await expect(body).toContainText('Xaibo never checks credentials');
  await expect(body).toContainText('VS Code extension: unverified for 0.160.0 (not tested)');
  await expect(body).not.toContainText(/\bsupported\b/);
  await shot(page, 'add-agent-coverage');
  await press(next);

  // 3. profile
  await expect(step('Profile and grants')).toBeFocused();
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  const profile = page.getByRole('radio', { name: new RegExp(`codex-add$`) });
  await press(profile, 'Space');
  await press(next);

  // 4. configuration preview through the Connect diff dialog
  await expect(step('Configuration preview')).toBeFocused();
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await press(page.getByRole('button', { name: 'Preview configuration change' }));
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('region', { name: 'Changes to apply' })).toBeVisible({ timeout: 20_000 });
  await press(dialog.getByRole('button', { name: 'Apply selected changes' }));
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(body).toContainText('Configuration is set up for this profile.', { timeout: 20_000 });
  await expect(step('Configuration preview')).toBeFocused(); // review M3: focus returns to the step, never the page body
  expect(existsSync(path.join(ra, 'hooks.json'))).toBe(true);
  await press(next);

  // 5. receipt test: only a lifecycle delivery made after the test started
  await expect(step('Receipt test')).toBeFocused();
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await press(page.getByRole('button', { name: 'Test receipt' }));
  await expect(body).toContainText('Waiting for test receipt…');
  const live = new DatabaseSync(path.join(dataDir, 'xaibo.db'));
  try {
    live.exec('PRAGMA busy_timeout = 5000');
    const t = Date.now() + 1_000;
    live.prepare("INSERT INTO hook_delivery (delivery_id, agent, profile_key, native_session_id, event, received_ts, committed_ts, unattributed) VALUES ('add-1', 'codex', ?, ?, 'Stop', ?, ?, NULL)").run(A, S, t, t);
  } finally { live.close(); }
  await expect(body).toContainText(/Receipt observed: Stop hook/, { timeout: 20_000 });
  await expect(next).not.toHaveAttribute('aria-disabled', 'true');
  await press(next);

  // 6. result from fresh evidence; Open integration lands on the panel
  await expect(step('Result')).toBeFocused();
  await expect(body).not.toContainText('none observed');
  await expect(body).toContainText(/State\s*Connected/); // the service's evidence after the receipt
  await shot(page, 'add-agent-result');
  await press(page.getByRole('button', { name: 'Open integration', exact: true }));
  const pane = page.getByRole('region', { name: 'Integration: Codex' });
  await expect(pane.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(wizard).toBeHidden();
  expect(errors, 'console errors').toEqual([]);
  await xaibo.quit(run);
});
