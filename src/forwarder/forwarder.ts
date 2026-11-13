// Hook forwarder (P3-T03, S3 runtime B; EC-11, EC-12, EC-63, EC-64; M7). Run by the shim as
// `xaibo-forwarder hook <agent> <profile_key>` with XAIBO_DATA_DIR set; the hook payload arrives on stdin. Contract: never
// writes stdout or stderr, always exits 0, within its own deadline. One self-contained file with builtins only, because
// a SEA runs a single script: it keeps its own minimal copy of protocol v1 framing (src/shared/hook-protocol.ts), and
// the end-to-end test against the real socket server guards drift. Trust (security review 379): the token is sent only
// through a run/ dir and socket of our own uid with private modes; spool records are written only into a private spool/
// of our own, as one newline-framed append each; the token is never spooled.
// Report mode (P3-T13c, PRD §5.10; security review 888) is the xaibo-report helper: `xaibo-forwarder report <registration>
// <token-file>` with one report v1 event on stdin (<= 256 KiB). The token comes from a private 0600 file of our own and is
// checked against the registration's stored hash before anything leaves; a missing delivery_id is assigned once, a given
// one kept; the frame is sent with the registration hello, and on a transient failure the exact frame (never the token)
// is spooled for the service's replay. A permanent failure exits 2 with one code-only stderr line and leaves nothing;
// stdout stays empty; the whole run is bounded (2 s). Same-uid spool forgery is the hook spool's trust domain (accepted).
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeSync, type Stats } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const t0 = performance.now();
const REPORT = process.argv[2] === 'report';
// S3: 100 ms total minus the SEA's startup p95. ponytail: a timer cannot fire during a blocking syscall, so a stalled
// disk can still overrun; a kill watchdog in the shim would cost a process spawn per hook (not adopted, review 379 #10).
const DEADLINE_MS = REPORT ? 2_000 : 60;
const STDIN_CAP = 256 * 1024; // also the report frame cap (MAX_REPORT_FRAME)
const STDIN_MS = REPORT ? 1_000 : 25;
const SPOOL_RESERVE_MS = 10;
const SPOOL_CAP = 50 * (1 << 20);
const OVERFLOW_CAP = 1 << 20;
const OVERFLOW_LINE_MAX = 128;
const MAX_SPOOL_ENTRIES = 1000;
const MAX_TOKEN = 256;
const AGENT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PROFILE = /^[A-Za-z0-9._-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REGISTRATIONS_MAX = 1 << 20;
// Rejections retrying cannot fix: the helper exits 2 and spools nothing. Everything else is transient and spooled.
const PERMANENT = new Set(['auth', 'malformed', 'unsupported-version', 'oversize', 'hello']);

let finished = false;
let unsettled: (() => void) | null = null; // spools the delivery if the deadline hits before an ack or spool
let exitCode = 0;
const finish = () => {
  if (finished) return;
  finished = true;
  if (unsettled) { const s = unsettled; unsettled = null; s(); }
  process.exit(exitCode);
};
/** Report mode: one fixed code on stderr, exit 2, nothing spooled. */
const fail = (code: string) => {
  if (finished) return;
  unsettled = null;
  exitCode = 2;
  try { writeSync(2, `xaibo-report: ${code}\n`); } catch { /* stderr closed */ }
  finish();
};
setTimeout(finish, DEADLINE_MS);
// Report mode: an error before the event is ready to spool is reported (exit 2), never a silent 0 (review M1).
const crash = () => (REPORT && !unsettled ? fail('internal') : finish());
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
// hook output reaches the model; a report producer gets only the one code line written by fail()
for (const s of REPORT ? [process.stdout] : [process.stdout, process.stderr]) s.write = (() => true) as typeof s.write;

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
    return str(buf.subarray(0, n).toString('utf8').replace(/\r?\n$/, ''), MAX_TOKEN); // a producer's `echo token > file`
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

/** Appends one buffer to a regular, single-link file of our own; true once fully written. */
function append(file: string, data: Buffer): boolean {
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const st = fstatSync(fd);
    // a short write leaves a torn line; replay skips it
    return st.isFile() && own(st) && st.nlink === 1 && writeSync(fd, data) === data.length;
  } finally {
    closeSync(fd);
  }
}

