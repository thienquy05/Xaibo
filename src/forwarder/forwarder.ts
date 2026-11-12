// Hook forwarder (P3-T03, S3 runtime B; EC-11, EC-12, EC-63, EC-64; M7). Run by the shim as
// `xaibo-forwarder hook <agent> <profile_key>` with XAIBO_DATA_DIR set; the hook payload arrives on stdin. Contract: never
// writes stdout or stderr, always exits 0, within its own deadline. One self-contained file with builtins only, because
// a SEA runs a single script: it keeps its own minimal copy of protocol v1 framing (src/shared/hook-protocol.ts), and
// the end-to-end test against the real socket server guards drift. Trust (security review 379): the token is sent only
// through a run/ dir and socket of our own uid with private modes; spool records are written only into a private spool/
// of our own, as one newline-framed append each; the token is never spooled.
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeSync, type Stats } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const t0 = performance.now();
// S3: 100 ms total minus the SEA's startup p95. ponytail: a timer cannot fire during a blocking syscall, so a stalled
// disk can still overrun; a kill watchdog in the shim would cost a process spawn per hook (not adopted, review 379 #10).
const DEADLINE_MS = 60;
const STDIN_CAP = 256 * 1024;
const STDIN_MS = 25;
const SPOOL_RESERVE_MS = 10;
const SPOOL_CAP = 50 * (1 << 20);
const OVERFLOW_CAP = 1 << 20;
const OVERFLOW_LINE_MAX = 128;
const MAX_SPOOL_ENTRIES = 1000;
const MAX_TOKEN = 256;
const AGENT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PROFILE = /^[A-Za-z0-9._-]{1,128}$/;

let finished = false;
let unsettled: Envelope | null = null; // spooled if the deadline hits before an ack or spool
const finish = () => {
  if (finished) return;
  finished = true;
  if (unsettled) spool(unsettled);
  process.exit(0);
};
setTimeout(finish, DEADLINE_MS);
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
for (const s of [process.stdout, process.stderr]) s.write = (() => true) as typeof s.write; // hook output reaches the model

interface Envelope {
  v: 1; delivery_id: string; agent: string; profile_key: string; event: string; session_id: string | null;
  cwd: string | null; received_ts: number; payload: Record<string, unknown> | null; truncated?: true; malformed?: true;
}

const dataDir = process.env['XAIBO_DATA_DIR'] ?? '';
const uid = process.getuid?.();
const own = (st: Stats) => uid === undefined || st.uid === uid;
const str = (x: unknown, max: number) => (typeof x === 'string' && x.length > 0 && x.length <= max ? x : null);
const elapsed = () => performance.now() - t0;

function lstat(p: string): Stats | null {
  try { return lstatSync(p); } catch { return null; }
}
const privateDir = (p: string) => { const st = lstat(p); return !!st && st.isDirectory() && own(st) && (st.mode & 0o077) === 0; };

function frame(msg: object): Buffer {
  const body = Buffer.from(JSON.stringify(msg));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function readToken(file: string): string | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !own(st) || (st.mode & 0o077) !== 0 || st.size > MAX_TOKEN) return null;
    const buf = Buffer.alloc(MAX_TOKEN);
    const n = readSync(fd, buf, 0, MAX_TOKEN, 0);
    return str(buf.subarray(0, n).toString('utf8'), MAX_TOKEN);
  } finally {
    closeSync(fd);
  }
}

/** A private spool dir of our own, created if missing; anything else (symlink, foreign owner, file) is refused. */
function spoolDir(): string | null {
  const dir = path.join(dataDir, 'spool');
  try { mkdirSync(dir, { mode: 0o700 }); } catch { /* exists, or the data dir is gone: checked below */ }
  const st = lstat(dir);
  if (!st || !st.isDirectory() || !own(st)) return null;
  if (st.mode & 0o077) chmodSync(dir, 0o700);
  return dir;
}

/** Appends one buffer to a regular, single-link file of our own. */
function append(file: string, data: Buffer) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const st = fstatSync(fd);
    if (st.isFile() && own(st) && st.nlink === 1) writeSync(fd, data); // a short write leaves a torn line; replay skips it
  } finally {
    closeSync(fd);
  }
}

function spool(e: Envelope) {
  unsettled = null;
  try {
    const dir = spoolDir();
    if (!dir) return; // never write through an untrusted spool
    const names = readdirSync(dir);
    let used = names.length > MAX_SPOOL_ENTRIES ? Infinity : 0;
    for (const n of names) {
      if (used === Infinity || !n.endsWith('.jsonl')) continue;
      const st = lstat(path.join(dir, n));
      if (st?.isFile()) used += st.size;
    }
    // Leading and trailing newlines isolate a torn record from its neighbours. Each file is per day (D-P3-04), so the
    // exact cap above costs O(days). ponytail: concurrent forwarders can overshoot the cap by N x 256 KiB.
    const record = Buffer.from(`\n${JSON.stringify(e)}\n`);
    if (used + record.length > SPOOL_CAP) { overflow(dir, e); return; }
    append(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), record);
  } catch { /* the hook must never fail; the gap shows in coverage */ }
}

