// P0-S13-T3 statusLine tee. Runs as the statusLine command: XAIBO_TEE_ORIGINAL holds the owner's original command
// string (empty/unset = none), XAIBO_TEE_SOCKET the capture socket. The original runs as `/bin/sh -c <original>` with
// stdout/stderr inherited (bytes untouched) and the tee's stdin copied to it; a copy of stdin (cap 256 KiB) becomes a
// capture record of allowlisted fields (explicit paths, numbers only) sent framed (4-byte BE length + JSON, as S3) with its own deadline.
// The tee writes 0 bytes and mirrors the original's exit: code, or the same signal re-raised, else 128+signal (OQ-B8).
// SIGTERM/SIGINT/SIGHUP to the tee are forwarded to the child; the tee then mirrors how the child ended. SIGKILL cannot
// be forwarded: the child is orphaned unless the caller kills the whole process group.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { constants } from 'node:os';

const CAPTURE_CAP = 256 * 1024;
const SEND_DEADLINE_MS = 50;
const FORWARD = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
// Field allowlist (the statusLine keys observed on 2.1.319, S13-T2): only these paths pass, and only with a number
// (or null, or an ISO date/time for resets_at). Anything else, whatever its value looks like, is dropped.
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const COST = ['total_cost_usd', 'total_duration_ms', 'total_api_duration_ms', 'total_lines_added', 'total_lines_removed'];
const CONTEXT = ['context_window_size', 'used_percentage', 'remaining_percentage', 'total_input_tokens', 'total_output_tokens'];
const USAGE = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
const WINDOWS = ['five_hour', 'seven_day'];

const at = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function pick(o: unknown, keys: string[], val: (v: unknown) => unknown = num) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const out = Object.fromEntries(keys.map((k) => [k, val(at(o, k))]).filter(([, v]) => v !== undefined));
  return Object.keys(out).length ? out : undefined;
}

function contextWindow(o: unknown) {
  const out: Record<string, unknown> = pick(o, CONTEXT) ?? {};
  const u = at(o, 'current_usage');
  if (u === null) out.current_usage = null; // "unavailable" before the first response and after /compact
  else { const p = pick(u, USAGE); if (p) out.current_usage = p; }
  return Object.keys(out).length ? out : undefined;
}

function rateLimits(o: unknown) {
  const resets = (v: unknown) => num(v) ?? (typeof v === 'string' && ISO.test(v) ? v : undefined);
  const out = Object.fromEntries(WINDOWS.map((w) => {
    const x = at(o, w);
    const p = { ...pick(x, ['used_percentage']), ...pick(x, ['resets_at'], resets) };
    return [w, Object.keys(p).length ? p : undefined];
  }).filter(([, v]) => v !== undefined));
  return Object.keys(out).length ? out : undefined;
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
  rec.cost = pick(at(v, 'cost'), COST);
  rec.context_window = contextWindow(at(v, 'context_window'));
  rec.rate_limits = rateLimits(at(v, 'rate_limits'));
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
      // Any throw here (bad JSON) would print and exit 1: drop the capture.
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
