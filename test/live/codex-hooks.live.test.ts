// XAIBO-PROD-306 (P3-T06 live, owner-run only). Skipped unless XAIBO_LIVE_ROOT names a signed-in disposable profile
// HOME under .cache/profiles/ (CODEX_HOME = <root>/.codex), XAIBO_LIVE_CODEX the codex executable and XAIBO_LIVE_DATA a
// short absolute app-data dir kept between the two steps (the socket path limit). Through the Phase 0 runner, guard
// snapshot before and compare after (MATCH), one PR-OK prompt per step:
//   step 1: XAIBO_LIVE_ROOT=<root> XAIBO_LIVE_CODEX=<exe> XAIBO_LIVE_DATA=<dir> node --test test/live/codex-hooks.live.test.ts
//           installs, runs one headless prompt: untrusted hooks deliver nothing; prints the guided steps.
//   owner:  follows the printed steps in Codex's own TUI (approves the listed hooks; never the bypass flag).
//   step 2: the same with XAIBO_LIVE_CODEX_TRUSTED=1: one headless prompt delivers hooks, state connected, uninstall.
// Needs the SEA forwarder (.cache/sea/xaibo-forwarder). Prints only event names, states and pass/fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { codexHookStatus, installCodexHooks, uninstallCodexHooks } from '../../src/service/adapters/codex/setup.ts';
import { deployShim } from '../../src/service/adapters/claude/setup.ts';
import { startHooks } from '../../src/service/receivers/intake.ts';
import { replaySpool } from '../../src/service/receivers/spool-replay.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';

const REPO = join(import.meta.dirname, '..', '..');
const { XAIBO_LIVE_ROOT: ROOT, XAIBO_LIVE_CODEX: CODEX, XAIBO_LIVE_DATA: DATA } = process.env;
const TRUSTED = process.env['XAIBO_LIVE_CODEX_TRUSTED'] === '1';
const skip = ROOT && CODEX && DATA ? false : 'live: set XAIBO_LIVE_ROOT (disposable profile under .cache/profiles/), XAIBO_LIVE_CODEX and XAIBO_LIVE_DATA';

test(`live: Codex hooks ${TRUSTED ? 'fire after the owner approved them' : 'stay silent until trusted'}`, { skip }, async (t) => {
  const root = realpathSync(ROOT!);
  assert.ok(root.startsWith(`${realpathSync(join(REPO, '.cache', 'profiles'))}/`), 'XAIBO_LIVE_ROOT must be a disposable profile under .cache/profiles/');
  const codexHome = join(root, '.codex');
  const forwarder = join(REPO, '.cache', 'sea', 'xaibo-forwarder');
  assert.ok(existsSync(forwarder), 'build the SEA forwarder first');
  mkdirSync(DATA!, { recursive: true, mode: 0o700 });
  const dataDir = realpathSync(DATA!);
  const store = await openStore({ file: join(dataDir, 'xaibo.db'), backupDir: join(dataDir, 'backups') });
  store.db.prepare("INSERT OR IGNORE INTO profiles (id, agent, root, origin) VALUES ('live', 'codex', ?, 'manual')").run(codexHome);
  const writer = new Writer(store.db);
  const hooks = await startHooks({ dataDir, db: store.db, writer });
  const o = { dataDir, codexHome, profileKey: 'live', bounds: { root, denied: [] }, db: store.db };
  const env = { PATH: process.env['PATH'] ?? '', HOME: root, CODEX_HOME: codexHome };
  try {
    assert.ok(hooks.socket, 'the hook socket listens (run outside the Claude sandbox)');
    if (!TRUSTED) {
      deployShim(dataDir, { hook: join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder });
      installCodexHooks(o);
    }
    // review R2: deliveries from earlier runs (the owner's TUI session included) are drained first and never counted
    await replaySpool({ dataDir, db: store.db, deliver: hooks.intake.deliver, graceMs: 0 });
    const start = Date.now();
    const code = await new Promise<number | null>((resolve) => {
      const c = spawn(CODEX!, ['exec', '--skip-git-repo-check', 'Reply with exactly: OK'], { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'] });
      c.on('close', resolve);
    });
    assert.equal(code, 0);
    await new Promise((r) => setTimeout(r, 2_000));
    await replaySpool({ dataDir, db: store.db, deliver: hooks.intake.deliver, graceMs: 0 });
    const events = new Set((store.db.prepare("SELECT event FROM hook_delivery WHERE agent = 'codex' AND profile_key = 'live' AND received_ts >= ?")
      .all(start) as { event: string }[]).map((r) => r.event));
    const s = codexHookStatus(o);
    t.diagnostic(`events: ${[...events].sort().join(', ') || 'none'}; state: ${s.label}`);
    if (!TRUSTED) {
      assert.equal(events.size, 0, 'untrusted hooks must not fire (S5-C2)');
      assert.equal(s.state, 'awaiting-trust');
      for (const line of s.steps) t.diagnostic(`step: ${line}`); // the owner follows these in Codex's TUI
      return;
    }
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop']) assert.ok(events.has(ev), ev);
    assert.equal(s.state, 'connected');
    const r = uninstallCodexHooks(o);
    t.diagnostic(`uninstall: ${r.result}, conflicts ${r.conflicts.length}`);
    assert.equal(r.conflicts.length, 0);
  } finally {
    await hooks.close();
    store.db.close();
  }
});
