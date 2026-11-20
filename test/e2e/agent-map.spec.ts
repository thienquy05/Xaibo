// XAIBO-PROD-538 (P5-T18a part 2a; design §6.5–6.5.1, S-37, US-21; look D-P5-13): the Agent Map area in the packaged
// app. Synthetic git layouts in the temp home (a main checkout with a linked worktree, plain folders) and Claude/Codex
// sessions: the nav link, repository → worktree → sessions with sessions of two agents under one shared worktree, a
// session moved to a Project override counted once (only under the override), the cwd fallback root, the tree keyboard
// (arrows, Home/End, typeahead, Space, Enter), focus to the surviving ancestor on collapse, Load more groups, the
// fifth expanded path evicting the least recent with an announcement, Enter on a leaf opening Session, and the narrow
// layout. Failed-page Retry and the refusal are covered at U level (tree.ts); connectors and Return come in part 2b.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openSessions, REPO, shot, test } from './fixtures.ts';

const sid = (i: number) => `00000000-0000-4000-8000-00000000ac${String(i).padStart(2, '0')}`;
function claude(home: string, i: number, cwd: string, prompt: string) {
  const dir = path.join(home, '.claude', 'projects', cwd.replaceAll('/', '-'));
  mkdirSync(dir, { recursive: true });
  const line = { parentUuid: null, type: 'user', uuid: `00000000-0000-4000-8000-00000000ce${String(i).padStart(2, '0')}`, timestamp: `2026-11-1${i % 10}T10:00:00.000Z`,
    cwd, sessionId: sid(i), entrypoint: 'cli', message: { role: 'user', content: prompt } };
  writeFileSync(path.join(dir, `${sid(i)}.jsonl`), `${JSON.stringify(line)}\n`);
}
/** The synthetic Codex simple-turn rollout with its cwd moved to `cwd`. */
function codex(home: string, cwd: string) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const fixture = path.join(REPO, 'test', 'fixtures', 'synthetic', 'codex', '0.160.0', 'simple-turn');
  const name = readdirSync(fixture).find((f) => f.startsWith('rollout-'))!;
  writeFileSync(path.join(dir, name), readFileSync(path.join(fixture, name), 'utf8').replaceAll('/tmp/xaibo-fixture/alpha', cwd));
}
function gitDir(dir: string) {
  mkdirSync(path.join(dir, 'objects'), { recursive: true });
  mkdirSync(path.join(dir, 'refs'), { recursive: true });
  writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
}
/** example-app (main checkout) with a linked worktree example-app-docs, as git lays them out; no git command runs. */
function repoLayout(root: string) {
  const main = path.join(root, 'example-app'), docs = path.join(root, 'example-app-docs'), admin = path.join(main, '.git', 'worktrees', 'docs');
  gitDir(path.join(main, '.git'));
  mkdirSync(admin, { recursive: true });
  mkdirSync(docs, { recursive: true });
  writeFileSync(path.join(admin, 'commondir'), '../..\n');
  writeFileSync(path.join(admin, 'gitdir'), `${path.join(docs, '.git')}\n`);
  writeFileSync(path.join(docs, '.git'), `gitdir: ${admin}\n`);
  return { main, docs };
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Repositories, worktrees and sessions' });
const item = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name });
const openMap = async (page: Page) => {
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Agent Map' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Agent Map' })).toBeFocused();
};
const announced = (page: Page) => page.locator('.x-map-area > [aria-live="polite"]');

