// XAIBO-PROD-317 (P3-T13d; plan P3-T13, D-P3-12): agy hooks go only into <profile HOME>/.gemini/config/hooks.json, as one
// `xaibo` group in the config shape P2-T00 recorded firing all six events (recorded-shape.json is that shape with
// synthetic commands). Foreign groups keep every byte; revert restores the file; a second Xaibo registration in the
// profile file or the selected project's .agents/hooks.json is refused and the project file is never written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { AGY_HOOK_EVENTS, agyHookOps, checkAgyInstall, installAgyHooks } from '../../src/service/adapters/agy/setup.ts';
import { deployShim } from '../../src/service/adapters/claude/setup.ts';
import { shimPath } from '../../src/service/adapters/codex/setup.ts';
import { lintHooks } from '../../src/service/config/hook-lint.ts';
import { ConfigError, plan, readManifest, revert } from '../../src/service/config/transaction.ts';

const REPO = join(import.meta.dirname, '..', '..');
const FIX = join(REPO, 'test', 'fixtures', 'synthetic', 'config', 'agy-hooks');
const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return e instanceof ConfigError ? e.code : String(e); } };
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const snapshot = (d: string) => Object.fromEntries(walk(d).map((f) => [relative(d, f), readFileSync(f, 'utf8')]));

function sandbox(o: { foreign?: boolean; project?: unknown } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'xag-')));
  const root = join(base, 'profile');
  const config = join(root, '.gemini', 'config');
  const project = join(base, 'project');
  const dataDir = join(base, 'data');
  mkdirSync(config, { recursive: true });
  mkdirSync(join(project, '.agents'), { recursive: true });
  mkdirSync(dataDir);
  if (o.foreign !== false) copyFileSync(join(FIX, 'foreign.json'), join(config, 'hooks.json'));
  if (o.project !== undefined) writeFileSync(join(project, '.agents', 'hooks.json'), JSON.stringify(o.project, null, 2));
  const forwarder = join(base, 'forwarder');
  writeFileSync(forwarder, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  deployShim(dataDir, { hook: join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder });
  const opts = { dataDir, profileKey: 'p1', profileHome: root, project, bounds: { root, denied: [] } };
  return { base, root, config, project, dataDir, opts, file: join(config, 'hooks.json') };
}
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, Record<string, unknown[]>>;
/** The structural shape of a group: per event, the keys of each entry and of each nested hook. */
const shapeOf = (group: Record<string, unknown[]>) => Object.fromEntries(Object.entries(group).map(([ev, list]) => [ev,
  list.map((e) => {
    const x = e as Record<string, unknown>;
    return Array.isArray(x['hooks']) ? { keys: Object.keys(x).sort(), hooks: (x['hooks'] as Record<string, unknown>[]).map((h) => Object.keys(h).sort()) } : { keys: Object.keys(x).sort() };
  })]));

test('install keeps every foreign byte and adds one xaibo group in the recorded P2-T00 shape; hook lint passes', () => {
  const h = sandbox();
  const foreign = readFileSync(h.file, 'utf8');
  installAgyHooks(h.opts);
  const doc = json(h.file);
  assert.deepEqual(doc['other-tool'], JSON.parse(foreign)['other-tool'], 'the foreign group is unchanged');
  assert.deepEqual(Object.keys(doc).sort(), ['other-tool', 'xaibo']);
  const recorded = json(join(FIX, 'recorded-shape.json'))['recorder']!;
  assert.deepEqual(shapeOf(doc['xaibo']!), shapeOf(recorded), 'same events, entry forms and keys as the recorded shape');
  assert.deepEqual([...AGY_HOOK_EVENTS].sort(), Object.keys(recorded).sort());
  const shim = shimPath(h.dataDir);
  assert.deepEqual(lintHooks({ xaibo: doc['xaibo'] }, { shim, asyncRequired: false }), []);
  const commands = JSON.stringify(doc['xaibo']).match(/"command":"[^"]*"/g)!;
  assert.equal(commands.length, 6);
  for (const c of commands) assert.equal(c, `"command":${JSON.stringify(`'${shim}' hook agy p1`)}`);
  assert.ok(!JSON.stringify(doc['xaibo']).includes('async'), 'async is unverified for agy: never written');
  assert.ok(!existsSync(join(h.project, '.agents', 'hooks.json')), 'the project file is never written');
});

