// P4-T13 (EC-86 E, US-9): closing the window hides it (the same BrowserWindow, never destroyed); collection continues
// while it is hidden; showing it again brings back the same window and its page; Quit stops the app and its service.
// The show step emits `activate` (the Dock's path), which calls the same `show` as the tray's "Show Xaibo" item: a
// native tray menu cannot be clicked from Playwright.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { alive, expect, servicePid, test } from './fixtures.ts';

const SESSION = '00000000-0000-4000-8000-000000001000';
const TRANSCRIPT = ['.claude', 'projects', '-tmp-xaibo-fixture-project', `${SESSION}.jsonl`];

function events(dataDir: string) {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true });
    return Number(Object.values(db.prepare('SELECT count(*) FROM events').get() ?? {})[0]);
  } catch { return -1; } finally { db?.close(); }
}

test('close hides the same window, collection continues while hidden, show restores it, Quit stops the service', async ({ xaibo }) => {
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  const app = run.app!;
  const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ id: w.id, visible: w.isVisible() })));
  const [first] = await windows();
  expect(first?.visible).toBe(true);
  await expect.poll(() => events(run.dataDir)).toBe(9);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()); // the close button's path
  await expect.poll(windows).toEqual([{ id: first!.id, visible: false }]);

  // US-9: a transcript append while hidden is collected
  xaibo.touchStore(() => appendFileSync(path.join(xaibo.home, ...TRANSCRIPT), JSON.stringify({ parentUuid: null, type: 'user',
    uuid: '00000000-0000-4000-8000-0000000010e3', timestamp: '2026-01-01T00:03:00.000Z', cwd: '/tmp/xaibo-fixture/alpha',
    sessionId: SESSION, message: { role: 'user', content: 'while hidden' } }) + '\n'));
  await expect.poll(() => events(run.dataDir), { timeout: 15_000 }).toBe(10);
  expect(await windows()).toEqual([{ id: first!.id, visible: false }]);

  await app.evaluate(({ app: a }) => { a.emit('activate'); });
  await expect.poll(windows).toEqual([{ id: first!.id, visible: true }]);
  await expect(page.getByRole('navigation', { name: 'Areas' })).toBeVisible(); // the same page, not a reload into a new window

  const service = await servicePid(app);
  await xaibo.quit(run);
  await expect.poll(() => alive(service)).toBe(false);
});
