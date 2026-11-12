// P3-T01: FR-32 safe config transaction engine and dev CLI (EC-48; FR-34 engine; Q3-2, Q3-3). Synthetic configs only;
// every directory is a fresh temp dir, nothing outside it is read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, ConfigError, plan, readManifest, revert, type Bounds, type Op } from '../../src/service/config/transaction.ts';

const REPO = join(import.meta.dirname, '..', '..');
const FIXTURES = join(REPO, 'test', 'fixtures', 'synthetic', 'config');
const CLI = join(REPO, 'src', 'service', 'config', 'dev-cli.ts');

function sandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'xcfg-')));
  const root = join(base, 'profile');
  const dataDir = join(base, 'data');
  mkdirSync(root);
  mkdirSync(dataDir);
  const bounds: Bounds = { root, denied: [join(base, 'denied')] };
  return { base, root, dataDir, bounds };
}
const mode = (p: string) => statSync(p).mode & 0o777;
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { assert.ok(e instanceof ConfigError, String(e)); return e.code; }
  assert.fail('expected a ConfigError');
};

const XAIBO_HOOK = { type: 'command', async: true, command: '/tmp/xaibo-fixture/xaibo-hook claude a' };
const OPS: Record<string, { route: 'claude-settings-fallback' | 'codex-hooks' | 'agy-hooks'; ops: Op[] }> = {
  'claude-settings': { route: 'claude-settings-fallback', ops: [{ op: 'append', pointer: '/hooks/SessionStart', value: { hooks: [XAIBO_HOOK] } }] },
  'codex-hooks': { route: 'codex-hooks', ops: [{ op: 'append', pointer: '/hooks/Stop', value: { hooks: [{ type: 'command', command: '/tmp/xaibo-fixture/xaibo-hook codex a' }] } }] },
  'agy-hooks': { route: 'agy-hooks', ops: [{ op: 'set', pointer: '/xaibo', value: { Stop: [{ type: 'command', command: '/tmp/xaibo-fixture/xaibo-hook agy a', timeout: 10 }] } }] },
};

test('apply then revert is byte-identical on every synthetic config fixture, mode kept', () => {
  const dirs = readdirSync(FIXTURES);
  assert.deepEqual(dirs.sort(), Object.keys(OPS).sort());
  for (const dir of dirs) {
    for (const f of readdirSync(join(FIXTURES, dir))) {
      const { root, dataDir, bounds } = sandbox();
      const target = join(root, 'config.json');
      copyFileSync(join(FIXTURES, dir, f), target);
      chmodSync(target, 0o644);
      const before = readFileSync(target);
      const entry = apply(plan(target, OPS[dir]!.route, OPS[dir]!.ops, bounds), { dataDir, bounds });
      assert.notDeepEqual(readFileSync(target), before, `${dir}/${f} unchanged by apply`);
      assert.equal(mode(target), 0o644, `${dir}/${f} mode`);
      const r = revert(entry, { dataDir, bounds });
      assert.deepEqual(r.conflicts, []);
      assert.deepEqual(readFileSync(target), before, `${dir}/${f} not byte-identical`);
      assert.deepEqual(readManifest(dataDir), []);
    }
  }
});

test('invalid JSON is refused without echoing content, nothing written', () => {
  const { root, dataDir, bounds } = sandbox();
  const target = join(root, 'settings.json');
  writeFileSync(target, '{"statusLine": "secret-ish-value", ');
  let err: unknown;
  try { plan(target, 'claude-tee', [{ op: 'set', pointer: '/statusLine', value: {} }], bounds); } catch (e) { err = e; }
  assert.ok(err instanceof ConfigError && err.code === 'invalid-json');
  assert.ok(!String((err as Error).message).includes('secret-ish-value'));
  assert.equal(readFileSync(target, 'utf8'), '{"statusLine": "secret-ish-value", ');
  assert.deepEqual(readdirSync(dataDir), []);
});

test('a file changed between plan and apply aborts and keeps the current bytes (EC-48)', () => {
  const { root, dataDir, bounds } = sandbox();
  const target = join(root, 'hooks.json');
  writeFileSync(target, '{"hooks": {}}\n');
  const p = plan(target, 'codex-hooks', OPS['codex-hooks']!.ops, bounds);
  writeFileSync(target, '{"hooks": {}, "edited": true}\n');
  assert.equal(code(() => apply(p, { dataDir, bounds })), 'changed');
  assert.equal(readFileSync(target, 'utf8'), '{"hooks": {}, "edited": true}\n');
  assert.deepEqual(readManifest(dataDir), []);
});

