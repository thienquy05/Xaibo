// XAIBO-PROD-585 (P6-T10a unit 4a; design §6.5.2 "Sign-in fieldset", .handoff/p6-t10a-design.md, D-P6-17): the sign-in
// declaration in the Agent Map integration panel over the real service, in disposable Codex profiles under the run's TMPDIR.
// Declare Subscription, change to API key, declare an account change (a new usage epoch), clear back to agent evidence and
// declare an explicit Unknown for profile A; profile B stays Unknown; the declaration survives a restart. No credential or
// account input exists. Synthetic only.
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import { expect, shot, test } from './fixtures.ts';

const A = '00000000-0000-4000-8000-0000000c8511', B = '00000000-0000-4000-8000-0000000c8512';
const open = async (page: Page) => {
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Agent Map' }).click();
  await page.getByRole('group', { name: 'Agent Map view' }).getByRole('button', { name: 'Agents' }).click();
  await page.getByRole('button', { name: /^Open integration: Codex · .*codex-sa$/ }).click();
  const pane = page.getByRole('region', { name: 'Integration: Codex' });
  await expect(pane.getByRole('heading', { level: 2 })).toBeFocused();
  return pane;
};

test('Sign-in declaration in the panel: declare, change, account change, clear, explicit Unknown; another profile unchanged; restart', async ({ xaibo }) => {
  test.setTimeout(180_000);
  const root = path.dirname(xaibo.home), tmp = path.join(root, 'tmp');
  chmodSync(tmp, 0o700);
  const dataDir = path.join(root, 'data-signin');
  mkdirSync(dataDir, { mode: 0o700 });
  const bin = path.join(root, 'bin-signin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho "codex-cli 0.160.0"\n');
  chmodSync(path.join(bin, 'codex'), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin` };
  const first = await xaibo.launch({ dataDir, env });
  await xaibo.window(first);
  await expect.poll(() => { try { const db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true }); try { return Number(Object.values(db.prepare('SELECT count(*) FROM profiles').get() ?? {})[0]); } finally { db.close(); } } catch { return -1; } }, { timeout: 30_000 }).toBeGreaterThan(0);
  await xaibo.quit(first);
  mkdirSync(path.join(tmp, 'profiles'), { mode: 0o700 });
  const dir = (name: string) => { const d = path.join(tmp, 'profiles', name); mkdirSync(d, { mode: 0o700 }); return realpathSync(d); };
  const a = dir('codex-sa'), b = dir('codex-sb');
  const db = new DatabaseSync(path.join(dataDir, 'xaibo.db'));
  try {
    const add = db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES (?, 'codex', ?, 'manual')");
    add.run(A, a); add.run(B, b);
    db.prepare("INSERT INTO kv (key, value) VALUES ('agent.codex.roots', ?)").run(JSON.stringify([a, b]));
  } finally { db.close(); }

  const run = await xaibo.launch({ dataDir, env });
  const page = await xaibo.window(run);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  const pane = await open(page);
  const fs = pane.getByRole('group', { name: 'Sign-in method' });
  await expect(fs).toContainText('Sign-in method: Unknown', { timeout: 20_000 });
  await expect(fs).toContainText('No sign-in evidence from agent output.');
  await expect(fs.getByRole('textbox')).toHaveCount(0); // no credential or account input
  await expect(fs).toContainText('This does not sign the agent in or verify an account.');
  const save = fs.getByRole('button', { name: 'Save declaration' }), select = fs.getByRole('combobox', { name: 'Declared method' });
  await expect(select).toBeDisabled(); // agent evidence in use
  // declare Subscription
  await fs.getByRole('radio', { name: 'Owner declaration' }).check();
  await select.selectOption({ label: 'Subscription' });
  await save.click();
  await expect(fs).toContainText('Declaration saved.');
  await expect(fs).toContainText(/Owner declaration: Subscription · declared \d{4}-/);
  await expect(fs).toContainText('Sign-in method: Subscription');
  // change to API key
  await select.selectOption({ label: 'API key' });
  await save.click();
  await expect(fs).toContainText('Sign-in method: API key');
  // an account change starts a new usage epoch
  await fs.getByRole('button', { name: 'Declare account change' }).click();
  await expect(fs).toContainText('Account change declared; usage epoch updated.');
  await expect(fs).toContainText(/Usage epoch \d+ since \d{4}-.*\(declared account change\)/);
  // clear back to agent evidence
  await fs.getByRole('button', { name: 'Clear declaration' }).click();
  await expect(fs).toContainText('Declaration cleared; using agent evidence.');
  await expect(save).toBeFocused(); // unit 4a review M3: the vanished Clear button hands focus to Save
  await expect(fs).toContainText('Choose Owner declaration to pick a method.');
  await expect(fs).toContainText('Sign-in method: Unknown');
  await expect(fs).not.toContainText('Owner declaration:');
  // an explicit Unknown is a declaration, not a clear
  await fs.getByRole('radio', { name: 'Owner declaration' }).check();
  await select.selectOption({ label: 'Unknown' });
  await save.click();
  await expect(fs).toContainText(/Owner declaration: Unknown · declared/);
  await shot(page, 'sign-in-panel');
  // keyboard: the fieldset's controls are in the Tab order after the panel's own
  await save.focus();
  await page.keyboard.press('Tab');
  await expect(fs.getByRole('button', { name: 'Clear declaration' })).toBeFocused();
  // profile B is its own: still Unknown, nothing declared
  await pane.getByRole('combobox', { name: 'Profile' }).selectOption({ label: b });
  await expect(fs).toContainText('Sign-in method: Unknown', { timeout: 20_000 });
  await expect(fs).not.toContainText('Owner declaration:');
  expect(errors).toEqual([]);
  await xaibo.quit(run);

  // restart: profile A keeps its explicit Unknown declaration
  const again = await xaibo.launch({ dataDir, env });
  const page2 = await xaibo.window(again);
  const pane2 = await open(page2);
  await expect(pane2.getByRole('group', { name: 'Sign-in method' })).toContainText(/Owner declaration: Unknown · declared/, { timeout: 20_000 });
  await xaibo.quit(again);
});
