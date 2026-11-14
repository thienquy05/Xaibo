// P3-T03 (EC-11): no service, a socket that never acks, an untrusted run/ or spool/, and a live P3-T02 server. The
// forwarder never connects through an untrusted run/, never writes through an untrusted spool/, and never spools the
// token. Socket cases skip only on the Claude sandbox's EPERM for bind (they run in the unsandboxed suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvelope, type Envelope } from '../../src/shared/hook-protocol.ts';
import { startSocketServer } from '../../src/service/receivers/socket.ts';
import { addRegistration } from '../../src/service/receivers/registrations.ts';

const FWD = join(import.meta.dirname, '..', '..', 'src', 'forwarder', 'forwarder.ts'); // run as Node under test:electron too (ELECTRON_RUN_AS_NODE), as the SEA would
const PAYLOAD = { session_id: '00000000-0000-4000-8000-0000000f0101', cwd: '/tmp/xaibo-fixture/alpha', hook_event_name: 'Stop', prompt: 'payload-canary' };
const dataDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'xd-')));
const probe = await new Promise<string>((resolve) => {
  const s = net.createServer().once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error')).listen(join(dataDir(), 'p.sock'), () => s.close(() => resolve('ok')));
});
if (probe !== 'ok' && probe !== 'EPERM') throw new Error(`unexpected socket probe failure: ${probe}`);
const skip = probe === 'EPERM' ? 'Unix socket bind is denied here (Claude sandbox); runs in the unsandboxed suite' : false;

function forward(dir: string) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [FWD, 'hook', 'claude', 'p1'], { input: JSON.stringify(PAYLOAD), env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH ?? '', XAIBO_DATA_DIR: dir }, timeout: 10_000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length + r.stderr.length, 0);
  return performance.now() - t0;
}
const lines = (dir: string) => existsSync(join(dir, 'spool'))
  ? readdirSync(join(dir, 'spool')).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(dir, 'spool', f), 'utf8').split('\n').filter(Boolean))
  : [];
function privateRun(dir: string, token = 'tok-canary-0123456789') {
  mkdirSync(join(dir, 'run'), { mode: 0o700 });
  writeFileSync(join(dir, 'run', 'token'), token, { mode: 0o600 });
  return token;
}

test('EC-11: no service (no run/, or a token but no socket) -> exactly one spooled envelope', () => {
  for (const withToken of [false, true]) {
    const dir = dataDir();
    const token = withToken ? privateRun(dir) : '';
    forward(dir);
    const ls = lines(dir);
    assert.equal(ls.length, 1);
    const p = parseEnvelope(JSON.parse(ls[0]!));
    assert.ok(p.ok);
    assert.deepEqual(p.envelope.payload, PAYLOAD);
    if (token) assert.ok(!ls[0]!.includes(token), 'the token is never spooled');
  }
});

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
// Baseline: the forwarder itself started without a data dir loads and exits at entry, so path time minus this is the
// time spent after entry (the M7 contract), without the dev runtime's TypeScript loading that the packaged SEA lacks.
const baseline = () => median(Array.from({ length: 7 }, () => {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [FWD, 'hook', 'claude', 'p1'], { env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH ?? '' }, input: '{}', timeout: 10_000 });
  const ms = performance.now() - t0;
  assert.ok(!r.error && r.status === 0 && r.stdout.length + r.stderr.length === 0, 'a failed baseline sample would hide a slow path');
  return ms;
}));

test('EC-11: a socket that accepts but never acks -> spooled within the deadline', { skip }, async (t) => {
  const dir = dataDir();
  privateRun(dir);
  const silent = net.createServer((c) => { c.on('data', () => {}); c.on('error', () => {}); });
  await new Promise<void>((r) => silent.listen(join(dir, 'run', 'xaibo.sock'), r));
  try {
    const base = baseline();
    // the kernel accepts each connection even while spawnSync blocks this loop; nothing ever acks
    const own = median(Array.from({ length: 5 }, () => forward(dir))) - base;
    assert.equal(lines(dir).length, 5);
    t.diagnostic(`dev runtime, no-ack path: own ~${own.toFixed(1)} ms`);
    assert.ok(own < 100, `own time ~${own.toFixed(0)} ms`);
  } finally { await new Promise((r) => silent.close(r)); }
});

