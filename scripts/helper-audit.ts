// P3-T16c helper attempt audit (plan P3-T16, §3.6 "Helpers audited in every P3-T16 mode: 0 attempts"; M6, §4.3 P2).
// Every helper case runs on two layers:
//   seatbelt: the packaged helpers (hook shim -> forwarder, report shim -> forwarder, statusLine tee), installed into the
//     data dir as Connect does, under test/e2e/audit.sb, which SIGKILLs a process on its first non-loopback or DNS attempt;
//   channel: the same helper sources under the SEA's own Node build with scripts/net-recorder.ts preloaded (a SEA takes no
//     preload; the shims are /bin/sh and are covered by the seatbelt layer), under the log-only profile (deny, no kill) so
//     the recorder sees any attempt. A Unix socket or a loopback host is allowed; any other socket or HTTP request counts.
// Each case also proves its path ran (delivered, spooled, overflow line, exit code, mirrored output; enospc: the same
// commands spool once 64 KiB is freed), so a helper that exits early cannot pass. Hook cases also run the forwarder
// directly, since the hook shim hides a kill of its child. A positive control per layer must fire. Modes: up (in-process socket server and intake), down,
// hung (accepts, never acks), enospc (full volume on spool/), cap (spool at 50 MiB), malformed stdin, tee capture failure.
// Binds a Unix socket and runs sandbox-exec and hdiutil: run outside the command sandbox (owner-approved, as P0-S10-T1).
//   node scripts/helper-audit.ts   (needs npm run dist:mac; prints aggregates, exits 1 on any attempt or failed case)
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { deployShim } from '../src/service/adapters/claude/setup.ts';
import { teeCommand } from '../src/forwarder/statusline-tee.ts';
import { addRegistration, openRegistry } from '../src/service/receivers/registrations.ts';
import { createReportIntake } from '../src/service/receivers/report.ts';
import { startSocketServer } from '../src/service/receivers/socket.ts';
import { hookStore } from '../test/helpers/hook-store.ts';
import { fault, full, overflowLines, ownSpool, spoolLines, type Undo } from '../test/perf/m16.ts';

const REPO = path.resolve(import.meta.dirname, '..');
const RESOURCES = path.join(REPO, 'release', 'mac-arm64', 'Xaibo.app', 'Contents', 'Resources', 'bin');
const SEA_NODE = path.join(REPO, '.cache', 'node-official', 'node-v26.10.0-darwin-arm64', 'bin', 'node'); // the SEAs' runtime (build-forwarder.sh)
const PROFILE = path.join(REPO, 'test', 'e2e', 'audit.sb');
const RECORDER = path.join(REPO, 'scripts', 'net-recorder.ts');
const CONTROL = path.join(REPO, 'spikes', 's10', 'control.ts');
const ORIGINAL = "printf 'synthetic status %s' ok";
const ORIGINAL_OUT = 'synthetic status ok';
const SID = '00000000-0000-4000-8000-0000000f1630';
const HOOK = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, cwd: '/tmp/xaibo-fixture/audit', tool_name: 'Bash', tool_use_id: 'a1' });
const STATUS = JSON.stringify({ session_id: SID, model: { id: 'synthetic-model', display_name: 'Synthetic' }, cost: { total_cost_usd: 0.1 } });
const report = () => JSON.stringify({ v: 1, session_id: SID, producer_id: 'audit-producer', producer_seq: 1, event: 'turn.start', source_ts: '2026-01-01T00:00:00.000Z', payload: {} });
const MALFORMED = 'this is { not json';

type Helper = 'hook' | 'report' | 'tee';
type Mode = 'up' | 'down' | 'hung' | 'enospc' | 'cap' | 'malformed' | 'capture-fail';
const CASES: [Helper, Mode][] = [
  ...(['up', 'down', 'hung', 'enospc', 'cap', 'malformed'] as const).flatMap((m) => [['hook', m], ['report', m]] as [Helper, Mode][]),
  ...(['up', 'down', 'hung', 'capture-fail'] as const).map((m) => ['tee', m] as [Helper, Mode]),
];

