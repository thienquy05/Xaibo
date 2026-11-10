// P0-S13-T3 statusLine tee. Runs as the statusLine command: XAIBO_TEE_ORIGINAL holds the owner's original command
// string (empty/unset = none), XAIBO_TEE_SOCKET the capture socket. The original runs as `/bin/sh -c <original>` with
// stdout/stderr inherited (bytes untouched) and the tee's stdin copied to it; a copy of stdin (cap 256 KiB) becomes a
// capture record of allowlisted fields sent framed (4-byte BE length + JSON, as S3) with its own deadline.
// The tee writes 0 bytes and mirrors the original's exit: code, or the same signal re-raised, else 128+signal (OQ-B8).
// SIGTERM/SIGINT/SIGHUP to the tee are forwarded to the child; the tee then mirrors how the child ended. SIGKILL cannot
// be forwarded: the child is orphaned unless the caller kills the whole process group.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { constants } from 'node:os';

const CAPTURE_CAP = 256 * 1024;
const SEND_DEADLINE_MS = 50;
const FORWARD = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const NEVER_KEY = /plan|account|email|org|user/i; // account attributes and identifiers stay out (D-22, as reduce.ts)
// Numbers-as-text and ISO dates/times only: a single word can be content, so identifier-like strings are dropped too.
// ponytail: enum strings (e.g. a limit status) are lost; allowlist them by key once T2 pins the schema.
const VALUE = /^-?\d+(\.\d+)?$|^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const at = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : undefined);

// Numbers, booleans, null and short identifier-like strings only, under identifier-like keys.
function scrub(v: unknown): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return VALUE.test(v) ? v : undefined;
  if (Array.isArray(v)) return v.map(scrub).filter((x) => x !== undefined);
  if (typeof v !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) { const s = scrub(x); if (KEY.test(k) && !NEVER_KEY.test(k) && s !== undefined) out[k] = s; }
  return out;
}

function strings(o: unknown, keys: string[]) {
  const out = Object.fromEntries(keys.map((k) => [k, str(at(o, k))]).filter(([, v]) => v !== undefined));
  return Object.keys(out).length ? out : undefined;
}

// OQ-B7: session_id yes; transcript_path, cwd, workspace and any content never.
export function captureRecord(v: unknown, receivedTs: number): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const rec: Record<string, unknown> = {
    received_ts: receivedTs,
    session_id: str(at(v, 'session_id')),
    model: strings(at(v, 'model'), ['id', 'display_name']),
    effort: strings(at(v, 'effort'), ['level']),
  };
  for (const k of ['cost', 'context_window', 'rate_limits']) { const x = at(v, k); if (x && typeof x === 'object') rec[k] = scrub(x); }
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
  return rec;
}

function send(path: string, rec: unknown): Promise<void> {
  return new Promise((done) => {
    try {
      const body = Buffer.from(JSON.stringify(rec));
      const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
      const s = connect(path);
      const timer = setTimeout(() => s.destroy(), SEND_DEADLINE_MS);
      s.on('error', () => {});
      s.on('close', () => { clearTimeout(timer); done(); });
      s.end(Buffer.concat([len, body]));
    } catch { done(); }
  });
}

function main() {
  const original = process.env.XAIBO_TEE_ORIGINAL;
  const sock = process.env.XAIBO_TEE_SOCKET;
  const env = { ...process.env };
  delete env.XAIBO_TEE_ORIGINAL; delete env.XAIBO_TEE_SOCKET; // the original sees the environment it would without the tee

  const chunks: Buffer[] = [];
  let kept = 0; let over = false;
  const captured = new Promise<void>((done) => {
    process.stdin.on('end', () => {
      if (!sock || over) return done(); // over the cap the JSON is cut anyway: no record
      let rec: Record<string, unknown> | undefined;
      // Any throw here (bad JSON, nesting deep enough to overflow scrub's stack) would print and exit 1: drop the capture.
      try { rec = captureRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')), Date.now()); } catch { return done(); }
      if (!rec) return done();
      void send(sock, rec).then(done);
    });
    process.stdin.on('error', () => done());
  });
  const keep = (c: Buffer) => { if (over || kept + c.length > CAPTURE_CAP) over = true; else { chunks.push(c); kept += c.length; } };

  if (!original) {
    process.stdin.on('data', keep);
    void captured.then(() => process.exit(0));
    return;
  }

  const child = spawn('/bin/sh', ['-c', original], { stdio: ['pipe', 'inherit', 'inherit'], env });
  for (const s of FORWARD) process.on(s, () => { child.kill(s); });
  let open = true; // false once the original stops reading (EPIPE): keep draining our stdin for the capture
  const stop = () => { open = false; process.stdin.resume(); };
  child.stdin.on('error', stop); child.stdin.on('close', stop);
  process.stdin.on('data', (c: Buffer) => {
    keep(c);
    if (open && !child.stdin.write(c)) { process.stdin.pause(); child.stdin.once('drain', () => process.stdin.resume()); }
  });
  process.stdin.on('end', () => { if (open) child.stdin.end(); });

  child.on('error', () => process.exit(127)); // /bin/sh could not start
  child.on('exit', (code, signal) => {
    // A capture still in flight gets at most its own deadline; if stdin never ended it is dropped.
    void Promise.race([captured, new Promise((r) => setTimeout(r, SEND_DEADLINE_MS))]).then(() => {
      if (!signal) process.exit(code ?? 0);
      for (const s of FORWARD) process.removeAllListeners(s);
      // SIGUSR1 would start Node's inspector and Node ignores SIGPIPE: those take the 128+n fallback directly.
      if (signal !== 'SIGUSR1' && signal !== 'SIGPIPE') process.kill(process.pid, signal);
      setTimeout(() => process.exit(128 + constants.signals[signal]), 50); // non-fatal default disposition
    });
  });
}

if (import.meta.main) main();