test('foreign-only edit after apply: revert removes Xaibo values, keeps foreign content and indent', () => {
  const { root, dataDir, bounds } = sandbox();
  const target = join(root, 'settings.json');
  copyFileSync(join(FIXTURES, 'claude-settings', 'custom-statusline.json'), target);
  const entry = apply(plan(target, 'claude-settings-fallback', OPS['claude-settings']!.ops, bounds), { dataDir, bounds });
  const doc = JSON.parse(readFileSync(target, 'utf8'));
  writeFileSync(target, JSON.stringify({ ...doc, theme: 'dark' }, null, 4));
  const r = revert(entry, { dataDir, bounds });
  assert.deepEqual(r.conflicts, []);
  const text = readFileSync(target, 'utf8');
  const after = JSON.parse(text);
  assert.equal(after.theme, 'dark');
  assert.equal(after.hooks, undefined, 'Xaibo-created container removed');
  assert.deepEqual(after.statusLine, doc.statusLine);
  assert.match(text, /^\{\n {4}"/);
  assert.ok(!text.endsWith('\n'), 'no trailing newline, as the original');
});

test('a changed Xaibo-owned value is a conflict and is not overwritten', () => {
  const { root, dataDir, bounds } = sandbox();
  const target = join(root, 'hooks.json');
  copyFileSync(join(FIXTURES, 'agy-hooks', 'foreign.json'), target);
  const entry = apply(plan(target, 'agy-hooks', OPS['agy-hooks']!.ops, bounds), { dataDir, bounds });
  const doc = JSON.parse(readFileSync(target, 'utf8'));
  doc.xaibo.Stop[0].timeout = 99;
  writeFileSync(target, JSON.stringify({ ...doc, added: true }, null, 2) + '\n');
  const r = revert(entry, { dataDir, bounds });
  assert.deepEqual(r.conflicts.map((c) => c.pointer), ['/xaibo']);
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).xaibo.Stop[0].timeout, 99);
  assert.equal(readManifest(dataDir).length, 1, 'entry kept while conflicts remain');
  const again = revert(readManifest(dataDir)[0]!, { dataDir, bounds });
  assert.deepEqual(again.conflicts.map((c) => c.pointer), ['/xaibo'], 'a retried revert never falls back to the full backup');
  const after = JSON.parse(readFileSync(target, 'utf8'));
  assert.equal(after.xaibo.Stop[0].timeout, 99);
  assert.equal(after.added, true);
});

test('set over a foreign value: structural revert restores the foreign value', () => {
  const { root, dataDir, bounds } = sandbox();
  const target = join(root, 'settings.json');
  copyFileSync(join(FIXTURES, 'claude-settings', 'custom-statusline.json'), target);
  const original = JSON.parse(readFileSync(target, 'utf8')).statusLine;
  const tee = { type: 'command', command: '/tmp/xaibo-fixture/xaibo-tee' };
  const p = plan(target, 'claude-tee', [{ op: 'set', pointer: '/statusLine', value: tee }], bounds);
  assert.deepEqual(p.diff.map((d) => d.pointer), ['/statusLine']);
  assert.ok(!JSON.stringify(p.diff).includes('status.sh'), 'replaced foreign value is not shown');
  const entry = apply(p, { dataDir, bounds });
  const doc = JSON.parse(readFileSync(target, 'utf8'));
  writeFileSync(target, JSON.stringify({ ...doc, theme: 'dark' }, null, 4));
  revert(entry, { dataDir, bounds });
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')).statusLine, original);
});

test('self-check failure restores the backup', () => {
  const { root, dataDir, bounds } = sandbox();
  const target = join(root, 'hooks.json');
  copyFileSync(join(FIXTURES, 'codex-hooks', 'foreign.json'), target);
  const before = readFileSync(target);
  const p = plan(target, 'codex-hooks', OPS['codex-hooks']!.ops, bounds);
  assert.equal(code(() => apply(p, { dataDir, bounds, afterRename: (f) => writeFileSync(f, '{"hooks": {}}') })), 'self-check');
  assert.deepEqual(readFileSync(target), before);
  assert.deepEqual(readManifest(dataDir), []);
});

test('a malformed file after the rename rolls back; oversized output is refused before writing', () => {
  const { root, dataDir, bounds } = sandbox();
  const target = join(root, 'hooks.json');
  copyFileSync(join(FIXTURES, 'codex-hooks', 'foreign.json'), target);
  const before = readFileSync(target);
  const p = plan(target, 'codex-hooks', OPS['codex-hooks']!.ops, bounds);
  assert.equal(code(() => apply(p, { dataDir, bounds, afterRename: (f) => writeFileSync(f, '{"hooks": ') })), 'self-check');
  assert.deepEqual(readFileSync(target), before);
  assert.deepEqual(readManifest(dataDir), []);
  const big = [{ op: 'set' as const, pointer: '/blob', value: 'x'.repeat(5 << 20) }];
  assert.equal(code(() => plan(target, 'codex-hooks', big, bounds)), 'too-large');
});

