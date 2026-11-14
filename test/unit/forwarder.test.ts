// P3-T03: forwarder and shim (EC-63 bounded/malformed stdin, EC-64 silence, M7 own time). No service runs here, so every
// delivery spools; each spooled line must be a valid protocol envelope (guards drift from src/shared/hook-protocol.ts).
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvelope } from '../../src/shared/hook-protocol.ts';

const REPO = join(import.meta.dirname, '..', '..');
const FWD = join(REPO, 'src', 'forwarder', 'forwarder.ts');
const SHIM = join(REPO, 'src', 'forwarder', 'xaibo-hook');
const PAYLOAD = { session_id: '00000000-0000-4000-8000-0000000f0001', cwd: '/tmp/xaibo-fixture/alpha', hook_event_name: 'Stop', prompt: 'payload-canary' };

const dataDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'xf-')));
function forward(dir: string, input: SpawnSyncOptions['input'] | null, args = ['hook', 'claude', 'p1']) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [FWD, ...args], {
    env: { PATH: process.env.PATH ?? '', XAIBO_DATA_DIR: dir }, timeout: 10_000, ...(input === null ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input }),
  });
  return { ...r, ms: performance.now() - t0 };
}
function spooled(dir: string): unknown[] {
  const spool = join(dir, 'spool');
  if (!existsSync(spool)) return [];
  return readdirSync(spool).filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(spool, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown));
}
const silentExit0 = (r: ReturnType<typeof forward>) => {
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length, 0, 'stdout must stay empty (EC-64)');
  assert.equal(r.stderr.length, 0, 'stderr must stay empty (EC-64)');
};

