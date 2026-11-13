// XAIBO-PROD-318 (P3-T14 live, owner-run only). Skipped unless XAIBO_LIVE_ROOT names a signed-in disposable profile
// HOME under .cache/profiles/ (Claude config in <root>/.claude), XAIBO_LIVE_CLAUDE the claude executable and
// XAIBO_LIVE_PROJECT a disposable project dir. Run through the Phase 0 runner with a guard snapshot before and a compare
// after (MATCH):
//   XAIBO_LIVE_ROOT=<root> XAIBO_LIVE_CLAUDE=<exe> XAIBO_LIVE_PROJECT=<dir> node --test test/live/statusline-tee.live.test.ts
// Needs the SEA tee (.cache/sea/xaibo-statusline, `npm run build && sh scripts/build-forwarder.sh`). Seeds a synthetic
// `printf` statusLine (a bashism prints BASH under bash, SH otherwise: which shell runs it, review M4), installs the tee
// over it, opens one interactive Claude TUI in a detached screen, waits for the original's text in the status line
// (Claude draws it at start: no prompt is sent), checks that a statusline snapshot arrived, quits, reverts
// byte-identical and restores the profile's settings. The raw screen log stays in git-ignored .cache/spike-results/ and
// is deleted at the end; only pass/fail and the marker name are printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CTRL_C, tui } from '../../spikes/shared/tui.ts';
import { deployShim, installTee } from '../../src/service/adapters/claude/setup.ts';
import { revert } from '../../src/service/config/transaction.ts';
import { startHooks } from '../../src/service/receivers/intake.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';

const REPO = join(import.meta.dirname, '..', '..');
const ROOT = process.env['XAIBO_LIVE_ROOT'];
const CLAUDE = process.env['XAIBO_LIVE_CLAUDE'];
const PROJECT = process.env['XAIBO_LIVE_PROJECT'];
const skip = ROOT && CLAUDE && PROJECT ? false : 'live: set XAIBO_LIVE_ROOT (disposable profile under .cache/profiles/), XAIBO_LIVE_CLAUDE and XAIBO_LIVE_PROJECT';
const ORIGINAL = "if [[ 1 == 1 ]] 2>/dev/null; then printf 'XAIBO-TEE-LIVE-BASH'; else printf 'XAIBO-TEE-LIVE-SH'; fi";

test('live: the tee renders the original status text in a real TUI and a snapshot arrives; revert byte-identical', { skip }, async (t) => {
  const root = realpathSync(ROOT!);
  assert.ok(root.startsWith(`${realpathSync(join(REPO, '.cache', 'profiles'))}/`), 'XAIBO_LIVE_ROOT must be a disposable profile under .cache/profiles/');
  const configDir = join(root, '.claude');
  const settings = join(configDir, 'settings.json');
  const statusline = join(REPO, '.cache', 'sea', 'xaibo-statusline');
  assert.ok(existsSync(statusline), 'build the SEA tee first');
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'xl-'))); // short: the socket path limit
  const store = await openStore({ file: join(dataDir, 'xaibo.db'), backupDir: join(dataDir, 'backups') });
  store.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('live', 'claude', ?, 'manual')").run(configDir);
  const hooks = await startHooks({ dataDir, db: store.db, writer: new Writer(store.db) });
  const before = existsSync(settings) ? readFileSync(settings) : null;
  const logDir = join(REPO, '.cache', 'spike-results', 'p3-tee');
  const bounds = { root, denied: [] };
  try {
    assert.ok(hooks.socket, 'the hook socket listens (run outside the Claude sandbox)');
    writeFileSync(settings, JSON.stringify({ ...(before ? JSON.parse(before.toString('utf8')) : {}), statusLine: { type: 'command', command: ORIGINAL } }, null, 2));
    const seeded = readFileSync(settings);
    deployShim(dataDir, { hook: join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder: join(REPO, '.cache', 'sea', 'xaibo-forwarder'), statusline });
    const entry = installTee({ dataDir, profileKey: 'live', configDir, bounds });
    const screen = tui('xaibo-p3-tee', realpathSync(PROJECT!), logDir, ['/usr/bin/env', `HOME=${root}`, `CLAUDE_CONFIG_DIR=${configDir}`, CLAUDE!]);
    try {
      const seen = await screen.waitFor(/XAIBO-TEE-LIVE-(BASH|SH)/, 60_000);
      t.diagnostic(`status text: ${seen ? (/XAIBO-TEE-LIVE-BASH/.test(screen.text()) ? 'BASH' : 'SH') : 'not seen'}`);
      assert.ok(seen, 'the original status text appears through the tee');
      await new Promise((r) => setTimeout(r, 2_000));
      const n = (store.db.prepare("SELECT count(*) AS n FROM events WHERE source = 'statusline'").get() as { n: number }).n;
      t.diagnostic(`statusline snapshots stored: ${n > 0 ? '>= 1' : '0'}`);
      assert.ok(n > 0, 'a snapshot arrived');
    } finally {
      screen.send(CTRL_C);
      screen.send(CTRL_C);
      await new Promise((r) => setTimeout(r, 1_000));
      screen.quit();
    }
    assert.equal(revert(entry, { dataDir, bounds }).result, 'restored');
    assert.deepEqual(readFileSync(settings), seeded, 'revert restores the seeded settings byte-identical');
  } finally {
    if (before) writeFileSync(settings, before); else rmSync(settings, { force: true });
    rmSync(logDir, { recursive: true, force: true }); // raw TUI output never stays
    await hooks.close();
    store.db.close();
  }
});
