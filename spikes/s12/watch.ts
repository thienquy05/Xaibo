// S12 watcher/FD strategy and reconciliation interval (P0-S12-T6), personal profile (owner decision 2026-11-10):
// a 1,000-file synthetic tree (Claude projects/<dir>/<id>.jsonl, Codex sessions/YYYY/MM/DD/) with 5 active appenders
// at ~20 events/s and a 50 events/s burst; one ~3x probe (15 appenders, 60/s, burst 150/s); scan cost at 1k and 10k.
// Watcher side runs on the packaged runtime (run.ts --watch); appenders are separate system-Node processes
// (`node spikes/s12/watch.ts --append ...`). Cross-process latency uses process.hrtime (mach absolute time, system-wide).
// Writes .cache/spike-results/s12/watch.json (raw) and spikes/s12/evidence/watch.json (reduced; no paths).
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, unwatchFile, watch, watchFile, writeFileSync, writeSync, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { envRecord, hr, mulberry32, summary } from '../shared/bench.ts';
import { LIVE, liveSizes, SCALE, SEEDS } from './gen.ts';

const SEED_TREE = SEEDS.build + 1; // 12006: tree layout and active-file choice
const SEED_APPEND = SEEDS.build + 2; // 12007: appender schedules (liveSizes seed)
const POLL_MS = 1000; // fs.watchFile interval for strategy (c); Node's default is 5007 ms
const IDLE_S = 10, SETTLE_MS = 2000, SCANS = 20;
const INTERVALS = [2, 5, 10, 15, 30, 60];
const RULE = { cpuFraction: 0.0025, wallFraction: 0.1 }; // OQ-A10
// Watch run: the T1 live profile reshaped to 15 s (5 s burst first, then base rate), so every run sees one burst.
const RUN = { seconds: 15, burstEverySeconds: 15, burstSeconds: 5 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- appender mode (system Node): appends synthetic JSONL lines to the given files on the liveSizes schedule ----
const { values: a } = parseArgs({ options: { append: { type: 'boolean' }, scale: { type: 'boolean' }, file: { type: 'string', multiple: true } }, strict: false });
if (a.append) {
  const files = a.file as string[];
  const plan = liveSizes({ ...(a.scale ? SCALE : LIVE), ...RUN, sessions: files.length, seed: SEED_APPEND });
  const fds = files.map((f) => openSync(f, 'a'));
  const t0 = performance.now();
  let slip = 0;
  for (let i = 0; i < plan.bytes.length; i++) {
    const wait = plan.atMs[i] - (performance.now() - t0);
    if (wait > 1) await sleep(wait); else slip = Math.max(slip, -wait);
    const head = `{"t":"${hr()}","s":${i},"p":"`;
    writeSync(fds[plan.session[i]], head + 'x'.repeat(Math.max(0, plan.bytes[i] - head.length - 3)) + '"}\n');
  }
  for (const fd of fds) closeSync(fd);
  process.stdout.write(JSON.stringify({ written: plan.bytes.length, maxSlipMs: Math.round(slip) }));
  process.exit(0);
}

// ---- watcher mode (packaged runtime) ----
const REPO = join(import.meta.dirname, '..', '..', '..', '..'); // compiled to spikes/app/build/s12/
const TREE = join(REPO, '.cache', 'spike-data', 's12', 'tree');
const RAW = join(REPO, '.cache', 'spike-results', 's12', 'watch.json');
const EVIDENCE = join(REPO, 'spikes', 's12', 'evidence', 'watch.json');
const APPENDER = join(REPO, 'spikes', 's12', 'watch.ts');
const log = (m: string) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);

