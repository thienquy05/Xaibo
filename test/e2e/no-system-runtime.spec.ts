// P7-T12 (MVP hardening sweep; plan P7-T12, PRD §9 packaged artifact): the packaged app needs no system Node or Docker (the
// run's PATH is the fake agents' folder plus /usr/bin:/bin, none of which holds node or docker), its hook helper runs as a single
// executable through that PATH, and its app data is private: every folder 0700 and every file 0600 under the data dir (the
// deployed hook helpers may be 0755 inside the 0700 integrations/bin; never writable by others).
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { claudeProfile } from '../helpers/hook-socket.ts';
import { expect, test } from './fixtures.ts';

const SID = '00000000-0000-4000-8000-0000000f7201';

function loose(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const f = path.join(d, name), st = lstatSync(f);
      if (st.isSymbolicLink() || st.isSocket()) continue; // sockets live in 0700 folders; links are not followed
      // the deployed helpers are executables the agents' hooks run (as the same user) inside the 0700 integrations/bin: read and
      // execute for others is unreachable there; write for group or others never
      const helper = st.isFile() && path.basename(d) === 'bin' && path.basename(path.dirname(d)) === 'integrations';
      if ((st.mode & (helper ? 0o022 : 0o077)) !== 0) out.push(`${path.relative(root, f)} ${(st.mode & 0o777).toString(8)}`);
      if (st.isDirectory()) walk(f);
    }
  };
  if ((lstatSync(root).mode & 0o077) !== 0) out.push(`. ${(lstatSync(root).mode & 0o777).toString(8)}`);
  walk(root);
  return out;
}

test('packaged app: no system Node or Docker on PATH, the hook helper runs, app data is 0700/0600', async ({ xaibo }) => {
  for (const d of ['/usr/bin', '/bin', path.join(xaibo.home, 'bin')]) for (const exe of ['node', 'docker']) expect(existsSync(path.join(d, exe)), `${d}/${exe}`).toBe(false);
  const run = await xaibo.launch();
  const page = await xaibo.window(run);
  let profile: string | null = null;
  await expect.poll(() => (profile = claudeProfile(run.dataDir)), { timeout: 20_000 }).toBeTruthy();
  const h = await xaibo.hook(run, profile!, { hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: '/tmp/xaibo-fixture/runtime', prompt: 'runtime fixture prompt' });
  expect(h.exit).toEqual({ code: 0, signal: null });
  await page.getByRole('navigation', { name: 'Areas' }).getByRole('link', { name: 'Session', exact: true }).click();
  await expect(page.locator('.x-srow', { hasText: '/tmp/xaibo-fixture/runtime' })).toBeVisible({ timeout: 20_000 }); // the hooked session arrived
  expect(loose(run.dataDir)).toEqual([]);
});
