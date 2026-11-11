// S3 end-to-end hop bench (P0-S3-T7): packaged app in mode s3, hooks dispatched through the shim per candidate,
// hops dispatch/spawn, forwarder, transport, service, renderer+paint (upper bound incl. return hop) and end-to-end
// p50/p95/p99/max; candidate C via a synthetic loopback POST. Also the clock sanity check and both ack points.
// Run unsandboxed after `npm run spike:dist:mac`: node spikes/s3/e2e.ts [--n 1000]
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { hr, summary } from '../shared/bench.ts';

const REPO = join(import.meta.dirname, '..', '..');
const APP = join(REPO, 'dist/spike/mac-arm64/XaiboSpike.app');
const OUT = join(REPO, '.cache', 'spike-results', 's3');
const M1_MS = 250;
const { values } = parseArgs({ options: { n: { type: 'string' } } });
const N = Number(values.n ?? 1000);

type Msg = Record<string, any>;
function launch(dataDir: string, ack: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, XAIBO_DATA_DIR: dataDir, XAIBO_SPIKE_MODE: 's3', XAIBO_S3_ACK: ack };
  delete env.ELECTRON_RUN_AS_NODE;
  const child: ChildProcess = spawn(join(APP, 'Contents/MacOS/XaiboSpike'), [], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  const msgs: Msg[] = [];
  let buf = '';
  child.stdout!.on('data', (d: Buffer) => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) { try { msgs.push(JSON.parse(buf.slice(0, i))); } catch { /* ignore */ } } });
  return { child, msgs };
}
async function waitFor(msgs: Msg[], pred: (m: Msg) => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!msgs.some(pred)) { if (Date.now() > end) throw new Error('timeout'); await sleep(20); }
}

function dispatch(dataDir: string, candidate: string, benchId: string): Promise<bigint> {
  return new Promise((res) => {
    const t0 = hr();
    const env = { PATH: '/usr/bin:/bin', XAIBO_DATA_DIR: dataDir, XAIBO_FWD_CANDIDATE: candidate, XAIBO_APP: APP };
    const c = spawn('/bin/sh', ['-c', `${join(REPO, 'spikes/s3/shim.sh')} claude PreToolUse`], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('exit', () => res(t0));
    c.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: '00000000-0000-4000-8000-000000000001', bench_id: benchId }));
  });
}

function post(port: number, token: string, benchId: string): Promise<number> {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: '00000000-0000-4000-8000-000000000001', bench_id: benchId });
    const t0 = hr();
    const r = request({ host: '127.0.0.1', port, method: 'POST', path: '/hook', headers: { 'content-type': 'application/json', 'x-xaibo-token': token } }, (resp) => { resp.resume(); resp.on('end', () => res(Number(hr() - t0) / 1e6)); });
    r.on('error', rej);
    r.end(body);
  });
}

async function clockSanity(): Promise<boolean> {
  const child = spawn(process.execPath, ['-e', "process.stdin.on('data', (d) => { for (const l of String(d).split('\\n').filter(Boolean)) process.stdout.write(l + ' ' + process.hrtime.bigint() + '\\n'); })"], { stdio: ['pipe', 'pipe', 'ignore'] });
  let ok = true;
  let buf = '';
  let got = 0;
  const done = new Promise<void>((res) => child.stdout!.on('data', (d: Buffer) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) { const [a, b] = buf.slice(0, i).split(' ').map(BigInt); if (!(a < b)) ok = false; if (++got === 1000) res(); }
  }));
  for (let i = 0; i < 1000; i++) { child.stdin!.write(`${hr()}\n`); await sleep(0); }
  await done;
  child.kill();
  return ok;
}

