// XAIBO-PROD-559 (P6-T03 part 2a; part 2a design review in .handoff/p6-t03-design.md): the integrations operation lock. One
// exclusive private lock file in the data dir serializes every writer of agent config and the manifest (service, dev CLI,
// Codex status); a second acquire, in this process or another, is `busy`; a lock whose holder is gone is `stale-lock` and
// is never taken over; release removes only our own lock; an unreadable or linked lock file counts as held.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, lockState, tryLock } from '../../src/service/config/lock.ts';
import { ConfigError } from '../../src/service/config/transaction.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function dataDir() {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'xlock-')));
  dirs.push(d);
  return d;
}
const lockFile = (d: string) => join(d, 'integrations', 'operation.lock');
const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return e instanceof ConfigError ? e.code : String(e); } };

test('one holder: a second acquire is busy; release frees it; the file is private', () => {
  const d = dataDir();
  const l = acquireLock(d);
  assert.equal(lockState(d), 'busy');
  assert.equal(code(() => acquireLock(d)), 'busy', 'this process again');
  assert.equal(tryLock(d), null);
  assert.equal((JSON.parse(readFileSync(lockFile(d), 'utf8')) as { pid: number }).pid, process.pid);
  l.release();
  assert.equal(lockState(d), 'free');
  acquireLock(d).release();
});


test('another holder: busy while it lives, stale-lock once it is gone; never taken over', () => {
  const d = dataDir();
  mkdirSync(join(d, 'integrations'), { recursive: true, mode: 0o700 });
  const live = JSON.stringify({ pid: process.ppid, token: 'other', at: 1 });
  writeFileSync(lockFile(d), live, { mode: 0o600 });
  assert.equal(code(() => acquireLock(d)), 'busy');
  assert.equal(readFileSync(lockFile(d), 'utf8'), live, 'left untouched');
  // a pid that has exited and is not reused yet (code review L-g: retry until one is really gone)
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let gone = 0;
  for (let i = 0; i < 5 && (!gone || alive(gone)); i++) gone = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  const dead = JSON.stringify({ pid: gone, token: 'crashed', at: 1 });
  writeFileSync(lockFile(d), dead, { mode: 0o600 });
  assert.equal(code(() => acquireLock(d)), 'stale-lock');
  assert.equal(lockState(d), 'stale-lock', 'the lock-free state says the same (code review L-c)');
  assert.equal(readFileSync(lockFile(d), 'utf8'), dead, 'a stale lock is reported, never removed');
  assert.equal(tryLock(d), null);
});

test("an unreadable or linked lock file counts as held; a release never removes another holder's lock", () => {
  const d = dataDir();
  mkdirSync(join(d, 'integrations'), { recursive: true, mode: 0o700 });
  writeFileSync(lockFile(d), 'not json', { mode: 0o600 });
  assert.equal(code(() => acquireLock(d)), 'busy');
  rmSync(lockFile(d));
  symlinkSync(join(d, 'elsewhere'), lockFile(d));
  assert.equal(code(() => acquireLock(d)), 'busy');
  assert.equal(existsSync(join(d, 'elsewhere')), false, 'the link is never followed');
  rmSync(lockFile(d));
  const l = acquireLock(d);
  writeFileSync(lockFile(d), JSON.stringify({ pid: process.pid, token: 'someone-else', at: 1 }));
  l.release();
  assert.equal(existsSync(lockFile(d)), true, 'not our token: left in place');
});
