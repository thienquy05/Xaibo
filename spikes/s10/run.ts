// P0-S10 network audit driver (T1-T3). Run unsandboxed (Seatbelt does not nest):
//   npm run spike:s10 [-- --idle-s 300] [-- --only control|scenarios]   (no --only: controls first, then scenarios)
// Every audited process runs under spikes/s10/audit.sb, which kills a process on its first non-loopback or DNS
// attempt. Zero attempts = no audited process died except the two this driver kills on purpose. The app runs with
// --no-sandbox because Chromium's own sandbox cannot start inside another Seatbelt profile (nesting probe 2).
// Supplementary, not proof alone: lsof every 250 ms, Chromium NetLog, the kernel denial log (lossy).
// Positive controls: one TCP and one DNS attempt from main, service and the forwarder runtime must each be caught.
// Raw files: .cache/spike-results/s10/ (git-ignored). Aggregates only: spikes/s10/evidence/s10.json.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { envRecord, summary } from '../shared/bench.ts';

const REPO = join(import.meta.dirname, '..', '..');
const APP = join(REPO, 'dist/spike/mac-arm64/XaiboSpike.app');
const BIN = join(APP, 'Contents/MacOS/XaiboSpike');
const SHIM = join(REPO, 'spikes/s3/shim.sh');
const SEA_NODE = join(REPO, '.cache/node-official/node-v26.10.0-darwin-arm64/bin/node');
const PROFILE = join(import.meta.dirname, 'audit.sb');
const OUT = join(REPO, '.cache', 'spike-results', 's10');
const STEP_MS = 20_000;
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)(:\d+)?$/;
const { values } = parseArgs({ options: { 'idle-s': { type: 'string' }, only: { type: 'string' } } });
const IDLE_MS = Number(values['idle-s'] ?? 300) * 1000;

mkdirSync(OUT, { recursive: true });
// The NetLog control must survive its denied attempt: same rules without the kill.
const LOG_ONLY = join(OUT, 'audit-log-only.sb');
writeFileSync(LOG_ONLY, readFileSync(PROFILE, 'utf8').replaceAll(' (with send-signal SIGKILL)', ''));

type Line = Record<string, unknown>;
interface App { child: ChildProcess; lines: Line[]; exited: Promise<{ code: number | null; signal: string | null }>; dataDir: string }

function launch(mode: string, extra: NodeJS.ProcessEnv = {}, profile = PROFILE, prepare?: (dir: string) => void): App {
  const dataDir = mkdtempSync(join(tmpdir(), 's10-'));
  prepare?.(dataDir);
  const env: NodeJS.ProcessEnv = { ...process.env, XAIBO_DATA_DIR: dataDir, XAIBO_SPIKE_MODE: mode, XAIBO_S10: '1', ...extra };
  delete env.ELECTRON_RUN_AS_NODE; // the VS Code host exports it; it would turn the app into plain Node
  // After a process is killed, macOS offers to restore the app's windows on the next launch, which blocks startup:
  // the two defaults (argument domain, nothing persisted) switch window restoration off for this launch.
  const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, BIN, '--no-sandbox', '-ApplePersistenceIgnoreState', 'YES', '-NSQuitAlwaysKeepsWindows', 'NO'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines: Line[] = [];
  let buf = '';
  child.stdout!.on('data', (d: Buffer) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) { try { lines.push(JSON.parse(buf.slice(0, i))); } catch { /* not ours */ } }
  });
  // 'close', not 'exit': a final child-gone line may still be in the pipe when the process exits.
  const exited = new Promise<{ code: number | null; signal: string | null }>((res) => child.on('close', (code, signal) => res({ code, signal })));
  return { child, lines, exited, dataDir };
}

