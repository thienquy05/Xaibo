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
    // XAIBO-PROD-587: one synthetic priced request for profile B (its retained observed consumption)
    const t = Date.now() - 60_000;
    const sid = Number(db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id) VALUES ('codex', ?, 'sb-1')").run(B).lastInsertRowid);
    const ev = Number(db.prepare("INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, source_seq, received_ts) VALUES (?, 1, 'fixture', 'confirmed', 'e-sb', 'assistant', 1, ?)").run(sid, t).lastInsertRowid);
    db.prepare("INSERT INTO usage (session_id, schema_version, source, identity, scope, event_id, uncached_input, cache_read, cache_write, output, source_ts) VALUES (?, 1, 'fixture', 'r-sb', 'message', ?, 100, 0, 0, 50, ?)").run(sid, ev, t);
    db.prepare("INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, amount_usd, basis, coverage) VALUES (?, 1, 'fixture', 'usage:fixture:r-sb', 0.25, 'token_table', '{\"coverage\":\"full\"}')").run(sid);
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
  // XAIBO-PROD-586 (unit 4b, D-P6-17): the same declaration from Settings, then Open integration lands on that profile's panel
  await page2.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Settings' }).click();
  const section = page2.getByRole('region', { name: 'Sign-in declarations' });
  const pick = section.getByRole('combobox', { name: 'Profile' });
  await expect(pick.locator('option', { hasText: `Codex · ${b}` })).toHaveCount(1, { timeout: 20_000 }); // with the catalog's default profiles
  await expect(pick.locator('option', { hasText: `Codex · ${a}` })).toHaveCount(1);
  await pick.selectOption({ label: `Codex · ${b}` });
  const sfs = section.getByRole('group', { name: 'Sign-in method' });
  await expect(sfs).toContainText('Sign-in method: Unknown', { timeout: 20_000 });
  await sfs.getByRole('radio', { name: 'Owner declaration' }).check();
  await sfs.getByRole('combobox', { name: 'Declared method' }).selectOption({ label: 'Gateway' });
  await sfs.getByRole('button', { name: 'Save declaration' }).click();
  await expect(sfs).toContainText('Declaration saved.');
  await section.getByRole('button', { name: 'Open integration' }).click();
  const paneB = page2.getByRole('region', { name: 'Integration: Codex' });
  await expect(paneB.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(paneB.getByRole('group', { name: 'Sign-in method' })).toContainText(/Owner declaration: Gateway · declared/, { timeout: 20_000 });
  await expect(page2.getByRole('group', { name: 'Agent Map view' }).getByRole('button', { name: 'Agents' })).toHaveAttribute('aria-pressed', 'true');
  await shot(page2, 'sign-in-settings-open');
  // XAIBO-PROD-587 (unit 5): B's current block says Gateway (with its provenance); its request, made before the declaration, stays in an
  // earlier-epoch block under that epoch's method (never relabelled Gateway); Review integration opens B's panel
  await page2.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Dashboard' }).click();
  await page2.getByRole('group', { name: 'Dashboard view' }).getByRole('button', { name: 'Usage and history' }).click();
  const block = page2.getByRole('region', { name: `Codex · ${b}`, exact: true });
  await expect(block).toContainText('Sign-in method: Gateway', { timeout: 20_000 });
  await expect(block).toContainText(/Owner declaration: Gateway · declared \d{4}-/);
  const earlier = page2.getByRole('region', { name: `Codex · ${b} · earlier usage epoch` });
  await expect(earlier).toContainText('Sign-in method: Unknown (an earlier usage epoch)');
  const cons = earlier.getByRole('list', { name: `Observed consumption, Codex · ${b} · earlier usage epoch` });
  await expect(cons).toContainText('Observed tokens: 150');
  await expect(cons).toContainText('Estimated cost: ~$0.25');
  await expect(cons).not.toContainText('list-price'); // that epoch was not a gateway
  await expect(page2.getByRole('region', { name: `Codex · ${a}`, exact: true })).toContainText('Sign-in method: Unknown'); // A: explicit Unknown, no lead
  await shot(page2, 'sign-in-dashboard-usage');
  await block.getByRole('button', { name: `Review integration: Codex · ${b}` }).click();
  await expect(page2.getByRole('region', { name: 'Integration: Codex' }).getByRole('heading', { level: 2 })).toBeFocused();
  await expect(page2.getByRole('region', { name: 'Integration: Codex' }).getByRole('group', { name: 'Sign-in method' })).toContainText(/Owner declaration: Gateway/, { timeout: 20_000 });
  await xaibo.quit(again);
});
