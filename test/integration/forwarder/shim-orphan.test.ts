// P6-T05 (EC-27; OQ-P6-6): Xaibo removed without Disconnect. After a real Connect of a disposable Claude (settings fallback)
// and Codex profile, the app's bundled helpers are deleted and no service runs. Every hook command Connect wrote, run
// exactly as written through /bin/sh, prints nothing and exits 0 (the deployed shim and forwarder live in the data dir, so
// they still run and spool); with the forwarder deleted too, the shim still prints nothing and exits 0. Deleting the data
// dir itself (the shim with it) is the documented manual-cleanup case (docs/integrations/manual-cleanup.md): no wrapper.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnect, type ConnectContext } from '../../../src/service/integrations/connect.ts';
import { claudeContext } from '../../helpers/fake-claude.ts';
import type { Profile } from '../../../src/service/catalog/detect.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const FWD = join(REPO, 'src', 'forwarder', 'forwarder.ts');
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const iso = mkdtempSync(join(tmpdir(), 'xorphan-env-'));
dirs.push(iso);
for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR']) process.env[k] = join(iso, k.toLowerCase());

const PAYLOAD = JSON.stringify({ session_id: '00000000-0000-4000-8000-0000000f0027', cwd: '/tmp/xaibo-fixture/orphan', hook_event_name: 'Stop', prompt: 'payload-canary' });
/** Every command hook in the doc that runs the Xaibo shim. */
function shimCommands(doc: unknown, out: string[] = []): string[] {
  if (Array.isArray(doc)) doc.forEach((x) => shimCommands(x, out));
  else if (doc && typeof doc === 'object') {
    const o = doc as Record<string, unknown>;
    if (o['type'] === 'command' && typeof o['command'] === 'string' && o['command'].includes('xaibo-hook')) out.push(o['command']);
    else Object.values(o).forEach((x) => shimCommands(x, out));
  }
  return out;
}
const spooled = (dataDir: string) => (existsSync(join(dataDir, 'spool'))
  ? readdirSync(join(dataDir, 'spool')).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(dataDir, 'spool', f), 'utf8').split('\n').filter(Boolean))
  : []);

test('EC-27: helpers bundle deleted, no service, no Disconnect -> every written hook command is silent and exits 0; forwarder gone too -> still silent', async () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'xorphan-')));
  dirs.push(base);
  const home = join(base, 'home'), claudeDir = join(home, '.claude'), codexDir = join(home, '.codex');
  const bundle = join(base, 'Xaibo.app-resources-bin'), dataDir = join(base, 'data'), managed = join(base, 'managed');
  for (const d of [claudeDir, codexDir, bundle, dataDir, managed]) mkdirSync(d, { recursive: true, mode: 0o755 });
  writeFileSync(join(claudeDir, 'settings.json'), `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`);
  writeFileSync(join(codexDir, 'hooks.json'), `${JSON.stringify({ hooks: {} }, null, 2)}\n`);
  // the bundled helpers as the packaged app ships them: the real shims, a forwarder that runs the real forwarder
  for (const h of ['xaibo-hook', 'xaibo-report']) copyFileSync(join(REPO, 'src', 'forwarder', h), join(bundle, h));
  writeFileSync(join(bundle, 'xaibo-forwarder'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FWD)} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bundle, 'xaibo-statusline'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const ctx: ConnectContext = { ...await claudeContext(), dataDir, denied: [join(base, 'real')], allowed: [base], claudeManagedDir: managed,
    helpers: { hook: join(bundle, 'xaibo-hook'), forwarder: join(bundle, 'xaibo-forwarder'), statusline: join(bundle, 'xaibo-statusline') } };
  const c = createConnect(ctx);
  const profiles: Profile[] = [
    { id: 'claude-1', agent: 'claude', root: claudeDir, origin: 'default' },
    { id: 'codex-1', agent: 'codex', root: codexDir, origin: 'default' },
  ];
  for (const p of profiles) {
    const pv = c.previewConnect(p, { retention: false, tee: false });
    assert.equal(pv.status, 'preview', JSON.stringify(pv));
    assert.equal((await c.applyConnect(pv.status === 'preview' ? pv.previewId : '')).status, 'applied');
  }
  rmSync(bundle, { recursive: true }); // Xaibo deleted: the app and its helpers are gone; the data dir stays; nothing runs
  const commands = [join(claudeDir, 'settings.json'), join(codexDir, 'hooks.json')].flatMap((f) => shimCommands(JSON.parse(readFileSync(f, 'utf8'))));
  assert.ok(commands.length >= 2 && commands.every((cmd) => cmd.includes(join(dataDir, 'integrations', 'bin'))), 'hooks name the data dir shim, never the bundle');
  const run = (cmd: string) => spawnSync('/bin/sh', ['-c', cmd], { input: PAYLOAD, env: { PATH: '/usr/bin:/bin', HOME: home }, timeout: 15_000 });
  for (const cmd of commands) {
    const r = run(cmd);
    assert.equal(r.status, 0, cmd);
    assert.equal(r.stdout.length + r.stderr.length, 0, 'no visible output (no tokens, no errors)');
  }
  const after = spooled(dataDir).length;
  assert.equal(after, commands.length, 'each event reached the deployed forwarder and was spooled (no service)');
  unlinkSync(join(dataDir, 'integrations', 'bin', 'xaibo-forwarder')); // the plan's case: the forwarder target is gone
  for (const cmd of commands) {
    const r = run(cmd);
    assert.equal(r.status, 0, cmd);
    assert.equal(r.stdout.length + r.stderr.length, 0);
  }
  assert.equal(spooled(dataDir).length, after, 'nothing more ran');
});
