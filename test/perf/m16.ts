// P3-T16b (plan §3.5 M16, M4; D-P3-18), packaged helpers and app, synthetic data only.
// M16: the agent dispatches the packaged hook shim as `/bin/sh -c '<shim> hook claude <profile>'` with a payload on stdin;
//   added wait = p95(shim) - p95(`true`) <= 100 ms per mode (S3 method); 0 stdout/stderr bytes and exit 0 in every run.
//   Forwarder own time: the packaged forwarder spawned directly (no shell, no shim), wall time from spawn to exit. This
//   is an upper bound of its own entry -> exit time (it includes exec and SEA startup); the forwarder has no in-process
//   timer output, by design (M7). Modes: up (the packaged app's service), down (no socket), hung (a socket of the right
//   owner and modes that accepts and never acks), enospc (a full 1 MiB volume on spool/, no socket), cap (spool at its
//   50 MiB cap, no socket). Binds a Unix socket and mounts a disk image: run outside the command sandbox.
// M4: the packaged app on the T1 corpus after its import, window closed (hidden, as the close button does), collecting;
//   app.getAppMetrics() every 1 s for 5 min plus `ps` on the app's process tree; `footprint` every 10 s is the memory check.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeProfile } from '../helpers/hook-socket.ts';
import { close, environment, launch, query, serviceLog, sleep, stats, waitForEvent } from './app.ts';
import { installHelpers } from './emitter.ts';

const BOUND_MS = 100;
const SPOOL_CAP = 50 * (1 << 20); // the forwarder's
const MODES = ['up', 'down', 'hung', 'enospc', 'cap'] as const;
type Mode = (typeof MODES)[number];
const PAYLOAD = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: '00000000-0000-4000-8000-0000000f1600', cwd: '/tmp/xaibo-fixture/perf-m16',
  tool_name: 'Bash', tool_input: { command: 'echo synthetic' }, tool_use_id: 'm16' });

interface Run { ms: number; bytes: number; code: number | null }
function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const c = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let bytes = 0;
    c.stdout.on('data', (d: Buffer) => { bytes += d.length; });
    c.stderr.on('data', (d: Buffer) => { bytes += d.length; });
    c.stdin.on('error', () => undefined); // EPIPE if it stops reading early
    c.on('error', reject);
    c.on('close', (code) => resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes, code }));
    c.stdin.end(PAYLOAD);
  });
}
const sh = (command: string) => run('/bin/sh', ['-c', command], { PATH: '/usr/bin:/bin' });

const spoolLines = (dataDir: string) => {
  const dir = path.join(dataDir, 'spool');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).reduce((n, f) => n + readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.endsWith('}')).length, 0);
};
const overflowLines = (dataDir: string) => {
  const f = path.join(dataDir, 'spool', 'overflow.log');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
};

