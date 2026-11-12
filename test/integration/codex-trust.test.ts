// XAIBO-PROD-306 (P3-T06; EC-25, FR-31, FR-34, FR-06, S5): Codex hooks in a synthetic CODEX_HOME. After install the
// state is "installed, awaiting trust" with guided steps, rollouts keep being ingested, config.toml (where Codex keeps
// trust) is never touched and no source passes the trust-bypass flag; the first hook delivery after install makes it
// connected; a change to the Xaibo groups returns it to awaiting trust. Groups are appended after foreign ones, and a
// foreign group added after Xaibo's is a revert conflict, never shifted onto a stale trust key (S5-C5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_HOOK_EVENTS } from '../../src/service/adapters/codex/hooks.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { codexHookStatus, installCodexHooks, uninstallCodexHooks } from '../../src/service/adapters/codex/setup.ts';
import { deployShim } from '../../src/service/adapters/claude/setup.ts';
import { ConfigError, readManifest } from '../../src/service/config/transaction.ts';
import { createIntake } from '../../src/service/receivers/intake.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { envelope } from '../helpers/hook-store.ts';
import { count } from '../helpers/claude-profile.ts';

const REPO = join(import.meta.dirname, '..', '..');
const FIX = join(REPO, 'test', 'fixtures', 'synthetic');
const CASE = join(FIX, 'codex', '0.160.0', 'hooks', 'untrusted-installed');
const BYPASS = ['--dangerously', 'bypass', 'hook', 'trust'].join('-');
const TOML = '[hooks.state."/tmp/xaibo-fixture/codex/hooks.json:PreToolUse:0:0"]\ntrusted_hash = "sha256:synthetic"\n';
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return e instanceof ConfigError ? e.code : String(e); } };