test('revert restores the original bytes; a file Xaibo created is removed', () => {
  const h = sandbox();
  const before = readFileSync(h.file);
  const entry = installAgyHooks(h.opts);
  assert.equal(revert(entry, { dataDir: h.dataDir, bounds: h.opts.bounds }).result, 'restored');
  assert.deepEqual(readFileSync(h.file), before);
  const fresh = sandbox({ foreign: false });
  const e2 = installAgyHooks(fresh.opts);
  assert.ok(existsSync(fresh.file));
  assert.equal(revert(e2, { dataDir: fresh.dataDir, bounds: fresh.opts.bounds }).result, 'removed');
  assert.ok(!existsSync(fresh.file));
});

test('only <profile>/.gemini/config/hooks.json changes', () => {
  const h = sandbox({ project: { tool: { Stop: [{ type: 'command', command: '/tmp/xaibo-fixture/tools/stop.sh', timeout: 10 }] } } });
  const profileBefore = snapshot(h.root);
  const projectBefore = snapshot(h.project);
  installAgyHooks(h.opts);
  const profileAfter = snapshot(h.root);
  assert.deepEqual(Object.keys(profileAfter).sort(), Object.keys(profileBefore).sort());
  for (const f of Object.keys(profileBefore)) if (f !== join('.gemini', 'config', 'hooks.json')) assert.equal(profileAfter[f], profileBefore[f], f);
  assert.deepEqual(snapshot(h.project), projectBefore, 'a foreign project file is inspected, never changed');
});

test('duplicate Xaibo registration is refused: again, already in the profile file, or in the project file', () => {
  const h = sandbox();
  installAgyHooks(h.opts);
  assert.equal(code(() => installAgyHooks(h.opts)), 'duplicate', 'a second install');

  const g = sandbox();
  const shim = shimPath(g.dataDir);
  writeFileSync(g.file, JSON.stringify({ mine: { Stop: [{ type: 'command', command: `'${shim}' hook agy other`, timeout: 10 }] } }));
  const bytes = readFileSync(g.file);
  assert.equal(code(() => installAgyHooks(g.opts)), 'duplicate', 'the shim already runs from the profile file');
  assert.deepEqual(readFileSync(g.file), bytes);

  const n = sandbox();
  writeFileSync(n.file, JSON.stringify({ xaibo: { Stop: [] } }));
  assert.equal(code(() => installAgyHooks(n.opts)), 'duplicate', 'a group named xaibo is never replaced');

  const p = sandbox();
  const pshim = shimPath(p.dataDir);
  const projectHooks = { xaibo: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `'${pshim}' hook agy p1`, timeout: 10 }] }] } };
  writeFileSync(join(p.project, '.agents', 'hooks.json'), JSON.stringify(projectHooks));
  const projectBytes = readFileSync(join(p.project, '.agents', 'hooks.json'));
  const profileBytes = readFileSync(p.file);
  assert.equal(code(() => installAgyHooks(p.opts)), 'duplicate', 'Xaibo already runs from the project file');
  assert.deepEqual(readFileSync(join(p.project, '.agents', 'hooks.json')), projectBytes);
  assert.deepEqual(readFileSync(p.file), profileBytes);
  assert.equal(readManifest(p.dataDir).length, 0);
});

test('review: duplicates are found whatever the quoting or data-dir spelling; unreadable or odd project files refuse', () => {
  for (const command of ['/tmp/xaibo-fixture/elsewhere/integrations/bin/xaibo-hook hook agy p9', 'exec "/tmp/xaibo-fixture/x/integrations/bin/xaibo-hook" hook agy p1']) {
    const h = sandbox();
    writeFileSync(h.file, JSON.stringify({ mine: { Stop: [{ type: 'command', command, timeout: 10 }] } }));
    assert.equal(code(() => installAgyHooks(h.opts)), 'duplicate', command);
  }
  const g = sandbox();
  writeFileSync(g.file, JSON.stringify({ xaibo: { Stop: [{ type: 'command', command: '/tmp/xaibo-fixture/tools/other.sh', timeout: 10 }] } }));
  assert.equal(code(() => installAgyHooks(g.opts)), 'duplicate', 'a non-empty foreign group named xaibo');

  const bad = sandbox();
  writeFileSync(bad.file, '{not json');
  assert.equal(code(() => installAgyHooks(bad.opts)), 'invalid-json', 'an unparsable profile file');
  const badProject = sandbox();
  writeFileSync(join(badProject.project, '.agents', 'hooks.json'), '{not json');
  assert.equal(code(() => installAgyHooks(badProject.opts)), 'invalid-json', 'an unparsable project file cannot be checked');

  const linked = sandbox();
  const real = join(linked.base, 'elsewhere');
  mkdirSync(real);
  writeFileSync(join(real, 'hooks.json'), '{}');
  rmSync(join(linked.project, '.agents'), { recursive: true });
  symlinkSync(real, join(linked.project, '.agents'));
  assert.equal(code(() => installAgyHooks(linked.opts)), 'symlink', 'a symlinked .agents is never followed');

  const gone = sandbox();
  assert.equal(code(() => installAgyHooks({ ...gone.opts, project: join(gone.base, 'no-such-project') })), 'parent-missing');
  const denied = sandbox();
  assert.equal(code(() => installAgyHooks({ ...denied.opts, bounds: { ...denied.opts.bounds, denied: [denied.project] } })), 'denied-root');
  for (const s of [bad, badProject, linked, gone, denied]) assert.equal(readManifest(s.dataDir).length, 0);
});

