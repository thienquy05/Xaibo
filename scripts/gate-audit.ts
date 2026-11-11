// Gate 1 packaged S10-style audit (P1-T15; EC-60, M6; D-P1-08 item 2, spikes/s10 method), without Playwright: the
// packaged app runs under test/e2e/audit.sb (a process is killed on its first non-loopback or DNS attempt) with NetLog
// on, in a temp HOME/data dir/agent homes, cwd at the repo. Scenarios: startup, idle (default 5 min, window open),
// service SIGKILL and restart, shutdown (SIGTERM -> Quit). Pass = no Electron helper vanished except the one killed on
// purpose, no child of the service killed by the profile (`child_killed` in the service log, reported by spawn.ts),
// main exits 0 by itself, NetLog has no non-loopback event, one restart, repo and fixture store unchanged. A positive
// control launch first: a fake agent whose version probe attempts TEST-NET-1 must be killed and reported.
// Limit: a grandchild forked (not exec'd) by a child and killed while its parent exits 0 is not seen (root-level
// tracing would be needed); the audit's fake scripts exec, so none exist here.
// Run unsandboxed (Seatbelt does not nest). Aggregates only: printed and kept under .cache/gate-audit/.
//   node scripts/gate-audit.ts [--idle-s 300]
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { gitStatus, parseNetLog, treeHashes } from '../test/e2e/audit.ts';

const { values } = parseArgs({ options: { 'idle-s': { type: 'string', default: '300' } } });
const IDLE_MS = Number(values['idle-s']) * 1000;
const REPO = path.resolve(import.meta.dirname, '..');
const BIN = path.join(REPO, 'release', 'mac-arm64', 'Xaibo.app', 'Contents', 'MacOS', 'Xaibo');
const PROFILE = path.join(REPO, 'test', 'e2e', 'audit.sb');
const FIXTURE = path.join(REPO, 'test', 'fixtures', 'synthetic', 'claude', '2.1.319', 'usage-basic');

const root = mkdtempSync(path.join(tmpdir(), 'xaibo-gate-audit-'));
const home = path.join(root, 'home');
const bin = path.join(home, 'bin');
const project = path.join(home, '.claude', 'projects', '-tmp-xaibo-fixture-project');
for (const d of [bin, project, path.join(home, '.codex', 'sessions'), path.join(root, 'tmp')]) mkdirSync(d, { recursive: true });
for (const f of readdirSync(FIXTURE).filter((n) => n.endsWith('.jsonl'))) copyFileSync(path.join(FIXTURE, f), path.join(project, f));
const script = (name: string, body: string) => { const f = path.join(bin, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
script('claude', 'echo "2.1.319 (Claude Code)"');
script('codex', 'echo "codex-cli 0.160.0"');
const shell = script('fake-shell', 'while [ $# -gt 0 ]; do [ "$1" = -c ] && exec /bin/sh -c "$2"; shift; done');
const dataDir = path.join(root, 'data');
const controlDir = path.join(root, 'control-data');
const netlog = path.join(root, 'netlog.json');
const stores = () => JSON.stringify(['.claude', '.codex'].map((d) => treeHashes(path.join(home, d))));

const storesBefore = stores();
const gitBefore = gitStatus(REPO);
const envFor = (data: string) => ({
  HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHELL: shell, TMPDIR: path.join(root, 'tmp'), LANG: 'en_US.UTF-8',
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), GEMINI_CLI_HOME: home, XAIBO_DATA_DIR: data,
});
const launchApp = (data: string, log: string) => spawn('/usr/bin/sandbox-exec', ['-f', PROFILE, BIN, '--no-sandbox', `--log-net-log=${log}`,
  '-ApplePersistenceIgnoreState', 'YES', '-NSQuitAlwaysKeepsWindows', 'NO'], { env: envFor(data), cwd: REPO, stdio: 'ignore' });
const serviceEvents = (data: string) => { const f = path.join(data, 'logs', 'service', 'xaibo.log');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { event: string }).event) : []; };

// Positive control: the version probe of a fake agent attempts a TEST-NET-1 connection (never routed); the profile kills
// it before any packet leaves, and spawn.ts must report it as child_killed.
script('claude', 'exec /usr/bin/nc -z -G 2 192.0.2.1 80');
const control = launchApp(controlDir, path.join(root, 'control-netlog.json'));
const controlClosed = new Promise((res) => control.on('close', res));
{ const end = Date.now() + 30_000; while (Date.now() < end && !serviceEvents(controlDir).includes('detect')) await sleep(250); }
const controlDetected = serviceEvents(controlDir).includes('child_killed');
control.kill('SIGTERM');
await Promise.race([controlClosed, sleep(20_000)]);
script('claude', 'echo "2.1.319 (Claude Code)"');