// Waits for the n-th line matching pred; false on timeout or app exit.
async function seen(a: App, pred: (l: Line) => boolean, n = 1, ms = STEP_MS): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (a.lines.filter(pred).length >= n) return true;
    if (a.child.exitCode !== null || a.child.signalCode !== null) return a.lines.filter(pred).length >= n;
    await sleep(50);
  }
  return false;
}
const send = (a: App, cmd: string) => a.child.stdin!.write(`${cmd}\n`);
async function stop(a: App) {
  if (a.child.exitCode === null && a.child.signalCode === null) { send(a, 'quit'); await Promise.race([a.exited, sleep(5000)]); }
  for (const pid of tree(a.child.pid!)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(a.dataDir, { recursive: true, force: true });
}

function ps(): { pid: number; ppid: number; rss: number; cpu: number }[] {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,pcpu='], { encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => {
    const [pid, ppid, rss, cpu] = l.trim().split(/\s+/).map(Number);
    return { pid: pid!, ppid: ppid!, rss: rss!, cpu: cpu! };
  });
}
function tree(root: number, all = ps()): number[] {
  const out = [root];
  for (let i = 0; i < out.length; i++) for (const p of all) if (p.ppid === out[i] && !out.includes(p.pid)) out.push(p.pid);
  return out.filter((pid) => all.some((p) => p.pid === pid));
}

// lsof -i over the app's process tree: counts lines whose address is not loopback (ports and addresses are not kept).
function lsofNonLoopback(root: number): number {
  const pids = tree(root);
  if (!pids.length) return 0;
  const r = spawnSync('/usr/sbin/lsof', ['-nP', '-i', '-a', '-p', pids.join(',')], { encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').slice(1).filter(Boolean).filter((l) => {
    const name = l.trim().split(/\s+/).slice(8).join(' ').replace(/ \(.*\)$/, '');
    return !name.split('->').every((side) => LOCAL.test(side));
  }).length;
}

// Death lines of one app run, then how many are not explained by what the driver did itself. The service exits
// cleanly at quit (main asks it to), so every 'killed' service report beyond the driver's own SIGKILL is an attempt.
const deathsOf = (lines: Line[]) => lines.filter((l) => l.service === 'exit' || 'child-gone' in l)
  .map((l) => (l.service === 'exit' ? 'service-exit' : `${String(l['child-gone'])}:${String(l.reason)}:${String(l.name ?? '')}`));
function unexpectedDeaths(deaths: string[], allowed: { rendererCrashes: number; serviceKills: number }) {
  const n = (f: (x: string) => boolean) => deaths.filter(f).length;
  const svcKilled = (x: string) => x.startsWith('Utility:') && x.endsWith(':xaibo-spike-service') && !x.startsWith('Utility:clean-exit:');
  const known = (x: string) => x === 'service-exit' || x.startsWith('Renderer:') || x.startsWith('Utility:clean-exit:') || svcKilled(x);
  return n((x) => !known(x)) + Math.max(0, n((x) => x === 'service-exit') - allowed.serviceKills)
    + Math.max(0, n((x) => x.startsWith('Renderer:')) - allowed.rendererCrashes) + Math.max(0, n(svcKilled) - allowed.serviceKills);
}