test('valid stdin: one spooled envelope, protocol-valid, fields from the payload, 0600 in a 0700 dir', () => {
  const dir = dataDir();
  const r = forward(dir, JSON.stringify(PAYLOAD));
  silentExit0(r);
  const [line, ...rest] = spooled(dir);
  assert.equal(rest.length, 0);
  const p = parseEnvelope(line);
  assert.ok(p.ok, JSON.stringify(line).slice(0, 200));
  assert.equal(p.envelope.agent, 'claude');
  assert.equal(p.envelope.profile_key, 'p1');
  assert.equal(p.envelope.event, 'Stop');
  assert.equal(p.envelope.session_id, PAYLOAD.session_id);
  assert.equal(p.envelope.cwd, PAYLOAD.cwd);
  assert.deepEqual(p.envelope.payload, PAYLOAD);
  assert.ok(!p.envelope.truncated && !p.envelope.malformed);
  assert.ok(!JSON.stringify(line).includes('token'), 'the spool never carries the token');
  const spool = join(dir, 'spool');
  const file = readdirSync(spool)[0]!;
  assert.match(file, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  assert.equal(spawnSync('stat', ['-f', '%Lp', spool], { encoding: 'utf8' }).stdout.trim(), '700');
  assert.equal(spawnSync('stat', ['-f', '%Lp', join(spool, file)], { encoding: 'utf8' }).stdout.trim(), '600');
});

test('EC-63: malformed, non-object, empty and closed stdin -> malformed flag, payload null; agy camelCase fields', () => {
  for (const input of ['{"hook_event_name": ', '[1, 2]', '', null] as const) {
    const dir = dataDir();
    silentExit0(forward(dir, input));
    const p = parseEnvelope(spooled(dir)[0]);
    assert.ok(p.ok);
    assert.equal(p.envelope.malformed, true, String(input));
    assert.equal(p.envelope.payload, null);
    assert.equal(p.envelope.event, 'unknown');
  }
  const dir = dataDir();
  silentExit0(forward(dir, JSON.stringify({ hookEventName: 'PreToolUse', conversationId: 'conv-1', cwd: '/tmp/xaibo-fixture/b' }), ['hook', 'agy', 'p2']));
  const p = parseEnvelope(spooled(dir)[0]);
  assert.ok(p.ok);
  assert.equal(p.envelope.event, 'PreToolUse');
  assert.equal(p.envelope.session_id, 'conv-1');
});

test('EC-63: 10 MiB stdin -> truncated, payload null, bounded memory', (t) => {
  const dir = dataDir();
  const big = JSON.stringify({ ...PAYLOAD, blob: 'x'.repeat(10 << 20) });
  silentExit0(forward(dir, big));
  const p = parseEnvelope(spooled(dir)[0]);
  assert.ok(p.ok);
  assert.equal(p.envelope.truncated, true);
  assert.equal(p.envelope.payload, null);
  if (process.platform === 'darwin' && existsSync('/usr/bin/time')) {
    const timed = spawnSync('/usr/bin/time', ['-l', process.execPath, FWD, 'hook', 'claude', 'p1'], { input: big, env: { PATH: process.env.PATH ?? '', XAIBO_DATA_DIR: dataDir() }, encoding: 'utf8', timeout: 10_000 });
    const rss = Number(/(\d+)\s+maximum resident set size/.exec(timed.stderr)?.[1]);
    if (Number.isNaN(rss)) t.diagnostic('max RSS unavailable here (Claude sandbox); measured in the unsandboxed suite');
    else assert.ok(rss > 0 && rss < 150 * 1024 * 1024, `max RSS ${rss}`); // node baseline plus at most the 256 KiB bound
  }
});

test('bad argv never breaks the envelope: unknown agent/profile, missing data dir exits 0 silently', () => {
  const dir = dataDir();
  silentExit0(forward(dir, JSON.stringify(PAYLOAD), ['hook', 'Not An Agent!', '']));
  const p = parseEnvelope(spooled(dir)[0]);
  assert.ok(p.ok);
  assert.equal(p.envelope.agent, 'unknown');
  assert.equal(p.envelope.profile_key, 'unknown');
  const r = spawnSync(process.execPath, [FWD, 'hook', 'claude', 'p1'], { input: '{}', env: { PATH: process.env.PATH ?? '' }, timeout: 10_000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length + r.stderr.length, 0);
});

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
// Baseline: the forwarder itself started without a data dir loads and exits at entry, so path time minus this is the
// time spent after entry (the M7 contract), without the dev runtime's TypeScript loading that the packaged SEA lacks.
const baseline = () => median(Array.from({ length: 7 }, () => {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [FWD, 'hook', 'claude', 'p1'], { env: { PATH: process.env.PATH ?? '' }, input: '{}', timeout: 10_000 });
  const ms = performance.now() - t0;
  assert.ok(!r.error && r.status === 0 && r.stdout.length + r.stderr.length === 0, 'a failed baseline sample would hide a slow path');
  return ms;
}));

// M7 on the dev runtime: per path, the median of 7 runs minus a bare-node baseline stays within the 100 ms contract.
// (A median, because the suite runs files in parallel; the packaged per-run p95 is P3-T16's figure.)
test('M7: own time within 100 ms on the spool path (dev runtime)', (t) => {
  const base = baseline();
  const own = median(Array.from({ length: 7 }, () => forward(dataDir(), JSON.stringify(PAYLOAD)).ms)) - base;
  t.diagnostic(`dev runtime, spool path: own ~${own.toFixed(1)} ms (baseline ${base.toFixed(1)} ms)`);
  assert.ok(own < 100, `own time ${own.toFixed(1)} ms`);
});

test('EC-63/M7: stdin held open by the agent -> truncated by the read deadline, exits 0 silently within 100 ms', async (t) => {
  const base = baseline();
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const dir = dataDir();
    const t0 = performance.now();
    const child = spawn(process.execPath, [FWD, 'hook', 'claude', 'p1'], { env: { PATH: process.env.PATH ?? '', XAIBO_DATA_DIR: dir } });
    let out = 0;
    child.stdout.on('data', (d: Buffer) => { out += d.length; });
    child.stderr.on('data', (d: Buffer) => { out += d.length; });
    child.stdin.write('{"hook_event_name": "Stop", '); // never ended
    const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const code = await new Promise((r) => child.on('close', r));
    clearTimeout(kill);
    runs.push(performance.now() - t0);
    assert.equal(code, 0);
    assert.equal(out, 0);
    const p = parseEnvelope(spooled(dir)[0]);
    assert.ok(p.ok);
    assert.equal(p.envelope.truncated, true);
  }
  const own = median(runs) - base;
  t.diagnostic(`dev runtime, held-open stdin: own ~${own.toFixed(1)} ms`);
  assert.ok(own < 100, `own time ${own.toFixed(1)} ms`);
});

