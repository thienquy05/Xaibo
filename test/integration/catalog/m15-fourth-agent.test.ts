// P6-T09 (M15, EC-78; plan P6-T09, D-P6-12): a synthetic fourth agent through data only. Its catalog entry and report-v1 event
// stream (test/fixtures/synthetic/catalog/fourth-agent, seeded from S11-T8) go through the product paths unchanged: private
// import, root approval, probe and setup grants, granted detection at boot, setup preview and apply through Connect (the
// report-setup route), events sent by the deployed xaibo-report shim with a registration bound to the synced profile, then
// full-content storage, live status and the lifecycle receipt; Disconnect gives the config back byte for byte. Nothing in
// src/ names this agent: if a core path hard-coded agent ids, a step here fails. The helper runs while the service is
// stopped, so its frames spool and the next start replays them (no socket needed; the live path is report-helper.test.ts).
// ponytail: the deployed xaibo-forwarder is a shell wrapper running src/forwarder/forwarder.ts under this Node, not the SEA
// build (the shim's checks, token check, spool and replay are the real ones). Synthetic temp dirs only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../../../src/service/boot.ts';
import { approveRoot, grantProbe, grantSetup, importCatalog } from '../../../src/service/catalog/import.ts';
import { loadCatalog, type Catalog } from '../../../src/service/catalog/validate.ts';
import { deniedRootsFrom } from '../../../src/service/config/bounds.ts';
import { readManifest } from '../../../src/service/config/transaction.ts';
import { createConnect } from '../../../src/service/integrations/connect.ts';
import { answerIntegrationPage, pageEvidence } from '../../../src/service/integrations/state.ts';
import { connectContext } from '../../../src/service/integrations-ipc.ts';
import { addRegistration } from '../../../src/service/receivers/registrations.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const FIX = join(REPO, 'test', 'fixtures', 'synthetic', 'catalog', 'fourth-agent');
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
// AGENTS.md: nothing here may resolve a real agent home or data dir
const iso = mkdtempSync(join(tmpdir(), 'xm15-env-'));
dirs.push(iso);
for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'XAIBO_DATA_DIR']) process.env[k] = join(iso, k.toLowerCase());

// known locations limited to the temp home (as in import.test.ts), so no agent installed on this machine is probed
const bundled: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((a) => ({ ...a, detection: { ...a.detection, locations: ['~/.local/bin'] } })) };
const events = readFileSync(join(FIX, 'events.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as { event: string; session_id: string; item_id?: string; payload: Record<string, unknown> });
// single-name pointers in the fixture: fixture-lint reads any /a/b string as a machine path
const ORIGINAL = `${JSON.stringify({ model: 'synthetic', reportingEnabled: false }, null, 2)}\n`;

function run(cmd: string, args: string[], input: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: { PATH: '/usr/bin:/bin' } });
    let stdout = '', stderr = '';
    c.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
    c.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    c.on('error', reject);
    c.on('close', (status) => resolve({ status, stdout, stderr }));
    c.stdin.end(input);
  });
}

