// Service process (utilityProcess, P1-T06): boots the store and ingest (boot.ts) in the data dir main passes in
// XAIBO_DATA_DIR, posts `ready` once the store is open (health "Running"; ingest continues in the background), and
// answers main's commands. Logs go to their own dir so two processes never rotate one file. P1-T12: each brokered
// port gets agent status on connect, answers listSessions after boot, and receives coalesced session deltas.
import type { MessagePortMain } from 'electron';
import { homedir } from 'node:os';
import path from 'node:path';
import { errorCode, installCrashPolicy } from '../shared/crash.ts';
import { accept, IPC_VERSION, parsePortRequest, parseServiceCommand } from '../shared/ipc.ts';
import type { PortMessage, ServiceEvent } from '../shared/ipc.ts';
import { createLogger, loadInstallSecret, type Logger } from '../shared/log.ts';
import { answer, coalesce, sessionsByKey } from './api.ts';
import { boot, type Service } from './boot.ts';

const DELTA_MS = 250;
const parent = process.parentPort;
const ports = new Set<MessagePortMain>();
let svc: Service | undefined;
let resolveBooted: (s: Service) => void = () => {};
const booted = new Promise<Service>((resolve) => { resolveBooted = resolve; });

const broadcast = (m: PortMessage) => { for (const p of ports) p.postMessage(m); };
const changed = coalesce((keys) => {
  if (!svc?.store.db.isOpen) return;
  const rows = sessionsByKey(svc.store.db, keys.map((k) => { const [agent, profileId, nativeSessionId] = k.split('\0') as [string, string, string]; return { agent, profileId, nativeSessionId }; }));
  if (rows.length) broadcast({ v: IPC_VERSION, type: 'sessions', rows });
}, DELTA_MS);

const request = accept(parsePortRequest, (req, port: MessagePortMain) => {
  void booted.then((s) => { if (s.store.db.isOpen) port.postMessage(answer(s.store.db, req)); });
});

function connect(port: MessagePortMain) {
  ports.add(port);
  port.on('message', (e) => request(e.data, port));
  port.on('close', () => ports.delete(port));
  port.start();
  port.postMessage({ v: IPC_VERSION, type: 'agents', agents: svc?.agents() ?? null } satisfies PortMessage);
}

const command = accept(parseServiceCommand, (m, transferred: MessagePortMain[]) => {
  if (m.type === 'quit') { svc?.stop(); process.exit(0); }
  else if (m.type === 'wake') void svc?.wake();
  else if (m.type === 'port') transferred.forEach(connect);
  else if (m.type === 'setPath') { const { agent, path: file } = m; void booted.then((s) => s.setPath(agent, file)); }
});
parent.on('message', (e) => command(e.data, e.ports));

async function main(dataDir: string, log: Logger) {
  svc = await boot({
    dataDir, home: homedir(), shell: process.env.SHELL, log,
    onCommit: (b) => { for (const s of b.sessions) changed(`${b.agent}\0${b.profileId}\0${s.nativeSessionId}`); },
    onAgents: (agents) => broadcast({ v: IPC_VERSION, type: 'agents', agents }),
  });
  resolveBooted(svc);
  const ready: ServiceEvent = { v: IPC_VERSION, type: 'ready', readOnly: svc.store.reason ?? null };
  parent.postMessage(ready);
  svc.done.catch((e: unknown) => log.log('ingest_failed', { error: errorCode(e) }));
}

const dataDir = process.env.XAIBO_DATA_DIR;
if (!dataDir || !path.isAbsolute(dataDir)) process.exit(1);
else {
  const log = createLogger({ dir: path.join(dataDir, 'logs', 'service'), secret: loadInstallSecret(dataDir) });
  installCrashPolicy(process, log, { exitOnUncaught: () => process.exit(1) }); // P1-T13; the supervisor restarts us
  main(dataDir, log).catch((e: unknown) => { log.log('boot_failed', { error: errorCode(e) }); process.exit(1); });
}