// Synthetic tree: 60% Claude projects/<dir>/<uuid>.jsonl (~30 dirs), 40% Codex sessions/YYYY/MM/DD/rollout-*.jsonl.
function makeTree(n: number) {
  const root = join(TREE, `${n}`);
  rmSync(root, { recursive: true, force: true });
  const r = mulberry32(SEED_TREE + n);
  const hex = (k: number) => Array.from({ length: k }, () => Math.floor(r() * 16).toString(16)).join('');
  const roots = [join(root, 'claude', 'projects'), join(root, 'codex', 'sessions')];
  const files: string[] = [];
  for (let i = 0; i < n; i++) {
    let dir: string, name: string;
    if (i < n * 0.6) { dir = join(roots[0], `-synthetic-proj-${String(Math.floor(r() * 30)).padStart(2, '0')}`); name = `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}.jsonl`; }
    else {
      const d = new Date(Date.UTC(2026, 0, 1) + Math.floor(r() * 180) * 86_400_000);
      const ymd = [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')];
      dir = join(roots[1], ...ymd.map(String)); name = `rollout-${ymd.join('-')}T00-00-00-${hex(8)}.jsonl`;
    }
    mkdirSync(dir, { recursive: true });
    const f = join(dir, name);
    writeFileSync(f, `{"type":"synthetic","i":${i}}\n`.repeat(1 + Math.floor(r() * 32)));
    files.push(f);
  }
  return { roots, files, r };
}

const fdCount = () => readdirSync('/dev/fd').length;
const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

type Strategy = 'recursive' | 'perFile' | 'poll';
async function runStrategy(s: Strategy, tree: ReturnType<typeof makeTree>, active: string[], scale: boolean) {
  const offsets = new Map(active.map((f) => [f, statSync(f).size]));
  const lat: number[] = [];
  let events = 0, eventsActive = 0;
  const consume = (f: string, sink: number[] | null) => {
    const off = offsets.get(f);
    if (off === undefined) return 0;
    const fd = openSync(f, 'r');
    const size = fstatSync(fd).size;
    if (size <= off) { closeSync(fd); return 0; }
    const buf = Buffer.alloc(size - off);
    readSync(fd, buf, 0, buf.length, off);
    closeSync(fd);
    const end = buf.lastIndexOf(10);
    if (end < 0) return 0;
    offsets.set(f, off + end + 1);
    const now = hr();
    let n = 0;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      const m = /^\{"t":"(\d+)"/.exec(line);
      if (!m) continue;
      n++;
      sink?.push(Number(now - BigInt(m[1])) / 1e6);
    }
    return n;
  };
  const onPath = (f: string) => { events++; if (offsets.has(f)) { eventsActive++; consume(f, lat); } };

  const fd0 = fdCount();
  const watchers: FSWatcher[] = [];
  if (s === 'recursive') for (const root of tree.roots) watchers.push(watch(root, { recursive: true }, (_e, name) => name && onPath(join(root, name.toString()))));
  if (s === 'perFile') for (const f of active) watchers.push(watch(f, () => onPath(f)));
  if (s === 'poll') for (const f of tree.files) watchFile(f, { interval: POLL_MS }, (c, p) => { if (c.size !== p.size || c.mtimeMs !== p.mtimeMs) onPath(f); });
  // libuv reports EMFILE when FSEventStreamStart fails (e.g. FSEvents denied by a command sandbox): record, do not crash.
  let watchError: string | null = null;
  for (const w of watchers) w.on('error', (e: NodeJS.ErrnoException) => { watchError ??= e.code ?? e.message; });
  await sleep(1000);
  const fds = fdCount() - fd0;
  if (watchError) {
    for (const w of watchers) w.close();
    log(`${s}${scale ? ' (3x)' : ''}: watcher error ${watchError}`);
    return { strategy: s, scale, appenders: active.length, error: `${watchError} (FSEventStreamStart failed; FSEvents unavailable in this run's sandbox)`, extraFds: fds };
  }

  let idleCpuPct: number | null = null;
  if (!scale) {
    const c0 = cpuMs(), t0 = performance.now();
    await sleep(IDLE_S * 1000);
    idleCpuPct = (100 * (cpuMs() - c0)) / (performance.now() - t0);
  }
  events = eventsActive = 0;
  const c1 = cpuMs(), t1 = performance.now();
  const child = spawn('node', [APPENDER, '--append', ...(scale ? ['--scale'] : []), ...active.flatMap((f) => ['--file', f])], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const code = await new Promise<number | null>((res) => child.on('exit', res));
  if (code !== 0) throw new Error(`appender exited ${code}`);
  await sleep(SETTLE_MS);
  const loadCpuPct = (100 * (cpuMs() - c1)) / (performance.now() - t1);
  let missed = 0;
  for (const f of active) missed += consume(f, null); // lines no watch event delivered within SETTLE_MS of the run's end
  for (const w of watchers) w.close();
  if (s === 'poll') for (const f of tree.files) unwatchFile(f);
  const ap = JSON.parse(out) as { written: number; maxSlipMs: number };
  const l = summary(lat.length ? lat : [NaN]);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const res = { strategy: s, scale, appenders: active.length, written: ap.written, seenViaEvents: lat.length, missed, lost: ap.written - lat.length - missed,
    events, eventsOnActive: eventsActive, latencyMs: { p50: r2(l.p50), p95: r2(l.p95), p99: r2(l.p99), max: r2(l.max) },
    watchedFiles: s === 'recursive' ? tree.files.length : s === 'perFile' ? active.length : tree.files.length, extraFds: fds, idleCpuPct: idleCpuPct === null ? null : r2(idleCpuPct), loadCpuPct: r2(loadCpuPct), appenderMaxSlipMs: ap.maxSlipMs };
  log(`${s}${scale ? ' (3x)' : ''}: p95 ${res.latencyMs.p95} ms max ${res.latencyMs.max}, missed ${missed}, lost ${res.lost}, fds +${fds}, idle ${res.idleCpuPct}%`);
  return res;
}

// Reconciliation scan: readdir + stat every *.jsonl, compare (size, mtime, ino) with the checkpoint map.
type Cp = Map<string, { size: number; mtimeMs: number; ino: number }>;
function scanSync(dir: string, cp: Cp, acc = { files: 0, changed: 0 }) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) scanSync(p, cp, acc);
    else if (e.name.endsWith('.jsonl')) {
      const st = statSync(p); const c = cp.get(p); acc.files++;
      if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs || c.ino !== st.ino) { acc.changed++; cp.set(p, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }); }
    }
  }
  return acc;
}
async function scanAsync(dir: string, cp: Cp, acc = { files: 0, changed: 0 }) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await scanAsync(p, cp, acc);
    else if (e.name.endsWith('.jsonl')) {
      const st = await stat(p); const c = cp.get(p); acc.files++;
      if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs || c.ino !== st.ino) { acc.changed++; cp.set(p, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }); }
    }
  }
  return acc;
}

