// P6-T06 (EC-72; US-7, EC-09): a third-party hook tool (agent-flow style: synthetic command hooks on several Claude events
// and Codex, plus an HTTP hook to a bare origin) coexists with Xaibo. After Connect, agent-flow rewrites, reorders or
// removes its own entries: Xaibo's entries stay exactly as written, a synthetic hook fired through each of them still reaches
// Xaibo's forwarder, reconcile keeps them connected, and nothing is shared (Xaibo runs its own data-dir shim, never an HTTP
// hook or agent-flow's path). Disconnect afterwards removes only Xaibo's entries and leaves agent-flow's as they now are.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnect, type ConnectContext } from '../../../src/service/integrations/connect.ts';
import { claudeContext } from '../../helpers/fake-claude.ts';
import type { Profile } from '../../../src/service/catalog/detect.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const FWD = join(REPO, 'src', 'forwarder', 'forwarder.ts');
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const iso = mkdtempSync(join(tmpdir(), 'xflow-env-'));
dirs.push(iso);
for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR']) process.env[k] = join(iso, k.toLowerCase());

type Doc = { hooks: Record<string, unknown[]>; [k: string]: unknown };
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Doc;
const put = (f: string, v: unknown) => writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);
const flow = (ev: string, v = 'v1') => ({ matcher: '*', hooks: [{ type: 'command', command: `node /opt/agent-flow/${v}/hook.js ${ev}`, async: true }] });
const FLOW_HTTP = { hooks: [{ type: 'http', url: 'http://127.0.0.1' }] }; // a bare-origin URL hook: never Xaibo's
const CLAUDE = { theme: 'dark', hooks: { PreToolUse: [flow('PreToolUse')], PostToolUse: [flow('PostToolUse')], Stop: [flow('Stop'), FLOW_HTTP], SessionStart: [flow('SessionStart')] } };
const CODEX = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /opt/agent-flow/v1/hook.js codex-stop' }] }] } };
const isXaibo = (g: unknown) => JSON.stringify(g).includes('xaibo-hook');
const xaiboGroups = (d: Doc) => Object.fromEntries(Object.entries(d.hooks).map(([ev, gs]) => [ev, gs.filter(isXaibo)]));
/** agent-flow's groups per event; events left with none are omitted (Disconnect drops the arrays Xaibo created). */
const flowGroups = (d: Doc) => Object.fromEntries(Object.entries(d.hooks).map(([ev, gs]) => [ev, gs.filter((g) => !isXaibo(g))]).filter(([, gs]) => (gs as unknown[]).length));
function commands(doc: unknown, out: string[] = []): string[] {
  if (Array.isArray(doc)) doc.forEach((x) => commands(x, out));
  else if (doc && typeof doc === 'object') {
    const o = doc as Record<string, unknown>;
    if (o['type'] === 'command' && typeof o['command'] === 'string' && o['command'].includes('xaibo-hook')) out.push(o['command']);
    else Object.values(o).forEach((x) => commands(x, out));
  }
  return out;
}

