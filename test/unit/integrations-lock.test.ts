// XAIBO-PROD-559 (P6-T03 part 2a; part 2a design review in .handoff/p6-t03-design.md): the integrations operation lock. One
// exclusive private lock file in the data dir serializes every writer of agent config and the manifest (service, dev CLI,
// Codex status); a second acquire, in this process or another, is `busy`; a lock whose holder is gone is `stale-lock` and
// is never taken over; release removes only our own lock; an unreadable or linked lock file counts as held.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, judge, lockState, tryLock } from '../../src/service/config/lock.ts';
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
  const l = acquireLock(d, 'service');
  assert.equal(lockState(d), 'busy');
  assert.equal(code(() => acquireLock(d)), 'busy', 'this process again');
  assert.equal(tryLock(d), null);
  const rec = JSON.parse(readFileSync(lockFile(d), 'utf8')) as Record<string, unknown>;
  assert.equal(rec['pid'], process.pid);
  // XAIBO-PROD-612: record v2 carries the holder's process-start stamp (ps lstart, C locale, UTC) and the writer class
  assert.equal(rec['v'], 2);
  assert.equal(rec['writer'], 'service');
  assert.match(String(rec['start']), /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d\d:\d\d:\d\d \d{4}$/);
  l.release();
  assert.equal(lockState(d), 'free');
  acquireLock(d).release();
});


test('another holder: busy while it lives, stale-lock once it is gone; never taken over', () => {
  const d = dataDir();
  mkdirSync(join(d, 'integrations'), { recursive: true, mode: 0o700 });
  // XAIBO-PROD-612: a legacy record (no start stamp) whose pid is alive can't be verified: unknown, never busy or stale
  const live = JSON.stringify({ pid: process.ppid, token: 'other', at: 1 });
  writeFileSync(lockFile(d), live, { mode: 0o600 });
  assert.equal(code(() => acquireLock(d)), 'lock-unknown');
  assert.equal(lockState(d), 'lock-unknown');
  assert.equal(readFileSync(lockFile(d), 'utf8'), live, 'left untouched');
  // a pid that has exited and is not reused yet (code review L-g: retry until one is really gone)
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let gone = 0;
  for (let i = 0; i < 5 && (!gone || alive(gone)); i++) gone = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  writeFileSync(lockFile(d), JSON.stringify({ v: 2, pid: gone, token: 'crashed', at: 1, start: 'Thu Jan 1 00:00:00 2026', writer: 'service' }), { mode: 0o600 });
  assert.equal(lockState(d), 'stale-lock', 'v2 record, holder gone (ESRCH)');
  const dead = JSON.stringify({ pid: gone, token: 'crashed', at: 1 });
  writeFileSync(lockFile(d), dead, { mode: 0o600 });
  assert.equal(code(() => acquireLock(d)), 'stale-lock', 'a legacy record whose pid is gone');
  assert.equal(lockState(d), 'stale-lock', 'the lock-free state says the same (code review L-c)');
  assert.equal(readFileSync(lockFile(d), 'utf8'), dead, 'a stale lock is reported, never removed');
  assert.equal(tryLock(d), null);
});

test("an unreadable or linked lock file is unknown (never free, never clearable); a release never removes another holder's lock", () => {
  const d = dataDir();
  mkdirSync(join(d, 'integrations'), { recursive: true, mode: 0o700 });
  writeFileSync(lockFile(d), 'not json', { mode: 0o600 });
  assert.equal(code(() => acquireLock(d)), 'lock-unknown');
  writeFileSync(lockFile(d), '', { mode: 0o600 });
  assert.equal(code(() => acquireLock(d)), 'lock-unknown', 'XAIBO-PROD-612: an empty (half-written) lock');
  assert.equal(lockState(d), 'lock-unknown');
  rmSync(lockFile(d));
  symlinkSync(join(d, 'elsewhere'), lockFile(d));
  assert.equal(code(() => acquireLock(d)), 'lock-unknown');
  assert.equal(lockState(d), 'lock-unknown');
  assert.equal(existsSync(join(d, 'elsewhere')), false, 'the link is never followed');
  rmSync(lockFile(d));
  const l = acquireLock(d);
  writeFileSync(lockFile(d), JSON.stringify({ pid: process.pid, token: 'someone-else', at: 1 }));
  l.release();
  assert.equal(existsSync(lockFile(d)), true, 'not our token: left in place');
});

// XAIBO-PROD-612 (Phase 7 cleanup item 1, run 1; D-P7-03): the holder's process-start stamp tells a reused pid from the holder
test('a live pid with a different start stamp is stale (pid reused); the same stamp is busy; EPERM and probe failure are unknown', () => {
  const d = dataDir();
  const l = acquireLock(d, 'external');
  const rec = JSON.parse(readFileSync(lockFile(d), 'utf8')) as Record<string, unknown>;
  assert.equal(rec['writer'], 'external');
  writeFileSync(lockFile(d), JSON.stringify({ ...rec, token: 'other' }));
  assert.equal(lockState(d), 'busy', 'same pid, same stamp');
  writeFileSync(lockFile(d), JSON.stringify({ ...rec, token: 'other', start: 'Thu Jan 1 00:00:00 1970' }));
  assert.equal(lockState(d), 'stale-lock', 'same pid, different stamp: the pid was reused');
  assert.equal(code(() => acquireLock(d)), 'stale-lock', 'never taken over');
  l.release();
  assert.equal(existsSync(lockFile(d)), true, 'not our token');
  assert.equal(judge({ ...rec, pid: 1 }), 'lock-unknown', 'EPERM: alive but not ours to signal');
  assert.equal(judge({ ...rec, pid: process.ppid }, () => null), 'lock-unknown', 'our probe of the holder failed');
  // review LOW: our own pid is compared with our cached stamp, never probed (no ps per refresh while we hold it)
  assert.equal(judge(rec, () => { throw new Error('probed'); }), 'busy', 'our own lock, no probe');
  assert.equal(judge({ ...rec, start: 'Thu Jan 1 00:00:00 1970' }, () => { throw new Error('probed'); }), 'stale-lock', 'our pid, an earlier holder');
  assert.equal(judge({ ...rec, start: null }), 'lock-unknown', 'the holder could not stamp itself: only ESRCH proves staleness');
  assert.equal(judge({ ...rec, pid: 0 }), 'lock-unknown', 'malformed pid');
  assert.equal(judge('x'), 'lock-unknown');
});

test('lockState: only a missing lock file is free; any other fs error is unknown', { skip: process.getuid?.() === 0 }, () => {
  const d = dataDir();
  acquireLock(d).release();
  assert.equal(lockState(d), 'free');
  chmodSync(join(d, 'integrations'), 0o000);
  try { assert.equal(lockState(d), 'lock-unknown'); } finally { chmodSync(join(d, 'integrations'), 0o700); }
});
