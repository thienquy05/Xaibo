// XAIBO-PROD-318 (P3-T14; EC-28, FR-45, S-31; design review 1074): the claude-tee route and the service side. Install
// goes through the FR-32 engine into a disposable settings.json: an existing command statusLine keeps every key but its
// command (padding, refreshInterval), an absent one is added; revert is byte-identical or leaves a foreign edit as a
// conflict. The installed command really runs the original through the tee. Intake stores a Claude `statusline`
// envelope as source statusline, allowlisted fields only, once per change per session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { teeCommand } from '../../src/forwarder/statusline-tee.ts';
import { deployShim, installTee, teePlan } from '../../src/service/adapters/claude/setup.ts';
import { apply, ConfigError, readManifest, revert } from '../../src/service/config/transaction.ts';
import { envelope, hookStore, SESSION } from '../helpers/hook-store.ts';

const REPO = join(import.meta.dirname, '..', '..');
const FIX = join(REPO, 'test', 'fixtures', 'synthetic', 'config', 'claude-settings', 'custom-statusline.json');
const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return e instanceof ConfigError ? e.code : String(e); } };

function sandbox(settings: string | null = FIX) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'xst-')));
  const root = join(base, 'profile');
  const configDir = join(root, '.claude');
  const dataDir = join(base, 'data');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir);
  if (settings) copyFileSync(settings, join(configDir, 'settings.json'));
  const noop = join(base, 'noop');
  writeFileSync(noop, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // the tee as the dev runtime runs it (the SEA in the package); ELECTRON_RUN_AS_NODE as in installShim
  const statusline = join(base, 'statusline');
  writeFileSync(statusline, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO, 'src', 'forwarder', 'statusline-tee.ts'))} "$@"\n`, { mode: 0o755 });
  deployShim(dataDir, { hook: join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder: noop, statusline });
  const opts = { dataDir, profileKey: 'p1', configDir, bounds: { root, denied: [] } };
  return { base, root, configDir, dataDir, opts, file: join(configDir, 'settings.json') };
}
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, Record<string, unknown>>;

test('install replaces only statusLine.command; padding, refreshInterval and every other key stay; the manifest keeps the original', () => {
  const h = sandbox();
  const doc = json(h.file);
  doc['statusLine']!['refreshInterval'] = 5;
  writeFileSync(h.file, `${JSON.stringify(doc, null, 4)}\n`);
  const entry = installTee(h.opts);
  const after = json(h.file);
  assert.deepEqual(after['statusLine'], { type: 'command', command: teeCommand(h.dataDir, 'p1'), padding: 0, refreshInterval: 5 });
  assert.equal(after['model'], doc['model']);
  assert.equal(entry.route, 'claude-tee');
  assert.deepEqual(entry.owned, [{ pointer: '/statusLine/command', value: teeCommand(h.dataDir, 'p1'), old: '/tmp/xaibo-fixture/tools/status.sh' }]);
  assert.ok(existsSync(join(h.dataDir, 'integrations', 'bin', 'xaibo-statusline')));
});

test('the installed command runs the original through the tee: same bytes and exit as the original alone', () => {
  const h = sandbox();
  const original = "printf 'ORIG \\033[1m%s\\033[0m' ok; printf e >&2; exit 3";
  const doc = json(h.file);
  doc['statusLine']!['command'] = original;
  writeFileSync(h.file, JSON.stringify(doc, null, 2));
  installTee(h.opts);
  const installed = json(h.file)['statusLine']!['command'] as string;
  const input = JSON.stringify({ session_id: 'synthetic-session', model: { id: 'synthetic-model' } });
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const viaTee = spawnSync('/bin/sh', ['-c', installed], { input, env, timeout: 10_000 });
  const alone = spawnSync('/bin/sh', ['-c', original], { input, env });
  assert.ok(viaTee.stdout.equals(alone.stdout), viaTee.stdout.toString());
  assert.ok(viaTee.stderr.equals(alone.stderr), viaTee.stderr.toString());
  assert.equal(viaTee.status, 3);
});

test('a concurrent edit before the rename aborts and keeps the foreign edit (EC-28, EC-48)', () => {
  const h = sandbox();
  const p = teePlan(h.opts);
  writeFileSync(h.file, '{"statusLine":{"type":"command","command":"printf foreign"}}\n');
  assert.equal(code(() => apply(p, { dataDir: h.dataDir, bounds: h.opts.bounds })), 'changed');
  assert.equal(readFileSync(h.file, 'utf8'), '{"statusLine":{"type":"command","command":"printf foreign"}}\n');
  assert.deepEqual(readManifest(h.dataDir), []);
});

test('revert restores the original bytes', () => {
  const h = sandbox();
  const before = readFileSync(h.file);
  const entry = installTee(h.opts);
  assert.equal(revert(entry, { dataDir: h.dataDir, bounds: h.opts.bounds }).result, 'restored');
  assert.deepEqual(readFileSync(h.file), before);
  assert.deepEqual(readManifest(h.dataDir), []);
});

test('a foreign edit of the command after install is a conflict on revert and stays', () => {
  const h = sandbox();
  const entry = installTee(h.opts);
  const doc = json(h.file);
  doc['statusLine']!['command'] = 'printf mine';
  doc['theme'] = 'dark' as never;
  writeFileSync(h.file, JSON.stringify(doc, null, 2));
  const r = revert(entry, { dataDir: h.dataDir, bounds: h.opts.bounds });
  assert.deepEqual(r.conflicts, [{ pointer: '/statusLine/command' }]);
  assert.equal(json(h.file)['statusLine']!['command'], 'printf mine');
  assert.equal(json(h.file)['theme'], 'dark' as never);
});

test('an absent statusLine is added as a command statusLine and removed again; a missing file is created and removed', () => {
  const h = sandbox(null);
  writeFileSync(h.file, '{\n  "model": "claude-sonnet-5-5"\n}\n');
  const before = readFileSync(h.file);
  const entry = installTee(h.opts);
  assert.deepEqual(json(h.file)['statusLine'], { type: 'command', command: teeCommand(h.dataDir, 'p1') });
  assert.equal(revert(entry, { dataDir: h.dataDir, bounds: h.opts.bounds }).result, 'restored');
  assert.deepEqual(readFileSync(h.file), before);
  const fresh = sandbox(null);
  const e2 = installTee(fresh.opts);
  assert.equal(revert(e2, { dataDir: fresh.dataDir, bounds: fresh.opts.bounds }).result, 'removed');
  assert.ok(!existsSync(fresh.file));
});

test('refusals: a second install, a statusLine already running the tee, a non-command statusLine, no deployed tee', () => {
  const h = sandbox();
  installTee(h.opts);
  assert.equal(code(() => teePlan(h.opts)), 'duplicate');
  const copy = sandbox();
  writeFileSync(copy.file, JSON.stringify({ statusLine: { type: 'command', command: `'/x/integrations/bin/xaibo-statusline' '/x' p9` } }));
  assert.equal(code(() => teePlan(copy.opts)), 'duplicate');
  for (const s of [{ type: 'static', text: 'x' }, { type: 'command' }, 'printf x', ['printf']]) {
    const odd = sandbox();
    writeFileSync(odd.file, JSON.stringify({ statusLine: s }));
    assert.equal(code(() => teePlan(odd.opts)), 'statusline', JSON.stringify(s));
  }
  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'xst-')));
  mkdirSync(join(bare, '.claude'));
  copyFileSync(FIX, join(bare, '.claude', 'settings.json'));
  assert.equal(code(() => installTee({ dataDir: join(bare, 'data'), profileKey: 'p1', configDir: join(bare, '.claude'), bounds: { root: bare, denied: [] } })), 'shim-missing');
  assert.equal(code(() => teePlan({ ...h.opts, dataDir: `${h.dataDir}'x` })), 'ops', 'a data dir the command cannot quote is a refusal code (review L6)');
});

