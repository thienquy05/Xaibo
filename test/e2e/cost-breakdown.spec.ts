// XAIBO-PROD-418 (P4-T07b; plan P4-T07 E mixed-revision fixture; PRD FR-48, US-18; design §6.3.2): the Cost tab on a
// synthetic Claude session priced under the bundled table, then, after a restart with an owner override and fallback,
// two more requests priced under the owner revision. Both revisions are listed with Prices as of; the fallback is
// labeled; every amount has ~ and Estimated cost text; source references are plain text (and the run's network audit
// proves nothing was fetched).
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { expect, openSessions, test } from './fixtures.ts';

const CWD = '/tmp/xaibo-fixture/alpha';
const estimates = (dataDir: string) => {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true });
    return (db.prepare('SELECT COUNT(*) AS n FROM cost_estimates').get() as { n: number }).n;
  } catch { return -1; } finally { db?.close(); }
};
const override = JSON.stringify({ schemaVersion: 1, revision: 'owner-1', currency: 'USD', prices_as_of: '2026-11-12',
  sources: [{ id: 'owner', url: 'https://example.com/p', retrieved: '2026-11-12' }],
  models: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', source: 'owner', prices_verified: true,
    qualifiers: { service_tier: ['standard'], speed: ['standard'] }, rates: { input: 40, output: 200, cache_read: 2, cache_write: { '5m': 50, '1h': 80 } } }],
  fallbacks: [{ models: ['synthetic-unlisted-model'], agent: 'claude', qualifiers: { service_tier: ['standard'], speed: ['standard'] },
    rates: { input: 1, output: 1, cache_read: 1, cache_write: { '1h': 1 } } }] });

test('Cost tab: two price revisions with Prices as of, owner fallback labeled, every amount ~ with Estimated cost text', async ({ xaibo }) => {
  const first = await xaibo.launch();
  await expect.poll(() => estimates(first.dataDir), { timeout: 20_000 }).toBe(2); // usage-basic priced under the bundled table
  await xaibo.quit(first);

  const project = path.join(xaibo.home, '.claude', 'projects', '-tmp-xaibo-fixture-project');
  const file = readdirSync(project).find((f) => f.endsWith('.jsonl'))!;
  const last = readFileSync(path.join(project, file), 'utf8').split('\n').filter(Boolean).findLast((l) => l.includes('"msg_fixture_0002"'))!;
  xaibo.touchStore(() => appendFileSync(path.join(project, file),
    `${last.replaceAll('msg_fixture_0002', 'msg_fixture_0003').replace(/"uuid":"[^"]+"/, '"uuid":"00000000-0000-4000-8000-000000001903"')}\n`
    + `${last.replaceAll('msg_fixture_0002', 'msg_fixture_0004').replace(/"uuid":"[^"]+"/, '"uuid":"00000000-0000-4000-8000-000000001904"')
      .replace('"model":"claude-opus-5-5"', '"model":"synthetic-unlisted-model"')}\n`));
  writeFileSync(path.join(first.dataDir, 'models.override.json'), override);

  const run = await xaibo.launch({ dataDir: first.dataDir });
  await expect.poll(() => estimates(run.dataDir), { timeout: 20_000 }).toBe(4);
  const page = await xaibo.window(run);
  await openSessions(page);
  const list = page.getByRole('list', { name: 'Sessions' });
  await list.getByRole('button').filter({ hasText: CWD }).first().click({ timeout: 20_000 });
  await page.getByRole('group', { name: 'Session section' }).getByRole('button', { name: /^Cost/ }).click();
  const body = page.getByRole('region', { name: 'Cost' });
  await expect(body.getByRole('heading', { name: 'Estimated cost' })).toBeVisible();
  await expect(body.getByText(/^Estimated cost: .+ US dollars; 4 of 4 requests priced/)).toBeAttached();

  await expect(body.getByRole('table', { name: /· Price table .+ · 2 of 2 requests priced$/ })).toBeVisible();
  await expect(body.getByRole('table', { name: /· Price table owner-1 · 1 of 1 requests priced$/ })).toBeVisible();
  await expect(body.getByRole('table', { name: /^synthetic-unlisted-model · Owner-set fallback · 1 of 1 requests priced$/ })).toBeVisible();

  const amounts = body.locator('td.x-cost-usd');
  expect(await amounts.count()).toBe(15); // 3 groups × 5 Claude components
  for (const cell of await amounts.all()) {
    await expect(cell.locator('[aria-hidden="true"]')).toHaveText(/^~\$/);
    await expect(cell.locator('.x-sr-only')).toHaveText(/^Estimated cost/);
  }

  const provenance = body.getByRole('list', { name: 'Price provenance' });
  await expect(provenance.getByRole('listitem')).toHaveCount(2);
  await expect(provenance).toContainText('Bundled price table');
  await expect(provenance).toContainText('Owner override');
  await expect(provenance).toContainText('Prices as of 2026-11-12');
  await expect(provenance).toContainText('Owner-set fallback');
  await expect(provenance).toContainText('owner: https://example.com/p (retrieved 2026-11-12)');
  await expect(body.locator('a')).toHaveCount(0); // references are text, never links
});
