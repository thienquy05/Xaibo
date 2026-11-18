// XAIBO-PROD-505 (P5-T01a; FR-53, S-37, EC-106, EC-107): a session cwd resolves to its repository's verified common git
// directory from git metadata files only; every missing, unreadable or inconsistent step keeps cwd grouping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { resolveRepository } from '../../../src/service/history/repository.ts';

const root = () => realpathSync(mkdtempSync(join(tmpdir(), 'xrepo-')));
/** A git directory as FR-53 accepts it: HEAD, objects and refs. */
function gitDir(dir: string) {
  mkdirSync(join(dir, 'objects'), { recursive: true });
  mkdirSync(join(dir, 'refs'), { recursive: true });
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}
/** A linked worktree `wt` of the repository whose common git dir is `common`; pointers relative when asked. */
function linked(common: string, wt: string, name: string, rel = false) {
  const admin = join(common, 'worktrees', name);
  mkdirSync(admin, { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(admin, 'commondir'), rel ? '../..\n' : `${common}\n`);
  writeFileSync(join(admin, 'gitdir'), `${rel ? relative(admin, join(wt, '.git')) : join(wt, '.git')}\n`);
  writeFileSync(join(wt, '.git'), `gitdir: ${rel ? relative(wt, admin) : admin}\n`);
  return admin;
}
const repo = (key: string, worktree: string) => ({ kind: 'repository', key, worktree });

test('EC-106: a main checkout and its linked worktrees (absolute or relative pointers, symlinked cwd) share one key', () => {
  const r = root();
  const main = join(r, 'main');
  const common = gitDir(join(main, '.git'));
  mkdirSync(join(main, 'src', 'deep'), { recursive: true });
  assert.deepEqual(resolveRepository(join(main, 'src', 'deep')), repo(common, main));
  linked(common, join(r, 'wt-a'), 'wt-a');
  linked(common, join(r, 'wt-b'), 'wt-b', true);
  assert.deepEqual(resolveRepository(join(r, 'wt-a')), repo(common, join(r, 'wt-a')));
  assert.deepEqual(resolveRepository(join(r, 'wt-b')), repo(common, join(r, 'wt-b')));
  symlinkSync(join(r, 'wt-a'), join(r, 'alias'));
  assert.deepEqual(resolveRepository(join(r, 'alias')), repo(common, join(r, 'wt-a')));
});

test('EC-107: a separate git dir needs no back-pointer; worktrees of a bare repository key on the bare repository', () => {
  const r = root();
  const sep = gitDir(join(r, 'store', 'sep.git'));
  mkdirSync(join(r, 'checkout'));
  writeFileSync(join(r, 'checkout', '.git'), `gitdir: ${sep}\n`);
  assert.deepEqual(resolveRepository(join(r, 'checkout')), repo(sep, join(r, 'checkout')));
  const bare = gitDir(join(r, 'bare.git'));
  linked(bare, join(r, 'bw'), 'bw');
  assert.deepEqual(resolveRepository(join(r, 'bw')), repo(bare, join(r, 'bw')));
});

test('EC-107: the nearest repository wins (nested repository, submodule)', () => {
  const r = root();
  const outer = gitDir(join(r, 'outer', '.git'));
  const inner = gitDir(join(r, 'outer', 'inner', '.git'));
  mkdirSync(join(r, 'outer', 'inner', 'x'));
  assert.deepEqual(resolveRepository(join(r, 'outer', 'inner', 'x')), repo(inner, join(r, 'outer', 'inner')));
  const mod = gitDir(join(outer, 'modules', 'sub'));
  mkdirSync(join(r, 'outer', 'sub'));
  writeFileSync(join(r, 'outer', 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
  assert.deepEqual(resolveRepository(join(r, 'outer', 'sub')), repo(mod, join(r, 'outer', 'sub')));
});

test('EC-107: no .git, missing cwd, unreadable, malformed or inconsistent metadata and a failed back-pointer keep cwd grouping', () => {
  const r = root();
  mkdirSync(join(r, 'plain'));
  assert.deepEqual(resolveRepository(join(r, 'plain')), { kind: 'cwd', reason: 'no-git' });
  assert.deepEqual(resolveRepository(join(r, 'gone')), { kind: 'cwd', reason: 'unreadable' });
  const common = gitDir(join(r, 'main', '.git'));
  const at = (name: string, body: string) => { mkdirSync(join(r, name)); writeFileSync(join(r, name, '.git'), body); return join(r, name); };
  assert.deepEqual(resolveRepository(at('garbage', 'not a pointer\n')), { kind: 'cwd', reason: 'inconsistent' });
  assert.deepEqual(resolveRepository(at('missing', `gitdir: ${join(r, 'nowhere')}\n`)), { kind: 'cwd', reason: 'inconsistent' });
  writeFileSync(join(r, 'a-file'), 'x');
  assert.deepEqual(resolveRepository(at('to-file', `gitdir: ${join(r, 'a-file')}\n`)), { kind: 'cwd', reason: 'inconsistent' });
  const admin = linked(common, join(r, 'wt'), 'wt');
  writeFileSync(join(admin, 'gitdir'), `${join(r, 'other', '.git')}\n`);
  assert.deepEqual(resolveRepository(join(r, 'wt')), { kind: 'cwd', reason: 'back-pointer' });
  const admin2 = linked(common, join(r, 'wt2'), 'wt2');
  writeFileSync(join(admin2, 'commondir'), `${join(r, 'not-git')}\n`);
  mkdirSync(join(r, 'not-git'));
  assert.deepEqual(resolveRepository(join(r, 'wt2')), { kind: 'cwd', reason: 'not-repository' });
  const half = join(r, 'half', '.git');
  mkdirSync(join(half, 'objects'), { recursive: true });
  writeFileSync(join(half, 'HEAD'), 'x');
  assert.deepEqual(resolveRepository(join(r, 'half')), { kind: 'cwd', reason: 'not-repository' }, 'no refs');
  const locked = at('locked', `gitdir: ${common}\n`);
  chmodSync(join(locked, '.git'), 0o000);
  assert.deepEqual(resolveRepository(locked), { kind: 'cwd', reason: 'unreadable' });
  chmodSync(join(locked, '.git'), 0o600);
  assert.deepEqual(resolveRepository(at('huge', `gitdir: ${'x'.repeat(10_000)}\n`)), { kind: 'cwd', reason: 'inconsistent' }, 'oversized pointer');
});

// Review of XAIBO-PROD-505: the first .git decides; a .git that is not a file or directory never lets the walk reach an
// outer repository; oversized pointers are inconsistent; git's trailing whitespace and CRLF are accepted.
test('review: a dangling-symlink or FIFO .git under an outer repository is inconsistent, never the outer repository', () => {
  const r = root();
  gitDir(join(r, 'outer', '.git'));
  mkdirSync(join(r, 'outer', 'dangling'), { recursive: true });
  symlinkSync(join(r, 'nowhere'), join(r, 'outer', 'dangling', '.git'));
  assert.deepEqual(resolveRepository(join(r, 'outer', 'dangling')), { kind: 'cwd', reason: 'inconsistent' });
  mkdirSync(join(r, 'outer', 'fifo'));
  execFileSync('mkfifo', [join(r, 'outer', 'fifo', '.git')]);
  assert.deepEqual(resolveRepository(join(r, 'outer', 'fifo')), { kind: 'cwd', reason: 'inconsistent' });
});

test('review: an oversized commondir is inconsistent; trailing whitespace and CRLF in pointers are accepted', () => {
  const r = root();
  const common = gitDir(join(r, 'main', '.git'));
  const admin = linked(common, join(r, 'big'), 'big');
  writeFileSync(join(admin, 'commondir'), 'x'.repeat(5000));
  assert.deepEqual(resolveRepository(join(r, 'big')), { kind: 'cwd', reason: 'inconsistent' });
  const admin2 = linked(common, join(r, 'crlf'), 'crlf');
  writeFileSync(join(r, 'crlf', '.git'), `gitdir: ${admin2}  \r\n`);
  writeFileSync(join(admin2, 'gitdir'), `${join(r, 'crlf', '.git')}\r\n`);
  assert.deepEqual(resolveRepository(join(r, 'crlf')), repo(common, join(r, 'crlf')));
  const spaced = join(r, 'with space');
  linked(common, spaced, 'spaced');
  assert.deepEqual(resolveRepository(spaced), repo(common, spaced));
});

test('metadata files only: the resolver never starts a process', () => {
  const src = readFileSync(new URL('../../../src/service/history/repository.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /child_process|\bspawn(Sync)?\(|\bexecFile|\bexecSync|\bfork\(/); // RegExp#exec is not a process
});
