// Real sandbox-exec deny tests, supervisor tests and the end-to-end runner check (P0-T05).
// Seatbelt cannot nest inside the Claude sandbox: run with `npm run spike:test:unsandboxed` outside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { canaryOk, denyProfile } from './in-profile.ts';

const HERE = import.meta.dirname;
const SUP = join(HERE, 'supervise.pl');
const RUNNER = join(HERE, 'in-profile.sh');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readPid = (f: string) => Number(readFileSync(f, 'utf8').trim());
async function until(f: () => boolean, ms = 5000) { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) return false; await sleep(25); } return true; }
const groupAlive = (pg: number) => spawnSync('/bin/ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' }).stdout.split('\n')
  .some((l) => { const [g, st] = l.trim().split(/\s+/); return Number(g) === pg && !!st && !st.startsWith('Z'); });

test('deny profile blocks every protected root and allows the temp profile', () => {
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'deny-test-')));
  const p = (...s: string[]) => join(T, ...s);
  mkdirSync(p('prot', 'nested'), { recursive: true });
  writeFileSync(p('prot', 'f.txt'), 'orig');
  writeFileSync(p('protFile.json'), 'orig');
  mkdirSync(p('par (en)'));
  mkdirSync(p('ctrl'));
  mkdirSync(p('prof', 'tmp'), { recursive: true });
  mkdirSync(p('canary'));
  writeFileSync(p('canary', 'canary.txt'), 'c');
  symlinkSync(p('prot'), p('prof', 'link'));
  const roots = [
    { path: p('prot'), file: false }, { path: p('protFile.json'), file: true }, { path: p('absentFile.json'), file: true },
    { path: p('absentDir'), file: false }, { path: p('par (en)'), file: false }, { path: p('canary'), file: false },
  ];
  const sb = p('sb');
  writeFileSync(sb, denyProfile(roots));
  const run = (cmd: string) => spawnSync('/usr/bin/sandbox-exec', ['-f', sb, '/bin/sh', '-c', cmd], { cwd: T, stdio: 'ignore' }).status;
  const intact = () => readFileSync(p('prot', 'f.txt'), 'utf8') === 'orig' && readFileSync(p('protFile.json'), 'utf8') === 'orig';
  const denied = [
    'echo x > prot/f.txt', 'echo x > prot/nested/new.txt', 'echo x > prof/link/new2.txt', 'mkdir -p absentDir/sub',
    'echo x > protFile.json', ': > protFile.json', 'rm protFile.json', 'echo o > ctrl/o1; mv ctrl/o1 protFile.json',
    'mv protFile.json ctrl/moved', 'echo x > absentFile.json', 'rm prot/f.txt', 'echo o > ctrl/o2; mv ctrl/o2 prot/f.txt',
    'mv prot ctrl/protmoved', 'rm -r prot', 'echo x > "par (en)/a"', 'cat protFile.json', 'cat prot/f.txt', 'cat canary/canary.txt',
  ];
  for (const cmd of denied) {
    assert.notEqual(run(cmd), 0, `not denied: ${cmd}`);
    assert.ok(intact(), `state changed by: ${cmd}`);
  }
  run('rm -rf prot'); // -f masks the EPERM once listing is denied; the state is what must hold
  assert.ok(intact(), 'state changed by: rm -rf prot');
  assert.ok(!existsSync(p('absentDir')) && !existsSync(p('absentFile.json')) && !existsSync(p('prot', 'nested', 'new.txt')));
  for (const cmd of ['echo ok > ctrl/a', 'echo ok > prof/tmp/b',
    'mkdir -p prof/home/.claude && echo {} > prof/home/.claude/settings.json && echo l >> prof/home/.claude/t.jsonl && : > prof/home/.lock']) {
    assert.equal(run(cmd), 0, `not allowed: ${cmd}`);
  }
  mkdirSync(p('absentDir')); // a root created after generation is still protected
  assert.notEqual(run('echo x > absentDir/late'), 0);
  assert.ok(!existsSync(p('absentDir', 'late')));
  assert.equal(canaryOk(sb, p('canary'), p('prof', 'tmp')), true);
  const noop = p('noop.sb');
  writeFileSync(noop, '(version 1)\n(allow default)\n');
  assert.equal(canaryOk(noop, p('canary'), p('prof', 'tmp')), false);
  rmSync(T, { recursive: true, force: true });
});