/** Spools one record; `gap` names it in the overflow line (agent, session, event only). True only once it is appended. */
function spool(e: object, gap: Gap): boolean {
  unsettled = null;
  try {
    const dir = spoolDir();
    if (!dir) return false; // never write through an untrusted spool
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
    if (used + record.length > SPOOL_CAP) { overflow(dir, gap); return false; }
    return append(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), record);
  } catch { return false; } // the hook must never fail; the gap shows in coverage
}

/** EC-12: a short line naming the gap (never cwd or content); a line that would cross the cap only sets a flag. */
interface Gap { agent: string; session_id: string | null; event: string }
function overflow(dir: string, e: Gap) {
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

/** Our own socket under a private run/ dir, else null (never connect through anything else). */
function socketPath(): string | null {
  const run = path.join(dataDir, 'run');
  const sock = path.join(run, 'xaibo.sock');
  const st = privateDir(run) ? lstat(sock) : null;
  return st?.isSocket() && own(st) ? sock : null;
}

/** Sends hello + msg and hands the first ack (or null: error, timeout, no budget) to `done`, exactly once. */
function exchange(sock: string, hello: object, msg: object, done: (ack: Record<string, unknown> | null) => void) {
  const budget = DEADLINE_MS - elapsed() - SPOOL_RESERVE_MS;
  if (budget <= 0) { done(null); return; }
  const c = net.connect(sock);
  let settled = false;
  const end = (ack: Record<string, unknown> | null) => { if (settled) return; settled = true; clearTimeout(timer); c.destroy(); done(ack); };
  const timer = setTimeout(() => end(null), budget);
  let buf = Buffer.alloc(0);
  c.on('error', () => end(null));
  c.on('close', () => end(null));
  c.on('connect', () => { c.write(Buffer.concat([frame(hello), frame(msg)])); });
  c.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
    end(parseAck(buf.subarray(4, 4 + buf.readUInt32BE(0))));
  });
}

