// XAIBO-PROD-616 (P7-T04 slice A; OQ-P7-1): the external-terminal launcher in main. Immediately before a launch the grant is
// revalidated (P7-T03) and the command built (P7-T02); a blocked or refused launch writes and opens nothing. A started launch
// writes a private .command file (0700, O_EXCL, a random name with no shell metacharacters) into <dataDir>/launch/run, which
// removes itself when the shell starts reading it, and opens it through the injected spawner; stale files are swept.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, grantLaunch } from '../../../src/main/launch/grants.ts';
import { symlinkSync, mkdirSync } from 'node:fs';
import { launchInTerminal, sweepLaunchScripts, type LaunchRequest } from '../../../src/main/launch/terminal.ts';
import { quote } from '../../../src/main/launch/command.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const ID = '00000000-0000-4000-8000-0000000b7c02';
async function world(grant = true) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xterm-')));
  dirs.push(base);
  const exe = join(base, 'fake-agent');
  writeFileSync(exe, "#!/bin/sh\nprintf '%s\\0' \"$@\"\n", { mode: 0o755 });
  const req: LaunchRequest = { dataDir: join(base, 'data'), agent: 'claude', names: ['fake-agent'], executable: exe, args: ['--session-id', '{id}'], envKeys: [], nativeId: ID, cwd: base };
  if (grant) await grantLaunch(req.dataDir, 'claude', { exe, template: req.args, envKeys: req.envKeys }, 'bundled', await fingerprint(exe), 1);
  const opened: string[] = [];
  return { base, req, opened, spawner: { open: async (f: string) => { opened.push(f); return true; } } };
}
const runDir = (req: LaunchRequest) => join(req.dataDir, 'launch', 'run');

test('a granted launch writes a private self-removing .command and opens it; the script runs the validated argv', async () => {
  const w = await world();
  const r = await launchInTerminal(w.req, w.spawner);
  assert.deepEqual(r, { status: 'started', argv: [w.req.executable, '--session-id', ID] });
  assert.equal(w.opened.length, 1);
  const f = w.opened[0]!;
  assert.match(f, /\/launch\/run\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.command$/);
  assert.equal(f.startsWith(runDir(w.req)), true);
  assert.equal(statSync(f).mode & 0o777, 0o700);
  assert.equal(statSync(runDir(w.req)).mode & 0o777, 0o700);
  assert.equal(readFileSync(f, 'utf8').startsWith(`#!/bin/sh\nrm -f -- ${quote(f)}\ncd -- `), true, 'review LOW: the literal path, never $0');
  const out = spawnSync('/bin/sh', [f], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.deepEqual(out.stdout.split('\0').slice(0, -1), ['--session-id', ID]);
  assert.equal(existsSync(f), false, 'removed once the shell started it');
});

test('no grant, a renewal or a refused token: nothing is written or opened', async () => {
  const none = await world(false);
  assert.deepEqual(await launchInTerminal(none.req, none.spawner), { status: 'blocked', blocked: 'grant required' });
  const w = await world();
  assert.deepEqual(await launchInTerminal({ ...w.req, args: ['--session-id', '{id}', '--x'] }, w.spawner), { status: 'blocked', blocked: 'renewal required', field: 'template' });
  assert.deepEqual(await launchInTerminal({ ...w.req, nativeId: 'NOT-A-UUID' }, w.spawner), { status: 'refused', reason: 'id' });
  assert.deepEqual(await launchInTerminal({ ...w.req, cwd: join(w.base, 'missing') }, w.spawner), { status: 'refused', reason: 'cwd' });
  assert.deepEqual([none.opened, w.opened], [[], []]);
  for (const x of [none, w]) assert.equal(existsSync(runDir(x.req)) ? readdirSync(runDir(x.req)).length : 0, 0);
});

test('a spawner that fails leaves no script behind; stale scripts are swept on the next launch', async () => {
  const w = await world();
  assert.deepEqual(await launchInTerminal(w.req, { open: async () => false }), { status: 'failed', reason: 'open' });
  assert.deepEqual(await launchInTerminal(w.req, { open: async () => { throw new Error('x'); } }), { status: 'failed', reason: 'open' });
  assert.deepEqual(readdirSync(runDir(w.req)), []);
  const stale = join(runDir(w.req), '00000000-0000-4000-8000-0000000b7c03.command'), fresh = join(runDir(w.req), '00000000-0000-4000-8000-0000000b7c04.command');
  writeFileSync(stale, '#!/bin/sh\n', { mode: 0o700 });
  writeFileSync(fresh, '#!/bin/sh\n', { mode: 0o700 });
  utimesSync(stale, new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));
  assert.equal((await launchInTerminal(w.req, w.spawner)).status, 'started');
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true, 'a launch still being read is left alone');
});


// XAIBO-PROD-616 reviews: I/O errors are a result, never a rejection; the startup sweep; the run folder must be ours
test('a linked run folder or a relative data folder is a failed write; the startup sweep removes only stale scripts', async () => {
  const w = await world();
  mkdirSync(join(w.req.dataDir, 'launch', 'elsewhere'), { recursive: true });
  symlinkSync(join(w.req.dataDir, 'launch', 'elsewhere'), runDir(w.req));
  assert.deepEqual(await launchInTerminal(w.req, w.spawner), { status: 'failed', reason: 'write' });
  assert.deepEqual(await launchInTerminal({ ...w.req, dataDir: 'relative' }, w.spawner), { status: 'blocked', blocked: 'grant required' });
  assert.deepEqual(w.opened, []);
  const v = await world();
  assert.equal((await launchInTerminal(v.req, v.spawner)).status, 'started');
  const old = join(runDir(v.req), '00000000-0000-4000-8000-0000000b7c05.command');
  writeFileSync(old, '#!/bin/sh\n', { mode: 0o700 });
  utimesSync(old, new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));
  sweepLaunchScripts(v.req.dataDir);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(v.opened[0]!), true, 'a script younger than five minutes stays');
  sweepLaunchScripts(join(v.base, 'no-data-yet')); // nothing there: no throw
});