const ms = (a: string, b: string) => Number(BigInt(b) - BigInt(a)) / 1e6;
mkdirSync(OUT, { recursive: true });
const clockOk = await clockSanity();
const report: Record<string, unknown> = { clockOk };
let pass = true;
for (const ack of ['volatile', 'commit']) {
  const dir = mkdtempSync(join(tmpdir(), 's3e2e-'));
  const app = launch(dir, ack);
  try {
    await waitFor(app.msgs, (m) => 's3-ready' in m);
    await waitFor(app.msgs, (m) => m.smoke === 'paint-ack');
    const token = readFileSync(join(dir, 'run', 'token'), 'utf8');
    const port = JSON.parse(readFileSync(join(dir, 'run', 'http.json'), 'utf8')).port as number;
    for (const candidate of ack === 'volatile' ? ['electron-node', 'sea', 'http'] : ['sea']) {
      const t0s = new Map<string, bigint>();
      const clientMs: number[] = [];
      for (let i = 0; i < N; i++) {
        const id = `${candidate}-${ack}-${i}`; // unique across candidates and ack points
        if (candidate === 'http') { t0s.set(id, hr()); clientMs.push(await post(port, token, id)); }
        else t0s.set(id, await dispatch(dir, candidate, id));
      }
      const mine = () => app.msgs.filter((m) => t0s.has(m['s3-hop']?.bench_id)).map((m) => m['s3-hop']);
      for (let w = 0; w < 50 && mine().length < N; w++) await sleep(100); // late paint acks
      const recs = mine().map((r) => ({ ...r, tag: r.bench_id }));
      const viaSocket = candidate !== 'http';
      const hops: Record<string, number[]> = { service: [], renderer_paint: [] };
      if (viaSocket) Object.assign(hops, { forwarder: [], transport: [] });
      const missing = recs.filter((r) => ['t_recv', 't_publish', 't_paint_ack', ...(viaSocket ? ['t_entry', 't_send'] : [])].some((k) => !r[k]));
      const negative: string[] = [];
      for (const r of recs) {
        if (viaSocket) { hops.forwarder.push(ms(r.t_entry, r.t_send)); hops.transport.push(ms(r.t_send, r.t_recv)); }
        hops.service.push(ms(r.t_recv, r.t_publish));
        hops.renderer_paint.push(ms(r.t_publish, r.t_paint_ack));
      }
      for (const [k, v] of Object.entries(hops)) if (v.some((x) => x < 0)) negative.push(k);
      const e2e = recs.map((r) => ms(String(t0s.get(r.tag)), r.t_paint_ack));
      const spawnHop = viaSocket ? recs.map((r) => ms(String(t0s.get(r.tag)), r.t_entry)) : [];
      const row = {
        n: N, received: recs.length, missingStamps: missing.length, negativeHops: negative,
        hops: Object.fromEntries(Object.entries(hops).map(([k, v]) => [k, v.length ? summary(v) : null])),
        dispatch_spawn: spawnHop.length ? summary(spawnHop) : null,
        end_to_end: e2e.length ? summary(e2e) : null,
        http_client: clientMs.length ? summary(clientMs) : null,
      };
      const fails = [recs.length !== N && 'not every event reached paint', missing.length && 'missing stamps', negative.length && 'negative hops', row.end_to_end && row.end_to_end.p95 > M1_MS && 'end-to-end p95 > 250 ms (M1)'].filter(Boolean);
      report[`${candidate}-${ack}`] = { ...row, fails };
      console.log(`${candidate} (${ack} ack): ${fails.length ? `FAIL ${fails.join('; ')}` : 'pass'}; e2e p95 ${row.end_to_end?.p95.toFixed(1)} ms`);
      pass = pass && fails.length === 0;
    }
    const stats = [...app.msgs].reverse().find((m) => 's3-stats' in m)?.['s3-stats'];
    report[`ack-${ack}`] = stats?.socket?.ackUs?.length ? summary(stats.socket.ackUs.map((u: number) => u / 1000)) : null;
  } finally {
    app.child.kill('SIGTERM');
    await sleep(500);
    rmSync(dir, { recursive: true, force: true });
  }
}
writeFileSync(join(OUT, 'e2e.json'), JSON.stringify(report, null, 2));
console.log(`clock sanity: ${clockOk ? 'pass' : 'FAIL (report hop sums and end-to-end only)'}`);
process.exitCode = pass && clockOk ? 0 : 1;
