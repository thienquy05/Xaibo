// Hook socket server (P3-T02, EC-32, Q3-8, §7.3). A Unix socket at <dataDir>/run/xaibo.sock. The run/ dir (0700, own
// uid, never a symlink, checked at every start) is what keeps other users out; the 0600 chmod after listen is defense in
// depth. The per-install token (<dataDir>/run/token, 0600, new at every start) shuts out processes that cannot read
// run/; a same-uid client can read it, so caps and strict validation bound it and payloads are never trusted downstream.
// Every connection must open with a hello; any bad frame, version, shape, token or a deadline miss (reset only by whole
// frames) is answered with a fixed code and the connection is closed, before intake sees anything. Logs carry codes
// only, at most one line per second. Durable ack and dedup are P3-T04 (onEnvelope).
// Report producers (P3-T13b, SEC2, Q3-9, security review 872) open with their registration's own hello instead; the
// connection is then bound to that registration (at most 8 per registration), frames are at most 256 KiB, run through
// one round-robin scheduler across registrations (1,000 frames / 16 MiB queued per registration, 128 MiB in all), and a
// frame of a revoked registration cuts its connection. A frame intake rejects is acked rejected and the connection stays.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Logger } from '../../shared/log.ts';
import {
  createDecoder, encodeFrame, FrameError, MAX_FRAME, MAX_REPORT_FRAME, parseEnvelope, parseHello, parseRegistrationHello, PROTOCOL_VERSION,
  type Ack, type Envelope,
} from '../../shared/hook-protocol.ts';
import type { Registration, Registry } from './registrations.ts';
import type { ReportIntake } from './report.ts';

export class SocketError extends Error {
  readonly code: 'path-too-long' | 'in-use' | 'run-dir' | 'listen';
  constructor(code: SocketError['code']) {
    super(`hook socket unavailable: ${code}`);
    this.code = code;
  }
}

export interface IntakeResult { status: Ack['status']; code: string }
export interface SocketOptions {
  dataDir: string;
  onEnvelope: (e: Envelope) => Promise<IntakeResult>;
  /** Time allowed for each whole frame (the hello included). */
  deadlineMs?: number;
  maxConnections?: number;
  log?: Logger;
  /** P3-T13b: report producers authenticated by their own registration. */
  reports?: { registry: Registry; intake: ReportIntake };
}
export interface SocketServer { path: string; tokenFile: string; close(): Promise<void> }

const SUN_PATH_MAX = 103; // macOS sockaddr_un.sun_path is 104 bytes with the NUL; Linux allows 108
const DEADLINE_MS = 2_000;
const MAX_CONNECTIONS = 64;
// Bytes read while intake is busy before the connection is rejected 'busy' (two full frames, so one report chunk can be
// in flight). Reads are never paused: a paused socket never notices EOF, and a client that hangs up must have its
// queued work dropped. A producer that reads its acks never comes near it.
const QUEUE_BYTES = 2 * (1 << 20);
const REJECT_GRACE_MS = 1_000;
const PROBE_MS = 500;
const LOG_INTERVAL_MS = 1_000;
const TOKEN_BYTES = 32;
const PER_REGISTRATION_CONNECTIONS = 8;
const MAX_UNACKED = 1000; // report frames awaiting their ack on one connection (review L6: a client that never reads acks)
// ponytail: bytes are serialized frame sizes; the parsed objects cost a few times that in heap (review L8).
export const REPORT_QUEUE = { frames: 1000, bytes: 16 << 20, total: 128 << 20 };
const CLOSED: IntakeResult = { status: 'rejected', code: 'closed' };

export interface Scheduler {
  /** Queues a job for `key`; null when that key or the whole queue is at its cap. */
  submit(key: string, bytes: number, run: () => Promise<IntakeResult>): Promise<IntakeResult> | null;
}

/** Q3-9 fair scheduling: one job at a time, one per key per round; frames count while queued or running. */
export function createScheduler(limits = REPORT_QUEUE): Scheduler {
  interface Job { bytes: number; run: () => Promise<IntakeResult>; resolve: (r: IntakeResult) => void }
  const keys = new Map<string, { jobs: Job[]; n: number; bytes: number }>();
  let total = 0;
  let running = false;
  const pump = async () => {
    if (running) return;
    running = true;
    for (;;) {
      const ready = [...keys].filter(([, k]) => k.jobs.length);
      if (!ready.length) break;
      for (const [key, k] of ready) {
        const j = k.jobs.shift()!;
        const r = await j.run().catch((): IntakeResult => ({ status: 'rejected', code: 'intake' }));
        k.n--; k.bytes -= j.bytes; total -= j.bytes;
        if (!k.n) keys.delete(key);
        j.resolve(r);
      }
    }
    running = false;
  };
  return {
    submit(key, bytes, run) {
      const k = keys.get(key) ?? { jobs: [], n: 0, bytes: 0 };
      if (k.n >= limits.frames || k.bytes + bytes > limits.bytes || total + bytes > limits.total) return null;
      keys.set(key, k);
      k.n++; k.bytes += bytes; total += bytes;
      const p = new Promise<IntakeResult>((resolve) => k.jobs.push({ bytes, run, resolve }));
      void pump();
      return p;
    },
  };
}