test('review: dev CLI plan refuses what apply would refuse', () => {
  const h = sandbox();
  const shim = shimPath(h.dataDir);
  writeFileSync(join(h.project, '.agents', 'hooks.json'), JSON.stringify({ x: { Stop: [{ type: 'command', command: `'${shim}' hook agy p1`, timeout: 10 }] } }));
  const env = { PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), XAIBO_DATA_DIR: h.dataDir, SHELL: '/bin/sh', ELECTRON_RUN_AS_NODE: '1' };
  const r = spawnSync(process.execPath, [join(REPO, 'src', 'service', 'config', 'dev-cli.ts'), 'plan', '--target', 'agy-hooks', '--profile', h.root, '--profile-key', 'p1', '--project', h.project], { encoding: 'utf8', env, input: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already installed/);
  assert.doesNotMatch(r.stdout, /\/xaibo =/);
});

test('the shim must be deployed; a profile key that could reach a path or shell is refused', () => {
  const h = sandbox();
  const missing = { ...h.opts, dataDir: join(h.base, 'empty-data') };
  mkdirSync(missing.dataDir);
  assert.equal(code(() => installAgyHooks(missing)), 'shim-missing');
  for (const k of ['..', 'a b', "x'y", 'a/b']) assert.equal(code(() => agyHookOps(shimPath(h.dataDir), k)), 'ops', k);
});

test('dev CLI: plan, apply and revert through --target agy-hooks (disposable profile, --yes)', () => {
  const h = sandbox({ project: {} });
  const env = { PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), XAIBO_DATA_DIR: h.dataDir, SHELL: '/bin/sh', ELECTRON_RUN_AS_NODE: '1' };
  const cli = (args: string[]) => spawnSync(process.execPath, [join(REPO, 'src', 'service', 'config', 'dev-cli.ts'), ...args], { encoding: 'utf8', env, input: '' });
  const common = ['--target', 'agy-hooks', '--profile', h.root];
  const before = readFileSync(h.file);
  const planned = cli(['plan', ...common, '--profile-key', 'p1', '--project', h.project]);
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /\+ \/xaibo = /);
  assert.deepEqual(readFileSync(h.file), before, 'plan writes nothing');
  const applied = cli(['apply', ...common, '--profile-key', 'p1', '--project', h.project, '--forwarder', join(h.base, 'forwarder'), '--yes']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.ok(json(h.file)['xaibo']);
  const reverted = cli(['revert', ...common, '--yes']);
  assert.equal(reverted.status, 0, reverted.stderr);
  assert.deepEqual(readFileSync(h.file), before);
});

test('G3a-2: installAgyHooks applies the previewed plan, so an edit between preview and confirmation aborts (EC-48)', () => {
  const h = sandbox();
  const { file, ops } = checkAgyInstall(h.opts);
  const p = plan(file, 'agy-hooks', ops, h.opts.bounds);
  const doc = json(h.file);
  writeFileSync(h.file, `${JSON.stringify({ ...doc, edited: true }, null, 2)}\n`);
  const edited = readFileSync(h.file);
  assert.equal(code(() => installAgyHooks(h.opts, p)), 'changed');
  assert.deepEqual(readFileSync(h.file), edited, 'the edit is kept');
  assert.deepEqual(readManifest(h.dataDir), []);
});