function intervalRule(meanCpuMs: number, maxWallMs: number) {
  const ok = INTERVALS.find((s) => meanCpuMs <= RULE.cpuFraction * s * 1000 && maxWallMs <= RULE.wallFraction * s * 1000);
  return { intervalS: ok ?? null, recoveryS: ok === undefined ? null : ok + 1 };
}

async function scanCost(n: number, tree: ReturnType<typeof makeTree>, mode: 'sync' | 'async') {
  const cp: Cp = new Map();
  const first = mode === 'sync' ? tree.roots.map((r) => scanSync(r, cp)) : await Promise.all(tree.roots.map((r) => scanAsync(r, cp)));
  if (first.reduce((x, y) => x + y.files, 0) !== n) throw new Error(`scan saw ${first.reduce((x, y) => x + y.files, 0)} files, want ${n}`);
  const wall: number[] = [], cpu: number[] = [];
  let changed = 0;
  for (let i = 0; i < SCANS; i++) {
    const c0 = cpuMs(), t0 = performance.now();
    for (const r of tree.roots) changed += (mode === 'sync' ? scanSync(r, cp) : await scanAsync(r, cp)).changed;
    wall.push(performance.now() - t0); cpu.push(cpuMs() - c0);
  }
  const w = summary(wall), c = summary(cpu);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const rule = intervalRule(c.mean, w.max);
  const res = { files: n, mode, scans: SCANS, changedOnIdle: changed, wallMs: { mean: r2(w.mean), p95: r2(w.p95), max: r2(w.max) }, cpuMs: { mean: r2(c.mean), p95: r2(c.p95), max: r2(c.max) },
    cpuPctOfCoreAt: Object.fromEntries(INTERVALS.map((s) => [`${s}s`, r2((100 * c.mean) / (s * 1000))])), rule };
  log(`scan ${n} ${mode}: wall mean ${res.wallMs.mean} max ${res.wallMs.max} ms, cpu mean ${res.cpuMs.mean} ms -> interval ${rule.intervalS}s`);
  return res;
}