async function world() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xflow-')));
  dirs.push(base);
  const home = join(base, 'home'), claudeDir = join(home, '.claude'), codexDir = join(home, '.codex');
  const bundle = join(base, 'bundle'), dataDir = join(base, 'data'), managed = join(base, 'managed');
  for (const d of [claudeDir, codexDir, bundle, dataDir, managed]) mkdirSync(d, { recursive: true, mode: 0o755 });
  const files = { claude: join(claudeDir, 'settings.json'), codex: join(codexDir, 'hooks.json') };
  put(files.claude, CLAUDE);
  put(files.codex, CODEX);
  for (const h of ['xaibo-hook', 'xaibo-report']) copyFileSync(join(REPO, 'src', 'forwarder', h), join(bundle, h));
  writeFileSync(join(bundle, 'xaibo-forwarder'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FWD)} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bundle, 'xaibo-statusline'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const ctx: ConnectContext = { ...await claudeContext(), dataDir, denied: [join(base, 'real')], allowed: [base], claudeManagedDir: managed,
    helpers: { hook: join(bundle, 'xaibo-hook'), forwarder: join(bundle, 'xaibo-forwarder'), statusline: join(bundle, 'xaibo-statusline') } };
  const c = createConnect(ctx);
  const profiles: Profile[] = [{ id: 'claude-1', agent: 'claude', root: claudeDir, origin: 'default' }, { id: 'codex-1', agent: 'codex', root: codexDir, origin: 'default' }];
  for (const p of profiles) {
    const pv = c.previewConnect(p, { retention: false, tee: false });
    assert.equal(pv.status, 'preview', JSON.stringify(pv));
    assert.equal((await c.applyConnect(pv.status === 'preview' ? pv.previewId : '')).status, 'applied');
  }
  const spooled = () => (existsSync(join(dataDir, 'spool'))
    ? readdirSync(join(dataDir, 'spool')).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(dataDir, 'spool', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { agent: string; profile_key: string }))
    : []);
  /** A synthetic hook fired through every Xaibo command now in the files, as the agent runs it. */
  const fire = () => {
    const cmds = [files.claude, files.codex].flatMap((f) => commands(json(f)));
    const before = spooled().length;
    for (const cmd of cmds) {
      const r = spawnSync('/bin/sh', ['-c', cmd], { input: JSON.stringify({ session_id: '00000000-0000-4000-8000-0000000f0072', cwd: '/tmp/xaibo-fixture/flow', hook_event_name: 'Stop' }), env: { PATH: '/usr/bin:/bin', HOME: home }, timeout: 15_000 });
      assert.equal(r.status, 0);
      assert.equal(r.stdout.length + r.stderr.length, 0);
    }
    return { cmds, got: spooled().slice(before).map((e) => [e.agent, e.profile_key]) };
  };
  return { base, home, dataDir, files, ctx, c, profiles, fire };
}
type W = Awaited<ReturnType<typeof world>>;
const reconciled = (w: W) => { const r = w.c.reconcile(w.profiles); return r.status === 'ready' ? r.entries.map((e) => [e.route, e.state]) : r; };

/** agent-flow's own edits: a new version path everywhere, its groups moved in front of Xaibo's, a new event, the HTTP hook dropped. */
function rewrite(w: W) {
  const c = json(w.files.claude);
  const hooks = Object.fromEntries(Object.entries(c.hooks).map(([ev, gs]) => [ev, [...gs.filter((g) => !isXaibo(g) && g !== undefined && !JSON.stringify(g).includes('"http"')).map(() => flow(ev, 'v2')), ...gs.filter(isXaibo)]]));
  put(w.files.claude, { ...c, hooks: { ...hooks, Notification: [flow('Notification', 'v2'), ...(hooks['Notification'] ?? [])] } });
  const x = json(w.files.codex);
  put(w.files.codex, { hooks: { ...x.hooks, Stop: [{ hooks: [{ type: 'command', command: 'node /opt/agent-flow/v2/hook.js codex-stop' }] }, ...x.hooks['Stop']!.filter(isXaibo)] } });
}
/** agent-flow uninstalls itself: only its own entries go. */
function remove(w: W) {
  for (const f of [w.files.claude, w.files.codex]) { const d = json(f); put(f, { ...d, hooks: xaiboGroups(d) }); }
}

test('EC-72: agent-flow rewrites, then removes, its hooks: Xaibo\'s entries unchanged, still delivered, still connected; nothing shared', async () => {
  const w = await world();
  const mine = { claude: xaiboGroups(json(w.files.claude)), codex: xaiboGroups(json(w.files.codex)) };
  const first = w.fire();
  assert.ok(first.cmds.length >= 2);
  assert.ok(first.cmds.every((cmd) => cmd.includes(join(w.dataDir, 'integrations', 'bin', 'xaibo-hook')) && !cmd.includes('agent-flow')), 'Xaibo runs its own data-dir shim');
  assert.ok(!JSON.stringify(mine).includes('"http"'), 'never an HTTP (bare-origin) hook');
  assert.deepEqual(first.got, first.cmds.map((cmd) => (cmd.includes(' hook codex ') ? ['codex', 'codex-1'] : ['claude', 'claude-1'])));
  for (const step of [rewrite, remove]) {
    step(w);
    const strip = (d: Record<string, unknown[]>) => Object.fromEntries(Object.entries(d).filter(([, gs]) => gs.length));
    assert.deepEqual(strip(xaiboGroups(json(w.files.claude))), strip(mine.claude), `${step.name}: Xaibo's Claude groups unchanged`);
    assert.deepEqual(strip(xaiboGroups(json(w.files.codex))), strip(mine.codex), `${step.name}: Xaibo's Codex groups unchanged`);
    const r = w.fire();
    assert.equal(r.got.length, first.cmds.length, `${step.name}: every Xaibo hook still delivers`);
    assert.deepEqual(reconciled(w), [['claude-settings-fallback', 'connected'], ['codex-hooks', 'connected']], `${step.name}: reconcile does not flag it`);
  }
});