test('intake stores a Claude statusline envelope as source statusline with allowlisted fields, once per change', async () => {
  const s = await hookStore();
  const canary = 'canary-statusline-path';
  const payload = { session_id: SESSION, model: { id: 'synthetic-model', display_name: 'Synthetic' }, effort: { level: 'high' },
    cost: { total_cost_usd: 0.25 }, rate_limits: { five_hour: { used_percentage: 10, resets_at: 1767225600 } },
    transcript_path: `/tmp/${canary}`, cwd: `/tmp/${canary}`, workspace: { current_dir: canary } };
  const tee = (p: Record<string, unknown>, o: Record<string, unknown> = {}) => envelope({ event: 'statusline', cwd: null, payload: p, ...o });
  const rows = () => s.db.prepare("SELECT source, kind, raw FROM events WHERE source = 'statusline' ORDER BY id").all() as { source: string; kind: string; raw: string }[];
  assert.equal((await s.intake.deliver(tee(payload))).status, 'accepted');
  assert.equal((await s.intake.deliver(tee(payload))).status, 'accepted', 'an unchanged redraw is acked');
  assert.equal(rows().length, 1, 'an unchanged redraw stores nothing (review M3)');
  await s.intake.deliver(tee({ ...payload, cost: { total_cost_usd: 0.5 } }));
  assert.equal(rows().length, 2);
  const raw = JSON.parse(rows()[0]!.raw);
  assert.deepEqual(raw, { session_id: SESSION, model: { id: 'synthetic-model', display_name: 'Synthetic' }, effort: { level: 'high' },
    cost: { total_cost_usd: 0.25 }, rate_limits: { five_hour: { used_percentage: 10, resets_at: 1767225600 } } });
  assert.equal(rows()[0]!.kind, 'statusline');
  const all = JSON.stringify(s.db.prepare('SELECT * FROM events').all()) + JSON.stringify(s.db.prepare('SELECT * FROM sessions').all());
  assert.ok(!all.includes(canary), 'paths and workspace never reach the store');
  assert.equal((s.db.prepare('SELECT count(*) AS n FROM hook_delivery').get() as { n: number }).n, 0, 'redraws add no delivery rows');
});

