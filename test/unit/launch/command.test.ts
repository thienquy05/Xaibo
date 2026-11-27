// XAIBO-PROD-614 (P7-T02, EC-76; design .handoff/p7-designs.md, Claude from the plan, D-P7-02): launch argument safety. The
// external-terminal command is assembled only from validated, individually single-quoted whole-argument tokens: the agent's
// own executable (absolute, realpath, a regular executable file, never a shell, interpreter or package runner), the template's
// tokens (placeholders only as a whole token), the native id (per-agent pattern) and the cwd (an existing directory). Each
// token survives a real sh round trip as exactly one argument.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommand, quote } from '../../../src/main/launch/command.ts';

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xlaunch-')));
after(() => rmSync(base, { recursive: true, force: true }));
/** A synthetic agent CLI that prints its working directory and each argument it got, NUL-terminated. */
const exe = join(base, 'fake-agent');
writeFileSync(exe, "#!/bin/sh\nprintf '%s\\0' \"$PWD\" \"$@\"\n");
chmodSync(exe, 0o755);
const ID = '00000000-0000-4000-8000-0000000b7c01';
const NAMES = ['fake-agent', 'agent-link']; // the catalog's executable names for the agent
const run = (script: string) => {
  const f = join(base, `run-${Math.random().toString(36).slice(2)}.command`);
  writeFileSync(f, script, { mode: 0o700 });
  const r = spawnSync('/bin/sh', [f], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\0').slice(0, -1);
};

const FUZZ = ['; rm -rf ~', '$(touch pwned)', '`id`', "it's", '"quoted"', 'two\nlines', 'a && b', 'x | y', '> out', '< in', 'naïve 日本 ✓',
  'tab\there', 'trailing\\', ' leading space', '-p', '--dangerously-skip-permissions=no', '*', '~', '$HOME', '!!', '#comment', '\u{a0}nbsp\u{2003}em', ''];

test('each fuzz token round-trips through sh as exactly one argument; cwd with metacharacters too', () => {
  const cwd = join(base, "dir ;$(x) `y` 'q' \"d\" ✓ -n");
  mkdirSync(cwd);
  const b = buildCommand({ agent: 'claude', executable: exe, names: NAMES, envKeys: [], args: [...FUZZ, '{id}', '--cwd', '{cwd}'], nativeId: ID, cwd });
  assert.equal(b.ok, true, JSON.stringify(b));
  if (!b.ok) return;
  assert.deepEqual(b.argv, [exe, ...FUZZ, ID, '--cwd', cwd]);
  assert.deepEqual(run(b.script), [cwd, ...FUZZ, ID, '--cwd', cwd]);
  assert.match(b.script, /^#!\/bin\/sh\ncd -- '.*' \|\| exit 1\nexec \/usr\/bin\/env -i (\$\{[A-Z]+\+"[A-Z]+=\$[A-Z]+"\} )+'/s);
  for (const t of FUZZ) assert.equal(run(`#!/bin/sh\nexec ${quote(exe)} ${quote(t)}\n`)[1], t, t);
});

test('a placeholder only as a whole token; unknown placeholders, NUL and a missing id are refused', () => {
  const cwd = base;
  const no = (args: string[], extra: Record<string, unknown> = {}) => { const b = buildCommand({ agent: 'claude', executable: exe, names: NAMES, envKeys: [], args, nativeId: ID, cwd, ...extra }); return b.ok ? 'ok' : b.reason; };
  assert.equal(no(['--resume={id}']), 'placeholder');
  assert.equal(no(['x{cwd}']), 'placeholder');
  for (const t of ['{session}', '{session_id}', '{ID}', '{}', '{0}']) assert.equal(no([t]), 'placeholder', t);
  assert.equal(no(['a\0b']), 'text');
  assert.equal(no(['lone \u{d800} surrogate'.replace('\u{d800}', String.fromCharCode(0xd800))]), 'text', 'never written as U+FFFD');
  assert.equal(no(["''"]), 'ok');
  assert.equal(buildCommand({ agent: 'claude', executable: exe, names: NAMES, envKeys: [], args: ['--resume', '{id}'], cwd }).ok, false, 'no id for {id}');
  assert.equal(no(['--resume', '{id}']), 'ok');
});

test('native ids: lowercase UUID for claude, codex and agy; others only by a declared pattern', () => {
  const b = (agent: string, nativeId: string, idPattern?: RegExp) => buildCommand({ agent, executable: exe, names: NAMES, envKeys: [], args: ['{id}'], nativeId, cwd: base, ...(idPattern ? { idPattern } : {}) }).ok;
  for (const agent of ['claude', 'codex', 'agy']) {
    assert.equal(b(agent, ID), true, agent);
    for (const bad of [ID.toUpperCase(), `${ID};id`, `-${ID}`, '../x', `${ID}\n`, '']) assert.equal(b(agent, bad), false, `${agent} ${JSON.stringify(bad)}`);
  }
  assert.equal(b('gemini', ID), false, 'no declared pattern');
  assert.equal(b('gemini', 'ab12', /^[a-z0-9]{4}$/), true);
  assert.equal(b('gemini', 'ab12;', /^[a-z0-9]{4}$/), false);
  assert.equal(b('gemini', '-ab1', /^-?[a-z0-9]{3}$/), false, 'never a leading dash, whatever the pattern');
  assert.equal(b('gemini', 'ab', /a|ab/), true, 'the whole id, not the first alternative');
  assert.equal(b('gemini', 'x\0y', /[\s\S]+/), false, 'never a NUL');
  assert.equal(b('gemini', 'ab\ncd', /ab$/m), false, 'never a match up to a line break');
});

test('the executable: absolute, resolved, a regular executable file; never a shell, interpreter or package runner', () => {
  const why = (executable: string, cwd = base, names: readonly string[] = NAMES) => { const r = buildCommand({ agent: 'claude', executable, names, envKeys: [], args: [], cwd }); return r.ok ? 'ok' : r.reason; };
  assert.equal(why('fake-agent'), 'executable');
  assert.equal(why(join(base, 'missing')), 'executable');
  assert.equal(why(base), 'executable', 'a directory');
  const plain = join(base, 'plain');
  writeFileSync(plain, 'x', { mode: 0o644 });
  assert.equal(why(plain), 'executable', 'not executable');
  const link = join(base, 'agent-link');
  symlinkSync(exe, link);
  const r = buildCommand({ agent: 'claude', executable: link, names: NAMES, envKeys: [], args: [], cwd: base });
  assert.deepEqual(r.ok ? r.argv : r, [exe], 'the realpath runs');
  // security review MEDIUM: the given name must be one of the agent's catalog names (a wrapper, a renamed tool, another CLI)
  assert.equal(why(exe, base, ['claude']), 'name');
  assert.equal(why('/usr/bin/nice', base, ['nice']), 'interpreter', 'a wrapper, even when a catalog named it');
  // and the interpreter/runner/wrapper denylist stays as a second layer, by the given or resolved name, any case
  for (const name of ['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'env', 'node', 'python', 'python3', 'python3.12', 'ruby', 'ruby3.3', 'perl', 'osascript', 'npx', 'npm', 'pnpm', 'pnpx', 'bunx', 'bun', 'yarn', 'uv', 'uvx', 'pipx', 'deno', 'tsx', 'ts-node',
    'nice', 'nohup', 'arch', 'time', 'timeout', 'xargs', 'caffeinate', 'script', 'sudo', 'doas', 'xcrun', 'sandbox-exec', 'open', 'pwsh', 'php', 'lua', 'awk', 'tclsh', 'expect', 'irb', 'swift']) {
    const f = join(base, name);
    writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(why(f, base, [name]), 'interpreter', name);
    const l = join(base, `${name}-alias`);
    symlinkSync(f, l);
    assert.equal(why(l, base, [`${name}-alias`]), 'interpreter', `a link to ${name}`);
  }
  assert.equal(why('/bin/sh', base, ['sh']), 'interpreter');
  const upper = join(base, 'upper'); // case-insensitive volume: its own folder, so SH never collides with sh
  mkdirSync(upper);
  for (const name of ['SH', 'Python3']) { const f = join(upper, name); writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 }); assert.equal(why(f, base, [name]), 'interpreter', name); }
  assert.equal(why(exe, 'relative'), 'cwd');
  assert.equal(why(exe, join(base, 'no-such-dir')), 'cwd');
  assert.equal(why(exe, plain), 'cwd', 'a file');
});