test('the forwarder delivers to the real P3-T02 server: accepted ack, nothing spooled, within 100 ms', { skip }, async (t) => {
  const got: Envelope[] = [];
  // spawn, not spawnSync: the server shares this event loop and must answer while the forwarder waits.
  const s2 = await startSocketServer({ dataDir: dataDir(), onEnvelope: async (e) => { got.push(e); return { status: 'accepted', code: 'ok' }; } });
  const dir2 = s2.path.replace(/\/run\/xaibo\.sock$/, '');
  try {
    const base = baseline();
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const child = spawn(process.execPath, [FWD, 'hook', 'claude', 'p1'], { env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH ?? '', XAIBO_DATA_DIR: dir2 } });
      let out = 0;
      child.stdout.on('data', (d: Buffer) => { out += d.length; });
      child.stderr.on('data', (d: Buffer) => { out += d.length; });
      child.stdin.end(JSON.stringify(PAYLOAD));
      const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
      const code = await new Promise((r) => child.on('close', r));
      clearTimeout(kill);
      runs.push(performance.now() - t0);
      assert.equal(code, 0);
      assert.equal(out, 0);
    }
    assert.equal(lines(dir2).length, 0, 'acked, so nothing spooled');
    assert.equal(got.filter((e) => JSON.stringify(e.payload) === JSON.stringify(PAYLOAD)).length, 5);
    const own = median(runs) - base;
    t.diagnostic(`dev runtime, accepted path: own ~${own.toFixed(1)} ms`);
    assert.ok(own < 100, `own time ~${own.toFixed(0)} ms`);
  } finally { await s2.close(); }
});

test('untrusted run/ (group/other bits, symlink) -> no connect, spooled; untrusted spool/ -> dropped, nothing written through it', () => {
  const loose = dataDir();
  privateRun(loose);
  chmodSync(join(loose, 'run'), 0o755);
  forward(loose);
  assert.equal(lines(loose).length, 1, 'spooled instead of trusting a loose run/');

  const linked = dataDir();
  const elsewhere = dataDir();
  privateRun(elsewhere);
  symlinkSync(join(elsewhere, 'run'), join(linked, 'run'));
  forward(linked);
  assert.equal(lines(linked).length, 1);

  const victim = dataDir();
  const outside = dataDir();
  symlinkSync(outside, join(victim, 'spool'));
  forward(victim);
  assert.deepEqual(readdirSync(outside), [], 'nothing written through a symlinked spool/');
});

test('G3b-1 (SEC2): an ack header declaring 0xffffffff bytes ends the exchange at once; the report falls back to the spool', { skip }, async () => {
  const dir = dataDir();
  privateRun(dir);
  const { registration, token } = addRegistration(dir, { agent: 'claude', profileKey: 'p1' });
  const tokenFile = join(dir, 'producer.token');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  let written = 0;
  const junk = Buffer.alloc(64 * 1024, 0x61);
  const hostile = net.createServer((c) => {
    let open = true;
    c.on('error', () => { open = false; });
    c.on('close', () => { open = false; });
    const pump = () => { if (open) c.write(junk, (err) => { if (!err) { written += junk.length; pump(); } }); };
    c.once('data', () => { const h = Buffer.alloc(4); h.writeUInt32BE(0xffffffff); c.write(h); pump(); });
  });
  await new Promise<void>((r) => hostile.listen(join(dir, 'run', 'xaibo.sock'), r));
  try {
    // spawn, not spawnSync: the server shares this event loop
    const child = spawn(process.execPath, [FWD, 'report', registration.id, tokenFile], { env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH ?? '', XAIBO_DATA_DIR: dir } });
    let out = 0;
    child.stdout.on('data', (d: Buffer) => { out += d.length; });
    child.stderr.on('data', (d: Buffer) => { out += d.length; });
    child.stdin.end(JSON.stringify({ v: 1, delivery_id: 'g3b1-1', session_id: PAYLOAD.session_id, event: 'turn.start', payload: {} }));
    const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const status = await new Promise((r) => child.on('close', r));
    clearTimeout(kill);
    assert.equal(status, 0);
    assert.equal(out, 0);
    const ls = lines(dir);
    assert.equal(ls.length, 1, 'fell back to the spool');
    assert.equal((JSON.parse(ls[0]!) as { kind: string }).kind, 'report');
    assert.ok(written < 512 * 1024, `the forwarder kept reading ~${written} bytes of a hostile ack`);
  } finally { await new Promise((r) => hostile.close(r)); }
});