test('intake: a statusline with a cwd takes the hook path; an invalid one stores nothing', async () => {
  const s = await hookStore();
  const count = (src: string) => (s.db.prepare('SELECT count(*) AS n FROM events WHERE source = ?').get(src) as { n: number }).n;
  await s.intake.deliver(envelope({ event: 'statusline', payload: { hook_event_name: 'statusline', session_id: SESSION, cost: { total_cost_usd: 1 } } }));
  assert.equal(count('statusline'), 0, 'a hook-path envelope (cwd set) is never a statusline snapshot (review L1)');
  assert.equal(count('hook'), 1);
  assert.equal((await s.intake.deliver(envelope({ event: 'statusline', cwd: null, payload: null }))).status, 'accepted');
  assert.equal((await s.intake.deliver(envelope({ event: 'statusline', cwd: null, session_id: null, payload: { cost: { total_cost_usd: 1 } } }))).status, 'accepted');
  assert.equal(count('statusline'), 0, 'no record or no session: nothing stored');
});

test('dev CLI: claude-tee --profile-key plans, installs (deploying the tee), reverts byte-identical', () => {
  const h = sandbox();
  const before = readFileSync(h.file);
  const sh = join(h.base, 'fake-shell');
  writeFileSync(sh, "#!/bin/sh\nprintf 'PATH=/usr/bin:/bin\\000'\n", { mode: 0o700 });
  mkdirSync(join(h.base, 'home'));
  const dataDir = join(h.base, 'cli-data');
  mkdirSync(dataDir);
  // ELECTRON_RUN_AS_NODE: under test:electron the exec path is Electron, which must run the CLI as Node
  const env = { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), HOME: join(h.base, 'home'), XAIBO_DATA_DIR: dataDir, SHELL: sh };
  const cli = (args: string[]) => spawnSync(process.execPath, [join(REPO, 'src', 'service', 'config', 'dev-cli.ts'), ...args, '--target', 'claude-tee', '--profile', h.root], { encoding: 'utf8', env, input: '', timeout: 30_000 });
  const p = cli(['plan', '--profile-key', 'p1']);
  assert.equal(p.status, 0, p.stderr);
  assert.ok(p.stdout.includes(`+ /statusLine/command = ${JSON.stringify(teeCommand(dataDir, 'p1'))}`), p.stdout);
  assert.deepEqual(readFileSync(h.file), before);
  const a = cli(['apply', '--profile-key', 'p1', '--forwarder', join(h.base, 'noop'), '--statusline', join(h.base, 'statusline'), '--yes']);
  assert.equal(a.status, 0, a.stderr);
  assert.ok(existsSync(join(dataDir, 'integrations', 'bin', 'xaibo-statusline')));
  assert.equal(json(h.file)['statusLine']!['command'], teeCommand(dataDir, 'p1'));
  const r = cli(['revert', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(h.file), before);
});