function send(e: Envelope) {
  const sock = socketPath();
  const token = sock ? readToken(path.join(dataDir, 'run', 'token')) : null;
  if (!sock || !token) { spool(e, e); finish(); return; }
  exchange(sock, { v: 1, token }, e, (ack) => {
    if (ack?.['delivery_id'] !== e.delivery_id || ack?.['status'] !== 'accepted') spool(e, e);
    unsettled = null;
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

/** The registration's agent and token hash from <dataDir>/registrations.json (our own regular file), else null. */
function registration(id: string): { agent: string; hash: Buffer } | null {
  let fd: number;
  try { fd = openSync(path.join(dataDir, 'registrations.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !own(st) || st.size > REGISTRATIONS_MAX) return null;
    const buf = Buffer.alloc(st.size);
    for (let n = 0; n < buf.length;) { const got = readSync(fd, buf, n, buf.length - n, null); if (!got) break; n += got; }
    const list: unknown = JSON.parse(buf.toString('utf8'));
    const r = Array.isArray(list) ? (list as Record<string, unknown>[]).find((x) => x && typeof x === 'object' && x['id'] === id) : undefined;
    const hash = r?.['token_sha256'];
    return r && typeof r['agent'] === 'string' && AGENT.test(r['agent']) && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)
      ? { agent: r['agent'], hash: Buffer.from(hash, 'hex') } : null;
  } catch { return null; } finally { closeSync(fd); }
}

/** Report mode: validate, then send or spool one report v1 event (see the header). */
function report(regArg: string, tokenFile: string, input: Buffer) {
  const token = readToken(tokenFile);
  if (!token) { fail('token'); return; }
  const reg = registration(regArg);
  const got = createHash('sha256').update(token).digest();
  if (!timingSafeEqual(got, reg?.hash ?? Buffer.alloc(32)) || !reg) { fail('auth'); return; }
  let ev: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(input.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) { fail('malformed'); return; }
    ev = v as Record<string, unknown>;
  } catch { fail('malformed'); return; }
  if (!Object.hasOwn(ev, 'delivery_id')) ev = { ...ev, delivery_id: randomUUID() }; // once, before the first send or spool
  const id = ev['delivery_id'];
  if (typeof id !== 'string' || !id.length || id.length > 128 || !id.isWellFormed()) { fail('invalid-delivery_id'); return; }
  if (Buffer.byteLength(JSON.stringify(ev)) > STDIN_CAP) { fail('oversize'); return; }
  const record = { v: 1, kind: 'report', registration: regArg, received_ts: Date.now(), frame: ev };
  const gap = { agent: reg.agent, session_id: str(ev['session_id'], 256), event: str(ev['event'], 128) ?? 'unknown' };
  // a spool that cannot take it is reported, never a false "spooled" (review M2)
  unsettled = () => { if (!spool(record, gap)) { exitCode = 2; try { writeSync(2, 'xaibo-report: spool\n'); } catch { /* stderr closed */ } } };
  const sock = socketPath();
  if (!sock) { finish(); return; } // spooled by finish
  exchange(sock, { v: 1, registration: regArg, token }, ev, (ack) => {
    const code = typeof ack?.['code'] === 'string' ? ack['code'] : '';
    // a null id is only a connection-level rejection; an acceptance names our delivery (review L3)
    if (ack?.['delivery_id'] === id && ack['status'] === 'accepted') { unsettled = null; finish(); return; }
    const ours = ack?.['delivery_id'] === id || ack?.['delivery_id'] === null;
    if (ours && ack?.['status'] === 'rejected' && (PERMANENT.has(code) || code.startsWith('invalid-'))) { fail(/^[a-z0-9_-]{1,64}$/.test(code) ? code : 'rejected'); return; }
    finish(); // transient: spooled by finish
  });
}

function main() {
  const [mode, agentArg = '', profileArg = ''] = process.argv.slice(2);
  if (mode === 'report') {
    if (!path.isAbsolute(dataDir) || !UUID.test(agentArg) || !profileArg || process.argv.length !== 5) { fail('usage'); return; }
    const parts: Buffer[] = [];
    let size = 0;
    let read = false; // set at end: a deferred stdin timeout then never cuts a send in flight
    const timer = setTimeout(() => setImmediate(() => { if (!read) fail('stdin'); }), STDIN_MS); // pending data and end run first
    process.stdin.on('data', (b: Buffer) => {
      size += b.length;
      if (size > STDIN_CAP) { clearTimeout(timer); process.stdin.destroy(); fail('oversize'); return; }
      parts.push(b);
    });
    process.stdin.on('end', () => { read = true; clearTimeout(timer); if (!finished) report(agentArg, profileArg, Buffer.concat(parts, size)); });
    process.stdin.on('error', () => { clearTimeout(timer); fail('stdin'); });
    return;
  }
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
    unsettled = () => spool(e, e);
    send(e);
  };
  // setImmediate: a slow start can make this timer due before stdin's data is read; poll runs first (review, EC-46 flake)
  const readTimer = setTimeout(() => setImmediate(() => complete(false)), STDIN_MS);
  process.stdin.on('data', (b: Buffer) => {
    total += b.length;
    if (kept < STDIN_CAP) { const part = b.subarray(0, STDIN_CAP - kept); chunks.push(part); kept += part.length; }
    if (total > STDIN_CAP) complete(false);
  });
  process.stdin.on('end', () => complete(true));
  process.stdin.on('error', () => complete(false));
}

main();
