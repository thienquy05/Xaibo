// S3 dispatch bench (P0-S3-T1): mimics command-hook dispatch (`/bin/sh -c <hook>`, JSON on stdin) per candidate
// and failure mode; asserts 0 output bytes, exit 0, the forwarder's own entry->exit deadline (M16) and the added
// wait vs `true`. Hosts the receiver in-process (system Node). Run unsandboxed:
//   node spikes/s3/dispatch-bench.ts --candidate system-node|electron-node|sea [--modes up,nosocket,…] [--n 1000] [--idle]
// Raw results: .cache/spike-results/s3/ (git-ignored; no paths).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { hr, summary, type Summary } from '../shared/bench.ts';
import { startReceiver } from './receiver.ts';

const REPO = join(import.meta.dirname, '..', '..');
const APP = join(REPO, 'dist/spike/mac-arm64/XaiboSpike.app');
const SHIM = join(REPO, 'spikes/s3/shim.sh');
const OUT = join(REPO, '.cache', 'spike-results', 's3');
const OWN_DEADLINE_MS = 100;
const ADDED_WAIT_MS = 100;
const IDLE_MS = 60_000;
const CONCURRENCY = 50;
const ALL_MODES = ['up', 'nosocket', 'noack', 'fulldisk', 'malformed', 'big300k', 'big10m', 'stdinopen', 'concurrent'] as const;
type Mode = (typeof ALL_MODES)[number];

const { values } = parseArgs({ options: { candidate: { type: 'string' }, modes: { type: 'string' }, n: { type: 'string' }, idle: { type: 'boolean' } } });
const candidate = values.candidate ?? '';
const N = Number(values.n ?? 1000);
const modes = (values.modes?.split(',') ?? ALL_MODES) as Mode[];

const payload = (bytes = 0) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: '00000000-0000-4000-8000-000000000001', cwd: '/tmp/xaibo-fixture/p', tool_name: 'Bash', pad: 'x'.repeat(bytes) });

