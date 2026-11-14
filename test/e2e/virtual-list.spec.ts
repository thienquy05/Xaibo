// P4-T03 (design §5.1, §5.2; App. G §7): the virtualized record list in the packaged app. With 150 of 300 synthetic
// sessions loaded, the DOM holds only the visible records plus overscan and the focused one; Arrow/Home/End move a
// single roving focus within the loaded range; ArrowDown at the loaded end fetches the next page once; a session
// arriving at the head leaves the record in view where it was.
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './fixtures.ts';

const project = (home: string) => path.join(home, '.claude', 'projects', '-tmp-xaibo-fixture-project');
const sid = (n: number) => `00000000-0000-4000-8000-0000000d${String(n).padStart(4, '0')}`;
const line = (id: string, n: number, ts: string) => JSON.stringify({ parentUuid: null, type: 'user', uuid: `00000000-0000-4000-8000-0000000e${String(n).padStart(4, '0')}`,
  timestamp: ts, cwd: `/tmp/xaibo-fixture/v${n}`, sessionId: id, entrypoint: 'cli', message: { role: 'user', content: 'x' } }) + '\n';
const count = (dataDir: string) => {
  let db: DatabaseSync | undefined;
  try { db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true }); return Number(Object.values(db.prepare('SELECT count(*) FROM sessions').get() ?? {})[0]); } catch { return -1; } finally { db?.close(); }
};

test('virtualized records: bounded DOM, roving Arrow/Home/End, edge fetch by arrow, anchor kept on head insertion', async ({ xaibo }) => {
  test.setTimeout(120_000);
  xaibo.touchStore(() => {
    for (let n = 1; n <= 300; n++) writeFileSync(path.join(project(xaibo.home), `${sid(n)}.jsonl`), line(sid(n), n, new Date(Date.UTC(2026, 0, 3, 0, 0, n)).toISOString()));
  });
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  await expect.poll(() => count(run.dataDir), { timeout: 60_000 }).toBe(301); // 300 plus the fixture session
  const list = page.getByRole('list', { name: 'Sessions' });
  await expect(list).toHaveAttribute('data-count', '50');
  const focused = page.locator(':focus');

  await list.getByRole('listitem').first().focus();
  await expect(focused).toHaveAttribute('aria-posinset', '1');
  await page.keyboard.press('End');
  await expect(focused).toHaveAttribute('aria-posinset', '50');
  await expect(focused).toHaveAttribute('aria-setsize', '-1'); // more exist: no invented total
  await page.keyboard.press('ArrowDown'); // at the loaded edge: one fetch, focus stays
  await expect(list).toHaveAttribute('data-count', '100');
  await page.keyboard.press('ArrowDown');
  await expect(focused).toHaveAttribute('aria-posinset', '51');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(list).toHaveAttribute('data-count', '150');
  await list.getByRole('listitem').first().focus();
  await page.keyboard.press('Home');
  await expect(focused).toHaveAttribute('aria-posinset', '1');
  await page.keyboard.press('ArrowDown');
  await expect(focused).toHaveAttribute('aria-posinset', '2');
  await page.keyboard.press('ArrowUp');
  await expect(focused).toHaveAttribute('aria-posinset', '1');
  await page.keyboard.press('End');
  await expect(focused).toHaveAttribute('aria-posinset', '150');
  expect(await page.locator('.x-vlist-item[tabindex="0"]').count()).toBe(1); // one roving tab stop

  const dom = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.x-vlist')!;
    const items = [...document.querySelectorAll<HTMLElement>('.x-vlist-item')];
    const minH = Math.min(...items.map((i) => i.getBoundingClientRect().height));
    return { rendered: items.length, visible: Math.ceil(scroller.clientHeight / minH) + 1 };
  });
  expect(dom.rendered).toBeLessThanOrEqual(dom.visible + 2 * 3 + 1); // viewport + overscan 3 each side + focused
  expect(dom.rendered).toBeLessThan(150);

  // Anchor: scroll into the middle, remember a record in view, add a newer session (inserted at the head).
  await page.evaluate(async () => { // scroll, then let the virtualizer render the new range before choosing the anchor
    document.querySelector<HTMLElement>('.x-vlist')!.scrollTop = 4000;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.waitForTimeout(200);
  const anchor = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.x-vlist')!;
    const top = scroller.getBoundingClientRect().top;
    const li = [...document.querySelectorAll<HTMLElement>('.x-vlist-item')].find((i) => i.getBoundingClientRect().top >= top)!;
    return { folder: li.querySelector('[data-field="folder"]')!.textContent!, pos: Number(li.getAttribute('aria-posinset')), y: li.getBoundingClientRect().top };
  });
  xaibo.touchStore(() => appendFileSync(path.join(project(xaibo.home), `${sid(999)}.jsonl`), line(sid(999), 999, '2026-02-01T00:00:00.000Z')));
  const rec = list.getByRole('listitem').filter({ has: page.locator('[data-field="folder"]', { hasText: new RegExp(`^${anchor.folder}$`) }) }); // exact: v12 must not match v120
  await expect(rec).toHaveAttribute('aria-posinset', String(anchor.pos + 1), { timeout: 15_000 }); // one record above it now
  const y = await rec.evaluate((li) => li.getBoundingClientRect().top);
  expect(Math.abs(y - anchor.y)).toBeLessThanOrEqual(2);
});