test('Agent Map: shared worktree, Project override counted once, cwd fallback, keyboard, open in Session, narrow', async ({ xaibo }) => {
  test.setTimeout(180_000);
  const work = path.join(xaibo.home, 'work');
  const { main, docs } = repoLayout(work);
  mkdirSync(path.join(work, 'plain'), { recursive: true });
  xaibo.touchStore(() => {
    claude(xaibo.home, 1, main, 'Add a rate limiter');
    claude(xaibo.home, 2, docs, 'Write the docs pass');
    claude(xaibo.home, 3, path.join(work, 'plain'), 'Summarize the meeting notes');
    claude(xaibo.home, 4, main, 'Tune the token budget');
    codex(xaibo.home, main);
  });
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));

  // move one session to the Project override Atlas first (Session list More actions)
  await openSessions(page);
  const records = page.locator('.x-list-pane .x-srow');
  await expect(records.filter({ hasText: 'token budget' })).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole('list', { name: 'Sessions' })).toHaveAttribute('data-count', '6', { timeout: 30_000 }); // and the shared fixture's
  await page.getByRole('button', { name: /^More actions for .*Tune the token budget/ }).click();
  await page.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name: 'Move to…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move to project or folder' });
  await dialog.getByRole('combobox', { name: 'Project', exact: true }).selectOption('new');
  await dialog.getByRole('textbox', { name: 'Project name' }).fill('Atlas');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  // the nav link (between Session and Settings) opens Agent Map with its heading focused; roots collapsed
  const links = page.getByRole('navigation', { name: 'Areas' }).getByRole('link');
  await expect(links).toHaveText(['Dashboard', 'Session', 'Agent Map', 'Settings']);
  await openMap(page);
  const repo = item(page, /^example-app · Sessions 3$/); // the moved session is not counted here
  await expect(repo).toBeVisible({ timeout: 20_000 });
  await expect(repo).toHaveAttribute('aria-level', '1');
  await expect(repo).toHaveAttribute('aria-expanded', 'false');
  const atlas = item(page, /^Project override: Atlas · Sessions 1$/);
  await expect(atlas).toBeVisible();
  const plain = item(page, /^Folder: .*\/plain · 1 session/);
  await expect(plain).toContainText('No git directory observed');
  await expect(tree(page).getByRole('treeitem')).toHaveCount(4); // and the shared fixture's /tmp/xaibo-fixture/project folder

  // select a repository: Details shows its evidence; Right expands it (worktrees: main checkout and linked)
  await repo.locator('.x-map-label').click();
  await expect(repo).toHaveAttribute('aria-selected', 'true');
  const details = page.getByRole('region', { name: 'Details' });
  await expect(details.getByRole('heading', { name: 'example-app' })).toBeVisible();
  await expect(details).toContainText('Membership evidence');
  await expect(details).toContainText('Repository');
  await expect(repo).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(repo).toHaveAttribute('aria-expanded', 'true');
  const mainWt = item(page, /^example-app · 2 sessions · .* · Claude Code, Codex$/); // two agents in one shared worktree
  await expect(mainWt).toContainText('Main checkout');
  await expect(mainWt).toHaveAttribute('aria-level', '2');
  await expect(item(page, /^example-app-docs · 1 session · .* · Claude Code$/)).toContainText('Linked worktree');
  await expect(announced(page)).toHaveText('2 worktrees loaded');

  // Down to the main checkout, Space expands without selecting; its sessions are both agents', not the moved one
  await page.keyboard.press('ArrowDown');
  await expect(mainWt).toBeFocused();
  await page.keyboard.press(' ');
  await expect(mainWt).toHaveAttribute('aria-expanded', 'true');
  await expect(mainWt).not.toHaveAttribute('aria-selected', 'true');
  const limiter = item(page, /Add a rate limiter · Claude Code · /);
  await expect(limiter).toHaveAttribute('aria-level', '3');
  await expect(tree(page).getByRole('treeitem', { name: /· Codex ·/ })).toHaveCount(1);
  await expect(tree(page).getByRole('treeitem', { name: /token budget/ })).toHaveCount(0);

  // Left from a leaf goes to its parent; a collapse with focus inside hands focus to the surviving node
  await page.keyboard.press('ArrowRight');
  await expect(tree(page).getByRole('treeitem', { level: 3 }).first()).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(mainWt).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await repo.locator('.x-map-chev').click(); // the chevron only toggles
  await expect(repo).toHaveAttribute('aria-expanded', 'false');
  await expect(repo).toBeFocused();
  await expect(tree(page).getByRole('treeitem')).toHaveCount(4);

  // Home/End and typeahead over loaded labels
  await page.keyboard.press('End');
  await expect(tree(page).getByRole('treeitem').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tree(page).getByRole('treeitem').first()).toBeFocused();
  await page.keyboard.press('p');
  await expect(atlas).toBeFocused();

  // the override's child is the evidenced worktree, qualified by its repository
  await page.keyboard.press('ArrowRight');
  const atlasWt = item(page, /^example-app · 1 session · .* · Claude Code$/);
  await expect(atlasWt).toContainText('Main checkout · example-app');
  await shot(page, 'agent-map-wide');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'agent-map-wide-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // the cwd fallback holds sessions directly; Enter on a leaf opens it in Session
  await plain.locator('.x-map-chev').click();
  const notes = item(page, /Summarize the meeting notes · Claude Code · /);
  await expect(notes).toHaveAttribute('aria-level', '2');
  await notes.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: /Summarize the meeting notes/ })).toBeFocused({ timeout: 10_000 });
  await expect(links.filter({ hasText: 'Session' }).first()).toHaveAttribute('aria-current', 'page');

  // narrow: Details below the tree, 12 px indentation, no horizontal scroll
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 640));
  await openMap(page);
  await expect(repo).toBeVisible({ timeout: 10_000 });
  await repo.focus();
  await page.keyboard.press('ArrowRight');
  await expect(mainWt).toBeVisible();
  const t = (await page.getByRole('region', { name: 'Repositories' }).boundingBox())!, d = (await details.boundingBox())!;
  expect(d.y).toBeGreaterThanOrEqual(t.y + t.height);
  expect(await mainWt.locator('.x-map-node').evaluate((el) => getComputedStyle(el).paddingInlineStart)).toBe('12px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await shot(page, 'agent-map-narrow');
  expect(errors, 'console errors').toEqual([]);
});

