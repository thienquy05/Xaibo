// XAIBO-PROD-575 (P6-T10 unit 2b; FR-06, D-PD-02; design §6.5, .handoff/p6-t10-design.md section 3): the Agent Map Agents
// mode in the packaged app over the real service. Synthetic evidence only, all inside the run's temp folders: 28 extra
// Codex profiles under the run's TMPDIR (seeded as manual roots), three of them with a Codex hooks manifest entry (intact
// and untrusted; changed outside Xaibo; intact with a stored lifecycle delivery), a claude that reports no version and no
// agy executable. 31 rows: every FR-06 state (Partial coverage after a restart with a recorded hook gap), 10 a page with
// at most three resident and Load previous after eviction, the mode buttons (roving, manual activation, focus stays),
// each mode keeping its own anchor, and the narrow layout. Nothing is installed and no agent runs.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import { expect, shot, test } from './fixtures.ts';

const P = (n: number) => `00000000-0000-4000-8000-0000000c75${String(n).padStart(2, '0')}`;
const S = '00000000-0000-4000-8000-0000000c75f1';
const list = (page: Page) => page.getByRole('list', { name: 'Agents and profiles' });
const row = (page: Page, name: RegExp) => list(page).getByRole('listitem', { name });
const modes = (page: Page) => page.getByRole('group', { name: 'Agent Map view' });

/** A Codex hooks.json holding Xaibo's Stop group, and the manifest entry that records it. */
const group = (dataDir: string, key: string) => ({ hooks: [{ type: 'command', command: `'${path.join(dataDir, 'integrations', 'bin', 'xaibo-hook')}' hook codex ${key}` }] });
function entry(dataDir: string, root: string, key: string, at: number) {
  return { id: key.replace(/c75/, 'e75'), target: path.join(root, 'hooks.json'), route: 'codex-hooks', state: 'applied', existed: false, preHash: null, postHash: 'synthetic',
    owned: [{ pointer: '/hooks/Stop/0', value: group(dataDir, key) }], created: [], backup: null, at: new Date(at).toISOString() };
}

