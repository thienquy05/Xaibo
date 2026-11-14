// P3-T02: private hook socket (EC-32 malicious local client; EC-47 dev/prod separation; Q3-8 path limit). Short temp
// data dirs keep socket paths under the macOS sun_path limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { createDecoder, encodeFrame, type Envelope } from '../../src/shared/hook-protocol.ts';
import { createLogger } from '../../src/shared/log.ts';
import { SocketError, startSocketServer, type SocketServer } from '../../src/service/receivers/socket.ts';

const dataDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'xs-')));
// The Claude sandbox denies bind() on Unix sockets; these cases run in the unsandboxed suite (as the real-ps case does).
const probe = await new Promise<string>((resolve) => {
  const p = join(dataDir(), 'probe.sock');
  const s = net.createServer().once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error')).listen(p, () => s.close(() => resolve('ok')));
});
if (probe !== 'ok' && probe !== 'EPERM') throw new Error(`unexpected socket probe failure: ${probe}`);
const skip = probe === 'EPERM' ? 'Unix socket bind is denied here (Claude sandbox); runs in the unsandboxed suite' : false;
const ENV = {
  v: 1, delivery_id: '00000000-0000-4000-8000-0000000d0101', agent: 'claude', profile_key: 'p1', event: 'Stop',
  session_id: null, cwd: null, received_ts: 1767225600000, payload: { marker: 'payload-canary' },
};

async function server(dir: string, deadlineMs = 2_000, intake?: (e: Envelope) => Promise<void>) {
  const got: Envelope[] = [];
  const logDir = join(dir, 'logs');
  const s = await startSocketServer({
    dataDir: dir, deadlineMs,
    onEnvelope: async (e) => { got.push(e); await intake?.(e); return { status: 'accepted', code: 'ok' }; },
    log: createLogger({ dir: logDir, secret: Buffer.alloc(32, 7) }),
  });
  const logs = () => readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('');
  return { s, got, logs, token: readFileSync(s.tokenFile, 'utf8') };
}

/** Sends raw chunks (with optional gaps) and resolves with the decoded replies once the server closes the connection. */
function talk(path: string, chunks: Array<Buffer | number>): Promise<{ replies: unknown[]; closedMs: number }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const push = createDecoder();
    const replies: unknown[] = [];
    const c = net.connect(path);
    c.on('data', (d: Buffer) => replies.push(...push(d)));
    c.on('error', () => { /* reset by the server counts as closed */ });
    c.on('close', () => resolve({ replies, closedMs: Date.now() - t0 }));
    c.on('connect', async () => {
      for (const x of chunks) {
        if (typeof x === 'number') await new Promise((r) => setTimeout(r, x));
        else if (!c.destroyed) c.write(x);
      }
      setTimeout(() => c.end(), 300);
    });
    setTimeout(() => reject(new Error('no close')), 10_000).unref();
  });
}
const hello = (token: string) => encodeFrame({ v: 1, token });

test('a valid hello and envelope are accepted and acked once', { skip }, async () => {
  const { s, got, token } = await server(dataDir());
  try {
    const r = await talk(s.path, [Buffer.concat([hello(token), encodeFrame(ENV)])]);
    assert.equal(got.length, 1);
    assert.deepEqual(got[0], ENV);
    assert.deepEqual(r.replies, [{ v: 1, delivery_id: ENV.delivery_id, status: 'accepted', code: 'ok' }]);
  } finally { await s.close(); }
});

test('EC-32: wrong token, missing hello, bad version, oversize, garbage and slow-loris never reach intake', { skip }, async () => {
  const { s, got, logs, token } = await server(dataDir(), 300);
  try {
    const wrong = await talk(s.path, [Buffer.concat([hello('x'.repeat(token.length)), encodeFrame(ENV)])]);
    assert.deepEqual(wrong.replies, [{ v: 1, delivery_id: null, status: 'rejected', code: 'auth' }]);
    await talk(s.path, [encodeFrame(ENV)]);
    await talk(s.path, [Buffer.concat([hello(token), encodeFrame({ ...ENV, v: 2 })])]);
    const big = Buffer.alloc(4);
    big.writeUInt32BE((1 << 20) + 1);
    await talk(s.path, [Buffer.concat([hello(token), big, Buffer.alloc(64)])]);
    const junk = Buffer.from('garbage bytes, not a frame at all');
    await talk(s.path, [Buffer.concat([hello(token), Buffer.from([0, 0, 0, junk.length]), junk])]);
    const frame = Buffer.concat([hello(token), encodeFrame(ENV)]);
    const slow = await talk(s.path, [...frame].flatMap((b) => [Buffer.from([b]), 50]).slice(0, 40));
    assert.ok(slow.closedMs < 1_500, `slow-loris closed after ${slow.closedMs} ms`);
    assert.equal(got.length, 0, 'nothing reached intake');
    const text = logs();
    assert.ok(!text.includes(token) && !text.includes('payload-canary') && !text.includes('garbage'), 'logs carry codes only');
    assert.match(text, /"socket_reject"/);
    assert.match(text, /"error":"auth"/, 'the rejection reason survives the real logger');
  } finally { await s.close(); }
});

