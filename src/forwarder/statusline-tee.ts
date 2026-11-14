// Claude statusLine tee (P3-T14; S-31, FR-45, EC-28, M7; S13; design review 1074). Built as its own SEA, xaibo-statusline
// (execArgvExtension none: NODE_OPTIONS never reaches it), deployed to <dataDir>/integrations/bin and named in a
// disposable profile's settings.json as `'<bin>' '<dataDir>' <profile_key>` (teeCommand). One self-contained file with
// builtins only, because a SEA runs a single script; the service imports its pure parts.
// The owner's original command is the value Xaibo replaced: the `old` of the applied claude-tee manifest entry whose owned
// statusLine command is exactly ours (Q3-7; applied or pending, review M2); the data dir and integrations/ must be our own dirs, integrations/ and the
// manifest private, and a SEA must sit in that data dir's bin (review M2). It runs at once as `/bin/sh -c <original>`
// (the S13 invocation; Claude's own shell is not named by S13, review M4) with cwd and environment unchanged, stdout and
// stderr inherited, stdin streamed to it byte for byte while a separate copy (<= 256 KiB) is kept. SIGTERM/SIGINT/SIGHUP
// are forwarded; the exit mirrors the original's code, or re-raises its signal, else 128 + n (OQ-B8). The tee writes no
// byte: process.stdout/stderr are never created (creating one sets O_NONBLOCK on the pipe the original shares, review
// H1) but answer with a discard sink, and errors are never printed. Native runtime writes (a V8 fatal error) cannot be
// silenced without a shim that would alter the original's environment (review M5, accepted). After stdin EOF, only the
// FR-45 allowlist is sent as one hook-protocol v1 envelope (agent claude, event statusline, cwd null) with the install
// token, within 50 ms, never spooled: the next redraw replaces a lost one. No original: nothing written, exit 0.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import net from 'node:net';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import sea from 'node:sea';
import { Writable } from 'node:stream';