// EC-46 (XAIBO-PROD-328): a stall (a loaded machine) right after the forwarder arms a timer leaves it overdue when the
// event loop starts, while stdin already waits in the pipe. An outside SIGSTOP cannot hit that sub-millisecond window
// (0 of 36 staggered tries), so a test-side preload, never part of the SEA, sleeps inside the forwarder's first
// setTimeout(..., at) and writes a marker; each test asserts the marker, so a changed timer constant cannot pass silently.
const DEADLINE = 60, READ = 25, REPORT_DEADLINE = 2_000, REPORT_READ = 1_000; // forwarder.ts DEADLINE_MS / STDIN_MS
async function stalled(dir: string, input: string, end: boolean, at = DEADLINE, sleep = 200, args = ['hook', 'claude', 'p1']) {
  const tmp = dataDir();
  const marker = join(tmp, 'stalled');
  const pre = join(tmp, 'stall.cjs');
  writeFileSync(pre, `const set = globalThis.setTimeout; let armed = false;
globalThis.setTimeout = function (fn, ms, ...a) {
  const t = set(fn, ms, ...a);
  if (!armed && ms === ${at}) { armed = true; require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${sleep}); }
  return t;
};\n`);
  const child = spawn(process.execPath, ['--require', pre, FWD, ...args], { env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH ?? '', XAIBO_DATA_DIR: dir } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  if (end) child.stdin.end(input); else child.stdin.write(input);
  const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const code = await new Promise((r) => child.on('close', r));
  clearTimeout(kill);
  assert.ok(existsSync(marker), `the preload never stalled: no setTimeout(..., ${at}) in the forwarder`);
  return { code, stdout, stderr, lines: spooled(dir) };
}
const hookStalled = async (dir: string, input: string, end: boolean, at = DEADLINE) => {
  const r = await stalled(dir, input, end, at);
  assert.equal(r.code, 0);
  assert.equal(r.stdout + r.stderr, '', 'stdout and stderr stay empty (EC-64)');
  return r.lines;
};

test('EC-46: a stall past the deadline before stdin is read still spools the full payload, exactly once', async () => {
  const dir = dataDir();
  const lines = await hookStalled(dir, JSON.stringify(PAYLOAD), true);
  assert.equal(lines.length, 1, 'the delivery must not be lost');
  const p = parseEnvelope(lines[0]);
  assert.ok(p.ok);
  assert.deepEqual(p.envelope.payload, PAYLOAD);
  assert.ok(!p.envelope.truncated);
});

test('EC-46: a stall after both timers are armed (read timer due first) still spools the full payload, not a truncated one', async () => {
  const dir = dataDir();
  const lines = await hookStalled(dir, JSON.stringify(PAYLOAD), true, READ);
  assert.equal(lines.length, 1);
  const p = parseEnvelope(lines[0]);
  assert.ok(p.ok);
  assert.deepEqual(p.envelope.payload, PAYLOAD);
  assert.ok(!p.envelope.truncated);
});

test('EC-46/EC-63: stdin held open past the deadline under a stall -> a truncated envelope with its delivery id, not nothing', async () => {
  const dir = dataDir();
  const lines = await hookStalled(dir, '{"hook_event_name": "Stop", ', false);
  assert.equal(lines.length, 1, 'a missed hook must leave evidence');
  const p = parseEnvelope(lines[0]);
  assert.ok(p.ok);
  assert.equal(p.envelope.truncated, true);
  assert.equal(p.envelope.payload, null);
  assert.match(p.envelope.delivery_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

/** Report mode: a registration (synthetic id) whose token hash matches a private token file. */
function reportArgs(dir: string) {
  const id = '00000000-0000-4000-8000-0000000f0e01';
  const token = 'tok-fixture-0123456789';
  writeFileSync(join(dir, 'registrations.json'), JSON.stringify([{ id, agent: 'claude', token_sha256: createHash('sha256').update(token).digest('hex') }]));
  const tokenFile = join(dir, 'producer.token');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  return ['report', id, tokenFile];
}
const REPORT_EVENT = { v: 1, delivery_id: 'h-stall-1', session_id: PAYLOAD.session_id, producer_id: 'fixture-producer', producer_seq: 1, event: 'turn.start', source_ts: '2026-01-01T00:00:00.000Z', payload: {} };

test('report mode (G3i-1): a stall past the 2 s deadline with input not yet arrived -> exit 2, one code line, nothing spooled', async () => {
  const dir = dataDir();
  const r = await stalled(dir, '{"v": 1, ', false, REPORT_DEADLINE, 2_200, reportArgs(dir));
  assert.equal(r.code, 2, 'never a silent exit 0 with nothing delivered');
  assert.equal(r.stderr, 'xaibo-report: stdin\n');
  assert.equal(r.stdout, '');
  assert.equal(r.lines.length, 0);
});

test('report mode: a stall past the stdin timer with the full event already in the pipe still spools it (no service), exit 0', async () => {
  const dir = dataDir();
  const r = await stalled(dir, JSON.stringify(REPORT_EVENT), true, REPORT_READ, 1_200, reportArgs(dir));
  assert.equal(r.stderr, '');
  assert.equal(r.code, 0);
  assert.equal(r.lines.length, 1);
  assert.deepEqual((r.lines[0] as { frame: unknown }).frame, REPORT_EVENT);
});

test('shim: derives the data dir from its location, execs the forwarder; missing forwarder -> exit 0 silent', () => {
  const app = dataDir();
  const bin = join(app, 'integrations', 'bin');
  mkdirSync(bin, { recursive: true });
  copyFileSync(SHIM, join(bin, 'xaibo-hook'));
  chmodSync(join(bin, 'xaibo-hook'), 0o755);
  const run = () => spawnSync(join(bin, 'xaibo-hook'), ['hook', 'codex', 'p3'], { input: JSON.stringify(PAYLOAD), env: { PATH: process.env.PATH ?? '' } });
  const missing = run();
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout.length + missing.stderr.length, 0);
  assert.ok(!existsSync(join(app, 'spool')));
  writeFileSync(join(bin, 'xaibo-forwarder'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FWD)} "$@"\n`);
  chmodSync(join(bin, 'xaibo-forwarder'), 0o755);
  const ok = run();
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.length + ok.stderr.length, 0);
  const p = parseEnvelope(spooled(app)[0]);
  assert.ok(p.ok);
  assert.equal(p.envelope.agent, 'codex');
});

function shimApp(forwarder: string) {
  const app = dataDir();
  const bin = join(app, 'integrations', 'bin');
  mkdirSync(bin, { recursive: true });
  copyFileSync(SHIM, join(bin, 'xaibo-hook'));
  chmodSync(join(bin, 'xaibo-hook'), 0o755);
  writeFileSync(join(bin, 'xaibo-forwarder'), forwarder);
  chmodSync(join(bin, 'xaibo-forwarder'), 0o755);
  return { app, bin, run: (env: Record<string, string> = {}) => spawnSync(join(bin, 'xaibo-hook'), ['hook', 'codex', 'p3'], { input: JSON.stringify(PAYLOAD), env: { PATH: process.env.PATH ?? '', ...env }, timeout: 10_000 }) };
}
const realForwarder = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FWD)} "$@"\n`;

test('shim: a group/world-writable forwarder or bin dir is never run, even when PATH holds a fake find', () => {
  for (const mode of ['file', 'dir'] as const) {
    const s = shimApp(realForwarder);
    chmodSync(mode === 'file' ? join(s.bin, 'xaibo-forwarder') : s.bin, mode === 'file' ? 0o775 : 0o777);
    const fake = join(dataDir(), 'fakebin');
    mkdirSync(fake);
    for (const tool of ['find']) { writeFileSync(join(fake, tool), '#!/bin/sh\nexit 1\n'); chmodSync(join(fake, tool), 0o755); }
    const r = s.run({ PATH: `${fake}:${process.env.PATH ?? ''}` });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.length + r.stderr.length, 0);
    assert.ok(!existsSync(join(s.app, 'spool')), `writable ${mode} must not run`);
  }
});

test('shim: exits 0 silently when the forwarder fails, cannot launch or crashes', () => {
  for (const forwarder of ['#!/bin/sh\nexit 3\n', '#!/nonexistent/interpreter\n', 'not an executable format\n', '#!/bin/sh\nkill -9 $$\n']) {
    const r = shimApp(forwarder).run();
    assert.equal(r.status, 0, JSON.stringify(forwarder));
    assert.equal(r.stdout.length + r.stderr.length, 0);
  }
});