function sup(cmd: string[], env: NodeJS.ProcessEnv = {}, token = 'unused-token') {
  const T = mkdtempSync(join(tmpdir(), 'sup-test-'));
  const child = spawn('/usr/bin/perl', [SUP, token, join(T, 'pids'), '--', ...cmd], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise<number>((res) => child.on('exit', (c, s) => res(c ?? 128)));
  return { T, child, done, err: () => stderr, f: join(T, 'F') };
}

test('supervisor passes the exit code and records itself', async () => {
  const s = sup(['/bin/sh', '-c', 'exit 7']);
  assert.equal(await s.done, 7);
  assert.equal(readFileSync(join(s.T, 'pids'), 'utf8').trim().split('\t').length, 4);
});

test('background child, grace period and KILL escalation', async () => {
  const D = mkdtempSync(join(tmpdir(), 'grace-'));
  const F = join(D, 'F');
  let s = sup(['/bin/sh', '-c', 'sleep 30 & echo $! > "$0"', F]);
  assert.equal(await s.done, 0);
  assert.ok(!alive(readPid(F)), 'background child survived');
  let t0 = Date.now();
  s = sup(['/bin/sh', '-c', '(trap "" TERM; sleep 2) & echo $! > "$0"', F]);
  await s.done;
  assert.ok(Date.now() - t0 < 5000, 'waited past the grace period for a descendant that exits in it');
  assert.ok(!alive(readPid(F)));
  t0 = Date.now();
  s = sup(['/bin/sh', '-c', '(trap "" TERM; sleep 30) & echo $! > "$0"', F]);
  await s.done;
  const took = Date.now() - t0;
  assert.ok(took >= 5000 && took < 9000, `KILL escalation timing ${took}`);
  assert.ok(!alive(readPid(F)));
});

test('cleanup signal while running, and immediately after start', async () => {
  const D = mkdtempSync(join(tmpdir(), 'sig-'));
  const F = join(D, 'F');
  let s = sup(['/bin/sh', '-c', 'sleep 30 & echo $! > "$0"; sleep 30', F]);
  assert.ok(await until(() => existsSync(F)));
  s.child.kill('SIGTERM');
  await s.done;
  assert.ok(!alive(readPid(F)));
  rmSync(F);
  s = sup(['/bin/sh', '-c', 'echo $$ > "$0"; sleep 30 & sleep 30', F]);
  s.child.kill('SIGTERM');
  await s.done;
  if (existsSync(F)) assert.ok(await until(() => !groupAlive(readPid(F)), 2000), 'group member left behind');
});

test('setup races and failures leave nothing behind', async () => {
  const D = mkdtempSync(join(tmpdir(), 'setup-'));
  const F = join(D, 'F');
  let s = sup(['/bin/sh', '-c', 'sleep 30 & echo $! > "$0"', F], { XAIBO_SUPERVISE_TEST: 'parent-delay' });
  assert.equal(await s.done, 0, 'EACCES race must be accepted');
  assert.ok(!alive(readPid(F)));
  rmSync(F);
  s = sup(['/bin/sh', '-c', 'echo $$ > "$0"; sleep 30', F], { XAIBO_SUPERVISE_TEST: 'child-setpgid-fail' });
  assert.equal(await s.done, 126);
  assert.ok(!existsSync(F), 'command ran despite the setup failure');
  s = sup(['/nonexistent/cmd']);
  assert.equal(await s.done, 127);
  s = sup(['/bin/sh', '-c', 'echo $$ > "$0"; sleep 30', F], { XAIBO_SUPERVISE_TEST: 'group-check-fail' });
  assert.equal(await s.done, 126);
  assert.ok(await until(() => !existsSync(F) || !alive(readPid(F)), 2000));
  // pids registration fails after the command started: the group is stopped, exit 126, nothing left running
  rmSync(F, { force: true });
  s = sup(['/bin/sh', '-c', 'echo $$ > "$0"; sleep 30 & wait', F], { XAIBO_SUPERVISE_TEST: 'register-fail' });
  assert.equal(await s.done, 126);
  assert.match(s.err(), /pids registration/);
  assert.ok(!existsSync(F) || !alive(readPid(F)), 'command left running after a registration failure');
});

test('escaped descendants: marker fd, Node-spawned (tree), double-fork limit (block backstop)', async () => {
  const D = mkdtempSync(join(tmpdir(), 'esc-'));
  const F = join(D, 'F');
  const escaper = 'use POSIX; setsid(); open my $f, ">", $ARGV[0]; print $f $$; close $f; sleep 30';
  let s = sup(['/bin/sh', '-c', `/usr/bin/perl -e '${escaper}' "$0" & sleep 0.5`, F], {}, 'tokesc');
  assert.equal(await s.done, 125);
  assert.match(s.err(), /survivors 1/);
  process.kill(readPid(F), 'SIGKILL');
  rmSync(F);
  const blk = (c: string) => spawnSync(process.execPath, [join(HERE, 'in-profile.ts'), c, 'runner-test'], { encoding: 'utf8' });
  // Node parent (the shape of Claude Code / Gemini): children do not inherit the marker fd; tree tracking catches it.
  const nodeEsc = `require('child_process').spawn('/usr/bin/perl', ['-e', ${JSON.stringify(escaper)}, process.argv[1]], { detached: true, stdio: 'ignore' }).unref(); setTimeout(() => {}, 500)`;
  s = sup([process.execPath, '-e', nodeEsc, F], {}, 'toknode');
  assert.equal(await s.done, 125, 'Node-spawned escaper not detected');
  process.kill(readPid(F), 'SIGKILL');
  rmSync(F);
  assert.equal(blk('block-start').status, 0);
  // Stated limit: a double fork that detaches within one poll gap and closes its fds; the block backstop lists it.
  const dbl = `use POSIX; exit if fork; setsid(); POSIX::close($_) for 3..255; open my $f, ">", $ARGV[0]; print $f $$; close $f; sleep 30`;
  s = sup(['/bin/sh', '-c', `/usr/bin/perl -e '${dbl}' "$0"; sleep 0.5`, F]);
  assert.ok([0, 125].includes(await s.done));
  assert.ok(await until(() => existsSync(F) && readFileSync(F, 'utf8').trim() !== ''));
  const pid = readPid(F);
  assert.equal(blk('block-end').status, 1);
  const listed = readFileSync(join(HERE, '..', '..', '.cache', 'spike-results', 'runner-test', 'block-new.txt'), 'utf8');
  assert.ok(listed.split('\n').some((l) => l.trim().startsWith(`${pid} `)), 'backstop missed the escaper');
  process.kill(pid, 'SIGKILL');
  assert.ok(await until(() => !alive(pid), 2000));
  rmSync(join(HERE, '..', '..', '.cache', 'spike-results', 'runner-test'), { recursive: true, force: true });
});

test('runner: /usr/bin/env shows only allowlisted names with isolation paths under $P', () => {
  const ALLOWED = new Set(['PATH', 'TERM', 'LANG', 'USER', 'LOGNAME', 'SHELL', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
    'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR', 'TMPDIR', 'XAIBO_RUN_TOKEN', 'DISABLE_AUTOUPDATER', 'GEMINI_FORCE_FILE_STORAGE', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']);
  const P = join(homedir(), '.xaibo-spike-profiles');
  for (const agent of ['claude', 'codex', 'gemini']) {
    const r = spawnSync('/bin/bash', [RUNNER, agent, 'a', '--', '/usr/bin/env'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const env = Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    for (const k of Object.keys(env)) assert.ok(ALLOWED.has(k), `unexpected ${k}`);
    for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR', 'TMPDIR']) assert.ok(env[k].startsWith(`${P}/`), `${agent} ${k}`);
    if (agent === 'codex') assert.match(readFileSync(join(P, 'codex-a', 'home', '.codex', 'config.toml'), 'utf8'), /sandbox_mode = "danger-full-access"/);
    if (agent === 'gemini') assert.match(readFileSync(join(P, 'gemini-a', 'home', '.gemini', 'settings.json'), 'utf8'), /"enableAutoUpdate": false/);
  }
  assert.equal(spawnSync('/bin/bash', [RUNNER, '--gemini-layout', 'custom', 'claude', 'a', '--', '/usr/bin/true']).status, 3);
});

test('block-end never lists itself or its own ps child', async () => {
  const run = (c: string) => spawn(process.execPath, [join(HERE, 'in-profile.ts'), c, 'runner-idle'], { stdio: 'ignore' });
  await new Promise((r) => run('block-start').on('exit', r));
  const end = run('block-end');
  await new Promise((r) => end.on('exit', r));
  const lines = readFileSync(join(HERE, '..', '..', '.cache', 'spike-results', 'runner-idle', 'block-new.txt'), 'utf8').split('\n').filter(Boolean);
  rmSync(join(HERE, '..', '..', '.cache', 'spike-results', 'runner-idle'), { recursive: true, force: true });
  for (const l of lines) {
    const [pid, ppid] = l.trim().split(/\s+/).map(Number);
    assert.ok(pid !== end.pid && ppid !== end.pid, 'block-end listed itself or its ps child');
  }
});
