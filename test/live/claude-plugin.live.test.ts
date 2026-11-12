// XAIBO-PROD-305 (P3-T05 live, owner-run only). Skipped unless XAIBO_LIVE_ROOT names a signed-in disposable profile
// HOME under .cache/profiles/ (its Claude config in <root>/.claude) and XAIBO_LIVE_CLAUDE the claude executable. Run it
// through the Phase 0 runner with a guard snapshot before and a compare after (MATCH), one PR-OK prompt in total:
//   XAIBO_LIVE_ROOT=<root> XAIBO_LIVE_CLAUDE=<exe> node --test test/live/claude-plugin.live.test.ts
// Needs the SEA forwarder (.cache/sea/xaibo-forwarder, `npm run build && sh scripts/build-forwarder.sh`). Prints only
// event names and pass/fail; no prompt text, ids or paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPlugin, deployShim, uninstallPlugin } from '../../src/service/adapters/claude/setup.ts';
import { startHooks } from '../../src/service/receivers/intake.ts';
import { replaySpool } from '../../src/service/receivers/spool-replay.ts';
import { ConfigError } from '../../src/service/config/transaction.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';

const REPO = join(import.meta.dirname, '..', '..');
const ROOT = process.env['XAIBO_LIVE_ROOT'];
const CLAUDE = process.env['XAIBO_LIVE_CLAUDE'];
const skip = ROOT && CLAUDE ? false : 'live: set XAIBO_LIVE_ROOT (disposable profile under .cache/profiles/) and XAIBO_LIVE_CLAUDE';

test('live: install, one PR-OK session delivers SessionStart/UserPromptSubmit/Stop, duplicate refused, uninstall', { skip }, async (t) => {
  const root = realpathSync(ROOT!);
  const profiles = realpathSync(join(REPO, '.cache', 'profiles'));
  assert.ok(root.startsWith(`${profiles}/`), 'XAIBO_LIVE_ROOT must be a disposable profile under .cache/profiles/');
  const configDir = join(root, '.claude');
  const forwarder = join(REPO, '.cache', 'sea', 'xaibo-forwarder');
  assert.ok(existsSync(forwarder), 'build the SEA forwarder first');
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'xl-'))); // short: the socket path limit
  const store = await openStore({ file: join(dataDir, 'xaibo.db'), backupDir: join(dataDir, 'backups') });
  store.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('live', 'claude', ?, 'manual')").run(configDir);
  const writer = new Writer(store.db);
  const hooks = await startHooks({ dataDir, db: store.db, writer });
  const o = { dataDir, profileKey: 'live', configDir, claude: CLAUDE!, bounds: { root, denied: [] }, env: { PATH: process.env['PATH'] ?? '', HOME: root } };
  const settings = join(configDir, 'settings.json');
  const hash = () => (existsSync(settings) ? createHash('sha256').update(readFileSync(settings)).digest('hex') : null);
  try {
    assert.ok(hooks.socket, 'the hook socket listens (run outside the Claude sandbox)');
    deployShim(dataDir, { hook: join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder });
    const pre = hash();
    await installPlugin(o);
    await assert.rejects(installPlugin(o), (e) => e instanceof ConfigError && e.code === 'duplicate');
    const code = await new Promise<number | null>((resolve) => {
      const c = spawn(CLAUDE!, ['-p', 'Reply with exactly: OK'], { env: { ...o.env, CLAUDE_CONFIG_DIR: configDir }, stdio: ['ignore', 'ignore', 'ignore'] });
      c.on('close', resolve);
    });
    assert.equal(code, 0);
    await new Promise((r) => setTimeout(r, 2_000)); // async hooks finish after the reply
    await replaySpool({ dataDir, db: store.db, deliver: hooks.intake.deliver, graceMs: 0 });
    const events = new Set((store.db.prepare("SELECT event FROM hook_delivery WHERE agent = 'claude' AND unattributed IS NULL").all() as { event: string }[]).map((r) => r.event));
    t.diagnostic(`events: ${[...events].sort().join(', ')}`);
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop']) assert.ok(events.has(ev), ev);
    const r = await uninstallPlugin(o);
    t.diagnostic(`uninstall: pre-hash restored ${r.preHashRestored}, residue ${r.residue.length}`);
    assert.deepEqual(r.residue, []);
    t.diagnostic(`settings before install ${pre === null ? 'absent' : 'present'}`);
  } finally {
    await hooks.close();
    store.db.close();
  }
});
