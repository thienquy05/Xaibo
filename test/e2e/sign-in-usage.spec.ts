// XAIBO-PROD-585 (P6-T10a unit 4a; design §6.5.2 "Sign-in fieldset", .handoff/p6-t10a-design.md, D-P6-17): the sign-in
// declaration in the Agent Map integration panel over the real service, in disposable Codex profiles under the run's TMPDIR.
// Declare Subscription, change to API key, declare an account change (a new usage epoch), clear back to agent evidence and
// declare an explicit Unknown for profile A; profile B stays Unknown; the declaration survives a restart. No credential or
// account input exists. Synthetic only.
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Locator, Page } from '@playwright/test';
import { addRules, focusProblems, layoutProblems, setTheme, SPACING, type Theme } from './a11y-checks.ts';
import { expect, shot, test, type Xaibo } from './fixtures.ts';

const A = '00000000-0000-4000-8000-0000000c8511', B = '00000000-0000-4000-8000-0000000c8512';
const open = async (page: Page) => {
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Agent Map' }).click();
  await page.getByRole('group', { name: 'Agent Map view' }).getByRole('button', { name: 'Agents' }).click();
  await page.getByRole('button', { name: /^Open integration: Codex · .*codex-sa$/ }).click();
  const pane = page.getByRole('region', { name: 'Integration: Codex' });
  await expect(pane.getByRole('heading', { level: 2 })).toBeFocused();
  return pane;
};

/** Disposable Codex profiles A and B (manual roots under the run's TMPDIR, UUID ids) in a fresh data dir, with one synthetic
 *  priced request for B (its retained observed consumption). */
async function seed(xaibo: Xaibo) {
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
  return { dataDir, env, a, b };
}

test('Sign-in declaration in the panel: declare, change, account change, clear, explicit Unknown; another profile unchanged; restart', async ({ xaibo }) => {
  test.setTimeout(180_000);
  const { dataDir, env, a, b } = await seed(xaibo);

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
  await expect(paneB.getByRole('button', { name: 'Return to Dashboard' })).toHaveCount(0); // XAIBO-PROD-610: opened from Settings
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
  // XAIBO-PROD-610 (Gate 6 D1-3, design §6.5.2): a panel opened from the Dashboard offers Return to Dashboard, which shows Usage
  // and history again and focuses the button that opened it
  await shot(page2, 'sign-in-dashboard-panel');
  await page2.getByRole('region', { name: 'Integration: Codex' }).getByRole('button', { name: 'Return to Dashboard' }).click();
  await expect(page2.getByRole('button', { name: `Review integration: Codex · ${b}` })).toBeFocused({ timeout: 10_000 });
  await expect(page2.getByRole('region', { name: `Codex · ${b}`, exact: true })).toContainText('Sign-in method: Gateway');
  await xaibo.quit(again);
});

// P6-T10a closing check (design §2.4, §8.1; the P4-T15b method): the three sign-in surfaces (the integration panel's
// fieldset, Settings Sign-in declarations, Dashboard usage blocks with consumption and links) at 320 CSS px and with 200%
// text plus the text-spacing overrides, light and dark: no overflow, clipped text, overlapping controls or clipped focus rings.
for (const theme of ['light', 'dark'] as Theme[]) {
  for (const mode of ['reflow', 'text200'] as const) {
    test(`sign-in surfaces ${theme} × ${mode}: no overflow, clipping, overlap or clipped focus rings`, async ({ xaibo }) => {
      test.setTimeout(180_000);
      const { dataDir, env, b } = await seed(xaibo);
      const run = await xaibo.launch({ dataDir, env });
      const page = await xaibo.window(run);
      const app = run.app!;
      const errors: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await setTheme(app, page, theme);
      if (mode === 'reflow') {
        await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(640, 560); w.webContents.setZoomFactor(2); });
        await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(320);
      } else {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 640));
        await addRules(page, ['html { font-size: 200% !important; }']);
      }
      await addRules(page, SPACING);
      const problems: string[] = [];
      const check = async (where: string, target: Locator) => {
        // WCAG 1.4.4: a select's text scales with the page text like its label's (form controls do not inherit font by default)
        for (const s of await target.locator('select').all()) {
          const [own, label] = await s.evaluate((e) => [getComputedStyle(e).fontSize, getComputedStyle(e.parentElement!).fontSize]);
          if (own !== label) problems.push(`${where}: select ${await s.getAttribute('id') ?? await s.getAttribute('aria-label') ?? ''} text ${own} beside its label's ${label}`);
        }
        if (process.env.XAIBO_SHOT) { // the window as painted (page screenshots come out blank under the window zoom)
          await target.evaluate((e) => (e.querySelector('select, button') ?? e).scrollIntoView({ block: 'start' }));
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // painted before the capture
          const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'));
          writeFileSync(path.join(process.env.XAIBO_SHOT, `sign-in-${theme}-${mode}-${where}.png`), Buffer.from(png, 'base64'));
        }
        problems.push(...await layoutProblems(page, where));
        await page.locator('body').focus();
        problems.push(...await focusProblems(page, where));
      };
      const pane = await open(page);
      await expect(pane.getByRole('group', { name: 'Sign-in method' })).toContainText('Sign-in method: Unknown', { timeout: 20_000 });
      await check('panel', pane);
      await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Settings' }).click();
      const section = page.getByRole('region', { name: 'Sign-in declarations' });
      await section.getByRole('combobox', { name: 'Profile' }).selectOption({ label: `Codex · ${b}` });
      await expect(section.getByRole('group', { name: 'Sign-in method' })).toContainText('Sign-in method: Unknown', { timeout: 20_000 });
      await check('settings', section);
      await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Dashboard' }).click();
      await page.getByRole('group', { name: 'Dashboard view' }).getByRole('button', { name: 'Usage and history' }).click();
      const usage = page.getByRole('region', { name: `Codex · ${b}`, exact: true });
      await expect(usage).toContainText('Observed tokens: 150', { timeout: 20_000 });
      await check('dashboard-usage', usage);
      expect(errors, 'console errors').toEqual([]);
      expect(problems, `layout and focus problems (${mode})`).toEqual([]);
      await xaibo.quit(run);
    });
  }
}