test('intake: unknown profile and a payload session that differs from the envelope store nothing; times are the service clock', async () => {
  const s = await hookStore({ intake: { now: () => 5_000 } });
  const count = () => (s.db.prepare("SELECT count(*) AS n FROM events WHERE source = 'statusline'").get() as { n: number }).n;
  const p = { session_id: SESSION, cost: { total_cost_usd: 1 } };
  await s.intake.deliver(envelope({ event: 'statusline', cwd: null, profile_key: 'nope', payload: p }));
  await s.intake.deliver(envelope({ event: 'statusline', cwd: null, session_id: 'other-session', payload: p }));
  assert.equal(count(), 0);
  await s.intake.deliver(envelope({ event: 'statusline', cwd: null, payload: p, received_ts: 9_999_999_999_999 }));
  const row = s.db.prepare("SELECT received_ts, source_seq FROM events WHERE source = 'statusline'").get() as { received_ts: number; source_seq: number };
  assert.deepEqual([row.received_ts, row.source_seq], [5_000, 5_000], 'a sender-chosen time never orders rows (review L7)');
});

test('intake: a disk-full commit is rejected and the same snapshot is stored once the store accepts writes', async () => {
  let full = true;
  const diskFull = () => Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
  const { commitBatch } = await import('../../src/service/store/writer.ts');
  const s = await hookStore({ writer: { commit: (db, b) => { if (full) throw diskFull(); commitBatch(db, b); } } });
  const e = () => envelope({ event: 'statusline', cwd: null, payload: { session_id: SESSION, cost: { total_cost_usd: 1 } } });
  assert.deepEqual(await s.intake.deliver(e()), { status: 'rejected', code: 'disk-full' });
  full = false;
  assert.deepEqual(await s.intake.deliver(e()), { status: 'accepted', code: 'ok' }, 'the failed snapshot was never marked stored');
  assert.deepEqual(await s.intake.deliver(e()), { status: 'accepted', code: 'unchanged' });
});

test('G3a-2: installTee applies the previewed plan, so an edit between preview and confirmation aborts (EC-48)', () => {
  const h = sandbox();
  const p = teePlan(h.opts);
  const doc = json(h.file);
  doc['statusLine']!['command'] = 'printf edited-after-preview';
  writeFileSync(h.file, `${JSON.stringify(doc, null, 2)}\n`);
  const edited = readFileSync(h.file);
  assert.equal(code(() => installTee(h.opts, p)), 'changed');
  assert.deepEqual(readFileSync(h.file), edited, 'the edit is kept');
  assert.deepEqual(readManifest(h.dataDir), []);
});
