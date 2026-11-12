// Service process (utilityProcess, P1-T06): boots the store and ingest (boot.ts) in the data dir main passes in
// XAIBO_DATA_DIR, posts `ready` once the store is open (health "Running"; ingest continues in the background), and
// answers main's commands. Logs go to their own dir so two processes never rotate one file. P1-T12: each brokered
// port gets agent status on connect, answers listSessions after boot, and receives coalesced session deltas.
import type { MessagePortMain } from 'electron';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { errorCode, installCrashPolicy } from '../shared/crash.ts';
import { accept, IPC_VERSION, parsePortRequest, parseServiceCommand } from '../shared/ipc.ts';
import type { Banner, PortMessage, ServiceEvent } from '../shared/ipc.ts';
import { createLogger, loadInstallSecret, type Logger } from '../shared/log.ts';
import { answer, coalesce, sessionsByKey, type LiveOf } from './api.ts';
import { boot, type Service } from './boot.ts';
import type { Batch } from './store/writer.ts';

// P3-T10: 50 ms keeps one push per window while leaving most of M1's 250 ms hook-to-paint budget; the tick re-reads
// sessions whose status changes with time alone (settle within interval + 250 ms, M1), coverage is re-read slowly.
const DELTA_MS = 50;
const TICK_MS = 250;
const COVERAGE_MS = 5000;
const parent = process.parentPort;
const ports = new Set<MessagePortMain>();
let svc: Service | undefined;
let resolveBooted: (s: Service) => void = () => {};
const booted = new Promise<Service>((resolve) => { resolveBooted = resolve; });
const live: LiveOf = (agent, sid, profileId) => svc?.status(agent, sid, profileId) ?? null;

// Perf trace (XAIBO_PERF_TRACE=1, test only, IDs only): hrtime at commit per delivery/record id, and per pushed delta its
// id and the ids it carries; the renderer acks a delta's paint to main, which stamps the same monotonic clock.
let trace: string | null = null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pendingIds = new Map<string, string[]>();
let deltaSeq = 0;
const stamp = (line: object) => { if (trace) appendFileSync(trace, `${JSON.stringify({ ...line, t: process.hrtime.bigint().toString() })}\n`); };

const broadcast = (m: PortMessage) => { for (const p of ports) p.postMessage(m); };
const changed = coalesce((keys) => {
  const ids = trace ? keys.flatMap((k) => { const x = pendingIds.get(k) ?? []; pendingIds.delete(k); return x; }) : []; // cleared on every flush (review L2)
  if (!svc?.store.db.isOpen) return;
  const rows = sessionsByKey(svc.store.db, keys.map((k) => { const [agent, profileId, nativeSessionId] = k.split('\0') as [string, string, string]; return { agent, profileId, nativeSessionId }; }), svc.kinds(), svc.models(), live);
  if (!rows.length) return;
  if (!trace) { broadcast({ v: IPC_VERSION, type: 'sessions', rows }); return; }
  const delta = ++deltaSeq;
  stamp({ ev: 'delta', delta, ids });
  broadcast({ v: IPC_VERSION, type: 'sessions', rows, delta });
}, DELTA_MS);

let banners: Banner[] = [];
const coverage = () => {
  const now = svc?.coverage() ?? [];
  if (JSON.stringify(now) === JSON.stringify(banners)) return;
  banners = now;
  broadcast({ v: IPC_VERSION, type: 'coverage', banners });
};

const request = accept(parsePortRequest, (req, port: MessagePortMain) => {
  void booted.then((s) => { if (s.store.db.isOpen) port.postMessage(answer(s.store.db, req, s.kinds(), s.models(), live)); });
});

function connect(port: MessagePortMain) {
  ports.add(port);
  port.on('message', (e) => request(e.data, port));
  port.on('close', () => ports.delete(port));
  port.start();
  port.postMessage({ v: IPC_VERSION, type: 'agents', agents: svc?.agents() ?? null } satisfies PortMessage);
  port.postMessage({ v: IPC_VERSION, type: 'coverage', banners } satisfies PortMessage);
}

function committed(b: Batch) {
  const keys = new Set(b.sessions.map((s) => `${b.agent}\0${b.profileId}\0${s.nativeSessionId}`));
  for (const k of keys) changed(k);
  if (!trace) return;
  // IDs only: record ids come from untrusted files, so only UUID-shaped ones are traced (review L2)
  const ids = (b.delivery ? [b.delivery.deliveryId] : b.events.map((e) => e.nativeId)).filter((x) => UUID.test(x));
  stamp({ ev: 'commit', ids });
  for (const k of keys) pendingIds.set(k, [...(pendingIds.get(k) ?? []), ...ids]);
}

const command = accept(parseServiceCommand, (m, transferred: MessagePortMain[]) => {
  if (m.type === 'quit') { svc?.stop(); process.exit(0); }
  else if (m.type === 'wake') void svc?.wake();
  else if (m.type === 'reloadPrices') void booted.then((s) => s.reloadPrices());
  else if (m.type === 'port') transferred.forEach(connect);
  else if (m.type === 'setPath') { const { agent, path: file } = m; void booted.then((s) => s.setPath(agent, file)); }
});
parent.on('message', (e) => command(e.data, e.ports));

async function main(dataDir: string, log: Logger) {
  svc = await boot({
    dataDir, home: homedir(), shell: process.env.SHELL, log,
    onCommit: committed,
    onAgents: (agents) => broadcast({ v: IPC_VERSION, type: 'agents', agents }),
  });
  resolveBooted(svc);
  setInterval(() => { for (const k of svc?.ticking() ?? []) changed(k); }, TICK_MS);
  setInterval(coverage, COVERAGE_MS);
  svc.done.then(coverage, coverage); // profiles are synced by then; a spool replay still running is caught by the interval
  const ready: ServiceEvent = { v: IPC_VERSION, type: 'ready', readOnly: svc.store.reason ?? null };
  parent.postMessage(ready);
  svc.done.catch((e: unknown) => log.log('ingest_failed', { error: errorCode(e) }));
}

const dataDir = process.env.XAIBO_DATA_DIR;
if (!dataDir || !path.isAbsolute(dataDir)) process.exit(1);
else {
  const log = createLogger({ dir: path.join(dataDir, 'logs', 'service'), secret: loadInstallSecret(dataDir) });
  if (process.env.XAIBO_PERF_TRACE === '1') trace = path.join(dataDir, 'logs', 'perf-trace-service.jsonl');
  installCrashPolicy(process, log, { exitOnUncaught: () => process.exit(1) }); // P1-T13; the supervisor restarts us
  main(dataDir, log).catch((e: unknown) => { log.log('boot_failed', { error: errorCode(e) }); process.exit(1); });
}