interface Run { ms: number; out: number; err: number; code: number | null }
function dispatch(cmd: string, env: NodeJS.ProcessEnv, stdin: string | Buffer | null): Promise<Run> {
  return new Promise((res) => {
    const t0 = hr();
    const c = spawn('/bin/sh', ['-c', cmd], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = 0, err = 0;
    c.stdout.on('data', (d: Buffer) => { out += d.length; });
    c.stderr.on('data', (d: Buffer) => { err += d.length; });
    c.stdin.on('error', () => {}); // EPIPE when the forwarder stops reading early
    c.on('exit', (code) => res({ ms: Number(hr() - t0) / 1e6, out, err, code }));
    if (stdin !== null) c.stdin.end(stdin); // null = never closed (stdinopen mode)
  });
}

function ownTimes(statsFile: string): number[] {
  if (!existsSync(statsFile)) return [];
  return readFileSync(statsFile, 'utf8').split('\n').filter(Boolean).map((l) => { const [a, b] = l.split('\t'); return Number(BigInt(b) - BigInt(a)) / 1e6; });
}

function spooled(dir: string): number {
  const s = join(dir, 'spool');
  if (!existsSync(s)) return 0;
  return readdirSync(s).filter((f) => f.endsWith('.jsonl')).reduce((a, f) => a + readFileSync(join(s, f), 'utf8').split('\n').filter(Boolean).length, 0);
}

async function runMode(mode: Mode, baseline: Summary) {
  const dir = mkdtempSync(join(tmpdir(), 's3-'));
  const stats = join(dir, 'fwd-stats.tsv');
  // A and B must work with no system Node reachable; only the system-node logic check gets Node's dir.
  const PATH = candidate === 'system-node' ? `/usr/bin:/bin:${dirname(process.execPath)}` : '/usr/bin:/bin';
  const env: NodeJS.ProcessEnv = { PATH, ...(process.env.XAIBO_FWD_DEADLINE_MS ? { XAIBO_FWD_DEADLINE_MS: process.env.XAIBO_FWD_DEADLINE_MS } : {}), XAIBO_DATA_DIR: dir, XAIBO_FWD_CANDIDATE: candidate, XAIBO_APP: APP, XAIBO_FWD_STATS: stats, XAIBO_REPO: REPO };
  const cmd = `${SHIM} claude PreToolUse`;
  let rx: Awaited<ReturnType<typeof startReceiver>> | null = null;
  let mounted = false;
  if (mode === 'fulldisk') {
    const img = join(dir, 'full.dmg');
    execFileSync('/usr/bin/hdiutil', ['create', '-size', '1m', '-fs', 'HFS+', '-volname', 'xaibo-full', img], { stdio: 'ignore' });
    mkdirSync(join(dir, 'spool'));
    execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', join(dir, 'spool'), img], { stdio: 'ignore' });
    mounted = true;
  }
  if (['up', 'malformed', 'big300k', 'big10m', 'stdinopen', 'concurrent'].includes(mode)) rx = await startReceiver({ dataDir: dir, ackPoint: 'volatile' });
  if (mode === 'noack') rx = await startReceiver({ dataDir: dir, ackPoint: 'volatile', noAck: true });
  // `in`, not `??`: stdinopen's null (stdin never closed) must survive.
  const special: Record<string, string | Buffer | null> = {
    malformed: 'this is { not json', big300k: payload(300 * 1024), big10m: Buffer.alloc(10 * 1024 * 1024, 0x61), stdinopen: null, fulldisk: payload(8 * 1024),
  };
  const stdinFor = (): string | Buffer | null => (mode in special ? special[mode]! : payload());
  if (mode === 'stdinopen' && stdinFor() !== null) throw new Error('stdinopen must leave stdin open');
  const runs: Run[] = [];
  try {
    if (mode === 'concurrent') {
      for (let r = 0; r < N / CONCURRENCY; r++) runs.push(...await Promise.all(Array.from({ length: CONCURRENCY }, () => dispatch(cmd, env, stdinFor()))));
    } else {
      for (let i = 0; i < N; i++) runs.push(await dispatch(cmd, env, stdinFor()));
    }
    let idle: Summary | null = null;
    if (values.idle && mode === 'up') {
      await sleep(IDLE_MS);
      const cold: Run[] = [];
      for (let i = 0; i < 10; i++) cold.push(await dispatch(cmd, env, stdinFor()));
      idle = summary(cold.map((r) => r.ms));
    }
    const own = ownTimes(stats);
    const wait = summary(runs.map((r) => r.ms));
    const overflowFile = join(dir, 'run', 'spool-overflow');
    const result = {
      candidate, mode, n: runs.length,
      bytes: runs.reduce((a, r) => a + r.out + r.err, 0),
      nonZeroExit: runs.filter((r) => r.code !== 0).length,
      wait, addedP95: wait.p95 - baseline.p95,
      own: own.length ? summary(own) : null, ownRecorded: own.length,
      delivered: rx?.stats.delivered ?? 0, spooled: mounted ? null : spooled(dir),
      overflow: existsSync(overflowFile) ? Number(readFileSync(overflowFile, 'utf8') || 0) : 0,
      idle,
    };
    const fails = [
      result.bytes !== 0 && 'output bytes',
      result.nonZeroExit !== 0 && 'non-zero exit',
      result.ownRecorded !== runs.length + (idle ? 10 : 0) && 'forwarder did not report every run',
      result.own && result.own.max > OWN_DEADLINE_MS && 'own deadline (max > 100 ms)',
      result.addedP95 > ADDED_WAIT_MS && 'added wait p95 > 100 ms',
      ['up', 'malformed', 'big300k'].includes(mode) && result.delivered !== runs.length + (idle ? 10 : 0) && 'not every run delivered',
      mode === 'concurrent' && result.delivered + (result.spooled ?? 0) < runs.length && 'a run was neither delivered nor spooled',
      ['nosocket', 'noack'].includes(mode) && result.spooled !== runs.length && 'not every run spooled',
      mode === 'fulldisk' && result.overflow === 0 && 'full disk produced no overflow count',
    ].filter(Boolean);
    writeFileSync(join(OUT, `${candidate}-${mode}.json`), JSON.stringify({ ...result, fails }, null, 2));
    console.log(`${candidate} ${mode}: ${fails.length ? `FAIL ${fails.join('; ')}` : 'pass'} (wait p95 ${wait.p95.toFixed(1)} ms, added ${result.addedP95.toFixed(1)} ms, own max ${result.own?.max.toFixed(1) ?? '-'} ms)`);
    return fails.length === 0;
  } finally {
    await rx?.close();
    if (mounted) execFileSync('/usr/bin/hdiutil', ['detach', join(dir, 'spool'), '-force'], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  }
}

const CANDIDATES = ['system-node', 'electron-node', 'electron-node-asar', 'sea', 'sea-nocache'];
if (!CANDIDATES.includes(candidate)) { console.log(`usage: --candidate ${CANDIDATES.join('|')}`); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const base: Run[] = [];
for (let i = 0; i < N; i++) base.push(await dispatch('true', { PATH: '/usr/bin:/bin' }, payload()));
const baseline = summary(base.map((r) => r.ms));
writeFileSync(join(OUT, 'baseline-true.json'), JSON.stringify(baseline, null, 2));
let ok = true;
for (const m of modes) ok = (await runMode(m, baseline)) && ok;
process.exitCode = ok ? 0 : 1;