test('a failure after the rename keeps the pending entry and backup, so revert still restores', { skip: process.getuid?.() === 0 }, () => {
  const { root, dataDir, bounds } = sandbox();
  const target = join(root, 'hooks.json');
  copyFileSync(join(FIXTURES, 'codex-hooks', 'foreign.json'), target);
  const before = readFileSync(target);
  const p = plan(target, 'codex-hooks', OPS['codex-hooks']!.ops, bounds);
  chmodSync(root, 0o300); // rename still works; opening the directory to fsync it does not
  try { assert.throws(() => apply(p, { dataDir, bounds })); } finally { chmodSync(root, 0o700); }
  const entries = readManifest(dataDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.state, 'pending');
  assert.equal(readdirSync(join(dataDir, 'integrations', 'backups')).length, 1);
  revert(entries[0]!, { dataDir, bounds });
  assert.deepEqual(readFileSync(target), before);
});

test('a permission change between plan and apply aborts (no widening)', () => {
  const { root, dataDir, bounds } = sandbox();
  const target = join(root, 'hooks.json');
  copyFileSync(join(FIXTURES, 'codex-hooks', 'foreign.json'), target);
  chmodSync(target, 0o644);
  const p = plan(target, 'codex-hooks', OPS['codex-hooks']!.ops, bounds);
  chmodSync(target, 0o600);
  assert.equal(code(() => apply(p, { dataDir, bounds })), 'changed');
  assert.equal(mode(target), 0o600);
});

test('backup and manifest are 0600 in 0700 dirs', () => {
  const { root, dataDir, bounds } = sandbox();
  const target = join(root, 'hooks.json');
  copyFileSync(join(FIXTURES, 'codex-hooks', 'foreign.json'), target);
  apply(plan(target, 'codex-hooks', OPS['codex-hooks']!.ops, bounds), { dataDir, bounds });
  const dir = join(dataDir, 'integrations');
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(join(dir, 'backups')), 0o700);
  assert.equal(mode(join(dir, 'manifest.json')), 0o600);
  const backups = readdirSync(join(dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0]!, /^[0-9a-f-]{36}\.bak$/);
  assert.equal(mode(join(dir, 'backups', backups[0]!)), 0o600);
});

test('a new file is created and revert removes it', () => {
  const { root, dataDir, bounds } = sandbox();
  const target = join(root, 'hooks.json');
  const entry = apply(plan(target, 'codex-hooks', OPS['codex-hooks']!.ops, bounds), { dataDir, bounds });
  assert.equal(mode(target), 0o600);
  revert(entry, { dataDir, bounds });
  assert.ok(!existsSync(target));
});

test('refusals: symlinked target, escape from root, denied root, missing parent, forbidden hook types, async, pointers', () => {
  const { base, root, bounds } = sandbox();
  const real = join(root, 'real.json');
  writeFileSync(real, '{}\n');
  symlinkSync(real, join(root, 'link.json'));
  const set: Op[] = [{ op: 'set', pointer: '/a', value: 1 }];
  assert.equal(code(() => plan(join(root, 'link.json'), 'claude-tee', set, bounds)), 'symlink');
  mkdirSync(join(base, 'outside'));
  symlinkSync(join(base, 'outside'), join(root, 'dir'));
  assert.equal(code(() => plan(join(root, 'dir', 'x.json'), 'claude-tee', set, bounds)), 'outside-root');
  mkdirSync(join(base, 'denied'));
  assert.equal(code(() => plan(join(base, 'denied', 'x.json'), 'claude-tee', set, { root: base, denied: bounds.denied })), 'denied-root');
  assert.equal(code(() => plan(join(root, 'none', 'x.json'), 'claude-tee', set, bounds)), 'parent-missing');
  for (const type of ['prompt', 'agent']) {
    assert.equal(code(() => plan(real, 'codex-hooks', [{ op: 'append', pointer: '/hooks/Stop', value: { hooks: [{ type, prompt: 'x' }] } }], bounds)), 'forbidden-hook-type');
  }
  const syncHook = { hooks: [{ type: 'command', command: '/tmp/xaibo-fixture/h' }] };
  assert.equal(code(() => plan(real, 'claude-settings-fallback', [{ op: 'append', pointer: '/hooks/PreToolUse', value: syncHook }], bounds)), 'async-required');
  assert.equal(code(() => plan(real, 'claude-tee', [{ op: 'append', pointer: '/hooks/PreToolUse', value: syncHook }], bounds)), 'async-required');
  assert.ok(plan(real, 'claude-settings-fallback', [{ op: 'append', pointer: '/hooks/Stop', value: syncHook }], bounds), 'Stop stays synchronous (S3)');
  for (const pointer of ['/__proto__/x', '/constructor/prototype', 'nope', '/a/-/b']) {
    assert.equal(code(() => plan(real, 'claude-tee', [{ op: 'set', pointer, value: 1 }], bounds)), 'pointer', pointer);
  }
  assert.equal(({} as Record<string, unknown>)['x'], undefined, 'no prototype pollution');
  writeFileSync(real, '[1, 2]');
  assert.equal(code(() => plan(real, 'claude-tee', set, bounds)), 'not-object');
  writeFileSync(real, '﻿{}');
  assert.equal(code(() => plan(real, 'claude-tee', set, bounds)), 'bom');
});