const lim = execFileSync('/bin/launchctl', ['limit', 'maxfiles'], { encoding: 'utf8' }).trim().split(/\s+/);
const maxfiles = { soft: lim[1], hard: lim[2] };
log(`launchctl maxfiles soft ${maxfiles.soft} hard ${maxfiles.hard}; building trees`);
const tree1k = makeTree(1_000);
const tree10k = makeTree(10_000);
const pick = (t: ReturnType<typeof makeTree>, k: number) => { const idx = new Set<number>(); while (idx.size < k) idx.add(Math.floor(t.r() * t.files.length)); return [...idx].map((i) => t.files[i]); };
const active5 = pick(tree1k, LIVE.sessions);
const active15 = [...active5, ...pick(tree1k, SCALE.sessions).filter((f) => !active5.includes(f))].slice(0, SCALE.sessions);

const c0 = cpuMs(), t0 = performance.now();
await sleep(5000);
const baselineIdleCpuPct = Math.round(((100 * (cpuMs() - c0)) / (performance.now() - t0)) * 100) / 100;
const watchers = [];
for (const s of ['recursive', 'perFile', 'poll'] as Strategy[]) watchers.push(await runStrategy(s, tree1k, active5, false));
for (const s of ['recursive', 'perFile'] as Strategy[]) watchers.push(await runStrategy(s, tree1k, active15, true));
const scans = [];
for (const [n, t] of [[1_000, tree1k], [10_000, tree10k]] as const) for (const m of ['sync', 'async'] as const) scans.push(await scanCost(n, t, m));

const out = {
  tag: 'spike, not gate evidence',
  task: 'P0-S12-T6',
  profile: { name: 'personal (owner decision 2026-11-10; overrides plan scale 50 appenders / 200 events/s)', estimate: '~',
    run: { appenders: LIVE.sessions, ratePerS: LIVE.ratePerS, burstPerS: LIVE.burstPerS, ...RUN, meanBytes: LIVE.meanBytes, maxBytes: LIVE.maxBytes },
    scaleProbe: { appenders: SCALE.sessions, ratePerS: SCALE.ratePerS, burstPerS: SCALE.burstPerS, ...RUN } },
  runtime: 'watchers and scans: packaged Electron runtime (ELECTRON_RUN_AS_NODE=1); appenders: system Node child processes',
  env: envRecord(), appenderNode: execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(),
  seeds: { tree: SEED_TREE, appendSchedule: SEED_APPEND },
  tree: { files1k: tree1k.files.length, files10k: tree10k.files.length, layout: '60% claude/projects/<dir>/<uuid>.jsonl over ~30 dirs, 40% codex/sessions/YYYY/MM/DD/rollout-*.jsonl over 180 days' },
  method: { pollIntervalMs: POLL_MS, idleSeconds: IDLE_S, settleMs: SETTLE_MS, missed: `lines not delivered by any watch event within ${SETTLE_MS} ms after the last append (recovered by a final read)`,
    latency: 'append (hrtime stamp before write) -> watch callback reads the line; coalesced events count from each line\'s own stamp', fds: '/dev/fd entries after watcher setup minus before', idleCpu: 'process.cpuUsage over the idle window, % of one core', scan: 'readdir + stat of every *.jsonl vs (size, mtime, ino) checkpoint map; first scan primes the map, then timed scans' },
  launchctlMaxfiles: maxfiles,
  baselineIdleCpuPct,
  watchers,
  scans,
  intervalRule: { rule: 'smallest of {2,5,10,15,30,60} s with mean scan CPU <= 0.25% of one core and max scan wall <= 10% of the interval (OQ-A10); recovery = interval + 1 s',
    personal1k: Object.fromEntries(scans.filter((x) => x.files === 1_000).map((x) => [x.mode, x.rule])), scaleUp10k: Object.fromEntries(scans.filter((x) => x.files === 10_000).map((x) => [x.mode, x.rule])) },
};
const text = JSON.stringify(out, null, 1) + '\n';
writeFileSync(RAW, text);
writeFileSync(EVIDENCE, text);
log('done');
process.exit(0);