// ponytail (D-P6-25): macOS only. connectContext allows os.tmpdir() as the disposable root; on Linux that is the shared
// /tmp, which writable() refuses by design, so this production-wired test cannot preview there. Revisit with S-23 (Linux).
const m15Skip = process.platform !== 'darwin' && 'the disposable root is the shared /tmp off macOS (S-23)';
test('M15: a fourth agent from data only: import, detect, setup preview/apply, report delivery, full content, status, receipt', { skip: m15Skip }, async () => {
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'xm15-')));
  dirs.push(tmp);
  const home = join(tmp, 'home'), dataDir = join(tmp, 'data'), helpers = join(tmp, 'helpers');
  mkdirSync(home);
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(helpers);
  const shell = join(tmp, 'login-shell');
  writeFileSync(shell, "#!/bin/sh\nprintf 'PATH=/nonexistent-xaibo\\0'\n", { mode: 0o755 });
  const policy = { home, allowed: [tmp], denied: deniedRootsFrom({ PATH: '/nonexistent-xaibo' })! };

  // 1. import and the owner's grants (trusted service calls): root, probe of the declared binary, setup
  assert.deepEqual(importCatalog(dataDir, readFileSync(join(FIX, 'entry.json')), bundled), { status: 'imported', agent: 'synthagent' });
  const root = join(home, '.synthagent');
  mkdirSync(join(root, 'bin'), { recursive: true, mode: 0o755 });
  writeFileSync(join(root, 'config.json'), ORIGINAL);
  const exe = join(root, 'bin', 'synthagent');
  writeFileSync(exe, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
  assert.equal(approveRoot(dataDir, bundled, 'synthagent', 'user', policy), true);
  assert.equal(grantProbe(dataDir, bundled, 'synthagent', 'main', exe, policy), true);
  assert.equal(grantSetup(dataDir, bundled, 'synthagent', policy), true);

  // helpers as main ships them beside each other; the forwarder runs the repo source (see ponytail above)
  copyFileSync(join(REPO, 'src', 'forwarder', 'xaibo-hook'), join(helpers, 'xaibo-hook'));
  copyFileSync(join(REPO, 'src', 'forwarder', 'xaibo-report'), join(helpers, 'xaibo-report'));
  writeFileSync(join(helpers, 'xaibo-forwarder'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${join(REPO, 'src', 'forwarder', 'forwarder.ts')}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(helpers, 'xaibo-statusline'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const start = () => boot({ dataDir, home, shell, catalog: bundled, allowedRoots: [tmp], intervalMs: 60_000 });
  const connectFor = (svc: Awaited<ReturnType<typeof start>>) => createConnect(connectContext({
    dataDir, login: svc.loginEnv(), bin: helpers, catalog: svc.catalog(),
    detection: (a) => svc.detections.find((d) => d.agent === a), setupAccess: (a) => svc.setupAccess(a),
    e2e: true, // XAIBO-PROD-611: helpers set (a packaged-style context) under the temp dir, as a marked packaged run
  }));

  // 2. detection and profile, 3. setup preview and apply (service wiring: boot's setupAccess into connectContext)
  const svc = await start();
  let profileId: string;
  try {
    await svc.done;
    assert.deepEqual(svc.agents()?.find((a) => a.agent === 'synthagent'), { agent: 'synthagent', name: 'Synthetic Agent', state: 'detected', version: '1.0.0' });
    const profile = svc.profiles()?.find((p) => p.agent === 'synthagent');
    assert.ok(profile && profile.root === root, 'the approved root is the profile');
    profileId = profile.id;
    const c = connectFor(svc);
    const pv = c.previewConnect(profile, { retention: false, tee: false });
    assert.ok(pv.status === 'preview', JSON.stringify(pv));
    assert.deepEqual(pv.steps.map((s) => [s.route, s.target]), [['report-setup', join(root, 'config.json')]]);
    assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), ORIGINAL, 'preview wrote nothing');
    const r = await c.applyConnect(pv.previewId);
    assert.equal(r.status, 'applied', JSON.stringify(r));
  } finally {
    svc.stop();
  }
  const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(config, { model: 'synthetic', reportingEnabled: true, xaiboReportHelper: join(dataDir, 'integrations', 'bin', 'xaibo-report'), xaiboProfileKey: profileId, xaiboAgentId: 'synthagent' });
  const helper = config['xaiboReportHelper'] as string;
  assert.deepEqual(readManifest(dataDir).map((e) => e.route), ['report-setup']);

  // 4. the producer: an approved registration for the configured agent and profile, every event through the configured helper
  const { registration, token } = addRegistration(dataDir, { agent: config['xaiboAgentId'] as string, profileKey: config['xaiboProfileKey'] as string });
  const tokenFile = join(tmp, 'producer.token');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  for (const e of events) {
    const out = await run(helper, [registration.id, tokenFile], JSON.stringify(e));
    assert.deepEqual([out.status, out.stdout, out.stderr], [0, '', ''], e.event);
  }

  // 5. the next start replays the spool: every delivery attributed, full content stored, status and receipt
  const svc2 = await start();
  try {
    await svc2.done;
    const db = svc2.store.db;
    // the start replay runs beside startup (intake.ts runReplay; done does not wait for it): wait for it, bounded
    const stored = () => (db.prepare("SELECT count(*) AS n FROM report_delivery WHERE agent = 'synthagent'").get() as { n: number }).n;
    for (const until = Date.now() + 10_000; stored() < events.length && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
    const deliveries = db.prepare("SELECT event, profile_key AS p, unattributed AS u FROM report_delivery WHERE agent = 'synthagent' ORDER BY producer_seq").all() as { event: string; p: string; u: string | null }[];
    assert.deepEqual(deliveries.map((d) => d.event), events.map((e) => e.event), 'every event stored once, in order');
    assert.ok(deliveries.every((d) => d.p === profileId && d.u === null), 'attributed to the synced imported profile');

    const want = new Map<string, { role: string; kind: string; text: string }>();
    for (const e of events.filter((x) => x.event === 'content.upsert')) {
      const w = want.get(e.item_id!) ?? { role: e.payload['role'] as string, kind: e.payload['kind'] as string, text: '' };
      want.set(e.item_id!, { ...w, text: w.text + (e.payload['content'] as string) });
    }
    const items = db.prepare('SELECT item_id AS item, role, kind, state, content FROM report_content WHERE native_session_id = ? ORDER BY item_id').all(events[0]!.session_id) as { item: string; role: string; kind: string; state: string; content: string }[];
    assert.deepEqual(items.map((s) => [s.item, s.role, s.kind, s.state, s.content]), [...want].sort(([a], [b]) => (a < b ? -1 : 1)).map(([item, w]) => [item, w.role, w.kind, 'complete', w.text]),
      'prompt, reasoning, tool output and response, each complete and whole');

    const status = svc2.status('synthagent', events[0]!.session_id, profileId);
    assert.ok(status, 'the session has a live status');
    // turn.end shows Finishing… until the settle interval passes (engine.ts life()), then the session is no longer busy
    assert.ok(status.lifecycle !== 'busy' || status.reason === 'Finishing…', `the turn ended: ${JSON.stringify(status)}`);

    const c2 = connectFor(svc2);
    const profiles = svc2.profiles() ?? [];
    const page = answerIntegrationPage({ db, catalog: svc2.catalog(), detections: svc2.detections, profiles, home, now: Date.now(), reconcile: () => c2.reconcile(profiles), ...pageEvidence({ db, dataDir }) },
      { cursor: null, direction: 'next', limit: 10 });
    const row = page.status === 'ready' ? page.value.rows.find((x) => x.key.agent === 'synthagent') : undefined;
    assert.equal(row?.receipt?.source, 'report');
    assert.equal(row?.receipt?.event, 'turn.end', 'the newest lifecycle event, not the usage snapshot after content');
    assert.equal(row?.state, 'partial-coverage', 'setup and receipt verified; content coverage is not claimed from a declaration');

    // 6. Disconnect: the config file back byte for byte
    const d = await c2.disconnect(profiles.find((p) => p.id === profileId)!);
    assert.equal(d.status, 'disconnected', JSON.stringify(d));
    assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), ORIGINAL);
    assert.deepEqual(readManifest(dataDir), []);
  } finally {
    svc2.stop();
  }
  assert.ok(existsSync(join(dataDir, 'integrations', 'bin', 'xaibo-report')), 'the deployed helper stays (FR-34: history and helpers are a separate choice)');
});