// XAIBO-PROD-615 reviews (MEDIUM): Terminal runs the .command with its own environment, so the script itself starts the agent
// under env -i with the fixed set plus the granted key names, values read in the terminal at launch (never written)
test('the script passes only the fixed set and granted keys; values are never in the script; bad key names are refused', () => {
  const show = join(base, 'env-agent');
  writeFileSync(show, '#!/bin/sh\n/usr/bin/env\n', { mode: 0o755 });
  const b = buildCommand({ agent: 'claude', executable: show, names: ['env-agent'], envKeys: ['FOO', 'UNSET_KEY'], args: [], cwd: base });
  assert.equal(b.ok, true);
  if (!b.ok) return;
  assert.doesNotMatch(b.script, /bar|k-secret/);
  const f = join(base, 'env.command');
  writeFileSync(f, b.script, { mode: 0o700 });
  const r = spawnSync('/bin/sh', [f], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/tmp/h', FOO: 'bar baz', ANTHROPIC_API_KEY: 'k-secret', NODE_OPTIONS: '--require x' } });
  const vars = new Map(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const));
  assert.equal(vars.get('FOO'), 'bar baz');
  assert.equal(vars.get('HOME'), '/tmp/h');
  for (const k of ['ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'UNSET_KEY']) assert.equal(vars.has(k), false, k);
  for (const k of ['A-B', 'X;Y', '1A', '']) assert.deepEqual(buildCommand({ agent: 'claude', executable: show, names: ['env-agent'], envKeys: [k], args: [], cwd: base }), { ok: false, reason: 'env' }, k);
});