// --- dev CLI ---------------------------------------------------------------------------------------------------

function cli(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), ...env }, input: '' });
}
/** A stand-in login shell: ignores its argv and prints NUL-separated env entries, like `env -0`. */
function fakeShell(base: string, extra: Record<string, string> = {}) {
  const sh = join(base, 'fake-shell');
  const entries = Object.entries({ PATH: '/usr/bin:/bin', ...extra }).map(([k, v]) => `${k}=${v}\\000`).join('');
  writeFileSync(sh, `#!/bin/sh\nprintf '${entries}'\n`);
  chmodSync(sh, 0o700);
  return sh;
}

test('dev CLI: apply/revert/status in a temp profile with --yes; foreign entries kept; byte-identical', () => {
  const { base, root, dataDir } = sandbox();
  mkdirSync(join(root, '.gemini', 'config'), { recursive: true });
  const target = join(root, '.gemini', 'config', 'hooks.json');
  copyFileSync(join(FIXTURES, 'agy-hooks', 'foreign.json'), target);
  const before = readFileSync(target);
  const change = join(base, 'ops.json');
  writeFileSync(change, JSON.stringify(OPS['agy-hooks']!.ops));
  const env = { HOME: join(base, 'home'), XAIBO_DATA_DIR: dataDir, SHELL: fakeShell(base) };
  mkdirSync(env.HOME);
  const a = cli(['apply', '--target', 'agy-hooks', '--profile', root, '--change', change, '--yes'], env);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /\/xaibo/);
  assert.equal(JSON.parse(readFileSync(target, 'utf8'))['other-tool'].Stop[0].timeout, 10);
  const s = cli(['status', '--target', 'agy-hooks', '--profile', root], env);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /agy-hooks/);
  const r = cli(['revert', '--target', 'agy-hooks', '--profile', root, '--yes'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(target), before);
});

test('dev CLI refuses real roots, login-shell overrides, failed login env, escapes, unconfirmed writes and claude-plugin writes', () => {
  const { base, root, dataDir } = sandbox();
  const change = join(base, 'ops.json');
  writeFileSync(change, JSON.stringify([{ op: 'set', pointer: '/statusLine', value: { type: 'command', command: '/tmp/xaibo-fixture/t' } }]));
  const home = join(base, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{}\n');
  const env = { HOME: home, XAIBO_DATA_DIR: dataDir, SHELL: fakeShell(base) };
  const args = (profile: string, target = 'claude-tee') => ['apply', '--target', target, '--profile', profile, '--change', change, '--yes'];

  const real = cli(args(home), env);
  assert.notEqual(real.status, 0);
  assert.match(real.stderr, /real agent root/);
  assert.equal(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'), '{}\n');

  mkdirSync(join(root, '.claude'));
  const login = cli(args(root), { ...env, SHELL: fakeShell(join(base, 'profile'), { CLAUDE_CONFIG_DIR: join(root, '.claude') }) });
  assert.notEqual(login.status, 0);
  assert.match(login.stderr, /real agent root/);

  const noShell = cli(args(root), { ...env, SHELL: '' });
  assert.notEqual(noShell.status, 0);
  assert.match(noShell.stderr, /login/);

  mkdirSync(join(base, 'elsewhere'));
  symlinkSync(join(base, 'elsewhere'), join(root, '.gemini'));
  const escape = cli(args(root, 'agy-hooks'), env);
  assert.notEqual(escape.status, 0);
  assert.match(escape.stderr, /outside/);

  const repoProfile = join(REPO, '.cache', `devcli-test-${process.pid}`);
  mkdirSync(join(repoProfile, '.claude'), { recursive: true });
  try {
    const unconfirmed = cli(args(repoProfile), env);
    assert.notEqual(unconfirmed.status, 0);
    assert.match(unconfirmed.stderr, /confirm/);
    assert.ok(!existsSync(join(repoProfile, '.claude', 'settings.json')));
  } finally {
    spawnSync('/bin/rm', ['-r', repoProfile]);
  }

  const plugin = cli(args(root, 'claude-plugin'), env);
  assert.notEqual(plugin.status, 0);
  assert.match(plugin.stderr, /status only/);
});