const app = launchApp(dataDir, netlog);
const exited = new Promise<{ code: number | null; signal: string | null }>((res) => app.on('close', (code, signal) => res({ code, signal })));

// Electron/Chromium helpers under main (sandbox-exec execs the app, so app.pid is main), tracked once per second.
// Short-lived children of the service (login-shell read, version probes) exit normally and are not tracked; an attempt
// by main or the service itself shows as a killed main or an extra restart.
const table = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 << 20 }).trim().split('\n')
  .map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)!; return { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! }; });
function descendants() {
  const rows = table();
  const out = new Map<number, string>();
  const walk = (p: number) => { for (const r of rows) if (r.ppid === p && !out.has(r.pid)) { out.set(r.pid, r.cmd); walk(r.pid); } };
  walk(app.pid!);
  return out;
}
const seen = new Map<number, string>();
const vanished: number[] = [];
let running = true;
const sample = () => {
  if (!running) return;
  const now = descendants();
  for (const [pid, cmd] of now) if (cmd.includes('--type=')) seen.set(pid, cmd);
  for (const pid of seen.keys()) if (!now.has(pid) && !vanished.includes(pid)) vanished.push(pid);
};
const timer = setInterval(sample, 1000);

const log = () => (existsSync(path.join(dataDir, 'logs', 'xaibo.log'))
  ? readFileSync(path.join(dataDir, 'logs', 'xaibo.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string }) : []);
const count = (event: string) => log().filter((e) => e.event === event).length;
async function until(cond: () => boolean, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(250); } return false; }
const servicePid = () => [...descendants()].find(([, cmd]) => cmd.includes('node.mojom.NodeService'))?.[0];

const reached: Record<string, boolean> = {};
reached.startup = await until(() => count('service_ready') >= 1, 30_000);
sample();
await sleep(IDLE_MS);
reached.idle = app.exitCode === null && app.signalCode === null;
const killed = servicePid();
if (killed) process.kill(killed, 'SIGKILL');
reached['service kill and restart'] = killed !== undefined && await until(() => count('service_ready') >= 2, 30_000);
await sleep(5_000);
sample();
running = false; // shutdown: every process is expected to go
clearInterval(timer);
app.kill('SIGTERM');
const exit = await Promise.race([exited, sleep(20_000).then(() => null)]);
reached.shutdown = exit !== null;
if (!exit) app.kill('SIGKILL');

const unexpected = vanished.filter((pid) => pid !== killed);
let nl;
try { nl = parseNetLog(readFileSync(netlog, 'utf8')); } catch { nl = { parsed: false, events: 0, nonLocal: 0, types: [] }; }
const result = {
  idleSeconds: IDLE_MS / 1000, reached, processesSeen: seen.size, unexpectedDeaths: unexpected.length,
  killedServiceDetected: killed !== undefined && vanished.includes(killed), // positive control for the death detector
  childKillControlDetected: controlDetected, // positive control for the child-kill detector
  childrenKilled: serviceEvents(dataDir).filter((e) => e === 'child_killed').length,
  unexpectedKinds: unexpected.map((p) => /--type=([\w-]+)/.exec(seen.get(p) ?? '')?.[1] ?? 'other'),
  mainExit: exit, serviceRestarts: count('service_restart'),
  netlog: { parsed: nl.parsed, events: nl.events, nonLoopback: nl.nonLocal },
  repoUnchanged: gitStatus(REPO) === gitBefore, fixtureStoresUnchanged: stores() === storesBefore,
};
const pass = Object.values(reached).every(Boolean) && result.killedServiceDetected && controlDetected && result.childrenKilled === 0 && unexpected.length === 0 && exit?.code === 0 && exit.signal === null
  && result.serviceRestarts === 1 && nl.parsed && nl.nonLocal === 0 && result.repoUnchanged && result.fixtureStoresUnchanged;
const out = path.join(REPO, '.cache', 'gate-audit');
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, `audit-${Date.now()}.json`), JSON.stringify({ ...result, pass }, null, 2));
console.log(JSON.stringify({ ...result, pass }, null, 2));
rmSync(root, { recursive: true, force: true });
process.exitCode = pass ? 0 : 1;
