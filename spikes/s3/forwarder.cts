// S3 spike forwarder (P0-S3-T2). One CommonJS file, Node builtins only; also the SEA entry.
// Contract: never writes stdout/stderr, exits 0 on every path within 100 ms of entry. Bounded stdin (256 KB kept,
// read deadline), delivery_id before the first send, framed send to <data>/run/xaibo.sock, 1-byte ack within the
// remaining budget, else append to <data>/spool (50 MB cap, overflow counter outside the spool dir).
const t_entry = process.hrtime.bigint();
// Own deadline. Total added wait = runtime startup (before this line) + this budget, so the shipped value is
// 100 ms minus the runtime's startup p95 (S3 finding); env override exists for the bench only.
const DEADLINE_MS = Number(process.env.XAIBO_FWD_DEADLINE_MS) || 100;
const hardTimer = setTimeout(() => finish(), DEADLINE_MS); // first thing: nothing below may push exit past the deadline
process.removeAllListeners('warning');
const fs: typeof import('node:fs') = require('node:fs');
const net: typeof import('node:net') = require('node:net');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');

const STDIN_CAP = 256 * 1024;
const STDIN_DEADLINE_MS = 40;
const SPOOL_RESERVE_MS = 15;
const SPOOL_CAP = 50 * 1024 * 1024;

let finished = false;
let settled = false;            // acked or spooled
let buildLine: (() => string) | null = null;
let outcome = 'start';
const elapsed = () => Number(process.hrtime.bigint() - t_entry) / 1e6;

function finish(): void {
  if (finished) return;
  finished = true;
  // Deadline hit before ack or spool (CPU starvation): spool what we have rather than lose it.
  if (!settled && buildLine && dataDir) { spool(buildLine()); outcome = `late-${outcome}`; }
  try {
    const stats = process.env.XAIBO_FWD_STATS; // bench only
    if (stats) fs.appendFileSync(stats, `${t_entry}\t${process.hrtime.bigint()}\t${outcome}\n`);
  } catch { /* silent */ }
  process.exit(0);
}
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
void hardTimer;

const dataDir = process.env.XAIBO_DATA_DIR;
const [agent = 'unknown', event = 'unknown'] = process.argv.slice(2);

function spool(line: string): void {
  try {
    const dir = path.join(dataDir!, 'spool');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // ponytail: approximate cap via a byte counter (racy under concurrency, can overshoot slightly); exact accounting
    // would need a lock. Avoids listing the spool on every run (O(files) sync work blew the deadline). The receiver
    // resets the counter after each replay.
    const bytesFile = path.join(dataDir!, 'run', 'spool-bytes');
    let used = 0;
    try { used = Number(fs.readFileSync(bytesFile, 'utf8')) || 0; } catch { /* first spool */ }
    const bytes = Buffer.byteLength(line);
    if (used + bytes > SPOOL_CAP) throw new Error('cap');
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(dir, `${day}-${process.pid}.jsonl`), line, { mode: 0o600 });
    settled = true;
    try { fs.mkdirSync(path.dirname(bytesFile), { recursive: true, mode: 0o700 }); fs.writeFileSync(bytesFile, String(used + bytes), { mode: 0o600 }); } catch { /* counter best effort */ }
    outcome = 'spooled';
  } catch {
    try {
      const counter = path.join(dataDir!, 'run', 'spool-overflow');
      fs.mkdirSync(path.dirname(counter), { recursive: true, mode: 0o700 });
      const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) + 1;
      fs.writeFileSync(counter, String(n), { mode: 0o600 });
    } catch { /* silent loss */ }
    settled = true;
    outcome = 'lost';
  }
}

function send(delivery: Record<string, unknown>): void {
  let token = '';
  try { token = fs.readFileSync(path.join(dataDir!, 'run', 'token'), 'utf8'); } catch { /* service never ran */ }
  const line = `${JSON.stringify(delivery)}\n`;
  if (!token) { spool(line); return finish(); }
  const budget = DEADLINE_MS - elapsed() - SPOOL_RESERVE_MS;
  if (budget <= 0) { spool(line); return finish(); }
  const sock = net.connect(path.join(dataDir!, 'run', 'xaibo.sock'));
  const timer = setTimeout(() => { sock.destroy(); spool(line); finish(); }, budget);
  sock.on('error', () => { clearTimeout(timer); spool(line); finish(); });
  sock.on('data', () => { clearTimeout(timer); settled = true; outcome = 'acked'; sock.destroy(); finish(); });
  sock.on('connect', () => {
    const body = Buffer.from(JSON.stringify({ ...delivery, token, t_send: String(process.hrtime.bigint()) }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    sock.write(Buffer.concat([len, body]));
  });
}

function main(): void {
  if (!dataDir) return finish();
  const chunks: Buffer[] = [];
  let kept = 0;
  let total = 0;
  let done = false;
  let ended = false; // stdin closed by the agent (else the read deadline cut it)
  const delivery = () => {
    const truncated = total > kept || !ended;
    const text = Buffer.concat(chunks).toString('utf8');
    let payload: unknown = null;
    let malformed = false;
    if (!truncated) { try { payload = JSON.parse(text); } catch { malformed = true; } }
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    return {
      v: 1, delivery_id: id, agent, event,
      session_id: typeof p.session_id === 'string' ? p.session_id : null, cwd: typeof p.cwd === 'string' ? p.cwd : null,
      received_ts: Date.now(), payload, truncated, malformed, stdin_bytes: total, t_entry: String(t_entry),
    };
  };
  const id = crypto.randomUUID(); // assigned before the first send or spool
  buildLine = () => `${JSON.stringify(delivery())}\n`;
  const complete = () => {
    if (done) return;
    done = true;
    clearTimeout(readTimer);
    process.stdin.pause();
    send(delivery());
  };
  const readTimer = setTimeout(complete, STDIN_DEADLINE_MS);
  process.stdin.on('data', (c: Buffer) => {
    total += c.length;
    if (kept < STDIN_CAP) { const part = c.subarray(0, STDIN_CAP - kept); chunks.push(part); kept += part.length; }
  });
  process.stdin.on('end', () => { ended = true; complete(); });
  process.stdin.on('error', complete);
}

main();
