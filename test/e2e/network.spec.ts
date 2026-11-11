// P1-T05 (EC-60, EC-61, M6): requests to non-loopback hosts are blocked before any attempt, and both detectors
// (kill-on-attempt profile, NetLog) and the repo-write guard catch a deliberate violation. The main-side attempts
// run through electronApp.evaluate, so no test hook ships in src/.
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { gitStatus } from './audit.ts';
import { expect, REPO, test } from './fixtures.ts';

test('a renderer fetch to a non-loopback host fails without an attempt', async ({ xaibo }) => {
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  expect(await page.evaluate(() => fetch('https://example.invalid/').then(() => 'loaded', (e: Error) => e.name))).toBe('TypeError');
});

test('a main-side load of a non-loopback URL is cancelled by the request filter and counted', async ({ xaibo }) => {
  const run = await xaibo.launch();
  await xaibo.window(run);
  const result = await run.app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.loadURL('https://example.invalid/').then(() => 'loaded', (e: Error) => e.message));
  expect(result).toContain('ERR_BLOCKED_BY_CLIENT');
  await xaibo.quit(run);
  expect(readFileSync(path.join(run.dataDir, 'logs', 'xaibo.log'), 'utf8')).toContain('"event":"request_blocked"');
});

test('detector: a main-process TCP attempt is killed by the audit profile', async ({ xaibo }) => {
  const run = await xaibo.launch({ expectAttempt: true });
  await run.app!.evaluate(() => { process.getBuiltinModule('node:net').connect(443, '192.0.2.1').on('error', () => {}); }).catch(() => {});
  expect((await run.exit).signal).toBe('SIGKILL');
});

test('detector: NetLog records a Chromium-stack request that bypasses the request filter', async ({ xaibo }) => {
  const run = await xaibo.launch({ logOnly: true, expectAttempt: true });
  await xaibo.window(run); // after the first paint: a denied lookup during startup stalls it (S10)
  await run.app!.evaluate(({ session }) => session.fromPartition('audit-control').fetch('https://example.invalid/').then(() => 0, () => 0));
  await xaibo.quit(run);
  expect((await xaibo.audit(run)).netlog.nonLocal).toBeGreaterThan(0);
});

test('repo-write guard: a file the app writes into the repo shows in git status', async ({ xaibo }) => {
  const run = await xaibo.launch();
  await xaibo.window(run);
  const before = gitStatus(REPO);
  const probe = path.join(REPO, 'xaibo-e2e-probe.tmp');
  try {
    await run.app!.evaluate(() => process.getBuiltinModule('node:fs').writeFileSync('xaibo-e2e-probe.tmp', 'x')); // cwd is the repo
    expect(gitStatus(REPO)).not.toBe(before);
  } finally { rmSync(probe, { force: true }); }
});