test('Agents mode: 31 rows, every FR-06 state, bounded paging, mode anchors, restart, narrow', async ({ xaibo }) => {
  test.setTimeout(240_000);
  const root = path.dirname(xaibo.home), tmp = path.join(root, 'tmp');
  chmodSync(tmp, 0o700); // the service's disposable root must be private for its config evidence to be read
  const dataDir = path.join(root, 'data-agents');
  mkdirSync(dataDir, { mode: 0o700 });
  const bin = path.join(root, 'bin-agents');
  mkdirSync(bin);
  for (const [name, out] of [['claude', 'Claude Code'], ['codex', 'codex-cli 0.160.0']]) { writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${out}"\n`); chmodSync(path.join(bin, name), 0o755); }
  const env = { PATH: `${bin}:/usr/bin:/bin` };

  // first run: the store exists (profiles are synced at boot)
  const first = await xaibo.launch({ dataDir, env });
  await xaibo.window(first);
  await expect.poll(() => { try { const db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true }); try { return Number(Object.values(db.prepare('SELECT count(*) FROM profiles').get() ?? {})[0]); } finally { db.close(); } } catch { return -1; } }, { timeout: 30_000 }).toBeGreaterThan(0);
  await xaibo.quit(first);

  const roots: string[] = [];
  mkdirSync(path.join(tmp, 'profiles'), { mode: 0o700 });
  for (let i = 1; i <= 28; i++) { const d = path.join(tmp, 'profiles', `codex-${String(i).padStart(2, '0')}`); mkdirSync(d, { mode: 0o700 }); roots.push(realpathSync(d)); }
  const at = Date.now() - 60_000;
  writeFileSync(path.join(roots[0]!, 'hooks.json'), JSON.stringify({ hooks: { Stop: [group(dataDir, P(1))] } }));
  writeFileSync(path.join(roots[1]!, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ ...group(dataDir, P(2)).hooks[0], timeout: 5 }] }] } })); // changed outside Xaibo
  writeFileSync(path.join(roots[2]!, 'hooks.json'), JSON.stringify({ hooks: { Stop: [group(dataDir, P(3))] } }));
  mkdirSync(path.join(dataDir, 'integrations'), { mode: 0o700, recursive: true });
  writeFileSync(path.join(dataDir, 'integrations', 'manifest.json'), JSON.stringify({ v: 1, entries: [1, 2, 3].map((n) => entry(dataDir, roots[n - 1]!, P(n), at)) }), { mode: 0o600 });
  const db = new DatabaseSync(path.join(dataDir, 'xaibo.db'));
  try {
    const add = db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES (?, 'codex', ?, 'manual')");
    roots.forEach((r, i) => add.run(P(i + 1), r));
    db.prepare("INSERT INTO kv (key, value) VALUES ('agent.codex.roots', ?)").run(JSON.stringify(roots));
    db.prepare("INSERT INTO hook_delivery (delivery_id, agent, profile_key, native_session_id, event, received_ts, committed_ts, unattributed) VALUES ('d-c753', 'codex', ?, ?, 'Stop', ?, ?, NULL)")
      .run(P(3), S, at + 30_000, at + 30_000);
  } finally { db.close(); }

  const run = await xaibo.launch({ dataDir, env });
  const page = await xaibo.window(run);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Agent Map' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Agent Map' })).toBeFocused();

  // mode buttons: Repositories pressed first; Tab reaches it; Right moves focus only; Enter selects; focus stays
  const repos = modes(page).getByRole('button', { name: 'Repositories' }), agents = modes(page).getByRole('button', { name: 'Agents' });
  await expect(repos).toHaveAttribute('aria-pressed', 'true');
  await expect(agents).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Tab');
  await expect(repos).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(agents).toBeFocused();
  await expect(agents).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Enter');
  await expect(agents).toHaveAttribute('aria-pressed', 'true');
  await expect(agents).toBeFocused();
  await expect(page.getByRole('heading', { level: 2, name: 'Agents' })).toBeVisible();
  await expect(page.getByRole('tree')).toHaveCount(0); // the hidden mode is not in the DOM
  await expect(page.getByRole('region', { name: 'Details' })).toHaveCount(0);

  // the first page: 10 rows in stable order, each FR-06 state from its evidence
  await expect(list(page)).toHaveAttribute('data-count', '10', { timeout: 30_000 });
  await expect(row(page, /^Antigravity CLI · No profile · Not detected$/)).toContainText('No executable found');
  await expect(row(page, /^Claude Code · Default profile · Unsupported version$/)).toContainText('Version unknown');
  const trust = row(page, /^Codex · .*codex-01 · Awaiting trust$/);
  await expect(trust).toContainText('Hooks installed, awaiting trust');
  await expect(trust).toContainText('Lifecycle receipt: none observed');
  await expect(row(page, /^Codex · .*codex-02 · Setup required$/)).toContainText('Configuration changed outside Xaibo');
  const connected = row(page, /^Codex · .*codex-03 · Connected$/);
  await expect(connected).toContainText(/Lifecycle receipt: Stop hook, \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  await expect(connected).toContainText('Content coverage: native transcript, verified (S9)');
  await expect(row(page, /^Codex · .*codex-04 · Detected$/)).toContainText('Not connected');
  await expect(page.getByText(/^Evidence checked \d{4}-/)).toBeVisible();
  await shot(page, 'agents-wide');

  // paging: Load more three times; the fourth page evicts the first; Load previous brings it back and leaves
  const more = page.getByRole('button', { name: 'Load more' });
  await more.click();
  await expect(list(page)).toHaveAttribute('data-count', '20');
  await more.click();
  await expect(list(page)).toHaveAttribute('data-count', '30');
  // ArrowDown on the last loaded row fetches the fourth page (evicting the first) and keeps focus there; that redraw must
  // not lose the row as this mode's anchor (code review H1)
  await list(page).locator('li[tabindex="0"]').focus();
  await page.keyboard.press('End');
  const edgeRow = row(page, /codex-28 · Detected$/);
  await expect(edgeRow).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(list(page)).toHaveAttribute('data-count', '21'); // pages 2-4: 10 + 10 + 1
  await expect(more).toHaveCount(0);
  await expect(edgeRow).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Load previous agents' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(agents).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(repos).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(list(page)).toHaveAttribute('data-count', '21');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(edgeRow).toBeFocused();
  await page.keyboard.press('Home');
  await expect(row(page, /codex-09 · Detected$/)).toBeFocused(); // the first page (agy, claude, codex-01..08) was evicted
  await page.keyboard.press('End');
  await expect(row(page, /^Codex · Default profile · Detected$/)).toBeFocused(); // the 31st row
  const previous = page.getByRole('button', { name: 'Load previous agents' });
  await previous.focus();
  await previous.press('Enter');
  await expect(list(page)).toHaveAttribute('data-count', '30');
  await expect(previous).toHaveCount(0);
  await expect(row(page, /Not detected$/)).toBeFocused(); // nothing earlier left: the first row takes focus
  await expect(list(page).locator('li[tabindex="0"]')).toHaveCount(1); // one roving row
  await expect(list(page).locator('button[tabindex="0"]')).toHaveCount(1); // and only its own Open integration joins the Tab order

  // anchors: a focused row survives a round trip to Repositories, which keeps its own state
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const anchor = row(page, /^Codex · .*codex-01 · Awaiting trust$/);
  await expect(anchor).toBeFocused();
  await page.keyboard.press('Shift+Tab'); // one tab stop in the group: the selected mode
  await expect(agents).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(repos).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(repos).toBeFocused();
  await expect(page.getByRole('tree', { name: 'Repositories, worktrees and sessions' })).toBeVisible();
  await expect(list(page)).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(agents).toHaveAttribute('aria-pressed', 'true');
  await expect(list(page)).toHaveAttribute('data-count', '30'); // pages kept, refetched in place
  await expect(page.getByText('Loading agents…')).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(anchor).toBeFocused();

  // XAIBO-PROD-578 (unit 4b): Enter on the focused row opens its integration panel; heading focused; status only, no write control
  await page.keyboard.press('Enter');
  const pane = page.getByRole('region', { name: 'Integration: Codex' });
  await expect(pane.getByRole('heading', { level: 2, name: 'Integration: Codex' })).toBeFocused();
  await expect(pane).toContainText('Hooks installed, awaiting trust');
  await expect(pane.getByText(/Open Codex once/)).toBeVisible();
  await expect(pane).toContainText('Codex hooks: intact');
  await expect(pane).toContainText('Codex notify wrapper: unavailable');
  // XAIBO-PROD-579 (unit 5): the intact hooks offer Disconnect and Full Uninstall (each previewed), never Connect again
  await expect(pane.getByRole('button', { name: /Connect|Disconnect|Uninstall/ })).toHaveText(['Disconnect', 'Full Uninstall']);
  // the Profile select is scoped to Codex; a change keeps focus there
  const select = pane.getByRole('combobox', { name: 'Profile' });
  await expect(select.locator('option')).toHaveCount(29);
  await select.focus(); // as a keyboard user is (selectOption alone never focuses)
  await select.selectOption(P(2));
  await expect(pane).toContainText('Codex hooks: changed outside Xaibo');
  await expect(select).toBeFocused();
  // Test receipt: waiting, then a lifecycle delivery stored after the click is observed (nothing is run)
  await pane.getByRole('button', { name: 'Test receipt' }).click();
  await expect(pane).toContainText('Waiting for test receipt…');
  for (let i = 0; ; i++) {
    try {
      const w = new DatabaseSync(path.join(dataDir, 'xaibo.db'));
      try { w.prepare("INSERT INTO hook_delivery (delivery_id, agent, profile_key, native_session_id, event, received_ts, committed_ts, unattributed) VALUES ('d-c752', 'codex', ?, ?, 'Stop', ?, ?, NULL)").run(P(2), S, Date.now() + 1, Date.now() + 1); } finally { w.close(); }
      break;
    } catch (e) { if (i > 20) throw e; await page.waitForTimeout(100); } // the service may hold a write briefly
  }
  await expect(pane).toContainText(/Receipt observed: Stop hook, \d{4}-/, { timeout: 15_000 });
  // code review M1: opening another row while the panel is open shows that row's integration, heading focused
  await page.getByRole('button', { name: 'Open integration: Claude Code · Default profile' }).click();
  const claudePane = page.getByRole('region', { name: 'Integration: Claude Code' });
  await expect(claudePane.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(claudePane.getByRole('combobox', { name: 'Profile' })).toHaveCount(0); // never Codex's profiles
  await claudePane.getByRole('button', { name: 'Back to map' }).click();
  await expect(row(page, /^Claude Code · Default profile · Unsupported version$/)).toBeFocused();
  // code review M2: a later mode round trip leaves focus on the mode button (no old focus request replays)
  await page.keyboard.press('Shift+Tab'); // nothing earlier is loaded, so no Load previous: the mode group
  await expect(agents).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(list(page)).toBeVisible();
  await expect(agents).toBeFocused();
  await anchor.focus();

  // narrow: the list wraps, no horizontal scrolling
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 640));
  await expect(anchor).toBeVisible();
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth)).toBe(true);
  await shot(page, 'agents-narrow');
  // below 800 px the panel replaces the list; Back to map brings the list and the row back
  await anchor.focus();
  await page.keyboard.press('Enter');
  await expect(pane.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(list(page)).toBeHidden();
  await pane.getByRole('button', { name: 'Back to map' }).click();
  await expect(anchor).toBeFocused();
  await shot(page, 'agents-narrow-back');
  expect(errors).toEqual([]);
  await xaibo.quit(run);

  // restart with a recorded Codex hook gap: the receipt-bearing row is Partial coverage, the others keep their states
  const db2 = new DatabaseSync(path.join(dataDir, 'xaibo.db'));
  try { db2.prepare("INSERT INTO hook_gaps (reason, agent, locator, recorded_at) VALUES ('spool-overflow', 'codex', 'gap-c75', ?)").run(Date.now()); } finally { db2.close(); }
  const again = await xaibo.launch({ dataDir, env });
  const page2 = await xaibo.window(again);
  await page2.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Agent Map' }).click();
  await modes(page2).getByRole('button', { name: 'Agents' }).click();
  await expect(row(page2, /^Codex · .*codex-03 · Partial coverage$/)).toContainText('Recent hook events lost (spool overflow)', { timeout: 30_000 });
  await expect(row(page2, /^Codex · .*codex-01 · Awaiting trust$/)).toHaveCount(1);
  await xaibo.quit(again);
});