/** The ack id of a report frame: its delivery_id when that is a plain bounded string, else null. */
const reportId = (f: unknown): string | null => {
  const id = typeof f === 'object' && f !== null ? (f as Record<string, unknown>)['delivery_id'] : undefined;
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && id.isWellFormed() ? id : null;
};

const uid = () => process.getuid?.();
const digest = (s: string) => createHash('sha256').update(s).digest();
const ownSocket = (st: { isSocket(): boolean; uid: number }) => st.isSocket() && (uid() === undefined || st.uid === uid());

function privateRunDir(run: string) {
  try { mkdirSync(run, { mode: 0o700 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new SocketError('run-dir');
  }
  const st = lstatSync(run);
  if (!st.isDirectory() || (uid() !== undefined && st.uid !== uid())) throw new SocketError('run-dir');
  if (st.mode & 0o077) chmodSync(run, 0o700);
}

function writeToken(file: string, token: string) {
  const tmp = path.join(path.dirname(file), `.token.${randomUUID()}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, token); fchmodSync(fd, 0o600); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

/** Resolves true once buffered output drains, false on close or after `ms`. */
function drained(c: net.Socket, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ok: boolean) => { clearTimeout(t); c.off('drain', onDrain); c.off('close', onClose); resolve(ok); };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const t = setTimeout(() => finish(false), ms);
    c.once('drain', onDrain);
    c.once('close', onClose);
  });
}

/** Existing endpoint: our own socket that refuses connections is stale and removed; anything else is in use. */
async function clearStale(sock: string) {
  let st;
  try { st = lstatSync(sock); } catch { return; }
  if (!ownSocket(st)) throw new SocketError('in-use');
  const probe = await new Promise<string>((resolve) => {
    const c = net.connect(sock);
    const done = (r: string) => { c.destroy(); resolve(r); };
    c.once('connect', () => done('live'));
    c.once('error', (e: NodeJS.ErrnoException) => done(e.code ?? 'error'));
    c.setTimeout(PROBE_MS, () => done('timeout'));
  });
  if (probe === 'ENOENT') return;
  if (probe !== 'ECONNREFUSED') throw new SocketError('in-use');
  // ponytail: two services starting at once could both see ECONNREFUSED; the app's single-instance lock and the one
  // supervised service rule that out. A lock file if a second writer ever appears.
  unlinkSync(sock);
}

export async function startSocketServer(o: SocketOptions): Promise<SocketServer> {
  const run = path.join(o.dataDir, 'run');
  const sock = path.join(run, 'xaibo.sock');
  if (Buffer.byteLength(sock) > SUN_PATH_MAX) throw new SocketError('path-too-long');
  privateRunDir(run);
  await clearStale(sock);
  const tokenFile = path.join(run, 'token');
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  writeToken(tokenFile, token);
  const expected = digest(token);
  const deadlineMs = o.deadlineMs ?? DEADLINE_MS;

  let lastLog = 0;
  let dropped = 0;
  const logReject = (code: string) => {
    const now = Date.now();
    if (now - lastLog < LOG_INTERVAL_MS) { dropped++; return; }
    o.log?.log('socket_reject', { error: code, dropped });
    lastLog = now;
    dropped = 0;
  };

  const open = new Set<net.Socket>();
  const scheduler = createScheduler();
  const perRegistration = new Map<string, number>();
  const handle = (c: net.Socket) => {
    open.add(c);
    let reg: Registration | null = null; // set by a registration hello
    const push = createDecoder(() => (reg ? MAX_REPORT_FRAME : MAX_FRAME));
    const pending: { id: string | null; result: () => Promise<IntakeResult> }[] = [];
    let authed = false;
    let done = false;
    let draining = false;
    let queuedBytes = 0;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reject('deadline'), deadlineMs);
    };
    const stop = () => {
      done = true;
      pending.length = 0; // queued work never reaches intake once the connection ends
      clearTimeout(timer);
    };
    const reject = (code: string) => {
      if (done) return;
      stop();
      logReject(code);
      c.end(encodeFrame({ v: PROTOCOL_VERSION, delivery_id: null, status: 'rejected', code }));
      setTimeout(() => c.destroy(), REJECT_GRACE_MS).unref(); // a client that never reads cannot hold the slot
    };
    /** One envelope at a time through intake; no new ack until the last one drained. */
    const drain = async () => {
      if (draining) return;
      draining = true;
      clearTimeout(timer); // time spent in our own intake is not the client's deadline
      while (pending.length && !done) {
        const item = pending.shift()!;
        const r = await item.result().catch((): IntakeResult => ({ status: 'rejected', code: 'intake' }));
        if (done) break;
        if (!c.write(encodeFrame({ v: PROTOCOL_VERSION, delivery_id: item.id, status: r.status, code: r.code }))
          && !(await drained(c, deadlineMs))) reject('stalled');
      }
      draining = false;
      queuedBytes = 0;
      if (!done) arm();
    };
    arm();
    c.on('error', () => { /* a client that went away (EPIPE, reset) never takes the service down */ });
    c.on('close', () => {
      stop();
      open.delete(c);
      if (reg) { const n = perRegistration.get(reg.id)! - 1; if (n) perRegistration.set(reg.id, n); else perRegistration.delete(reg.id); }
    });
    /** A report frame of the bound registration, run by the scheduler; a revoked registration ends the connection. */
    const report = (r: Registration, f: unknown) => async (): Promise<IntakeResult> => {
      if (done) return CLOSED; // queued work of a closed connection never reaches intake
      if (o.reports!.registry.current(r.id)?.token_sha256 !== r.token_sha256) { reject('auth'); return CLOSED; }
      return o.reports!.intake.deliver(r, f);
    };
    c.on('data', (chunk: Buffer) => {
      if (done) return;
      let frames: unknown[];
      try { frames = push(chunk); } catch (e) {
        const code = e instanceof FrameError ? e.code : 'frame';
        if (reg) o.reports!.intake.rejected(reg, code);
        reject(code);
        return;
      }
      if (!reg && draining && (queuedBytes += chunk.length) > QUEUE_BYTES) { reject('busy'); return; }
      for (const f of frames) {
        if (done) return;
        if (!draining) arm();
        if (!authed) {
          const rh = o.reports ? parseRegistrationHello(f) : null;
          if (rh) { // never falls back to the install token (review 872 #5)
            const r = o.reports!.registry.verify(rh.registration, rh.token);
            if (!r) { reject('auth'); return; }
            const n = perRegistration.get(r.id) ?? 0;
            if (n >= PER_REGISTRATION_CONNECTIONS) { reject('busy'); return; }
            perRegistration.set(r.id, n + 1);
            reg = r;
            authed = true;
            continue;
          }
          const h = parseHello(f);
          const got = h ? digest(h.token) : null;
          if (!got || !timingSafeEqual(got, expected)) { reject('auth'); return; }
          authed = true;
          continue;
        }
        if (reg) {
          // a frame decoded in the hello's own chunk was read under the hook limit: re-checked here
          const size = Buffer.byteLength(JSON.stringify(f));
          if (size > MAX_REPORT_FRAME) { o.reports!.intake.rejected(reg, 'oversize'); reject('oversize'); return; }
          const result = pending.length < MAX_UNACKED ? scheduler.submit(reg.id, size, report(reg, f)) : null;
          if (!result) { reject('busy'); return; }
          pending.push({ id: reportId(f), result: () => result });
          void drain();
          continue;
        }
        const p = parseEnvelope(f);
        if (!p.ok) { reject(parseHello(f) ? 'hello' : p.code); return; }
        const e = p.envelope;
        pending.push({ id: e.delivery_id, result: () => o.onEnvelope(e) });
        void drain();
      }
    });
  };

  const server = net.createServer(handle);
  server.maxConnections = o.maxConnections ?? MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => reject(new SocketError(e.code === 'EADDRINUSE' ? 'in-use' : 'listen')));
    server.listen(sock, () => resolve());
  });
  chmodSync(sock, 0o600);
  if (!ownSocket(lstatSync(sock))) {
    server.close();
    throw new SocketError('run-dir');
  }
  server.on('error', () => o.log?.log('socket_error', {}));

  return {
    path: sock,
    tokenFile,
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        for (const f of [sock, tokenFile]) { try { unlinkSync(f); } catch { /* already gone */ } }
        resolve();
      });
      for (const c of open) c.destroy();
    }),
  };
}