export const STATUSLINE_BIN = 'xaibo-statusline';
const CAPTURE_CAP = 256 * 1024;
const SEND_DEADLINE_MS = 50;
const MANIFEST_MAX = 4 << 20; // as the FR-32 engine's file cap
const MAX_TOKEN = 256;
const FORWARD = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
const PROFILE_KEY = /^[A-Za-z0-9._-]{1,128}$/; // as the hook protocol's profile_key
const UNSAFE_PATH = /['\u0000-\u001f\u007f]/;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
// The statusLine keys observed on 2.1.319 (S13-T2) that FR-45 names; anything else is dropped whatever it looks like.
const CONTEXT = ['context_window_size', 'used_percentage', 'remaining_percentage', 'total_input_tokens', 'total_output_tokens'];
const USAGE = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
const WINDOWS = ['five_hour', 'seven_day'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const at = (o: unknown, k: string): unknown => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
/** Finite and not negative (review L1); spend over 100 % is kept. */
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
/** A well-formed string of at most `max` characters; longer ones are dropped, never cut. */
const str = (max: number) => (v: unknown) => (typeof v === 'string' && v.length <= max && v.isWellFormed() ? v : undefined);
const resets = (v: unknown) => num(v) ?? (typeof v === 'string' && v.length <= 40 && ISO.test(v) ? v : undefined);
const prune = (o: Obj) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return Object.keys(o).length ? o : undefined; };
const pick = (o: unknown, keys: string[], val: (v: unknown) => unknown = num) =>
  isObj(o) ? prune(Object.fromEntries(keys.map((k) => [k, val(at(o, k))]))) : undefined;

function contextWindow(o: unknown) {
  if (!isObj(o)) return undefined;
  const out: Obj = pick(o, CONTEXT) ?? {};
  const u = at(o, 'current_usage');
  out['current_usage'] = u === null ? null : pick(u, USAGE); // null = unavailable (before the first response, after /compact)
  return prune(out);
}

/** The FR-45 allowlist (plus session_id, OQ-B7) of one statusLine stdin object; undefined when it is not an object. */
export function captureRecord(v: unknown): Obj | undefined {
  if (!isObj(v)) return undefined;
  return prune({
    session_id: str(256)(at(v, 'session_id')),
    model: pick(at(v, 'model'), ['id', 'display_name'], str(200)),
    effort: pick(at(v, 'effort'), ['level'], str(32)),
    cost: pick(at(v, 'cost'), ['total_cost_usd']),
    context_window: contextWindow(at(v, 'context_window')),
    rate_limits: isObj(at(v, 'rate_limits'))
      ? prune(Object.fromEntries(WINDOWS.map((w) => {
        const x = at(at(v, 'rate_limits'), w);
        // a null or valueless window is kept (null / {}): it says "unavailable now", never the old value (G3e-1, EC-91)
        return [w, x === null ? null : isObj(x) ? prune({ used_percentage: num(at(x, 'used_percentage')), resets_at: resets(at(x, 'resets_at')) }) ?? {} : undefined];
      })))
      : undefined,
  }) ?? {};
}

/** The statusLine command Xaibo writes; the tee recomputes it from its own argv to find its manifest entry. */
export function teeCommand(dataDir: string, profileKey: string): string {
  if (!path.isAbsolute(dataDir) || UNSAFE_PATH.test(dataDir) || !PROFILE_KEY.test(profileKey) || profileKey === '.' || profileKey === '..') {
    throw new Error('statusline tee: unsupported data dir or profile key');
  }
  return `'${path.join(dataDir, 'integrations', 'bin', STATUSLINE_BIN)}' '${dataDir}' ${profileKey}`;
}

/** The original command of the claude-tee entry that owns exactly our command; null when there is none. */
export function findOriginal(entries: unknown, dataDir: string, profileKey: string): string | null {
  let cmd: string;
  try { cmd = teeCommand(dataDir, profileKey); } catch { return null; }
  if (!Array.isArray(entries)) return null;
  for (const e of entries) {
    // pending too: apply records it before the rename and drops it on a failed write, so a crash between the rename and
    // the applied write leaves a pending entry that still names the true original (review M2; was applied-only, L2)
    if (!isObj(e) || e['route'] !== 'claude-tee' || (e['state'] !== 'applied' && e['state'] !== 'pending') || !Array.isArray(e['owned'])) continue;
    for (const o of e['owned']) {
      if (isObj(o) && o['pointer'] === '/statusLine/command' && o['value'] === cmd) {
        return typeof o['old'] === 'string' && o['old'] !== '' ? o['old'] : null;
      }
    }
  }
  return null;
}

// --- runtime -------------------------------------------------------------------------------------------------

const uid = process.getuid?.();
const own = (st: Stats) => uid === undefined || st.uid === uid;
function lstat(p: string): Stats | null {
  try { return lstatSync(p); } catch { return null; }
}
const ownDir = (p: string, priv: boolean) => { const st = lstat(p); return !!st && st.isDirectory() && own(st) && (!priv || (st.mode & 0o077) === 0); };

/** A regular private file of our own, read without following links or blocking on a FIFO (review M1); else null. */
function readPrivate(file: string, max: number): Buffer | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !own(st) || (st.mode & 0o077) !== 0 || st.size > max) return null;
    const buf = Buffer.alloc(st.size + 1); // sized to the file (a 4 MiB zero-fill per redraw costs startup time)
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r) r = readSync(fd, buf, n, buf.length - n, null);
    return n > st.size ? null : buf.subarray(0, n); // grew while read: not a whole file
  } catch { return null; } finally { closeSync(fd); }
}

/** The data dir from argv when it is ours (and, in the SEA, the one this binary is installed in); else null. */
function trustedDataDir(arg: string): string | null {
  if (!path.isAbsolute(arg) || !ownDir(arg, false) || !ownDir(path.join(arg, 'integrations'), true)) return null;
  if (sea.isSea()) {
    try { if (realpathSync(path.dirname(process.execPath)) !== realpathSync(path.join(arg, 'integrations', 'bin'))) return null; } catch { return null; }
  }
  return arg;
}

function manifestEntries(dataDir: string): unknown {
  const buf = readPrivate(path.join(dataDir, 'integrations', 'manifest.json'), MANIFEST_MAX);
  try { const m: unknown = buf && JSON.parse(buf.toString('utf8')); return isObj(m) && m['v'] === 1 ? m['entries'] : null; } catch { return null; }
}

