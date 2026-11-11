import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { resolveReal } from './in-profile.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS, buildEnv, checkTargets, denyProfile, layoutFor, realRoots, targetsFor } from './in-profile.ts';

const ALLOWED = new Set(['PATH', 'TERM', 'LANG', 'USER', 'LOGNAME', 'SHELL', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR', 'TMPDIR', 'XAIBO_SPIKE_RAW', 'XAIBO_RUN_TOKEN', 'DISABLE_AUTOUPDATER', 'GEMINI_FORCE_FILE_STORAGE', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']);

function world() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'runner-test-')));
  const repo = join(home, 'repo');
  mkdirSync(join(home, '.claude'), { recursive: true });
  return { home, repo, done: () => rmSync(home, { recursive: true, force: true }) };
}

test('env holds only allowlisted names; isolation paths and TMPDIR live under $P for every agent', () => {
  const w = world();
  const inherited = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'x', CLAUDECODE: '1', OTEL_X: '1', CODEX_HOME: '/real', TERM: 'xterm' };
  for (const agent of AGENTS) {
    const l = layoutFor(w.repo, agent, 'a', 'default', 's9', join(w.repo, '.cache', 'profiles'));
    const env = buildEnv(l, agent, inherited, 'tok');
    for (const k of Object.keys(env)) assert.ok(ALLOWED.has(k), `unexpected ${k}`);
    for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR', 'TMPDIR']) {
      assert.ok(env[k].startsWith(`${l.P}/`), `${k} not under $P`);
    }
    assert.equal(env.XAIBO_RUN_TOKEN, 'tok');
    assert.ok(env.XAIBO_SPIKE_RAW.endsWith('/.cache/spike-results/s9/raw'));
  }
  w.done();
});

test('gemini layouts: unset drops GEMINI_CLI_HOME, custom points under $P', () => {
  const w = world();
  const unset = buildEnv(layoutFor(w.repo, 'gemini', 'a', 'unset', undefined, join(w.repo, '.cache', 'profiles')), 'gemini', {}, 't');
  assert.equal(unset.GEMINI_CLI_HOME, undefined);
  const l = layoutFor(w.repo, 'gemini', 'a', 'custom', undefined, join(w.repo, '.cache', 'profiles'));
  assert.equal(buildEnv(l, 'gemini', {}, 't').GEMINI_CLI_HOME, join(l.P, 'gemini-a', 'cli-home'));
  w.done();
});

test('profiles under the real home are accepted, incl. GEMINI_CLI_HOME = home or a custom parent', () => {
  const w = world();
  for (const g of [[w.home], [join(w.home, 'custom')]]) {
    const roots = realRoots(w.home, { GEMINI_CLI_HOME: g });
    for (const mode of ['default', 'unset', 'custom'] as const) {
      const l = layoutFor(w.repo, 'gemini', 'a', mode, undefined, join(w.repo, '.cache', 'profiles'));
      assert.deepEqual(checkTargets(targetsFor(l, l.home), roots), []);
    }
  }
  w.done();
});

test('targets under a real root, through a symlink into one, or outside $P are refused', () => {
  const w = world();
  const roots = realRoots(w.home, { GEMINI_CLI_HOME: [join(w.home, 'custom')], CLAUDE_CONFIG_DIR: [join(w.home, 'alt')] });
  const l = layoutFor(w.repo, 'claude', 'a', 'default', undefined, join(w.repo, '.cache', 'profiles'));
  const bad = (cwd: string) => assert.notDeepEqual(checkTargets(targetsFor(l, cwd), roots), []);
  bad(join(w.home, '.claude', 'x'));
  bad(join(w.home, 'custom', '.gemini'));
  bad(join(w.home, 'alt', 'deep'));
  bad(join(w.home, 'elsewhere'));
  mkdirSync(l.profile, { recursive: true });
  symlinkSync(join(w.home, '.claude'), join(l.profile, 'link'));
  bad(join(l.profile, 'link', 'x'));
  const lp = { ...l, home: join(l.profile, 'link') };
  assert.notDeepEqual(checkTargets(targetsFor(lp, l.profile), roots), []);
  w.done();
});

test('a profile that contains a real root is refused', () => {
  const w = world();
  const l = layoutFor(w.repo, 'claude', 'a', 'default', undefined, join(w.repo, '.cache', 'profiles'));
  const roots = realRoots(w.home, { CODEX_HOME: [join(l.home, '.codex', 'nested')] });
  assert.notDeepEqual(checkTargets(targetsFor(l, l.home), roots), []);
  w.done();
});

test('deny profile: one rule per root, literal for files, parentheses ok, quotes and control chars refused', () => {
  const sb = denyProfile([{ path: '/x/dir (1)', file: false }, { path: '/x/f.json', file: true }]);
  assert.match(sb, /^\(version 1\)\n\(allow default\)\n/);
  assert.equal(sb.match(/\(deny file-read\* file-write\*/g)?.length, 2);
  assert.ok(sb.includes('(subpath "/x/dir (1)")'));
  assert.ok(sb.includes('(literal "/x/f.json")'));
  for (const p of ['/x/a"b', '/x/a\\b', '/x/a\nb', 'relative']) {
    assert.throws(() => denyProfile([{ path: p, file: false }]));
  }
});

test('deny rules carry the on-disk letter case of an existing root given in other case', () => {
  const w = world();
  mkdirSync(join(w.home, 'Work-Dir'));
  const sb = denyProfile([{ path: join(w.home, 'WORK-DIR'), file: false }]);
  assert.ok(sb.includes(`(subpath "${join(w.home, 'Work-Dir')}")`), 'on-disk case missing');
  assert.equal(resolveReal(join(w.home, 'work-dir', 'x')), join(w.home, 'Work-Dir', 'x'));
  w.done();
});
