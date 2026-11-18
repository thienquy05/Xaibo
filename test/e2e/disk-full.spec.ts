// XAIBO-PROD-436 (P4-T14b; owner decision D-P4-09; EC-44 surface, design §6.0): a full disk pauses collection, and the
// persistent collection band says so in every area ("Collection: Paused (disk full)", not Running); live labels are
// qualified as last known while it lasts; freeing the disk returns the band to Running. The data dir lives on a small
// sparse HFS+ image filled to ENOSPC. Mounts an image and binds a socket: run outside the command sandbox. Synthetic only.
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { claudeProfile, deliver } from '../helpers/hook-socket.ts';
import { fillVolume, volume } from '../perf/t2-usage.ts';
import { expect, test } from './fixtures.ts';

const SID = '00000000-0000-4000-8000-0000000fd001';
const CWD = '/tmp/xaibo-fixture/disk-full';

test('disk full: the band reads Paused (disk full) on every area, live labels say Last known; freed, it reads Running', async ({ xaibo }) => {
  test.setTimeout(120_000);
  const vol = volume(path.dirname(xaibo.home), 1);
  const fill = path.join(vol.mount, 'fill.bin');
  try {
    const dataDir = path.join(vol.mount, 'd'); // short: the socket path
    const run = await xaibo.launch({ dataDir });
    const page = await xaibo.window(run);
    const band = page.getByRole('status');
    await expect(band).toContainText('Collection: Running', { timeout: 15_000 });
    let profile: string | null = null;
    await expect.poll(() => (profile = claudeProfile(dataDir)), { timeout: 15_000 }).toBeTruthy();
    await expect.poll(() => existsSync(path.join(dataDir, 'run', 'token')), { timeout: 15_000 }).toBe(true);
    const send = (event: string, payload: Record<string, unknown>) => deliver(dataDir,
      { v: 1, delivery_id: randomUUID(), agent: 'claude', profile_key: profile!, event, session_id: SID, cwd: CWD, received_ts: Date.now(), payload });
    await send('SessionStart', { hook_event_name: 'SessionStart', session_id: SID, source: 'startup' });
    await send('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'fixture prompt' });
    const totals = page.getByRole('region', { name: /live-session set/i });
    await expect(totals).toContainText('1 currently tracked', { timeout: 20_000 });
    await expect(totals.getByRole('heading')).toHaveText('Live-session set');

    // Full: the next commit fails (every commit is the probe) and the service reports it within its 5 s coverage push
    expect(fillVolume(fill)).toBe(true);
    await expect.poll(async () => { await send('Notification', { hook_event_name: 'Notification', session_id: SID, message: 'fixture' }).catch(() => undefined);
      return (await band.textContent()) ?? ''; }, { timeout: 30_000, intervals: [1000] }).toContain('Collection: Paused (disk full)');
    await expect(band).not.toContainText('Running');
    await expect(totals.getByRole('heading')).toContainText(/^Last known live-session set · since \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    // the band is not a Dashboard banner: the Session area shows it too (the P4-T12b carry-over)
    await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Session', exact: true }).click();
    await expect(page.locator('#sessions-heading')).toBeVisible();
    await expect(band).toContainText('Collection: Paused (disk full)');
    if (process.env.XAIBO_SHOT) await page.screenshot({ path: path.join(process.env.XAIBO_SHOT, 'session-disk-full.png') }); // visual check, off by default

    // Freed: the next commit succeeds, the banner clears and the band reads Running again
    unlinkSync(fill);
    await expect.poll(async () => { await send('Notification', { hook_event_name: 'Notification', session_id: SID, message: 'fixture' }).catch(() => undefined);
      return (await band.textContent()) ?? ''; }, { timeout: 30_000, intervals: [1000] }).toContain('Collection: Running');
    await xaibo.quit(run); // before the detach; teardown audits the finished run
  } finally {
    try { unlinkSync(fill); } catch { /* already freed */ }
    vol.detach();
  }
});