function frame(msg: object): Buffer {
  const body = Buffer.from(JSON.stringify(msg));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/** Hello + envelope over our own private socket; resolves on the first ack bytes, an error or the deadline. */
function send(dataDir: string, profileKey: string, rec: Obj): Promise<void> {
  return new Promise((done) => {
    const run = path.join(dataDir, 'run');
    const sock = path.join(run, 'xaibo.sock');
    const st = ownDir(run, true) ? lstat(sock) : null;
    const token = st?.isSocket() && own(st) ? readPrivate(path.join(run, 'token'), MAX_TOKEN)?.toString('utf8') : undefined;
    if (!token) { done(); return; }
    const e = { v: 1, delivery_id: randomUUID(), agent: 'claude', profile_key: profileKey, event: 'statusline',
      session_id: typeof rec['session_id'] === 'string' ? rec['session_id'] : null, cwd: null, received_ts: Date.now(), payload: rec };
    const c = net.connect(sock);
    const end = () => { clearTimeout(timer); c.destroy(); done(); };
    const timer = setTimeout(end, SEND_DEADLINE_MS);
    c.on('error', end);
    c.on('close', end);
    c.on('data', end); // the ack (or a rejection): delivery is the service's from here; closing earlier would drop it
    c.on('connect', () => { c.write(Buffer.concat([frame({ v: 1, token }), frame(e)])); });
  });
}

function main() {
  // Before anything can touch them (review H1): fd 1 and 2 belong to the original.
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  for (const name of ['stdout', 'stderr']) Object.defineProperty(process, name, { configurable: true, get: () => sink });
  let child: ChildProcess | null = null;
  process.on('uncaughtException', () => { if (!child) process.exit(0); }); // never printed; a running original is still mirrored
  process.on('unhandledRejection', () => {});
  for (const s of FORWARD) process.on(s, () => { if (child) child.kill(s); else process.exit(128 + osConstants.signals[s]); });

  const [dataArg = '', key = ''] = process.argv.slice(2);
  const dataDir = trustedDataDir(dataArg);
  const capture = dataDir !== null && PROFILE_KEY.test(key);
  const original = dataDir ? findOriginal(manifestEntries(dataDir), dataDir, key) : null;

  const chunks: Buffer[] = [];
  let kept = 0;
  let over = false;
  const keep = (c: Buffer) => { if (over || kept + c.length > CAPTURE_CAP) over = true; else { chunks.push(c); kept += c.length; } };
  const captured = new Promise<void>((done) => {
    process.stdin.on('end', () => {
      if (!capture || over) { done(); return; } // over the cap the JSON is cut anyway
      let rec: Obj | undefined;
      try { rec = captureRecord(JSON.parse(Buffer.concat(chunks, kept).toString('utf8'))); } catch { done(); return; }
      if (rec) void send(dataDir!, key, rec).then(done); else done();
    });
    process.stdin.on('error', () => done());
  });

  if (!original) {
    process.stdin.on('data', keep);
    void captured.then(() => process.exit(0));
    return;
  }

  child = spawn('/bin/sh', ['-c', original], { stdio: ['pipe', 'inherit', 'inherit'] }); // cwd and env inherited unchanged
  let open = true; // false once the original stops reading (EPIPE): keep draining our stdin for the capture
  const stop = () => { open = false; process.stdin.resume(); };
  child.stdin!.on('error', stop);
  child.stdin!.on('close', stop);
  process.stdin.on('data', (c: Buffer) => {
    keep(c);
    if (open && !child!.stdin!.write(c)) { process.stdin.pause(); child!.stdin!.once('drain', () => process.stdin.resume()); }
  });
  process.stdin.on('end', () => { if (open) child!.stdin!.end(); });
  process.stdin.on('error', () => { if (open) child!.stdin!.end(); }); // an original reading to EOF never hangs (review M1)
  // /bin/sh could not start; a failed kill or stdin write of a running original is not a reason to leave (review M3)
  child.on('error', () => { if (child!.pid === undefined) process.exit(127); });
  // 'exit', not 'close': a backgrounded grandchild holding the pipes never holds the tee (review L3)
  child.on('exit', (code, signal) => {
    const deadline = new Promise((r) => setTimeout(r, SEND_DEADLINE_MS)); // ref'd: the loop must live until the mirrored exit
    void Promise.race([captured, deadline]).then(() => {
      if (!signal) process.exit(code ?? 0);
      for (const s of FORWARD) process.removeAllListeners(s);
      // SIGUSR1 would start the inspector and Node ignores SIGPIPE: those take the 128 + n fallback directly
      if (signal !== 'SIGUSR1' && signal !== 'SIGPIPE') process.kill(process.pid, signal);
      setTimeout(() => process.exit(128 + osConstants.signals[signal]), 50);
    });
  });
}

if (import.meta.main) main();