interface Out { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
function exec(file: string, args: string[], input: string, env: Record<string, string>): Promise<Out> {
  return new Promise((resolve, reject) => {
    const c = spawn(file, args, { env: { PATH: '/usr/bin:/bin', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d: Buffer) => { stdout += d; });
    c.stderr.on('data', (d: Buffer) => { stderr += d; });
    c.stdin.on('error', () => undefined);
    c.on('error', reject);
    c.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    c.stdin.end(input);
  });
}

/** Recorder lines that are attempts: any HTTP request, or a socket that is neither a Unix socket nor loopback. */
function attempts(file: string): object[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { ch: string; kind?: string; host?: string | null })
    .filter((r) => r.ch !== 'net.client.socket' || (r.kind !== 'Pipe' && !/^(localhost|127\.\d+\.\d+\.\d+|::1)$/.test(r.host ?? '')));
}

async function runCase(helper: Helper, mode: Mode, layer: 'seatbelt' | 'channel', logOnly: string) {
  const h = await hookStore();
  const dir = h.dir;
  let envelopes = 0;
  let server: Awaited<ReturnType<typeof startSocketServer>> | null = null;
  let undo: Undo = async () => undefined;
  const record = `${dir}-net.jsonl`;
  try {
    const bin = path.dirname(deployShim(dir, { hook: path.join(RESOURCES, 'xaibo-hook'), forwarder: path.join(RESOURCES, 'xaibo-forwarder'), statusline: path.join(RESOURCES, 'xaibo-statusline') }));
    const { registration, token } = addRegistration(dir, { agent: 'claude', profileKey: 'p1' });
    const tokenFile = path.join(dir, 'producer.token');
    writeFileSync(tokenFile, token, { mode: 0o600 });
    writeFileSync(path.join(dir, 'integrations', 'manifest.json'), JSON.stringify({ v: 1, entries: [{ route: 'claude-tee', state: 'applied',
      owned: [{ pointer: '/statusLine/command', value: teeCommand(dir, 'p1'), old: ORIGINAL }] }] }), { mode: 0o600 });
    if (mode === 'up' || mode === 'malformed' || mode === 'capture-fail') {
      const reports = createReportIntake({ db: h.db, writer: h.writer, dataDir: dir });
      server = await startSocketServer({ dataDir: dir, onEnvelope: (e) => { envelopes++; return h.intake.deliver(e); }, reports: { registry: openRegistry(dir), intake: reports } });
    } else undo = await fault(mode as 'down' | 'hung' | 'enospc' | 'cap', dir);
    const input = mode === 'malformed' || mode === 'capture-fail' ? MALFORMED : helper === 'hook' ? HOOK : helper === 'tee' ? STATUS : report();
    const args = helper === 'hook' ? ['hook', 'claude', 'p1'] : helper === 'report' ? [registration.id, tokenFile] : [dir, 'p1'];
    // Commands of this case. Seatbelt: the shim as agents run it; for hooks also the forwarder directly, because the hook
    // shim runs it without exec and exits 0, so a kill of the forwarder would be invisible through the shim (review H1).
    const commands: [string, string[], Record<string, string>][] = layer === 'seatbelt'
      ? [[path.join(bin, helper === 'hook' ? 'xaibo-hook' : helper === 'report' ? 'xaibo-report' : 'xaibo-statusline'), args, {}],
        ...(helper === 'hook' ? [[path.join(bin, 'xaibo-forwarder'), args, { XAIBO_DATA_DIR: dir }] as [string, string[], Record<string, string>]] : [])]
      : [[SEA_NODE, ['--import', RECORDER, path.join(REPO, 'src', 'forwarder', helper === 'tee' ? 'statusline-tee.ts' : 'forwarder.ts'),
        ...(helper === 'report' ? ['report'] : []), ...args], { XAIBO_DATA_DIR: dir, XAIBO_NET_RECORD: record }]];
    const runAll = async () => {
      const outs: Out[] = [];
      for (const [file, a, env] of commands) outs.push(await exec('/usr/bin/sandbox-exec', ['-f', layer === 'seatbelt' ? PROFILE : logOnly, file, ...a], input, env));
      await new Promise((r) => setTimeout(r, 200)); // a commit in flight lands
      return outs;
    };
    // enospc (review M2): with 64 KiB freed on the same volume the same commands must spool, proving they reach the
    // spool there; then the volume is refilled to the byte and the measured runs must spool nothing.
    let controlSpooled: number | null = null;
    if (mode === 'enospc') {
      const fill = path.join(dir, 'spool', 'fill.bin');
      truncateSync(fill, Math.max(0, statSync(fill).size - 64 * 1024));
      const s0 = spoolLines(dir);
      await runAll();
      controlSpooled = spoolLines(dir) - s0;
      if (!full(path.join(dir, 'spool'))) throw new Error('could not refill the volume');
      // the control's day file has slack in its last block that an append can use without a new allocation: pad it
      for (const f of readdirSync(path.join(dir, 'spool')).filter((x) => x.endsWith('.jsonl'))) {
        const fd = openSync(path.join(dir, 'spool', f), 'a');
        try { for (;;) writeSync(fd, Buffer.alloc(1)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOSPC') throw e; } finally { closeSync(fd); }
      }
    }
    const before = { spooled: spoolLines(dir), overflow: overflowLines(dir) };
    const outs = await runAll();
    const n = commands.length;

    const spooled = spoolLines(dir) - before.spooled;
    const overflow = overflowLines(dir) - before.overflow;
    const reportRows = Number((h.db.prepare('SELECT count(*) AS n FROM report_delivery').get() as { n: number }).n);
    const hookRows = Number((h.db.prepare('SELECT count(*) AS n FROM hook_delivery').get() as { n: number }).n);
    const stillFull = mode === 'enospc' ? controlSpooled === n && ownSpool(dir) && full(path.join(dir, 'spool')) && spooled === 0 : null;
    const codeLine = (s: string) => outs.every((o) => o.stderr === `xaibo-report: ${s}\n`);
    // What proves the path ran, per helper and mode. tee/down has nothing to observe beyond the mirrored output (no
    // socket, so no attempt is possible); tee/capture-fail proves the original still works when the capture fails.
    const expected: Record<Helper, Partial<Record<Mode, boolean>>> = {
      hook: { up: hookRows === n, malformed: hookRows === n, down: spooled === n, hung: spooled === n, enospc: stillFull === true, cap: spooled === 0 && overflow === n },
      report: { up: reportRows === n, down: spooled === n, hung: spooled === n, enospc: stillFull === true && codeLine('spool'),
        cap: spooled === 0 && overflow === n && codeLine('spool'), malformed: codeLine('malformed') },
      tee: { up: envelopes === n, down: true, hung: (undo.connections?.() ?? 0) >= n, 'capture-fail': envelopes === 0 },
    };
    const codeCase = helper === 'report' && (mode === 'enospc' || mode === 'cap' || mode === 'malformed');
    const found = layer === 'channel' ? attempts(record) : [];
    const fails = outs.flatMap((out, i) => [
      out.signal && `run ${i} killed (${out.signal})`, (codeCase ? out.code !== 2 : out.code !== 0) && `run ${i} exit ${out.code}`,
      (helper === 'tee' ? out.stdout !== ORIGINAL_OUT : out.stdout !== '') && `run ${i} stdout`, !codeCase && out.stderr !== '' && `run ${i} stderr`,
    ]).concat([!expected[helper][mode] && 'path not proven to run', found.length > 0 && `${found.length} recorded attempts`]).filter(Boolean) as string[];
    return { helper, mode, layer, fails, attempts: outs.filter((o) => o.signal === 'SIGKILL').length + found.length };
  } finally {
    try { await server?.close(); } finally {
      try { await undo(); } finally {
        h.db.close();
        rmSync(dir, { recursive: true, force: true });
        rmSync(record, { force: true });
      }
    }
  }
}

/** Positive controls: an attempt by the SEA's Node runtime is killed by the profile, and recorded by the recorder. */
async function controls(logOnly: string, scratch: string) {
  const res: Record<string, boolean> = {};
  for (const kind of ['tcp', 'dns']) {
    const k = await exec('/usr/bin/sandbox-exec', ['-f', PROFILE, SEA_NODE, CONTROL, kind], '', {});
    res[`seatbelt-${kind}`] = k.signal === 'SIGKILL';
  }
  const record = path.join(scratch, 'control-net.jsonl');
  rmSync(record, { force: true }); // review M4: a stale line from an earlier run must not satisfy the control
  await exec('/usr/bin/sandbox-exec', ['-f', logOnly, SEA_NODE, '--import', RECORDER, CONTROL, 'tcp'], '', { XAIBO_NET_RECORD: record });
  res['channel-tcp'] = attempts(record).length > 0;
  return res;
}

for (const f of [SEA_NODE, path.join(RESOURCES, 'xaibo-forwarder'), path.join(RESOURCES, 'xaibo-statusline')]) {
  if (!existsSync(f)) throw new Error(`missing ${path.relative(REPO, f)} (npm run dist:mac; official Node in .cache)`);
}
const scratch = path.join(REPO, '.cache', 'helper-audit');
mkdirSync(scratch, { recursive: true });
const logOnly = path.join(scratch, 'audit-log-only.sb');
writeFileSync(logOnly, readFileSync(PROFILE, 'utf8').replaceAll(' (with send-signal SIGKILL)', ''));
const ctl = await controls(logOnly, scratch);
const results = [];
for (const [helper, mode] of CASES) for (const layer of ['seatbelt', 'channel'] as const) results.push(await runCase(helper, mode, layer, logOnly));
const failed = results.filter((r) => r.fails.length);
const summary = {
  audit: 'helper-attempts', cases: results.length, attempts: results.reduce((n, r) => n + r.attempts, 0), controls: ctl,
  failed: failed.map((r) => `${r.helper}/${r.mode}/${r.layer}: ${r.fails.join(', ')}`),
  pass: failed.length === 0 && Object.values(ctl).every(Boolean),
};
writeFileSync(path.join(scratch, `result-${Date.now()}.json`), JSON.stringify({ ...summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.pass ? 0 : 1;
