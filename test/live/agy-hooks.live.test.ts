// XAIBO-PROD-317 live (P3-T13e; plan P3-T13 "Live"): only with a fresh owner OK and prompt budget. Skipped unless
// XAIBO_LIVE_ROOT names the signed-in Phase 0 runner profile of agy (~/.xaibo-spike-profiles/agy-<slot>, HOME = <root>/home)
// and XAIBO_LIVE_DATA a short absolute app-data dir (the socket path limit). Run unsandboxed, with the guard around it:
//   node spikes/shared/guard.ts snapshot p3-agy
//   XAIBO_LIVE_ROOT=<root> XAIBO_LIVE_DATA=<dir> node --test test/live/agy-hooks.live.test.ts
//   node spikes/shared/guard.ts compare p3-agy        # must MATCH
// The test installs Xaibo's agy hooks into the profile HOME's .gemini/config/hooks.json through installAgyHooks (foreign groups
// kept), sends ONE headless prompt that reads a synthetic file through the Phase 0 runner (version freeze, process group
// supervision, read/write-deny sandbox) in .cache/spike-projects/p3-agy (no project hooks), checks that all six mapped
// events arrived over the socket from the SEA forwarder, and reverts the hooks (byte-identical). Prints only event names,
// counts and pass/fail; never payload content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { AGY_HOOK_EVENTS, agyHooksFile, installAgyHooks } from '../../src/service/adapters/agy/setup.ts';
import { deployShim } from '../../src/service/adapters/claude/setup.ts';
import { revert } from '../../src/service/config/transaction.ts';
import { startHooks } from '../../src/service/receivers/intake.ts';
import { replaySpool } from '../../src/service/receivers/spool-replay.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';

const REPO = join(import.meta.dirname, '..', '..');
const { XAIBO_LIVE_ROOT: ROOT, XAIBO_LIVE_DATA: DATA } = process.env;
const SPIKE = 'p3-agy';
const PROMPT = 'Read the file fixture.txt in the current directory with your file tool, then reply with exactly the word it contains.';
// Headless print mode of agy 1.5.6 (from `agy --help` in the disposable profile).
const PRINT = (process.env['XAIBO_LIVE_AGY_ARGS'] ?? '-p').split(' ');
const skip = ROOT && DATA ? false : 'live: set XAIBO_LIVE_ROOT (the runner profile ~/.xaibo-spike-profiles/agy-<slot>) and XAIBO_LIVE_DATA';

test('live: Xaibo agy hooks deliver all six mapped events and revert cleanly', { skip }, async (t) => {
  const root = realpathSync(ROOT!);
  const profiles = realpathSync(join(os.homedir(), '.xaibo-spike-profiles'));
  const slot = /\/agy-([ab])$/.exec(root)?.[1];
  assert.ok(root.startsWith(`${profiles}/`) && slot, 'XAIBO_LIVE_ROOT must be the runner profile ~/.xaibo-spike-profiles/agy-<a|b>');
  const home = join(root, 'home');
  const forwarder = join(REPO, '.cache', 'sea', 'xaibo-forwarder');
  assert.ok(existsSync(forwarder), 'build the SEA forwarder first (npm run build && sh scripts/build-forwarder.sh)');
  const project = join(REPO, '.cache', 'spike-projects', SPIKE);
  mkdirSync(project, { recursive: true, mode: 0o700 });
  writeFileSync(join(project, 'fixture.txt'), 'pineapple\n');
  assert.ok(!existsSync(join(project, '.agents')), 'the live project carries no project hooks');
  mkdirSync(DATA!, { recursive: true, mode: 0o700 });
  const dataDir = realpathSync(DATA!);

  const store = await openStore({ file: join(dataDir, 'xaibo.db'), backupDir: join(dataDir, 'backups') });
  store.db.prepare("INSERT OR IGNORE INTO profiles (id, agent, root, origin) VALUES ('live', 'agy', ?, 'manual')").run(join(home, '.gemini'));
  const writer = new Writer(store.db);
  const hooks = await startHooks({ dataDir, db: store.db, writer });
  const before = readFileSync(agyHooksFile(home));
  let entry: ReturnType<typeof installAgyHooks> | undefined;
  try {
    assert.ok(hooks.socket, 'the hook socket listens (run outside the Claude sandbox)');
    deployShim(dataDir, { hook: join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder });
    entry = installAgyHooks({ dataDir, profileKey: 'live', profileHome: home, project, bounds: { root: home, denied: [] } });
    await replaySpool({ dataDir, db: store.db, deliver: hooks.intake.deliver, graceMs: 0 }); // earlier runs never count
    const start = Date.now();
    const code = await new Promise<number | null>((resolve) => {
      const c = spawn('/bin/bash', [join(REPO, 'spikes', 'shared', 'in-profile.sh'), '--spike', SPIKE, 'agy', slot!, '--', 'agy', ...PRINT, PROMPT],
        { cwd: project, stdio: ['ignore', 'ignore', 'ignore'] });
      c.on('close', resolve);
    });
    t.diagnostic(`agy exit: ${code}`);
    assert.equal(code, 0);
    await new Promise((r) => setTimeout(r, 2_000));
    await replaySpool({ dataDir, db: store.db, deliver: hooks.intake.deliver, graceMs: 0 }); // any slow-ack spill
    const rows = store.db.prepare("SELECT event, count(*) AS n FROM hook_delivery WHERE agent = 'agy' AND profile_key = 'live' AND received_ts >= ? GROUP BY event")
      .all(start) as { event: string; n: number }[];
    t.diagnostic(`events: ${rows.map((r) => `${r.event}×${r.n}`).sort().join(', ') || 'none'}`);
    const seen = new Set(rows.map((r) => r.event));
    for (const ev of AGY_HOOK_EVENTS) assert.ok(seen.has(ev), `${ev} arrived`);
  } finally {
    if (entry) {
      const r = revert(entry, { dataDir, bounds: { root: home, denied: [] } });
      t.diagnostic(`revert: ${r.result}, conflicts ${r.conflicts.length}`);
      assert.deepEqual(readFileSync(agyHooksFile(home)), before, 'the profile hooks file is byte-identical after revert');
    }
    await hooks.close();
    store.db.close();
  }
});