test('Agent Map: Load more groups keeps the bound; a fifth expanded path evicts the least recent with an announcement', async ({ xaibo }) => {
  test.setTimeout(150_000);
  const work = path.join(xaibo.home, 'work');
  xaibo.touchStore(() => {
    for (let i = 1; i <= 12; i++) {
      const dir = path.join(work, `folder-${String(i).padStart(2, '0')}`);
      mkdirSync(dir, { recursive: true });
      claude(xaibo.home, i, dir, `Task ${i}`);
    }
  });
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  await openSessions(page);
  await expect(page.getByRole('list', { name: 'Sessions' })).toHaveAttribute('data-count', '13', { timeout: 30_000 }); // with the shared fixture's session; imported before the map's first page
  await openMap(page);
  const more = item(page, 'Load more groups');
  const count = (n: number) => expect(tree(page)).toHaveAttribute('data-count', String(n)); // rows, mounted or not
  await expect(tree(page).getByRole('treeitem').first()).toBeVisible({ timeout: 30_000 });
  await count(11); // 10 groups and the paging item, a treeitem without a nested button
  await tree(page).getByRole('treeitem').first().focus();
  await page.keyboard.press('End');
  await expect(more).toBeFocused();
  await expect(more.locator('button')).toHaveCount(0);
  await expect(more).toHaveAttribute('aria-setsize', '-1'); // more exists: the size is unknown
  const label = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  await page.keyboard.press('ArrowUp');
  const tenth = await label();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(announced(page)).toHaveText('3 more groups loaded');
  await count(13);
  await expect(more).toHaveCount(0);
  // review M2: focus is on the last group loaded before, so Down reaches the first new one
  await expect.poll(label).toBe(tenth);
  await page.keyboard.press('ArrowDown');
  await expect.poll(label).not.toBe(tenth);
  await expect(page.locator(':focus')).toHaveAttribute('aria-posinset', '11');

  // expand five folders by keyboard: the fifth evicts the least recently visited one and says so
  const focused = page.locator(':focus');
  const names: string[] = [];
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) {
    names.push((await focused.getAttribute('aria-label'))!.split(' · ')[0]!);
    await page.keyboard.press('ArrowRight');
    await expect(focused).toHaveAttribute('aria-expanded', 'true');
    await expect(tree(page).locator('[aria-level="2"]')).toHaveCount(Math.min(i + 1, 4));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
  }
  await expect(announced(page)).toHaveText(`Collapsed ${names[0]} to keep four branches open. 1 session loaded`);
  await page.keyboard.press('Home'); // the first folder may be outside the mounted window
  expect((await focused.getAttribute('aria-label'))!.split(' · ')[0]).toBe(names[0]);
  await expect(focused).toHaveAttribute('aria-expanded', 'false');
  await expect(tree(page).locator('[aria-expanded="true"]')).toHaveCount(4);
});