test('EC-72 + US-7: after agent-flow rewrites its hooks, Disconnect removes only Xaibo\'s and leaves agent-flow\'s as they now are', async () => {
  const w = await world();
  rewrite(w);
  const theirs = { claude: flowGroups(json(w.files.claude)), codex: flowGroups(json(w.files.codex)) };
  for (const p of w.profiles) {
    const d = await w.c.disconnect(p);
    assert.equal(d.status, 'disconnected', JSON.stringify(d));
  }
  assert.ok(!readFileSync(w.files.claude, 'utf8').includes('xaibo-hook') && !readFileSync(w.files.codex, 'utf8').includes('xaibo-hook'));
  assert.deepEqual(flowGroups(json(w.files.claude)), theirs.claude);
  assert.deepEqual(json(w.files.claude)['theme'], 'dark');
  assert.deepEqual(flowGroups(json(w.files.codex)), theirs.codex);
});

test('EC-72: a moved Xaibo group with an identical copy beside it is a conflict: both kept, nothing guessed', async () => {
  const w = await world();
  const c = json(w.files.claude);
  const mine = c.hooks['Stop']!.filter(isXaibo);
  assert.equal(mine.length, 1);
  put(w.files.claude, { ...c, hooks: { ...c.hooks, Stop: [mine[0], structuredClone(mine[0])] } }); // agent-flow's two gone, Xaibo's copied
  const d = await w.c.disconnect(w.profiles[0]!);
  assert.equal(d.status, 'partial', JSON.stringify(d));
  assert.deepEqual(d.status === 'partial' && d.conflicts.map((x) => x.pointer), ['/hooks/Stop/2']);
  assert.equal(json(w.files.claude).hooks['Stop']!.length, 2, 'both copies kept');
  const now = json(w.files.claude);
  put(w.files.claude, { ...now, hooks: { ...now.hooks, Stop: [now.hooks['Stop']![1]] } }); // the copy goes
  assert.equal((await w.c.disconnect(w.profiles[0]!)).status, 'disconnected', 'review R3: a retry after the partial revert finds it');
  assert.ok(!readFileSync(w.files.claude, 'utf8').includes('xaibo-hook'));
});

test('EC-72 review R5: a moved Xaibo group the owner edited, or a removed event array, is a conflict at the recorded pointer; nothing removed there', async () => {
  const w = await world();
  rewrite(w); // Xaibo's Stop group moves from index 2 to 1, its Notification group from 0 to 1
  const c = json(w.files.claude);
  const stop = c.hooks['Stop']!.map((g) => (isXaibo(g) ? { ...(g as object), edited: true } : g));
  const hooks = { ...c.hooks };
  delete hooks['Notification'];
  put(w.files.claude, { ...c, hooks: { ...hooks, Stop: stop } });
  const d = await w.c.disconnect(w.profiles[0]!);
  assert.equal(d.status, 'partial', JSON.stringify(d));
  assert.deepEqual(d.status === 'partial' && d.conflicts.map((x) => x.pointer).sort(), ['/hooks/Notification/0', '/hooks/Stop/2']);
  assert.ok(json(w.files.claude).hooks['Stop']!.some((g) => isXaibo(g) && JSON.stringify(g).includes('"edited":true')), 'the edited group is kept');
  const left = xaiboGroups(json(w.files.claude));
  assert.deepEqual(Object.entries(left).filter(([, gs]) => gs.length).map(([ev]) => ev), ['Stop'], 'code review 3: every other Xaibo group went');
});

test('EC-72 code review 1: Codex stays positional (S5-C5): a foreign group removed before Xaibo\'s is a conflict, nothing removed there', async () => {
  const w = await world();
  const x = json(w.files.codex);
  put(w.files.codex, { hooks: { ...x.hooks, Stop: x.hooks['Stop']!.filter(isXaibo) } }); // Xaibo's Stop group moves 1 -> 0
  const d = await w.c.disconnect(w.profiles[1]!);
  assert.equal(d.status, 'partial', JSON.stringify(d));
  assert.deepEqual(d.status === 'partial' && d.conflicts.map((c) => c.pointer), ['/hooks/Stop/1']);
  assert.equal(json(w.files.codex).hooks['Stop']!.filter(isXaibo).length, 1, 'Codex keys hook trust by position: never moved out');
});