function netlog(file: string) {
  let j: { constants: { logEventTypes: Record<string, number> }; events: { type: number; params?: unknown }[] };
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { return { parsed: false }; }
  const names = Object.fromEntries(Object.entries(j.constants.logEventTypes).map(([k, v]) => [v, k]));
  const types = new Set<string>(); let nonLocal = 0;
  for (const e of j.events) {
    const p = JSON.stringify(e.params ?? {});
    const hosts = [...p.matchAll(/https?:\/\/([^/"\\]+)|"(?:host|hostname|dns_query_name)":"([^"]+)"|"address":"([^"]+)"/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
    if (hosts.some((h) => !LOCAL.test(h))) { nonLocal++; types.add(names[e.type] ?? String(e.type)); }
  }
  return { parsed: true, events: j.events.length, nonLocal, types: [...types].sort() };
}

// Forwarder candidates under the same profile. Pass = exit 0 (not killed) AND the forwarder's own stats line shows it
// ran (the shim exits 0 silently when a runtime is missing, so exit 0 alone proves nothing).
function forwarders(dataDir: string): Record<string, { exit: number | null; ran: boolean; outcome: string }> {
  const out: Record<string, { exit: number | null; ran: boolean; outcome: string }> = {};
  for (const candidate of ['sea', 'electron-node']) {
    const stats = join(dataDir, `fwd-${candidate}.tsv`);
    const r = spawnSync('/usr/bin/sandbox-exec', ['-f', PROFILE, '/bin/sh', SHIM, 'claude', 'PreToolUse'], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: '00000000-0000-4000-8000-000000000001', tool_name: 'Bash' }),
      env: { PATH: '/usr/bin:/bin', XAIBO_DATA_DIR: dataDir, XAIBO_FWD_CANDIDATE: candidate, XAIBO_APP: APP, XAIBO_FWD_STATS: stats }, timeout: STEP_MS,
    });
    const line = existsSync(stats) ? readFileSync(stats, 'utf8').trim().split('\n').at(-1) ?? '' : '';
    out[candidate] = { exit: r.signal ? null : r.status, ran: line !== '', outcome: line.split('\t')[2] ?? 'none' };
  }
  return out;
}
const fwdOk = (f: ReturnType<typeof forwarders>) => Object.values(f).every((c) => c.exit === 0 && c.ran);

async function controls() {
  const res: Record<string, boolean> = {};
  for (const kind of ['tcp', 'dns']) {
    const m = launch('idle', { XAIBO_S10_CONTROL: `main-${kind}` });
    const e = await Promise.race([m.exited, sleep(STEP_MS).then(() => null)]);
    res[`main-${kind}`] = e?.signal === 'SIGKILL';
    await stop(m);
    const s = launch('idle', { XAIBO_S10_CONTROL: `service-${kind}` });
    res[`service-${kind}`] = await seen(s, (l) => l.service === 'exit');
    await stop(s);
    const f = spawnSync('/usr/bin/sandbox-exec', ['-f', PROFILE, SEA_NODE, join(import.meta.dirname, 'control.ts'), kind], { timeout: STEP_MS });
    res[`forwarder-runtime-${kind}`] = f.signal === 'SIGKILL';
    // The Electron-as-Node forwarder runtime: the packaged binary in Node mode running the compiled control.
    const en = spawnSync('/usr/bin/sandbox-exec', ['-f', PROFILE, BIN, join(REPO, 'spikes/app/build/s10/control.js'), kind], { timeout: STEP_MS, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    res[`electron-node-runtime-${kind}`] = en.signal === 'SIGKILL';
  }
  // NetLog control: a denied (not killed) Chromium-stack request must show up in the parsed NetLog.
  const file = join(OUT, 'netlog-control.json');
  rmSync(file, { force: true });
  const n = launch('idle', { XAIBO_NETLOG: file }, LOG_ONLY);
  await seen(n, (l) => l.smoke === 'paint-ack');
  send(n, 'fetch-control');
  await sleep(3000);
  send(n, 'quit'); await Promise.race([n.exited, sleep(STEP_MS)]);
  const parsed = netlog(file);
  res.netlog = parsed.parsed === true && (parsed.nonLocal ?? 0) > 0;
  await stop(n);
  // An attempt by the service during shutdown must be counted by the same classifier as the scenario run.
  const sq = launch('idle', { XAIBO_S10_CONTROL: 'service-quit-tcp' });
  await seen(sq, (l) => l.smoke === 'paint-ack');
  send(sq, 'quit');
  await Promise.race([sq.exited, sleep(STEP_MS)]);
  res['service-at-quit-tcp'] = unexpectedDeaths(deathsOf(sq.lines), { rendererCrashes: 0, serviceKills: 0 }) > 0;
  await stop(sq);
  // The same harness with no control must report nothing (else the controls prove nothing).
  const q = launch('idle');
  const up = await seen(q, (l) => l.smoke === 'paint-ack');
  await sleep(2000);
  send(q, 'quit');
  const qe = await Promise.race([q.exited, sleep(5000).then(() => null)]);
  res['quiet-baseline'] = up && qe?.code === 0 && unexpectedDeaths(deathsOf(q.lines), { rendererCrashes: 0, serviceKills: 0 }) === 0;
  await stop(q);
  return { results: res, netlogControl: parsed };
}

async function scenarios() {
  const reached: Record<string, boolean> = {};
  const samples: Record<string, { rssMiB: number[]; cpu: number[] }> = { open: { rssMiB: [], cpu: [] }, closed: { rssMiB: [], cpu: [] } };
  let phase = '';
  let lsofHits = 0; let lsofRuns = 0;
  const klog = join(OUT, 'kernel.log');
  const logger = spawn('/usr/bin/log', ['stream', '--style', 'compact', '--predicate', 'sender == "Sandbox" AND eventMessage CONTAINS "network-outbound"'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let klogText = ''; logger.stdout.on('data', (d: Buffer) => { klogText += d; });
  await sleep(1500);

  const nl = join(OUT, 'netlog.json');
  rmSync(nl, { force: true });
  const a = launch('s3', { XAIBO_NETLOG: nl });
  const root = a.child.pid!;
  const sampler = setInterval(() => {
    if (!phase) return;
    const all = ps(); const pids = new Set(tree(root, all));
    const mine = all.filter((p) => pids.has(p.pid));
    samples[phase]!.rssMiB.push(mine.reduce((s, p) => s + p.rss, 0) / 1024);
    samples[phase]!.cpu.push(mine.reduce((s, p) => s + p.cpu, 0));
  }, 1000);
  let lsofBusy = false;
  const lsofTimer = setInterval(() => { if (lsofBusy) return; lsofBusy = true; lsofHits += lsofNonLoopback(root); lsofRuns++; lsofBusy = false; }, 250);
  const paint = (l: Line) => l.smoke === 'paint-ack';
  let fwdUp: ReturnType<typeof forwarders> = {};
  let exit: { code: number | null; signal: string | null } | null = null;
  try {
    reached['cold start'] = (await seen(a, (l) => l.smoke === 'service-ready')) && (await seen(a, (l) => 's3-ready' in l)) && (await seen(a, paint));
    phase = 'open'; await sleep(IDLE_MS); phase = '';
    reached['idle, window open'] = a.child.exitCode === null && a.child.signalCode === null;
    send(a, 'hide'); await seen(a, (l) => l.s10 === 'hide'); await sleep(2000);
    phase = 'closed'; await sleep(IDLE_MS); phase = '';
    reached['idle, window closed'] = a.child.exitCode === null && a.child.signalCode === null;
    send(a, 'show'); await sleep(1000);
    send(a, 'crash-renderer');
    reached['renderer crash and reload'] = (await seen(a, (l) => l['child-gone'] === 'Renderer')) && (await seen(a, paint, 2));
    const servicePid = Number(a.lines.findLast((l) => 'service-pid' in l)?.['service-pid']);
    process.kill(servicePid, 'SIGKILL');
    reached['service SIGKILL and restart'] = (await seen(a, (l) => l.service === 'exit')) && (await seen(a, (l) => l.smoke === 'service-ready', 2)) && (await seen(a, (l) => 's3-ready' in l, 2));
    fwdUp = forwarders(a.dataDir);
    reached['forwarders, service up'] = fwdOk(fwdUp);
    send(a, 'open-blocked');
    reached['blocked window.open, fetch and navigation'] = (await seen(a, (l) => l.blocked === 'window-open')) && (await seen(a, (l) => l.blocked === 'navigate'));
    await sleep(1000);
    send(a, 'quit');
    exit = await Promise.race([a.exited, sleep(STEP_MS).then(() => null)]);
    reached.quit = exit?.code === 0;
  } finally { clearInterval(sampler); clearInterval(lsofTimer); }
  const parsedNetlog = netlog(nl);
  const deaths = deathsOf(a.lines);
  await stop(a);

  const down = mkdtempSync(join(tmpdir(), 's10-'));
  const fwdDown = forwarders(down);
  rmSync(down, { recursive: true, force: true });
  reached['forwarders, service down'] = fwdOk(fwdDown);

  // DB open error: the database path is a directory.
  const d = launch('s1-probe', {}, PROFILE, (dir) => mkdirSync(join(dir, 's1-main.db')));
  const gotReport = await seen(d, (l) => 'report' in l);
  const report = d.lines.find((l) => 'report' in l)?.report as { main?: { error?: string } } | undefined;
  const dExit = await Promise.race([d.exited, sleep(STEP_MS).then(() => null)]);
  reached['DB open error'] = gotReport && typeof report?.main?.error === 'string' && dExit?.code === 0;
  const dDeaths = unexpectedDeaths(deathsOf(d.lines), { rendererCrashes: 0, serviceKills: 0 });
  await stop(d);

  await sleep(3000); logger.kill();
  writeFileSync(klog, klogText);
  const kernelLines = klogText.split('\n').filter((l) => /XaiboSpike|xaibo-forwarder/.test(l)).length;
  const unexpected = unexpectedDeaths(deaths, { rendererCrashes: 1, serviceKills: 1 }) + dDeaths;
  const idle = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.rssMiB.length ? { rssMiB: summary(v.rssMiB), cpuPercent: summary(v.cpu) } : null]));
  return { reached, unexpectedDeaths: unexpected, mainExit: exit, forwarderExit: { up: fwdUp, down: fwdDown }, lsof: { runs: lsofRuns, nonLoopbackLines: lsofHits }, netlog: parsedNetlog, kernelLogLines: kernelLines, idleSeconds: IDLE_MS / 1000, idle };
}

const result: Record<string, unknown> = { env: envRecord(), method: 'sandbox-exec kill-on-attempt profile; app run with --no-sandbox' };
let ok = true;
if (values.only !== 'scenarios') {
  const c = await controls();
  result.controls = c;
  for (const [k, v] of Object.entries(c.results)) { console.log(`control ${k}: ${v ? 'detected' : 'MISSED'}`.replace('quiet-baseline: detected', 'quiet-baseline: quiet')); ok &&= v; }
}
if (values.only !== 'control') {
  const s = await scenarios();
  result.scenarios = s;
  for (const [k, v] of Object.entries(s.reached)) { console.log(`scenario ${k}: ${v ? 'reached' : 'NOT REACHED'}`); ok &&= v; }
  const zero = s.unexpectedDeaths === 0 && s.lsof.nonLoopbackLines === 0 && s.netlog.parsed === true && s.netlog.nonLocal === 0;
  console.log(`attempts: unexpected deaths ${s.unexpectedDeaths}, lsof non-loopback ${s.lsof.nonLoopbackLines}/${s.lsof.runs} runs, kernel log lines ${s.kernelLogLines}, netlog non-local events ${String((s.netlog as { nonLocal?: number }).nonLocal ?? 'unparsed')}`);
  ok &&= zero;
}
if (!values.only && IDLE_MS >= 300_000) {
  mkdirSync(join(import.meta.dirname, 'evidence'), { recursive: true });
  writeFileSync(join(import.meta.dirname, 'evidence', 's10.json'), `${JSON.stringify(result, null, 2)}\n`);
} else writeFileSync(join(OUT, 'partial.json'), JSON.stringify(result, null, 2));
console.log(ok ? 's10: pass' : 's10: FAIL');
process.exit(ok ? 0 : 1);