/** Writes `fill.bin` (not *.jsonl, so the cap check does not count it) until ENOSPC; true when the volume is full. */
function full(dir: string): boolean {
  const fd = openSync(path.join(dir, 'fill.bin'), 'a');
  try { const b = Buffer.alloc(64 * 1024); for (;;) writeSync(fd, b); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOSPC'; } finally { closeSync(fd); }
}

/** The forwarder's spool trust test (forwarder.ts spoolDir): a directory of our own; it fixes the mode itself. */
const ownSpool = (dataDir: string) => { const st = lstatSync(path.join(dataDir, 'spool')); return st.isDirectory() && st.uid === process.getuid?.(); };

/** A data dir with the packaged helpers installed and the fault of `mode` in place; returns the undo. */
async function fault(mode: Exclude<Mode, 'up'>, dataDir: string): Promise<() => Promise<void>> {
  const spool = path.join(dataDir, 'spool');
  if (mode === 'hung') {
    const runDir = path.join(dataDir, 'run');
    mkdirSync(runDir, { mode: 0o700 });
    writeFileSync(path.join(runDir, 'token'), 'synthetic-token', { mode: 0o600 });
    const held = new Set<net.Socket>();
    const server = net.createServer((s) => { held.add(s); s.on('data', () => undefined); s.on('error', () => undefined); s.on('close', () => held.delete(s)); });
    await new Promise<void>((r) => server.listen(path.join(runDir, 'xaibo.sock'), r));
    return async () => { for (const s of held) s.destroy(); await new Promise((r) => server.close(r)); };
  }
  if (mode === 'enospc') {
    const img = path.join(path.dirname(dataDir), 'full.dmg');
    execFileSync('/usr/bin/hdiutil', ['create', '-size', '1m', '-fs', 'HFS+', '-volname', 'xaibo-full', img], { stdio: 'ignore' });
    mkdirSync(spool, { mode: 0o700 });
    execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', spool, img], { stdio: 'ignore' });
    const detach = async () => { execFileSync('/usr/bin/hdiutil', ['detach', spool, '-force'], { stdio: 'ignore' }); };
    try {
      if (!full(spool)) throw new Error('could not fill the volume');
    } catch (e) { await detach(); throw e; }
    return detach;
  }
  if (mode === 'cap') {
    mkdirSync(spool, { mode: 0o700 });
    const f = path.join(spool, '2000-01-01.jsonl');
    closeSync(openSync(f, 'w', 0o600));
    truncateSync(f, SPOOL_CAP); // sparse: counted at its size, no disk used
  }
  return async () => undefined;
}

export async function m16Probe(runs: number) {
  const modes: Record<string, unknown> = {};
  let env: Awaited<ReturnType<typeof environment>> | undefined;
  let ok = true;
  for (const mode of MODES) {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'xm16-')));
    let dataDir = path.join(root, 'data');
    let undo = async () => undefined as void;
    let l: Awaited<ReturnType<typeof launch>> | null = null;
    let profile = 'synthetic-profile';
    const claude = path.join(root, 'claude');
    mkdirSync(path.join(claude, 'projects'), { recursive: true });
    try {
      if (mode === 'up') {
        l = await launch(claude);
        env = await environment(l.app);
        dataDir = l.dataDir;
        profile = await until(() => claudeProfile(dataDir), 30_000);
        await until(() => existsSync(path.join(dataDir, 'run', 'token')), 30_000);
      } else mkdirSync(dataDir, { mode: 0o700 });
      const shim = installHelpers(dataDir);
      const forwarder = path.join(path.dirname(shim), 'xaibo-forwarder');
      if (mode !== 'up') undo = await fault(mode, dataDir);
      const before = { spooled: mode === 'enospc' ? 0 : spoolLines(dataDir), overflow: overflowLines(dataDir) };
      const base: Run[] = []; // review: a per-mode baseline, interleaved, under the same load as the mode
      const dispatch: Run[] = [];
      const direct: Run[] = [];
      for (let i = 0; i < runs; i++) {
        base.push(await sh('true'));
        dispatch.push(await sh(`'${shim}' hook claude ${profile}`));
        direct.push(await run(forwarder, ['hook', 'claude', profile], { PATH: '/usr/bin:/bin', XAIBO_DATA_DIR: dataDir }));
      }
      const all = [...dispatch, ...direct]; // the shim discards all output and exits 0 itself: bytes/exit bind on the direct runs
      const baseline = stats(base.map((r) => r.ms));
      const wait = stats(dispatch.map((r) => r.ms));
      const own = stats(direct.map((r) => r.ms));
      const spooled = mode === 'enospc' ? null : spoolLines(dataDir) - before.spooled;
      const overflow = overflowLines(dataDir) - before.overflow;
      // review: proof the fault path ran, not an early exit: up = every run ingested; enospc = the spool was ours and stayed full
      const ingested = l ? Number(query<number>(dataDir, 'SELECT count(*) FROM hook_delivery')) : null;
      const stillFull = mode === 'enospc' ? ownSpool(dataDir) && full(path.join(dataDir, 'spool')) : null;
      const fails = [
        all.some((r) => r.bytes) && 'output bytes',
        all.some((r) => r.code !== 0) && 'non-zero exit',
        wait.p95 - baseline.p95 > BOUND_MS && 'added wait p95',
        own.p95 > BOUND_MS && 'forwarder own time p95 (upper bound)',
        mode === 'up' && (spooled !== 0 || ingested !== all.length) && 'not every run ingested with the service up',
        (mode === 'down' || mode === 'hung') && spooled !== all.length && 'not every run spooled',
        mode === 'enospc' && !stillFull && 'spool not ours or volume not full',
        mode === 'cap' && (spooled !== 0 || overflow === 0) && 'spool grew past its cap or no overflow line',
      ].filter(Boolean);
      ok &&= fails.length === 0;
      modes[mode] = { baselineTrue: baseline, dispatch: wait, addedWaitP50: wait.p50 - baseline.p50, addedWaitP95: wait.p95 - baseline.p95, forwarderOwnUpperBound: own,
        ownOver100: direct.filter((r) => r.ms > BOUND_MS).length, outputBytes: all.reduce((n, r) => n + r.bytes, 0), nonZeroExit: all.filter((r) => r.code !== 0).length,
        spooled, ingested, overflowLines: overflow, spoolFullAndOwn: stillFull, fails };
    } finally {
      try { await undo(); } finally {
        try { if (l) await close(l); } finally { rmSync(root, { recursive: true, force: true }); }
      }
    }
  }
  return { metric: 'm16', boundMs: BOUND_MS, runs, modes,
    notes: 'Added wait = p95(shim via /bin/sh -c) - p95(true via /bin/sh -c), interleaved per mode, serial; the 50-way burst miss is accepted (D-P0-22). '
      + 'Forwarder own time is the direct-spawn wall (exec + SEA startup + run), an upper bound; the in-process deadline is 60 ms after entry. '
      + 'enospc spools nothing countable (the volume is full). Tee overhead: --only tee --packaged.',
    pass: ok, env };
}