test('blocked intake: no ack, and nothing reaches intake after the client hangs up', { skip }, async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const frames = Array.from({ length: 40 }, (_, i) => encodeFrame({ ...ENV, delivery_id: `00000000-0000-4000-8000-${String(200 + i).padStart(12, '0')}` }));
  const { s, got, token } = await server(dataDir(), 2_000, () => gate);
  try {
    const r = await talk(s.path, [Buffer.concat([hello(token), ...frames])]);
    assert.deepEqual(r.replies, [], 'no ack while intake is blocked');
    assert.equal(got.length, 1, 'only the first envelope reached the blocked intake');
    release();
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(got.length, 1, 'queued work is dropped when the connection ends');
  } finally { await s.close(); }
});

test('blocked intake: past the byte budget the connection is rejected and its queued work dropped', { skip }, async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { s, got, token } = await server(dataDir(), 2_000, () => gate);
  try {
    const big = Array.from({ length: 4 }, (_, i) => encodeFrame({ ...ENV, delivery_id: `00000000-0000-4000-8000-${String(300 + i).padStart(12, '0')}`, payload: { blob: 'x'.repeat(900 * 1024) } }));
    const r = await talk(s.path, [Buffer.concat([hello(token), ...big])]);
    assert.deepEqual(r.replies, [{ v: 1, delivery_id: null, status: 'rejected', code: 'busy' }]);
    release();
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(got.length, 1, 'nothing queued reaches intake once the connection is rejected');
  } finally { await s.close(); }
});

test('a client that never reads acks is throttled, then finishes once it reads', { skip }, async () => {
  const { s, got, token } = await server(dataDir(), 5_000);
  const N = 3000;
  try {
    const push = createDecoder();
    const acks: unknown[] = [];
    const c = net.connect(s.path);
    c.on('error', () => {});
    await new Promise((r) => c.once('connect', r));
    c.pause(); // never read: acks pile up in the kernel buffers
    c.write(hello(token));
    for (let i = 0; i < N; i++) c.write(encodeFrame({ ...ENV, delivery_id: `00000000-0000-4000-8000-${String(1000 + i).padStart(12, '0')}` }));
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(got.length < N, `intake stopped while acks were unread (${got.length})`);
    c.on('data', (d: Buffer) => acks.push(...push(d)));
    c.resume();
    const t0 = Date.now();
    while (acks.length < N && Date.now() - t0 < 8_000) await new Promise((r) => setTimeout(r, 50));
    assert.equal(acks.length, N);
    assert.equal(got.length, N);
    c.destroy();
  } finally { await s.close(); }
});

test('modes: run dir 0700, socket and token 0600; the token changes at each start', { skip }, async () => {
  const dir = dataDir();
  const a = await server(dir);
  const run = join(dir, 'run');
  assert.equal(statSync(run).mode & 0o777, 0o700);
  assert.equal(lstatSync(a.s.path).mode & 0o777, 0o600);
  assert.ok(lstatSync(a.s.path).isSocket());
  assert.equal(statSync(a.s.tokenFile).mode & 0o777, 0o600);
  await a.s.close();
  const b = await server(dir);
  try { assert.notEqual(b.token, a.token); } finally { await b.s.close(); }
});

test('a stale socket file is recovered; a live one makes a second listener fail', { skip }, async () => {
  const dir = dataDir();
  const first = await server(dir);
  const path = first.s.path;
  await first.s.close();
  // A process killed while listening leaves its socket file behind.
  spawnSync(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`]);
  assert.ok(lstatSync(path).isSocket(), 'stale socket present');
  const live = await server(dir);
  try {
    await assert.rejects(server(dir), (e) => e instanceof SocketError && e.code === 'in-use');
    const r = await talk(live.s.path, [Buffer.concat([hello(live.token), encodeFrame(ENV)])]);
    assert.equal(r.replies.length, 1, 'the first listener still answers');
  } finally { await live.s.close(); }
});

test('EC-47: two data dirs (dev/prod) listen on distinct sockets; neither takes the other', { skip }, async () => {
  const dev = await server(dataDir());
  const prod = await server(dataDir());
  try {
    assert.notEqual(dev.s.path, prod.s.path);
    await talk(dev.s.path, [Buffer.concat([hello(dev.token), encodeFrame(ENV)])]);
    await talk(prod.s.path, [Buffer.concat([hello(dev.token), encodeFrame(ENV)])]);
    assert.equal(dev.got.length, 1);
    assert.equal(prod.got.length, 0, "one service's token is not valid for the other");
  } finally { await dev.s.close(); await prod.s.close(); }
});

test('Q3-8: a socket path over the sun_path limit is a typed error', async () => {
  const dir = join(dataDir(), 'd'.repeat(90));
  await assert.rejects(startSocketServer({ dataDir: dir, onEnvelope: async () => ({ status: 'accepted', code: 'ok' }) }),
    (e) => e instanceof SocketError && e.code === 'path-too-long');
});
