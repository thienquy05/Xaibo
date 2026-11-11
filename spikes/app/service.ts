// Spike service (utilityProcess). Mode comes from argv[2].
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { probeCore, probeExtras, runWriter } from '../s1/db.ts';
import { startReceiver, type Stamped } from '../s3/receiver.ts';
import { startHttpReceiver } from '../s3/http-receiver.ts';
import { zstdProbe } from '../s9/zstd-probe.ts';
import { attempt } from '../s10/control.ts';

const mode = process.argv[2] ?? 'idle';
const parent = process.parentPort;
const dataDir = process.env.XAIBO_DATA_DIR!;
const warnings: string[] = [];
process.on('warning', (w) => warnings.push(w.name));

async function s1Probe() {
  const report: Record<string, unknown> = {};
  try {
    report.main = probeCore(path.join(dataDir, 's1-main.db'));
    Object.assign(report, await probeExtras(path.join(dataDir, 's1-main.db'), path.join(dataDir, 's1-backup.db')));
  } catch (e) { report.main = { error: (e as Error).message }; }
  report.worker = await new Promise((res) => {
    try {
      const w = new Worker(path.join(import.meta.dirname, '..', 's1', 'worker.js'), { workerData: { file: path.join(dataDir, 's1-worker.db') } });
      w.once('message', res);
      w.once('error', (e) => res({ error: (e as Error).message }));
    } catch (e) { res({ error: (e as Error).message }); }
  });
  report.versions = { node: process.versions.node, electron: process.versions.electron, sqlite: process.versions.sqlite };
  report.warnings = warnings;
  parent.postMessage({ type: 'report', report });
}

// S3: socket + HTTP receivers; each event goes to the renderer before persistence; the paint ack closes the hop chain.
let rendererPort: Electron.MessagePortMain | null = null;
const inflight = new Map<string, Record<string, string>>();
function publish(s: Stamped) {
  const id = s.d.delivery_id;
  const benchId = (s.d.payload as Record<string, unknown> | null)?.bench_id;
  inflight.set(id, { delivery_id: id, bench_id: String(benchId ?? ''), event: String(s.d.event), via: String(s.d.via ?? 'socket'), replay: String(s.replay),
    t_entry: String(s.d.t_entry ?? ''), t_send: String(s.d.t_send ?? ''), t_recv: String(s.t_recv), t_publish: String(s.t_publish) });
  rendererPort?.postMessage({ type: 'event', id });
}
async function s3() {
  const ackPoint = process.env.XAIBO_S3_ACK === 'commit' ? 'commit' : 'volatile';
  const rx = await startReceiver({ dataDir, ackPoint, publish });
  const http = await startHttpReceiver(dataDir, (d, t_recv) => publish({ d: d as Stamped['d'], t_recv, t_publish: process.hrtime.bigint(), replay: false }));
  parent.postMessage({ type: 's3-ready', ackPoint, replayed: rx.stats.replayed });
  setInterval(() => parent.postMessage({ type: 's3-stats', socket: rx.stats, http: http.rejected }), 1000).unref();
}

if (mode === 's1-probe') void s1Probe();
else if (mode === 's3') void s3();
else if (mode === 's9-zstd') void zstdProbe(path.join(dataDir, 's9')).then((report) => parent.postMessage({ type: 'report', report }), (e) => parent.postMessage({ type: 'report', report: { error: String(e) } }));
else if (mode === 's1-crash') runWriter(path.join(dataDir, 's1-crash.db'), (m) => parent.postMessage(m), process.env.XAIBO_S1_TWO_TX === '1');
else if (mode !== 'idle') {
  parent.postMessage({ type: 'error', message: `mode not implemented: ${mode}` });
  process.exit(2);
}

parent.on('message', (e) => {
  if (e.data?.type === 'quit') {
    // S10 positive control for an attempt during shutdown (spike env only); otherwise exit cleanly.
    if (process.env.XAIBO_S10_CONTROL === 'service-quit-tcp') { attempt('tcp'); setTimeout(() => process.exit(0), 1000); return; }
    process.exit(0);
  }
  const port = e.ports[0];
  if (e.data?.type !== 'port' || !port) return;
  rendererPort = port;
  port.on('message', (m) => {
    if (m.data?.type !== 'paint-ack') return;
    const rec = inflight.get(m.data.id);
    if (!rec) return parent.postMessage(m.data);
    inflight.delete(m.data.id);
    parent.postMessage({ type: 's3-hop', ...rec, t_paint_ack: String(process.hrtime.bigint()) });
  });
  port.start();
  port.postMessage({ type: 'event', id: 1 });
});
parent.postMessage({ type: 'ready', mode });
if (process.env.XAIBO_S10_CONTROL?.startsWith('service-')) attempt(process.env.XAIBO_S10_CONTROL.slice(8)); // S10 positive control