async function until<T>(f: () => T | null | false, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (let v = f(); ; v = f()) {
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------------------------------------------
const M4_MB = 250;
const M4_CPU = 1;

/** The pids under `roots` (inclusive) with their RSS (KiB) and %CPU from one `ps` call. */
function psTree(roots: number[]) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,pcpu='], { encoding: 'utf8' }).split('\n').filter(Boolean)
    .map((l) => { const [pid, ppid, rss, cpu] = l.trim().split(/\s+/).map(Number); return { pid: pid!, ppid: ppid!, rss: rss!, cpu: cpu! }; });
  const mine = new Set(roots);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true; } }
  return rows.filter((r) => mine.has(r.pid));
}

/** Sum over pids of the first `Footprint:` figure `footprint <pid>` prints, in MiB (one pid per call: no total line
 *  to double-count); null if any cannot be read. */
function footprintMiB(pids: number[]): number | null {
  const unit = { KB: 1 / 1024, MB: 1, GB: 1024 } as Record<string, number>;
  let sum = 0;
  for (const pid of pids) {
    try {
      // the header line reads "<name> [<pid>]: 64-bit    Footprint: 1760 KB (…)"
      const m = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(execFileSync('/usr/bin/footprint', [String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      if (!m) return null;
      sum += Number(m[1]) * unit[m[2]!]!;
    } catch { return null; }
  }
  return sum;
}

export async function m4Probe(corpus: string, seconds: number) {
  const l = await launch(path.join(corpus, '.claude'));
  try {
    const env = await environment(l.app);
    const done = await waitForEvent(l.dataDir, 'backfill_done', 30 * 60_000);
    if (done === null) throw new Error('import never finished');
    const imported = serviceLog(l.dataDir).find((e) => e.event === 'backfill_done') as { profiles?: number } | undefined;
    if (!imported?.profiles) throw new Error('nothing imported: the corpus profile was not found'); // P3-T16b: a wrong path measured an empty app
    await l.app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); }); // hides (tray app)
    const visible = await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()));
    await sleep(10_000); // the close settles
    type Sample = { metricsMiB: number; metricsCpu: number; psRssMiB: number; psCpu: number; processes: number };
    const samples: Sample[] = [];
    const footprints: (number | null)[] = []; // every 10 s (owner 2026-11-13: M4 memory = summed phys_footprint)
    await l.app.evaluate(({ app }) => void app.getAppMetrics()); // starts the percentCPUUsage interval
    for (let i = 0; i < seconds; i++) {
      await sleep(1000);
      const m = await l.app.evaluate(({ app }) => app.getAppMetrics().map((p) => ({ pid: p.pid, kb: p.memory.workingSetSize, cpu: p.cpu.percentCPUUsage })));
      const tree = psTree(m.map((p) => p.pid));
      samples.push({ metricsMiB: m.reduce((s, p) => s + p.kb, 0) / 1024, metricsCpu: m.reduce((s, p) => s + p.cpu, 0),
        psRssMiB: tree.reduce((s, p) => s + p.rss, 0) / 1024, psCpu: tree.reduce((s, p) => s + p.cpu, 0), processes: tree.length });
      if (i % 10 === 9) footprints.push(footprintMiB(tree.map((p) => p.pid)));
    }
    const s = (k: keyof Sample) => stats(samples.map((x) => x[k]));
    const cpu = s('metricsCpu');
    const fp = footprints.every((x) => x !== null) ? stats(footprints as number[]) : null;
    const checks = { fiveMinutes: seconds >= 300, windowHidden: !visible, footprint: fp !== null && fp.max <= M4_MB * 1e6 / 2 ** 20, cpu: cpu.mean <= M4_CPU };
    const result = { metric: 'm4', seconds, targets: { footprintMB: M4_MB, cpuPercentMean: M4_CPU }, footprintMiB: fp,
      psRssMiB: s('psRssMiB'), psRssMiBPerMinute: Array.from({ length: Math.ceil(samples.length / 60) }, (_, i) => stats(samples.slice(i * 60, i * 60 + 60).map((x) => x.psRssMiB)).mean),
      metricsWorkingSetMiB: s('metricsMiB'), cpuPercent: cpu, psCpuPercent: s('psCpu'), processes: s('processes'),
      notes: 'Memory checked as the max of the summed macOS phys_footprint of the app tree every 10 s (owner 2026-11-13; MB = 10^6 bytes); summed RSS '
        + 'is reported only (it counts shared framework pages once per process). CPU = mean of the summed getAppMetrics percentCPUUsage (percent of '
        + 'one core); it includes the probe\'s own 1 s app.evaluate polling in main, so it slightly overstates idle CPU.',
      checks, pass: Object.values(checks).every(Boolean), env };
    const quit = await close(l);
    return { ...result, quitTimedOut: quit.timedOut }; // reported, not a check: the quit path is investigated separately
  } catch (e) {
    await close(l);
    throw e;
  }
}
