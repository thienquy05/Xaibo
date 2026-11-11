// P1-T04 E specs, run in P1-T05 (EC-47, S-13, US-9): single instance per data dir, dev and packaged side by side,
// close hides while collection continues, Quit exits every process. Tray Quit calls app.quit(), driven here directly.
import { alive, expect, servicePid, test } from './fixtures.ts';

test('EC-47: a second launch on the same data dir exits and shows the first window', async ({ xaibo }) => {
  const first = await xaibo.launch();
  await xaibo.window(first);
  await first.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
  const second = xaibo.launchRaw({ dataDir: first.dataDir });
  expect(await second.exit).toEqual({ code: 0, signal: null });
  await expect.poll(() => first.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
});

test('EC-47: unpackaged (dev) and packaged launches with different data dirs run side by side', async ({ xaibo }) => {
  const prod = await xaibo.launch();
  const dev = await xaibo.launch({ unpackaged: true });
  await xaibo.window(prod);
  await xaibo.window(dev);
  expect(await prod.app!.evaluate(({ app }) => app.isPackaged)).toBe(true);
  expect(await dev.app!.evaluate(({ app }) => app.isPackaged)).toBe(false);
});

test('closing the window hides it; main and service stay alive', async ({ xaibo }) => {
  const run = await xaibo.launch();
  await xaibo.window(run);
  const svc = await servicePid(run.app!);
  await run.app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  const state = await run.app!.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows();
    return { windows: all.length, visible: all[0]?.isVisible() };
  });
  expect(state).toEqual({ windows: 1, visible: false });
  expect(alive(run.proc.pid)).toBe(true);
  expect(alive(svc)).toBe(true);
});

test('Quit stops the service and exits every process', async ({ xaibo }) => {
  const run = await xaibo.launch();
  await xaibo.window(run);
  await servicePid(run.app!);
  const pids = await run.app!.evaluate(({ app }) => app.getAppMetrics().map((m) => m.pid));
  expect(await xaibo.quit(run)).toEqual({ code: 0, signal: null });
  await expect.poll(() => pids.filter((p) => alive(p))).toEqual([]);
});
