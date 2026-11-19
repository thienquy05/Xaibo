// XAIBO-PROD-528 (P5-T18 part 2; design §6.6, §5.1, US-6, FR-11/FR-12; look D-P5-09): Settings > Session retention,
// Trash and Storage in the packaged app. The default is 45 days; an invalid Other value shows its corrective error on blur
// (aria-invalid on the field) and a failed Save focuses the field; a valid value saves (Saved., focus stays on Save) and
// survives a restart; Never saves too. Storage shows measured parts only; no horizontal scroll at the 640 px minimum.
// Synthetic data dir only; no agent transcripts are needed.
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, shot, test } from './fixtures.ts';
import { RETENTION_MAX } from '../../src/shared/ipc.ts';

async function settings(page: Page) {
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeFocused();
  const retention = page.getByRole('region', { name: 'Session retention' });
  return {
    retention,
    storage: page.getByRole('region', { name: 'Storage' }),
    days: retention.getByRole('textbox', { name: 'Number of days' }),
    save: retention.getByRole('button', { name: 'Save' }),
    radio: (name: string) => retention.getByRole('radio', { name }),
  };
}
const size = (app: ElectronApplication, w: number, h: number) => app.evaluate(({ BrowserWindow }, [a, b]) => BrowserWindow.getAllWindows()[0]!.setSize(a!, b!), [w, h]);

test('Settings retention: default, validation, Save, restart, Never; Storage parts and Trash', async ({ xaibo }) => {
  test.setTimeout(180_000);
  const dataDir = path.join(path.dirname(xaibo.home), 'data-ret');
  const run = await xaibo.launch({ dataDir });
  const page = await xaibo.window(run);
  await size(run.app!, 1280, 900);
  const s = await settings(page);
  await expect(s.radio('45 days (default)')).toBeChecked();
  await expect(s.retention).toContainText(/retention run/);
  await expect(page.getByRole('region', { name: 'Trash' })).toContainText('Auto-empty after 30 days');

  // an out-of-range value: error on blur, tied to the field, never clamped; Save focuses the field and changes nothing
  const range = `Enter a whole number of days from 1 to ${RETENTION_MAX}.`;
  await s.days.fill('0');
  await expect(s.radio('Other')).toBeChecked();
  await expect(s.retention).not.toContainText(range); // not while typing
  await s.days.press('Tab');
  await expect(s.retention).toContainText(range);
  await expect(s.days).toHaveAttribute('aria-invalid', 'true');
  await expect(s.days).toHaveAccessibleDescription(new RegExp(range.replace('.', '\\.')));
  await s.save.click();
  await expect(s.days).toBeFocused();
  await expect(s.days).toHaveValue('0');
  await s.days.fill(String(RETENTION_MAX + 1));
  await expect(s.retention).toContainText(range);

  // a correction removes the error; Save keeps focus and says Saved.
  await s.days.fill('90');
  await expect(s.retention).not.toContainText(range);
  await expect(s.days).not.toHaveAttribute('aria-invalid', 'true');
  await s.save.click();
  await expect(s.retention).toContainText('Saved.');
  await expect(s.save).toBeFocused();

  // review L2: an empty field and Save, with no blur first: the error is attached before focus lands on the field
  await s.days.fill('');
  await s.save.click();
  await expect(s.days).toBeFocused();
  await expect(s.days).toHaveAccessibleDescription(new RegExp(range.replace('.', '\\.')));
  await s.days.fill('90');
  await expect(s.retention).not.toContainText(range);

  // Storage: a measured total and the On disk parts, with Unavailable for anything not measured
  await expect(s.storage).toContainText('Storage used');
  await expect(s.storage.getByRole('table', { name: 'On disk' })).toBeVisible({ timeout: 15_000 });
  await expect(s.storage.getByRole('row', { name: /^Database / })).toContainText(/\d+(\.\d+)? (B|KB|MB|GB)/);
  await s.storage.getByRole('button', { name: 'Refresh' }).click();
  await expect(s.storage.getByRole('table', { name: 'On disk' })).toBeVisible();
  await shot(page, 'settings-retention-light');
  // as visual.spec.ts: Playwright's own scheme overrides nativeTheme; reduced motion so no state transition is captured midway
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await shot(page, 'settings-retention-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // the minimum window (640 px, narrow layout): no horizontal page scroll; the storage tables fit
  await size(run.app!, 640, 560);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'settings-retention-640');
  await xaibo.quit(run);

  // restart: the saved value is read back; Never saves too
  const again = await xaibo.launch({ dataDir });
  const p2 = await xaibo.window(again);
  await size(again.app!, 1280, 900);
  const s2 = await settings(p2);
  await expect(s2.radio('Other')).toBeChecked();
  await expect(s2.days).toHaveValue('90');
  await s2.radio('Never').check();
  await s2.save.click();
  await expect(s2.retention).toContainText('Saved.');
  await xaibo.quit(again);
});