/** EC-12: a short line naming the gap (never cwd or content); a line that would cross the cap only sets a flag. */
function overflow(dir: string, e: Envelope) {
  // Bounded in serialized UTF-8 bytes, newline included; the last fallback fits (agent <= 32 ASCII, fixed event).
  const line = (session: string | null, event: string) => Buffer.from(`${JSON.stringify({ ts: Date.now(), agent: e.agent, session_id: session, event })}\n`);
  let rec = line(e.session_id, e.event);
  if (rec.length > OVERFLOW_LINE_MAX) rec = line(null, e.event);
  if (rec.length > OVERFLOW_LINE_MAX) rec = line(null, 'unknown');
  const log = path.join(dir, 'overflow.log');
  if ((lstat(log)?.size ?? 0) + rec.length > OVERFLOW_CAP) {
    try { closeSync(openSync(path.join(dir, 'overflow.saturated'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); } catch { /* already flagged */ }
    return;
  }
  append(log, rec);
}

function parseAck(body: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body.toString('utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null; // treated as no ack
  }
}

function send(e: Envelope) {
  const run = path.join(dataDir, 'run');
  const sock = path.join(run, 'xaibo.sock');
  const st = privateDir(run) ? lstat(sock) : null;
  const token = st?.isSocket() && own(st) ? readToken(path.join(run, 'token')) : null;
  const budget = DEADLINE_MS - elapsed() - SPOOL_RESERVE_MS;
  if (!token || budget <= 0) { spool(e); finish(); return; }
  const c = net.connect(sock);
  const fallback = () => { clearTimeout(timer); c.destroy(); spool(e); finish(); };
  const timer = setTimeout(fallback, budget);
  let buf = Buffer.alloc(0);
  c.on('error', fallback);
  c.on('connect', () => { c.write(Buffer.concat([frame({ v: 1, token }), frame(e)])); });
  c.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
    const ack = parseAck(buf.subarray(4, 4 + buf.readUInt32BE(0)));
    if (ack?.['delivery_id'] !== e.delivery_id || ack?.['status'] !== 'accepted') { fallback(); return; }
    clearTimeout(timer);
    unsettled = null;
    c.destroy();
    finish();
  });
}

function envelope(agent: string, profile: string, id: string, bytes: Buffer, total: number, ended: boolean): Envelope {
  const truncated = total > STDIN_CAP || !ended;
  let payload: Record<string, unknown> | null = null;
  let malformed = false;
  if (!truncated) {
    try {
      const v: unknown = JSON.parse(bytes.toString('utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) payload = v as Record<string, unknown>;
      else malformed = true;
    } catch { malformed = true; }
  }
  const p = payload ?? {};
  return {
    v: 1, delivery_id: id, agent, profile_key: profile,
    event: str(p['hook_event_name'] ?? p['hookEventName'], 128) ?? 'unknown', // Claude/Codex snake_case, agy camelCase
    session_id: str(p['session_id'] ?? p['conversationId'], 256), cwd: str(p['cwd'], 4096),
    received_ts: Date.now(), payload, ...(truncated ? { truncated: true } : {}), ...(malformed ? { malformed: true } : {}),
  };
}

function main() {
  const [mode, agentArg = '', profileArg = ''] = process.argv.slice(2);
  if (!path.isAbsolute(dataDir) || mode !== 'hook') { finish(); return; }
  const agent = AGENT.test(agentArg) ? agentArg : 'unknown';
  const profile = PROFILE.test(profileArg) ? profileArg : 'unknown';
  const id = randomUUID(); // before the first send or spool, so a replay dedups against the same id
  const chunks: Buffer[] = [];
  let kept = 0;
  let total = 0;
  let done = false;
  const complete = (ended: boolean) => {
    if (done) return;
    done = true;
    clearTimeout(readTimer);
    process.stdin.destroy();
    const e = envelope(agent, profile, id, Buffer.concat(chunks, kept), total, ended);
    unsettled = e;
    send(e);
  };
  const readTimer = setTimeout(() => complete(false), STDIN_MS);
  process.stdin.on('data', (b: Buffer) => {
    total += b.length;
    if (kept < STDIN_CAP) { const part = b.subarray(0, STDIN_CAP - kept); chunks.push(part); kept += part.length; }
    if (total > STDIN_CAP) complete(false);
  });
  process.stdin.on('end', () => complete(true));
  process.stdin.on('error', () => complete(false));
}

main();
