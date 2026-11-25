// XAIBO-PROD-569 (P6-T10 unit 1; design §6.6 Startup, plan P6-T10; review R9): Settings > Startup in the packaged app. Off by
// default; checking the box changes nothing until Save; Save says what the OS now has and survives a restart. Every E2E run
// uses the login-item file stub (fixtures.ts sets XAIBO_LOGIN_ITEM_STUB=1), so the machine's login items are never touched.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Run } from './fixtures.ts';

test('Start at login: off by default, applied only on Save, kept across a restart; never the real login items', async ({ xaibo }) => {
  test.setTimeout(180_000);
  const dataDir = path.join(path.dirname(xaibo.home), 'data-startup');
  const stub = path.join(dataDir, 'logs', 'login-item-stub.json');
  let run: Run | null = null;
  const open = async () => {
    if (run) await xaibo.quit(run);
    run = await xaibo.launch({ dataDir });
    const page = await xaibo.window(run);
    await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeFocused();
    const r = page.getByRole('region', { name: 'Startup' });
    return { r, box: r.getByRole('checkbox', { name: 'Start Xaibo at login' }), save: r.getByRole('button', { name: 'Save' }) };
  };

  let s = await open();
  await expect(s.box).not.toBeChecked();
  await expect(s.r).toContainText('Closing the window keeps collection running; Quit stops it.');
  await s.box.check(); // no Save
  s = await open();
  await expect(s.box).not.toBeChecked();

  await s.box.check();
  await s.save.click();
  await expect(s.r).toContainText('Saved. Xaibo starts at login.');
  await expect(s.save).toBeFocused();
  expect(JSON.parse(readFileSync(stub, 'utf8'))).toEqual({ openAtLogin: true });
  s = await open();
  await expect(s.box).toBeChecked();
  await s.box.uncheck();
  await s.save.click();
  await expect(s.r).toContainText('Saved. Xaibo does not start at login.');
  expect(JSON.parse(readFileSync(stub, 'utf8'))).toEqual({ openAtLogin: false });
});