// XAIBO-PROD-579 (P6-T10 unit 5; design §6.5.2, §5.1, §5.4): the integration diff dialog over the real service, in disposable
// profiles under the run's TMPDIR. Claude Connect previews with retention selected; deselecting it replans and drops its
// change; Escape cancels and nothing is written. The real default profile is refused with Close. Codex Connect: a file
// changed after the preview answers a fresh preview that waits for another Apply; the applied hooks keep the foreign
// command; Disconnect restores; Clean up clears a record of hooks removed outside Xaibo; Full Uninstall names every profile
// and lists the conflict; the Agents list refreshes; narrow dialog wraps.
const D = (n: number) => `00000000-0000-4000-8000-0000000d79${String(n).padStart(2, '0')}`;
test('Integration diff dialog: Connect with retention, changed file, Disconnect, Clean up, Full Uninstall', async ({ xaibo }) => {
  test.setTimeout(240_000);
  const root = path.dirname(xaibo.home), tmp = path.join(root, 'tmp');
  chmodSync(tmp, 0o700);
  const dataDir = path.join(root, 'data-dialog');
  mkdirSync(dataDir, { mode: 0o700 });
  const bin = path.join(root, 'bin-dialog');
  mkdirSync(bin);
  for (const [name, out] of [['claude', '2.1.332 (Claude Code)'], ['codex', 'codex-cli 0.160.0']]) { writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${out}"\n`); chmodSync(path.join(bin, name), 0o755); }
  const env = { PATH: `${bin}:/usr/bin:/bin` };
  const first = await xaibo.launch({ dataDir, env });
  await xaibo.window(first);
  await expect.poll(() => { try { const db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true }); try { return Number(Object.values(db.prepare('SELECT count(*) FROM profiles').get() ?? {})[0]); } finally { db.close(); } } catch { return -1; } }, { timeout: 30_000 }).toBeGreaterThan(0);
  await xaibo.quit(first);

  mkdirSync(path.join(tmp, 'profiles'), { mode: 0o700 });
  const dir = (name: string) => { const d = path.join(tmp, 'profiles', name); mkdirSync(d, { mode: 0o700 }); return realpathSync(d); };
  const claudeA = dir('claude-a'), [a, b, c, d] = ['codex-a', 'codex-b', 'codex-c', 'codex-d'].map(dir) as [string, string, string, string];
  const at = Date.now() - 60_000;
  writeFileSync(path.join(b, 'hooks.json'), JSON.stringify({ hooks: {} })); // Xaibo's group removed outside Xaibo
  writeFileSync(path.join(c, 'hooks.json'), JSON.stringify({ hooks: { Stop: [group(dataDir, D(3))] } }));
  writeFileSync(path.join(d, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ ...group(dataDir, D(4)).hooks[0], timeout: 5 }] }] } })); // changed outside Xaibo
  mkdirSync(path.join(dataDir, 'integrations'), { mode: 0o700, recursive: true });
  const manifest = path.join(dataDir, 'integrations', 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ v: 1, entries: [[b, 2], [c, 3], [d, 4]].map(([r, n]) => entry(dataDir, r as string, D(n as number), at)) }), { mode: 0o600 });
  const db = new DatabaseSync(path.join(dataDir, 'xaibo.db'));
  try {
    const add = db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES (?, ?, ?, 'manual')");
    [a, b, c, d].forEach((r, i) => add.run(D(i + 1), 'codex', r));
    add.run(D(5), 'claude', claudeA);
    db.prepare("INSERT INTO kv (key, value) VALUES ('agent.codex.roots', ?)").run(JSON.stringify([a, b, c, d]));
    db.prepare("INSERT INTO kv (key, value) VALUES ('agent.claude.roots', ?)").run(JSON.stringify([claudeA]));
  } finally { db.close(); }

  const run = await xaibo.launch({ dataDir, env });
  const page = await xaibo.window(run);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Agent Map' }).click();
  await modes(page).getByRole('button', { name: 'Agents' }).click();
  const dialog = page.getByRole('dialog');
  const open = async (agent: string, profile: RegExp) => {
    await page.getByRole('button', { name: new RegExp(`^Open integration: ${agent} · ${profile.source}`) }).click();
    const pane = page.getByRole('region', { name: `Integration: ${agent}` });
    await expect(pane.getByRole('heading', { level: 2 })).toBeFocused();
    return pane;
  };

  // Claude: retention selected by default, deselecting replans without its change; Escape = Cancel; nothing written
  const claude = await open('Claude Code', /.*claude-a$/);
  const connect = claude.getByRole('button', { name: 'Connect', exact: true });
  await connect.click();
  await expect(dialog).toHaveAccessibleName('Connect Claude Code');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  const keep = dialog.getByRole('checkbox', { name: /^Raise transcript retention from \d+ to 45 days$/ });
  await expect(keep).toBeChecked({ timeout: 20_000 });
  await expect(dialog.getByRole('checkbox', { name: 'Lifecycle hooks (required)' })).toBeDisabled();
  const diff = dialog.getByRole('region', { name: 'Changes to apply' });
  await expect(diff).toContainText('/cleanupPeriodDays: 45');
  await expect(diff).toContainText('Runs: claude plugin');
  await keep.uncheck();
  await expect(dialog).toContainText('Preview updated.');
  await expect(keep).not.toBeChecked();
  await expect(diff).not.toContainText('/cleanupPeriodDays');
  await expect(dialog.getByRole('button', { name: 'Apply selected changes' })).not.toHaveAttribute('aria-disabled', 'true');
  await shot(page, 'dialog-connect-claude');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(connect).toBeFocused();
  expect(existsSync(path.join(claudeA, 'settings.json'))).toBe(false);
  // XAIBO-PROD-581 (unit 6b): the separate tee toggle, its own preview; Cancel leaves the toggle and the files as they were
  const teeBox = claude.getByRole('checkbox', { name: 'Optional status-line tee' });
  await expect(teeBox).not.toBeChecked();
  await teeBox.click(); // the toggle opens the dialog; it stays unchecked until applied (check() would expect it checked)
  await expect(dialog).toHaveAccessibleName('Turn on the status-line tee: Claude Code');
  await expect(dialog.getByRole('region', { name: 'Changes to apply' })).toContainText('/statusLine', { timeout: 20_000 });
  await expect(dialog).toContainText('Hooks are not changed.');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(teeBox).toBeFocused();
  await expect(teeBox).not.toBeChecked();
  expect(existsSync(path.join(claudeA, 'settings.json'))).toBe(false);
  // Escape then a quick Space: the old dialog's queued close event must not empty the reopened one (unit 6b finding)
  await page.keyboard.press('Space');
  await expect(dialog.getByRole('region', { name: 'Changes to apply' })).toContainText('/statusLine', { timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Turn on tee' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(claude).toContainText('Status-line tee on.');
  await expect(teeBox).toBeChecked();
  const teeOn = JSON.parse(readFileSync(path.join(claudeA, 'settings.json'), 'utf8')) as Record<string, unknown>;
  expect(Object.keys(teeOn)).toEqual(['statusLine']); // no hooks, no retention
  await teeBox.click();
  await expect(dialog).toHaveAccessibleName('Turn off the status-line tee: Claude Code');
  await expect(dialog.getByRole('region', { name: 'Changes to apply' })).toContainText(/Status-line tee · .*claude-a/, { timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Turn off tee' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(claude).toContainText('Status-line tee off.');
  await expect(teeBox).not.toBeChecked();
  expect(existsSync(path.join(claudeA, 'settings.json')) ? readFileSync(path.join(claudeA, 'settings.json'), 'utf8') : '').not.toContain('xaibo-statusline');
  // the real default profile: refused before any read, with Close only
  await claude.getByRole('combobox', { name: 'Profile' }).selectOption({ label: 'Default profile' });
  await claude.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dialog).toContainText('real-profile changes stay off until Gate 6', { timeout: 20_000 });
  await expect(dialog.getByRole('button', { name: 'Apply selected changes' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(claude.getByRole('button', { name: 'Connect', exact: true })).toBeFocused();

  // Codex: a file changed after the preview answers a fresh preview that waits for another Apply
  const codex = await open('Codex', /.*codex-a$/);
  await codex.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dialog).toHaveAccessibleName('Connect Codex');
  await expect(diff).toContainText('/hooks/Stop/0', { timeout: 20_000 });
  await expect(dialog).toContainText('After applying:');
  await expect(dialog).toContainText('Existing commands from other tools stay in place.');
  const foreign = { hooks: [{ type: 'command', command: 'echo foreign' }] };
  writeFileSync(path.join(a, 'hooks.json'), JSON.stringify({ hooks: { Stop: [foreign] } }));
  const apply = dialog.getByRole('button', { name: 'Apply selected changes' });
  await apply.click();
  await expect(dialog).toContainText('The configuration changed since the preview', { timeout: 20_000 });
  await expect(diff).toContainText('/hooks/Stop/1');
  expect(readFileSync(path.join(a, 'hooks.json'), 'utf8')).not.toContain('xaibo-hook'); // never submitted again by itself
  await apply.click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(codex.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(codex).toContainText('Changes applied. Hooks installed, awaiting trust.');
  await expect(codex).toContainText('Codex hooks: intact');
  const hooks = readFileSync(path.join(a, 'hooks.json'), 'utf8');
  expect(hooks).toContain('echo foreign');
  expect(hooks).toContain('xaibo-hook');
  await expect(row(page, /^Codex · .*codex-a · Awaiting trust$/)).toHaveCount(1, { timeout: 20_000 }); // the list refreshed
  // Disconnect: the profile's entry, then the foreign command alone remains
  await codex.getByRole('button', { name: 'Disconnect' }).click();
  await expect(dialog).toHaveAccessibleName('Disconnect Codex');
  await expect(dialog.getByRole('region', { name: 'Changes to apply' })).toContainText(/Codex hooks · .*codex-a/, { timeout: 20_000 });
  await expect(dialog).toContainText('Session history is kept.');
  await dialog.getByRole('button', { name: 'Disconnect' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(codex).toContainText(/Disconnected: 1 entry removed or restored/);
  expect(readFileSync(path.join(a, 'hooks.json'), 'utf8')).not.toContain('xaibo-hook');
  expect(readFileSync(path.join(a, 'hooks.json'), 'utf8')).toContain('echo foreign');
  await expect(codex.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();

  // Clean up: hooks removed outside Xaibo leave Xaibo's record, which is cleared
  const select = codex.getByRole('combobox', { name: 'Profile' });
  await select.selectOption(D(2));
  await codex.getByRole('button', { name: 'Clean up' }).click();
  await expect(dialog).toHaveAccessibleName('Clean up Codex');
  await expect(dialog).toContainText("Xaibo's record of this entry", { timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Clean up' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(codex).toContainText('Cleaned up 1 leftover.');
  await expect(codex.getByRole('button', { name: 'Clean up' })).toHaveCount(0);

  // Full Uninstall: all profiles, every entry named, the changed one listed as a conflict; history kept
  await select.selectOption(D(3));
  await codex.getByRole('button', { name: 'Full Uninstall' }).click();
  await expect(dialog).toHaveAccessibleName('Full Uninstall: all profiles');
  await expect(dialog.getByRole('region', { name: 'Changes to apply' }).getByRole('heading', { level: 3 })).toHaveCount(2, { timeout: 20_000 });
  await expect(dialog.getByRole('heading', { name: 'Conflicts' })).toBeVisible();
  await expect(dialog).toContainText(/codex-d: changed outside Xaibo/);
  await expect(dialog).toContainText('Session history is kept');
  await shot(page, 'dialog-uninstall');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'dialog-uninstall-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await dialog.getByRole('button', { name: 'Uninstall from all profiles' }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(codex).toContainText(/Uninstalled from all profiles: 2 entries removed or restored/);
  expect(readFileSync(path.join(c, 'hooks.json'), 'utf8')).not.toContain('xaibo-hook');
  expect(readFileSync(path.join(d, 'hooks.json'), 'utf8')).toContain('"timeout":5'); // the changed value is kept

  // narrow: one column, wrapped lines, no horizontal scroll
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 640));
  await codex.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(diff).toContainText('/hooks/Stop/0', { timeout: 20_000 });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await shot(page, 'dialog-narrow');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(codex.getByRole('button', { name: 'Connect', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
  await xaibo.quit(run);
});
