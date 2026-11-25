// XAIBO-PROD-538 (P5-T18a part 2a; design §5.3, §6.5.1, §8.1): Agent Map keyboard-only, narrow (720×640) and wide
// (1280×800): skip link → Areas links → Agent Map (heading focused) → Tab enters the tree at its one roving treeitem →
// arrows expand and move → Enter selects a group (Details) → Tab leaves the tree → Shift+Tab returns to the same
// treeitem. One tree with level/expanded/selected semantics; every control named; focus visible (2 px solid outline,
// 2 px offset on the item's first child). No axe (Q-4.2). Synthetic folders only.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, openSessions, tabTo, test } from './fixtures.ts';

const LAYOUTS = { narrow: [720, 640], wide: [1280, 800] } as const;
function claude(home: string, i: number, cwd: string, prompt: string) {
  const id = `00000000-0000-4000-8000-00000000ad${String(i).padStart(2, '0')}`;
  const dir = path.join(home, '.claude', 'projects', cwd.replaceAll('/', '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ parentUuid: null, type: 'user', uuid: `00000000-0000-4000-8000-00000000af${String(i).padStart(2, '0')}`,
    timestamp: `2026-11-1${i}T10:00:00.000Z`, cwd, sessionId: id, entrypoint: 'cli', message: { role: 'user', content: prompt } })}\n`);
}

async function expectVisibleFocus(target: Locator) {
  await expect(target).toBeFocused();
  const ring = await target.evaluate((el) => {
    const pick = (e: Element) => { const s = getComputedStyle(e); return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset }; };
    const own = pick(el);
    return own.style !== 'none' ? own : el.firstElementChild ? pick(el.firstElementChild) : own;
  });
  expect(ring).toMatchObject({ style: 'solid', width: '2px', offset: '2px' });
}
async function expectNamed(page: Page) {
  const controls = page.locator('button:visible, a[href]:visible, [tabindex="0"]:visible, [role="treeitem"]:visible');
  const n = await controls.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const c = controls.nth(i);
    await expect(c, await c.evaluate((e) => e.outerHTML.slice(0, 160))).toHaveAccessibleName(/\S/);
  }
}

for (const [layout, [w, h]] of Object.entries(LAYOUTS)) {
  test(`Agent Map keyboard only (${layout})`, async ({ xaibo }) => {
    test.setTimeout(120_000);
    const work = path.join(xaibo.home, 'work');
    xaibo.touchStore(() => {
      for (const [i, f] of ['atlas', 'notes'].entries()) { mkdirSync(path.join(work, f), { recursive: true }); claude(xaibo.home, i + 1, path.join(work, f), `Task in ${f}`); }
    });
    const run = await xaibo.launch();
    const page = await xaibo.window(run);
    await run.app!.evaluate(({ BrowserWindow }, [ww, hh]) => BrowserWindow.getAllWindows()[0]!.setSize(ww!, hh!), [w, h]);
    await openSessions(page); // imported before the map's first page
    await expect(page.getByRole('list', { name: 'Sessions' })).toHaveAttribute('data-count', '3', { timeout: 30_000 });

    const link = page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Agent Map' });
    await tabTo(page, link);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Agent Map' })).toBeFocused();
    await expect(link).toHaveAttribute('aria-current', 'page');

    const tree = page.getByRole('tree', { name: 'Repositories, worktrees and sessions' });
    await expect(tree).toHaveCount(1); // one semantic tree, no duplicated graph
    const items = tree.getByRole('treeitem');
    await expect(items).toHaveCount(3, { timeout: 20_000 }); // two folders and the shared fixture's
    await expect(tree.locator('[tabindex="0"]')).toHaveCount(1); // one roving tab stop
    // XAIBO-PROD-575 (design §6.5.2 tab order): the mode group's one tab stop, the selected mode, comes before the tree
    const modes = page.getByRole('group', { name: 'Agent Map view' });
    await page.keyboard.press('Tab');
    await expectVisibleFocus(modes.getByRole('button', { name: 'Repositories', pressed: true }));
    await page.keyboard.press('Tab');
    const first = items.first();
    await expectVisibleFocus(first);
    await expect(first).toHaveAttribute('aria-level', '1');
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    await expect(first).not.toHaveAttribute('aria-selected', /.*/);

    // Right expands (focus stays), Down enters, Left returns; Enter selects the group in place
    await page.keyboard.press('ArrowRight');
    await expect(first).toHaveAttribute('aria-expanded', 'true');
    await expect(first).toBeFocused();
    const leaf = items.filter({ has: page.locator('.x-map-leaf') }).first();
    await expect(leaf).toHaveAttribute('aria-level', '2');
    await expect(leaf).not.toHaveAttribute('aria-expanded', /.*/); // only expandable nodes carry it
    await page.keyboard.press('ArrowDown');
    await expectVisibleFocus(leaf);
    await page.keyboard.press('ArrowLeft');
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: 'Details' }).getByRole('heading', { level: 3 })).toHaveText(/^Folder: /);

    // Tab leaves the tree; Shift+Tab comes back to the same treeitem
    await page.keyboard.press('Tab');
    await expect(tree.locator(':focus')).toHaveCount(0);
    await page.keyboard.press('Shift+Tab');
    await expect(first).toBeFocused();

    await expectNamed(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // XAIBO-PROD-575: Agents by keyboard: Shift+Tab to the selected mode, Right then Enter selects Agents (focus stays), Tab
    // enters the list at its one roving row; Down moves; every control named; no horizontal scrolling
    await page.keyboard.press('Shift+Tab');
    await expect(modes.getByRole('button', { name: 'Repositories' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    const agents = modes.getByRole('button', { name: 'Agents', pressed: true });
    await expectVisibleFocus(agents);
    const rows = page.getByRole('list', { name: 'Agents and profiles' }).getByRole('listitem');
    await expect(rows).toHaveCount(3, { timeout: 20_000 }); // claude, codex and agy (not detected)
    await page.keyboard.press('Tab');
    await expectVisibleFocus(rows.first());
    await page.keyboard.press('ArrowDown');
    await expectVisibleFocus(rows.nth(1));
    await expectNamed(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
