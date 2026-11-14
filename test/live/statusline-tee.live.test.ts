// XAIBO-PROD-318 (P3-T14 live, owner-run only). Skipped unless XAIBO_LIVE_ROOT names the signed-in Phase 0 runner
// profile of Claude (~/.xaibo-spike-profiles/claude-<slot>, HOME = <root>/home, config in <home>/.claude) and
// XAIBO_LIVE_CLAUDE the claude executable. The TUI runs through the Phase 0 runner (in-profile.sh) in a project dir inside
// the profile home; guard snapshot before and compare after (MATCH):
//   XAIBO_LIVE_ROOT=<root> XAIBO_LIVE_CLAUDE=<exe> node --test test/live/statusline-tee.live.test.ts
// Needs the SEA tee (.cache/sea/xaibo-statusline, `npm run build && sh scripts/build-forwarder.sh`). Seeds a synthetic
// `printf` statusLine (a bashism prints BASH under bash, SH otherwise: which shell runs it, review M4), installs the tee
// over it, opens one interactive Claude TUI in a detached screen, waits for the original's text in the status line
// (Claude draws it at start: no prompt is sent), checks that a statusline snapshot arrived, quits, reverts
// byte-identical and restores the profile's settings. The raw screen log stays in git-ignored .cache/spike-results/ and
// is deleted at the end; only pass/fail and the marker name are printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CTRL_C, ENTER, tui, type Tui } from '../../spikes/shared/tui.ts';
import { deployShim, installTee } from '../../src/service/adapters/claude/setup.ts';
import { revert } from '../../src/service/config/transaction.ts';
import { startHooks } from '../../src/service/receivers/intake.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';

const REPO = join(import.meta.dirname, '..', '..');
const ROOT = process.env['XAIBO_LIVE_ROOT'];
const CLAUDE = process.env['XAIBO_LIVE_CLAUDE'];
const skip = ROOT && CLAUDE ? false : 'live: set XAIBO_LIVE_ROOT (the runner profile ~/.xaibo-spike-profiles/claude-<slot>) and XAIBO_LIVE_CLAUDE';
const ORIGINAL = "if [[ 1 == 1 ]] 2>/dev/null; then printf 'XAIBO-TEE-LIVE-BASH'; else printf 'XAIBO-TEE-LIVE-SH'; fi";
const MARKER = /XAIBO-TEE-LIVE-(BASH|SH)/;
// First-run screens of a never-opened disposable profile, each answered once. Folder trust defaults to "No, exit" (seen in
// 2.1.322), so it takes Down then Enter; the folder is a synthetic dir inside the profile. The others take their default.
const DOWN = '\x1b[B';
const FIRST_RUN: [string, RegExp, string][] = [
  ['theme', /text style/i, ENTER], ['notes', /Press Enter to continue/i, ENTER], ['folder trust', /Yes, I trust this folder/, DOWN + ENTER],
];

async function untilMarker(screen: Tui, ms: number, answered: string[]): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 1_000))) {
    const text = screen.text();
    if (MARKER.test(text)) return true;
    const next = FIRST_RUN.find(([name, re]) => !answered.includes(name) && re.test(text));
    if (next) { answered.push(next[0]); screen.send(next[2]); }
  }
  return false;
}

test('live: the tee renders the original status text in a real TUI and a snapshot arrives; revert byte-identical', { skip }, async (t) => {
  const root = realpathSync(ROOT!);
  const slot = /\/claude-([ab])$/.exec(root)?.[1];
  assert.ok(root.startsWith(`${realpathSync(join(homedir(), '.xaibo-spike-profiles'))}/`) && slot, 'XAIBO_LIVE_ROOT must be the runner profile ~/.xaibo-spike-profiles/claude-<a|b>');
  const home = join(root, 'home');
  const configDir = join(home, '.claude');
  const project = join(home, 'p3-live'); // inside the profile: no repo CLAUDE.md or project settings load
  mkdirSync(project, { recursive: true, mode: 0o700 });
  const settings = join(configDir, 'settings.json');
  const statusline = join(REPO, '.cache', 'sea', 'xaibo-statusline');
  assert.ok(existsSync(statusline), 'build the SEA tee first');
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'xl-'))); // short: the socket path limit
  const store = await openStore({ file: join(dataDir, 'xaibo.db'), backupDir: join(dataDir, 'backups') });
  store.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('live', 'claude', ?, 'manual')").run(configDir);
  const hooks = await startHooks({ dataDir, db: store.db, writer: new Writer(store.db) });
  const before = existsSync(settings) ? readFileSync(settings) : null;
  const logDir = join(REPO, '.cache', 'spike-results', 'p3-tee');
  const bounds = { root: home, denied: [] };
  try {
    assert.ok(hooks.socket, 'the hook socket listens (run outside the Claude sandbox)');
    writeFileSync(settings, JSON.stringify({ ...(before ? JSON.parse(before.toString('utf8')) : {}), statusLine: { type: 'command', command: ORIGINAL } }, null, 2));
    const seeded = readFileSync(settings);
    deployShim(dataDir, { hook: join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder: join(REPO, '.cache', 'sea', 'xaibo-forwarder'), statusline });
    const entry = installTee({ dataDir, profileKey: 'live', configDir, bounds });
    const screen = tui('xaibo-p3-tee', project, logDir, ['/bin/bash', join(REPO, 'spikes', 'shared', 'in-profile.sh'), 'claude', slot!, '--', CLAUDE!]);
    try {
      const answered: string[] = [];
      const seen = await untilMarker(screen, 60_000, answered);
      t.diagnostic(`first-run screens answered: ${answered.join(', ') || 'none'}`);
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
