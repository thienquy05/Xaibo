// XAIBO-PROD-568 (P6-T11; design §6.6 Local prices / Owner-set fallback, §529, A6, C30; PRD §5.12, SEC1): Settings > Local
// prices in the packaged app. Bundled revision and Prices as of shown; Reveal (test stub XAIBO_REVEAL_STUB=1, never Finder)
// says No override file yet and selects the folder; an invalid override: Validate reports it and Reload keeps the last valid
// revision with an error banner; a valid one: Validate, Reload -> its revision, date, Override file and the owner-set fallback
// rates; a symlinked override is never followed; a restart keeps the accepted revision. Synthetic data dir only.
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, shot, test } from './fixtures.ts';

const override = {
  schemaVersion: 1, revision: 'owner-e2e-1', currency: 'USD', prices_as_of: '2026-11-20',
  sources: [{ id: 'owner', url: 'https://example.com/prices', retrieved: '2026-11-20' }],
  models: [{ id: 'synthetic-model-x', display_name: 'Synthetic X', source: 'owner', prices_verified: true, rates: { input: 1, output: 2 } }],
  fallbacks: [{ models: ['synthetic-model-y'], agent: 'codex', rates: { input: 0.25, output: 1.5, cache_read: 0.0000001 } }],
};

async function prices(page: Page) {
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeFocused();
  const r = page.getByRole('region', { name: 'Local prices' });
  return {
    r,
    reveal: r.getByRole('button', { name: 'Reveal override file' }),
    validate: r.getByRole('button', { name: 'Validate' }),
    reload: r.getByRole('button', { name: 'Reload' }),
  };
}

test('Local prices: reveal, validate and reload the private override; the last valid revision stays', async ({ xaibo }) => {
  test.setTimeout(180_000);
  const dataDir = path.join(path.dirname(xaibo.home), 'data-prices');
  const file = path.join(dataDir, 'models.override.json');
  const stub = path.join(dataDir, 'logs', 'reveal-stub.jsonl');
  const kinds = () => readFileSync(stub, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { kind: string }).kind);
  const run = await xaibo.launch({ dataDir, env: { XAIBO_REVEAL_STUB: '1' } });
  const page = await xaibo.window(run);
  const p = await prices(page);
  await expect(p.r).toContainText('Prices as of 2026-11-12, revision 2026-11-12.1');
  await expect(p.r).toContainText('Bundled table');

  // Tab order Reveal -> Validate -> Reload; focus stays on the invoking button
  await p.reveal.focus();
  await page.keyboard.press('Tab');
  await expect(p.validate).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(p.reload).toBeFocused();

  await p.reveal.click();
  await expect(p.r).toContainText('No override file yet. Its folder is shown in Finder.');
  await expect(p.reveal).toBeFocused();
  expect(kinds()).toEqual(['missing']);

  // an invalid edit: Validate reports it, Reload keeps the bundled revision with an error banner
  writeFileSync(file, '{ "schemaVersion": 1, not json');
  await p.validate.click();
  await expect(p.r).toContainText('Not valid: it is not valid JSON. Prices are unchanged.');
  await expect(p.validate).toBeFocused();
  await p.reload.click();
  await expect(p.r.getByRole('alert')).toHaveText('Override not used: it is not valid JSON. The last valid prices stay in use.');
  await expect(p.r).toContainText('Prices as of 2026-11-12, revision 2026-11-12.1');
  await expect(p.reload).toBeFocused();

  // a valid edit: Validate does not switch, Reload does
  writeFileSync(file, JSON.stringify(override));
  await p.validate.click();
  await expect(p.r).toContainText('The override file is valid. Reload to use it.');
  await expect(p.r).toContainText('revision 2026-11-12.1');
  await p.reload.click();
  await expect(p.r).toContainText('Prices as of 2026-11-20, revision owner-e2e-1');
  await expect(p.r).toContainText('Override file');
  await expect(p.r).toContainText('Override prices loaded.');
  await expect(p.r.getByRole('alert')).toHaveCount(0);
  const fb = p.r.getByRole('table', { name: 'Owner-set fallback' });
  await expect(fb).toContainText('synthetic-model-y');
  await expect(fb).toContainText('Agent codex');
  await expect(fb).toContainText('USD 0.25 per 1,000,000 tokens');
  await expect(fb).toContainText('USD 0.0000001 per 1,000,000 tokens');
  await p.reveal.click();
  await expect(p.r).toContainText('Shown in Finder.');
  expect(kinds()).toEqual(['missing', 'file']);
  await shot(page, 'settings-prices-light');

  // a symlink at the override path is never followed: Reveal selects the folder, Reload keeps the last valid revision
  rmSync(file);
  writeFileSync(path.join(dataDir, 'elsewhere.json'), JSON.stringify({ ...override, revision: 'linked' }));
  symlinkSync(path.join(dataDir, 'elsewhere.json'), file);
  await p.reveal.click();
  await expect(p.r).toContainText('The override path is not a regular file. Its folder is shown in Finder.');
  expect(kinds()).toEqual(['missing', 'file', 'folder']);
  await p.reload.click();
  await expect(p.r.getByRole('alert')).toHaveText('Override not used: it is not a regular file. The last valid prices stay in use.');
  await expect(p.r).toContainText('revision owner-e2e-1');
  await xaibo.quit(run);

  // restart: the accepted revision is kept although the file is still unusable
  const run2 = await xaibo.launch({ dataDir, env: { XAIBO_REVEAL_STUB: '1' } });
  const p2 = await prices(await xaibo.window(run2));
  await expect(p2.r).toContainText('Prices as of 2026-11-20, revision owner-e2e-1');
  await expect(p2.r).toContainText('Override not used: it is not a regular file.');
  await xaibo.quit(run2);
});