async function sandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'xct-')));
  const root = join(base, 'profile');
  const codexHome = join(root, '.codex');
  const dataDir = join(base, 'data');
  mkdirSync(join(codexHome, 'sessions', '2026', '01', '01'), { recursive: true });
  mkdirSync(dataDir);
  copyFileSync(join(FIX, 'config', 'codex-hooks', 'foreign.json'), join(codexHome, 'hooks.json'));
  writeFileSync(join(codexHome, 'config.toml'), TOML);
  const forwarder = join(base, 'forwarder');
  writeFileSync(forwarder, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  deployShim(dataDir, { hook: join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder });
  const { db } = await openStore({ file: join(dataDir, 'xaibo.db'), backupDir: join(dataDir, 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'codex', ?, 'default')").run(codexHome);
  const writer = new Writer(db);
  const o = { dataDir, codexHome, profileKey: 'p1', bounds: { root, denied: [] }, db };
  return { base, root, codexHome, dataDir, forwarder, db, writer, intake: createIntake({ db, writer }), o };
}
const hooksJson = (h: { codexHome: string }) => JSON.parse(readFileSync(join(h.codexHome, 'hooks.json'), 'utf8')) as { hooks: Record<string, unknown[]> };

test('EC-25: installed, awaiting trust with steps; rollouts ingested meanwhile; trust state untouched; first delivery connects', async () => {
  const h = await sandbox();
  const tomlBefore = sha(join(h.codexHome, 'config.toml'));
  assert.equal(codexHookStatus(h.o).state, 'not-installed');
  await h.intake.deliver(envelope({ agent: 'codex', received_ts: Date.now() - 60_000 })); // before install: does not count
  installCodexHooks(h.o);

  const s = codexHookStatus(h.o);
  assert.equal(s.state, 'awaiting-trust');
  assert.equal(s.label, 'installed, awaiting trust');
  assert.equal(s.reason, 'no-event');
  const steps = s.steps.join('\n');
  assert.ok(s.steps.length >= 3);
  assert.ok(steps.includes(h.codexHome), 'names the profile');
  assert.ok(steps.includes(`'${join(h.dataDir, 'integrations', 'bin', 'xaibo-hook')}' hook codex p1`), 'shows the command to approve');
  assert.ok(steps.includes(String(CODEX_HOOK_EVENTS.length)), 'says how many hooks to approve');
  assert.ok(!steps.includes(BYPASS));

  // append rule: the foreign group keeps index 0 (and its trust key); Xaibo's group follows it
  const doc = hooksJson(h);
  assert.deepEqual(doc.hooks['PreToolUse']![0], JSON.parse(readFileSync(join(FIX, 'config', 'codex-hooks', 'foreign.json'), 'utf8')).hooks.PreToolUse[0]);
  assert.equal(doc.hooks['PreToolUse']!.length, 2);
  for (const ev of CODEX_HOOK_EVENTS) assert.ok(doc.hooks[ev]!.length >= 1, ev);
  assert.equal(code(() => installCodexHooks(h.o)), 'duplicate');

  // rollouts keep being observed while hooks are silent
  const name = readdirSync(CASE).find((f) => f.startsWith('rollout-'))!;
  copyFileSync(join(CASE, name), join(h.codexHome, 'sessions', '2026', '01', '01', name));
  const a = new CodexAdapter({ db: h.db, writer: h.writer, profileId: 'p1', root: h.codexHome, intervalMs: 60_000 });
  await a.start();
  a.stop();
  assert.equal(count(h.db, "SELECT count(*) FROM events WHERE source = 'rollout'"), 5);
  assert.equal(codexHookStatus(h.o).state, 'awaiting-trust');

  await h.intake.deliver(envelope({ agent: 'codex', event: 'SessionStart', received_ts: Date.now() }));
  assert.equal(codexHookStatus(h.o).state, 'connected');
  assert.equal(codexHookStatus(h.o).label, 'connected');

  // any change to the Xaibo entry returns it to awaiting trust (Codex re-reviews a changed declaration, S5-C4)
  const edited = hooksJson(h);
  (edited.hooks['Stop']!.at(-1) as { hooks: { command: string }[] }).hooks[0]!.command += ' extra';
  writeFileSync(join(h.codexHome, 'hooks.json'), JSON.stringify(edited, null, 2));
  const later = new Date(Date.now() + 5_000);
  utimesSync(join(h.codexHome, 'hooks.json'), later, later);
  const changed = codexHookStatus(h.o);
  assert.equal(changed.state, 'awaiting-trust');
  assert.equal(changed.reason, 'entry-changed');
  await h.intake.deliver(envelope({ agent: 'codex', received_ts: statSync(join(h.codexHome, 'hooks.json')).mtimeMs + 1 }));
  assert.equal(codexHookStatus(h.o).state, 'connected', 're-approved: a delivery after the change');

  // review R1: a change seen once is remembered; restoring the original declaration needs a new delivery too
  const original = readFileSync(join(h.codexHome, 'hooks.json'));
  const again = hooksJson(h);
  (again.hooks['Stop']!.at(-1) as { hooks: { command: string }[] }).hooks[0]!.command += ' again';
  writeFileSync(join(h.codexHome, 'hooks.json'), JSON.stringify(again, null, 2));
  const later2 = new Date(Date.now() + 10_000);
  utimesSync(join(h.codexHome, 'hooks.json'), later2, later2);
  assert.equal(codexHookStatus(h.o).state, 'awaiting-trust');
  writeFileSync(join(h.codexHome, 'hooks.json'), original);
  assert.equal(codexHookStatus(h.o).state, 'awaiting-trust', 'restored, but no delivery since the change');
  await h.intake.deliver(envelope({ agent: 'codex', received_ts: later2.getTime() + 1 }));
  assert.equal(codexHookStatus(h.o).state, 'connected');

  // re-review R1b: a deleted hooks.json is remembered; restoring the connected bytes needs a new delivery
  const connectedBytes = readFileSync(join(h.codexHome, 'hooks.json'));
  rmSync(join(h.codexHome, 'hooks.json'));
  assert.equal(codexHookStatus(h.o).state, 'awaiting-trust', 'hooks.json gone');
  writeFileSync(join(h.codexHome, 'hooks.json'), connectedBytes);
  assert.equal(codexHookStatus(h.o).state, 'awaiting-trust', 'restored after deletion, no delivery since');
  await h.intake.deliver(envelope({ agent: 'codex', received_ts: later2.getTime() + 10 }));
  assert.equal(codexHookStatus(h.o).state, 'connected');

  // re-review R2b: a change restored with an old mtime still excludes every delivery already received
  const third = hooksJson(h);
  (third.hooks['Stop']!.at(-1) as { hooks: { command: string }[] }).hooks[0]!.command += ' third';
  writeFileSync(join(h.codexHome, 'hooks.json'), JSON.stringify(third, null, 2));
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(join(h.codexHome, 'hooks.json'), old, old);
  assert.equal(codexHookStatus(h.o).state, 'awaiting-trust', 'old mtime, no delivery since the change was seen');
  await h.intake.deliver(envelope({ agent: 'codex', received_ts: later2.getTime() + 11 }));
  assert.equal(codexHookStatus(h.o).state, 'connected');

  assert.equal(sha(join(h.codexHome, 'config.toml')), tomlBefore, 'Xaibo never writes trust');
  assert.deepEqual(readdirSync(h.codexHome).sort(), ['config.toml', 'hooks.json', 'sessions']);
});

test('uninstall: byte-identical when nothing changed; config.toml untouched', async () => {
  const h = await sandbox();
  const before = readFileSync(join(h.codexHome, 'hooks.json'));
  const toml = sha(join(h.codexHome, 'config.toml'));
  installCodexHooks(h.o);
  assert.deepEqual(uninstallCodexHooks(h.o), { result: 'restored', conflicts: [] });
  assert.deepEqual(readFileSync(join(h.codexHome, 'hooks.json')), before);
  assert.equal(sha(join(h.codexHome, 'config.toml')), toml);
  assert.equal(readManifest(h.dataDir).length, 0);
  assert.equal(codexHookStatus(h.o).state, 'not-installed');
  assert.equal(code(() => uninstallCodexHooks(h.o)), 'not-installed');
});

test('S5-C5 append-then-remove: a foreign group added after Xaibo\'s is a conflict and keeps its position', async () => {
  const h = await sandbox();
  installCodexHooks(h.o);
  const doc = hooksJson(h);
  const later = { hooks: [{ type: 'command', command: '/tmp/xaibo-fixture/tools/later.sh' }] };
  doc.hooks['Stop']!.push(later);
  doc.hooks['PreToolUse']!.unshift({ hooks: [{ type: 'command', command: '/tmp/xaibo-fixture/tools/first.sh' }] }); // shifts Xaibo's group
  writeFileSync(join(h.codexHome, 'hooks.json'), JSON.stringify(doc, null, 2));
  const xaiboStop = doc.hooks['Stop']![0];

  const r = uninstallCodexHooks(h.o);
  assert.equal(r.result, 'structural');
  assert.deepEqual(r.conflicts.map((c) => c.pointer).sort(), ['/hooks/PreToolUse/1', '/hooks/Stop/0']);
  const after = hooksJson(h);
  assert.deepEqual(after.hooks['Stop'], [xaiboStop, later], 'the later foreign group keeps index 1 (its trust key)');
  assert.equal(after.hooks['PreToolUse']!.length, 3, 'the shifted Xaibo group is a conflict, not removed');
  assert.equal(after.hooks['SessionStart'], undefined, 'unchanged Xaibo groups at the end are removed');
  assert.equal(readManifest(h.dataDir).length, 1, 'the conflicts stay recorded');
});

test('static: no source passes the hook-trust bypass flag', () => {
  const files = (readdirSync(join(REPO, 'src'), { recursive: true }) as string[]).filter((f) => /\.(ts|tsx|js|sh)$|xaibo-hook$/.test(f));
  assert.ok(files.length > 50);
  for (const f of files) assert.ok(!readFileSync(join(REPO, 'src', f), 'utf8').includes(BYPASS), f);
});

test('dev CLI: codex-hooks --profile-key plans, installs with steps, reverts byte-identical', async () => {
  const h = await sandbox();
  const before = readFileSync(join(h.codexHome, 'hooks.json'));
  const sh = join(h.base, 'fake-shell');
  writeFileSync(sh, "#!/bin/sh\nprintf 'PATH=/usr/bin:/bin\\000'\n", { mode: 0o700 });
  mkdirSync(join(h.base, 'home'));
  // ELECTRON_RUN_AS_NODE: under test:electron the exec path is Electron, which must run the CLI as Node
  const env = { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), HOME: join(h.base, 'home'), XAIBO_DATA_DIR: h.dataDir, SHELL: sh };
  const cli = (args: string[]) => spawnSync(process.execPath, [join(REPO, 'src', 'service', 'config', 'dev-cli.ts'), ...args, '--target', 'codex-hooks', '--profile', h.root], { encoding: 'utf8', env, input: '', timeout: 30_000 });
  const p = cli(['plan', '--profile-key', 'p1']);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.split('\n').filter((l) => l.startsWith('+ /hooks/')).length, CODEX_HOOK_EVENTS.length);
  assert.deepEqual(readFileSync(join(h.codexHome, 'hooks.json')), before);
  const a = cli(['apply', '--profile-key', 'p1', '--forwarder', h.forwarder, '--yes']);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /installed, awaiting trust/);
  assert.ok(!a.stdout.includes(BYPASS));
  const r = cli(['revert', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(join(h.codexHome, 'hooks.json')), before);
});

// P3-T10 security review M2: the coverage poll runs codexHookStatus every 5 s, so the declarations are read bounded:
// a hooks.json that became a symlink is not followed (unreadable: awaiting trust again), never trusted through the link.
test('a symlinked hooks.json is not followed: unreadable, back to awaiting trust', async () => {
  const h = await sandbox();
  installCodexHooks(h.o);
  await h.intake.deliver(envelope({ agent: 'codex', received_ts: Date.now() + 1000 }));
  assert.equal(codexHookStatus(h.o).state, 'connected');
  const moved = join(h.base, 'elsewhere.json');
  copyFileSync(join(h.codexHome, 'hooks.json'), moved);
  rmSync(join(h.codexHome, 'hooks.json'));
  symlinkSync(moved, join(h.codexHome, 'hooks.json'));
  assert.equal(codexHookStatus(h.o).state, 'awaiting-trust');
});
