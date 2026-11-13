// XAIBO-PROD-318 (P3-T14; S-31, FR-45, EC-28, M7; design review 1074): the Claude statusLine tee. Every golden case
// compares the tee with `/bin/sh -c <original>` run directly on the same stdin and environment: stdout and stderr bytes,
// exit code and signal. The original comes from the applied claude-tee manifest entry (Q3-7); capture failures never
// change the output; the capture holds only the FR-45 allowlist. Synthetic originals only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Envelope } from '../../src/shared/hook-protocol.ts';
import { captureRecord, findOriginal, teeCommand } from '../../src/forwarder/statusline-tee.ts';
import { startSocketServer } from '../../src/service/receivers/socket.ts';

const REPO = join(import.meta.dirname, '..', '..');
const TEE = join(REPO, 'src', 'forwarder', 'statusline-tee.ts');
const ORIGINALS = join(REPO, 'test', 'fixtures', 'synthetic', 'claude', 'statusline-originals');
const orig = (name: string) => `'${join(ORIGINALS, name)}'`;
const KEY = 'p1';
// ELECTRON_RUN_AS_NODE: under test:electron the exec path is Electron; both runs get the same environment
const ENV: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

const CANARY = `canary-${randomUUID()}`;
const STDIN = {
  session_id: 'synthetic-session', transcript_path: `/tmp/xaibo-fixture/${CANARY}.jsonl`, cwd: `/tmp/xaibo-fixture/${CANARY}`,
  prompt_id: CANARY, workspace: { current_dir: `/tmp/${CANARY}`, project_dir: `/tmp/${CANARY}` }, version: '0.0.0-synthetic',
  model: { id: 'synthetic-model-1', display_name: 'Synthetic Model' }, effort: { level: 'high' },
  cost: { total_cost_usd: 0.5, total_duration_ms: 1000 },
  context_window: { context_window_size: 200000, used_percentage: 12, remaining_percentage: 88, total_input_tokens: 10, total_output_tokens: 5,
    current_usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, note: CANARY }, note: CANARY },
  rate_limits: { five_hour: { used_percentage: 12.5, resets_at: 1767225600 }, seven_day: { used_percentage: 140, resets_at: '2026-01-08T00:00:00Z' }, other: { used_percentage: 1 } },
  output_style: { name: CANARY },
};
const JSON_IN = JSON.stringify(STDIN);

/** A short data dir (socket path limit) whose manifest names `original` for KEY (null: an absent statusLine was replaced). */
function dataDir(original: string | null | undefined = undefined, state = 'applied'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'xt-')));
  if (original === undefined) return dir; // no manifest at all
  mkdirSync(join(dir, 'integrations'), { mode: 0o700 });
  const command = teeCommand(dir, KEY);
  const owned = original === null
    ? [{ pointer: '/statusLine', value: { type: 'command', command } }]
    : [{ pointer: '/statusLine/command', value: command, old: original }];
  const entry = { id: randomUUID(), target: join(dir, 'settings.json'), route: 'claude-tee', state, existed: true, preHash: 'x',
    postHash: 'y', owned, created: [], backup: null, at: new Date(0).toISOString() };
  writeFileSync(join(dir, 'integrations', 'manifest.json'), JSON.stringify({ v: 1, entries: [entry] }), { mode: 0o600 });
  return dir;
}

const direct = (original: string, input: string | Buffer = JSON_IN, env: NodeJS.ProcessEnv = {}) =>
  spawnSync('/bin/sh', ['-c', original], { input, env: { ...ENV, ...env }, timeout: 10_000 });
const viaTee = (dir: string, input: string | Buffer = JSON_IN, env: NodeJS.ProcessEnv = {}, args = [dir, KEY]) =>
  spawnSync(process.execPath, [TEE, ...args], { input, env: { ...ENV, ...env }, timeout: 10_000 });

type Run = { stdout: Buffer; stderr: Buffer; status: number | null; signal: NodeJS.Signals | null };
function same(a: Run, b: Run, what: string) {
  assert.ok(a.stdout.equals(b.stdout), `${what}: stdout bytes differ (${JSON.stringify(a.stdout.toString().slice(0, 200))} vs ${JSON.stringify(b.stdout.toString().slice(0, 200))})`);
  assert.ok(a.stderr.equals(b.stderr), `${what}: stderr bytes differ (${JSON.stringify(a.stderr.toString().slice(0, 200))})`);
  assert.equal(a.status, b.status, `${what}: exit code`);
  assert.equal(a.signal, b.signal, `${what}: signal`);
}
const golden = (original: string, input: string | Buffer = JSON_IN, what = original) => same(viaTee(dataDir(original), input), direct(original, input), what);

/** Async run (an in-process socket server must keep its event loop). `slowMs` pauses reading stdout at first. */
function teeAsync(dir: string, input: string | Buffer, env: NodeJS.ProcessEnv = {}, slowMs = 0): Promise<Run> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [TEE, dir, KEY], { env: { ...ENV, ...env } });
    const o: Buffer[] = []; const e: Buffer[] = [];
    if (slowMs) { c.stdout.pause(); setTimeout(() => c.stdout.resume(), slowMs); }
    c.stdout.on('data', (b: Buffer) => o.push(b)); c.stderr.on('data', (b: Buffer) => e.push(b));
    c.on('close', (status, signal) => resolve({ stdout: Buffer.concat(o), stderr: Buffer.concat(e), status, signal }));
    c.stdin.on('error', () => {});
    c.stdin.end(input);
  });
}

/** A real hook socket server in the data dir, recording what intake would receive. */
async function listener(dir: string) {
  const got: Envelope[] = [];
  const server = await startSocketServer({ dataDir: dir, onEnvelope: async (e) => { got.push(e); return { status: 'accepted', code: 'ok' }; } });
  return { got, close: () => server.close() };
}

// --- golden: byte, exit and signal preservation -------------------------------------------------------------------

test('stdout (ANSI, invalid UTF-8, no newline) and stderr bytes equal a direct run', () => golden(orig('bytes.sh')));

test('exit codes 0, 1, 3 and 255 are preserved', () => {
  for (const n of [0, 1, 3, 255]) golden(orig(`exit-${n}.sh`));
});

test('a signal-killed original is mirrored; an un-raisable signal exits 128 + n (OQ-B8)', () => {
  assert.equal(direct(orig('sig.sh')).signal, 'SIGTERM', 'the fixture dies of SIGTERM');
  golden(orig('sig.sh'));
  const t = viaTee(dataDir('kill -PIPE $$'));
  assert.equal(t.status, 128 + 13);
  assert.equal(t.stdout.length + t.stderr.length, 0);
});

test('the original reads all, part or none of stdin: same output, byte-identical input when read', () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'xt-')));
  for (const input of [Buffer.from(JSON_IN), randomBytes(2 << 20)]) {
    const out = join(work, `hash-${input.length}`);
    const t = viaTee(dataDir(orig('stdin-hash.sh')), input, { XAIBO_HASH_OUT: out });
    assert.equal(t.status, 0);
    assert.equal(readFileSync(out, 'utf8').trim(), createHash('sha256').update(input).digest('hex'), `${input.length} bytes reach the original`);
    golden('head -c 7 | od -An -tx1; printf "|partial"', input, 'reads part');
    golden(orig('nostdin.sh'), input, 'reads none');
  }
});

test('a slow 300 ms original: same output, the tee waits for it', () => {
  const t0 = performance.now();
  golden('sleep 0.3; printf slow; printf err >&2; exit 4');
  assert.ok(performance.now() - t0 >= 600, 'both runs really waited');
});

test('1 MiB of stdout reaches a slow reader whole: the tee leaves the shared pipe blocking (review H1)', async () => {
  const big = 'head -c 1048576 /dev/zero | tr "\\0" x';
  const t = await teeAsync(dataDir(big), JSON_IN, {}, 300);
  assert.equal(t.stderr.toString(), '', 'no EAGAIN from the original');
  assert.equal(t.stdout.length, 1 << 20);
  assert.equal(t.status, 0);
});

test('the tee forwards SIGTERM to the original and mirrors how it ended', async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'xt-')));
  const pidFile = join(work, 'pid');
  const tee = spawn(process.execPath, [TEE, dataDir(`echo $$ > '${pidFile}'; exec sleep 5`), KEY], { env: ENV });
  const bytes: Buffer[] = [];
  tee.stdout.on('data', (c: Buffer) => bytes.push(c)); tee.stderr.on('data', (c: Buffer) => bytes.push(c));
  tee.stdin.end(JSON_IN);
  const deadline = Date.now() + 5000;
  while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) {
    assert.ok(Date.now() < deadline, 'the original never started');
    await new Promise((r) => setTimeout(r, 20));
  }
  const pid = Number(readFileSync(pidFile, 'utf8'));
  tee.kill('SIGTERM');
  const [code, signal] = await new Promise<[number | null, string | null]>((r) => tee.on('exit', (c, s) => r([c, s])));
  assert.deepEqual([code, signal], [null, 'SIGTERM']);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the original is gone');
  assert.equal(Buffer.concat(bytes).length, 0);
});

test('cwd and environment reach the original unchanged', () => {
  const show = 'pwd; env | LC_ALL=C sort';
  same(viaTee(dataDir(show), JSON_IN, { XAIBO_PROBE: 'x' }), direct(show, JSON_IN, { XAIBO_PROBE: 'x' }), 'cwd/env');
});

// --- no original -----------------------------------------------------------------------------------------------

test('no original: 0 bytes, exit 0 (no manifest, absent statusLine replaced, other key, bad arguments)', () => {
  const cases: [string, string, string[] | undefined][] = [
    ['no manifest', dataDir(), undefined],
    ['absent statusLine', dataDir(null), undefined],
  ];
  const d = dataDir('printf X');
  cases.push(['another key', d, [d, 'other']], ['relative data dir', d, ['relative/dir', KEY]], ['no arguments', d, []], ['bad key', d, [d, '../x']]);
  for (const [what, dir, args] of cases) {
    const t = viaTee(dir, JSON_IN, {}, args);
    assert.equal(t.status, 0, what);
    assert.equal(t.stdout.length + t.stderr.length, 0, what);
  }
});

test('a manifest that is not private, a FIFO, a foreign route or a non-private integrations/ never supplies an original', () => {
  const loose = dataDir('printf LEAK');
  chmodSync(join(loose, 'integrations', 'manifest.json'), 0o644);
  assert.equal(viaTee(loose).stdout.length, 0, 'a group/world-readable manifest is ignored');
  const looseDir = dataDir('printf LEAK');
  chmodSync(join(looseDir, 'integrations'), 0o755);
  assert.equal(viaTee(looseDir).stdout.length, 0, 'a non-private integrations/ is ignored (review M2)');
  const other = dataDir('printf LEAK');
  const f2 = join(other, 'integrations', 'manifest.json');
  const m = JSON.parse(readFileSync(f2, 'utf8'));
  m.entries[0].route = 'claude-settings-fallback';
  writeFileSync(f2, JSON.stringify(m), { mode: 0o600 });
  assert.equal(viaTee(other).stdout.length, 0, 'only claude-tee entries count');
  const fifo = dataDir();
  mkdirSync(join(fifo, 'integrations'), { mode: 0o700 });
  assert.equal(spawnSync('mkfifo', ['-m', '600', join(fifo, 'integrations', 'manifest.json')]).status, 0);
  const t0 = performance.now();
  const t = viaTee(fifo);
  assert.equal(t.status, 0);
  assert.ok(performance.now() - t0 < 5000, 'a FIFO never blocks the tee (review M1)');
});

// --- capture -------------------------------------------------------------------------------------------------

test('capture failures leave output and exit identical: no socket, invalid JSON, 10 MB stdin, deep nesting', () => {
  const cases: [string, string | Buffer][] = [
    ['no socket', JSON_IN],
    ['invalid JSON', '{"session_id": '],
    ['10 MB stdin', Buffer.concat([Buffer.from('{"a":"'), Buffer.alloc(10 << 20, 0x61), Buffer.from('"}')])],
    ['deep nesting', `{"cost":${'['.repeat(100_000)}${']'.repeat(100_000)}}`],
  ];
  for (const [what, input] of cases) {
    golden(orig('bytes.sh'), input, what);
    golden(orig('exit-3.sh'), input, what);
  }
});

test('one delivery arrives with only the FR-45 allowlist; output stays identical; canaries never leave', async () => {
  const dir = dataDir(orig('bytes.sh'));
  const l = await listener(dir);
  try {
    same(await teeAsync(dir, JSON_IN), direct(orig('bytes.sh')), 'with a listener');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(l.got.length, 1);
    const e = l.got[0]!;
    assert.deepEqual({ agent: e.agent, profile_key: e.profile_key, event: e.event, session_id: e.session_id, cwd: e.cwd },
      { agent: 'claude', profile_key: KEY, event: 'statusline', session_id: 'synthetic-session', cwd: null });
    assert.match(e.delivery_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(e.payload, {
      session_id: 'synthetic-session', model: { id: 'synthetic-model-1', display_name: 'Synthetic Model' }, effort: { level: 'high' },
      cost: { total_cost_usd: 0.5 },
      context_window: { context_window_size: 200000, used_percentage: 12, remaining_percentage: 88, total_input_tokens: 10, total_output_tokens: 5,
        current_usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } },
      rate_limits: { five_hour: { used_percentage: 12.5, resets_at: 1767225600 }, seven_day: { used_percentage: 140, resets_at: '2026-01-08T00:00:00Z' } },
    });
    assert.ok(!JSON.stringify(e).includes(CANARY), 'no path, prompt id, workspace or content left the tee');
  } finally { await l.close(); }
});

test('no original still captures: 0 bytes, exit 0, one delivery', async () => {
  const dir = dataDir(null);
  const l = await listener(dir);
  try {
    const t = await teeAsync(dir, JSON_IN);
    assert.deepEqual([t.status, t.stdout.length + t.stderr.length], [0, 0]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(l.got.length, 1);
  } finally { await l.close(); }
});

test('a bad token: output identical, nothing accepted', async () => {
  const dir = dataDir(orig('bytes.sh'));
  const l = await listener(dir);
  try {
    writeFileSync(join(dir, 'run', 'token'), 'not-the-token', { mode: 0o600 });
    same(await teeAsync(dir, JSON_IN), direct(orig('bytes.sh')), 'bad token');
    assert.equal(l.got.length, 0);
  } finally { await l.close(); }
});

test('the tee contributes no bytes on any path, even with NODE_DEBUG and warning variables set (review M5)', async () => {
  const noisy = { NODE_DEBUG: 'net,child_process,fs,stream', NODE_PENDING_DEPRECATION: '1' };
  for (const name of ['exit-0.sh', 'exit-1.sh', 'exit-255.sh']) {
    for (const input of ['', JSON_IN, 'garbage']) {
      const t = viaTee(dataDir(orig(name)), input, noisy);
      assert.equal(t.status, Number(name.slice(5, -3)));
      assert.equal(t.stdout.length + t.stderr.length, 0, `${name} with ${input.slice(0, 10)}: ${t.stderr.toString().slice(0, 200)}`);
    }
  }
  const dir = dataDir(orig('exit-0.sh'));
  const l = await listener(dir);
  try {
    const t = await teeAsync(dir, JSON_IN, noisy);
    assert.equal(t.stdout.length + t.stderr.length, 0, `the capture path writes nothing either: ${t.stderr.toString().slice(0, 200)}`);
    assert.equal(l.got.length, 1);
  } finally { await l.close(); }
});

// --- pure parts ----------------------------------------------------------------------------------------------

test('captureRecord: field allowlist with range checks, not value shape (review L1)', () => {
  assert.equal(captureRecord('not an object'), undefined);
  assert.equal(captureRecord([]), undefined);
  assert.equal(captureRecord(null), undefined);
  assert.deepEqual(captureRecord({}), {});
  assert.deepEqual(captureRecord(JSON.parse(`{
    "cost": { "total_cost_usd": 1, "pin": 12345 },
    "context_window": { "context_window_size": 1, "prompt_text": "12345", "note": "2026-01-01", "current_usage": { "input_tokens": 1, "secret": 7 } },
    "rate_limits": { "five_hour": { "used_percentage": 1, "resets_at": 2, "extra": 5 }, "weekly_note": { "used_percentage": 9 } },
    "private_payload": { "secret": 123 }, "__proto__": { "session_id": "proto" }
  }`)), { cost: { total_cost_usd: 1 }, context_window: { context_window_size: 1, current_usage: { input_tokens: 1 } }, rate_limits: { five_hour: { used_percentage: 1, resets_at: 2 } } });
  assert.deepEqual(captureRecord({ context_window: { current_usage: null } }), { context_window: { current_usage: null } }, 'null = unavailable (before the first response, after /compact)');
  assert.deepEqual(captureRecord({ cost: { total_cost_usd: '1' }, rate_limits: { five_hour: { used_percentage: Infinity, resets_at: 'soon' } } }), {});
  assert.deepEqual(captureRecord({ cost: { total_cost_usd: -1 }, context_window: { total_input_tokens: -5, used_percentage: -1 } }), {}, 'negative numbers are dropped');
  assert.deepEqual(captureRecord({ session_id: 'x'.repeat(257), model: { id: 'm'.repeat(201) }, effort: { level: 'e'.repeat(33) } }), {}, 'over-long strings are dropped, not cut');
  assert.deepEqual(captureRecord({ rate_limits: { five_hour: { resets_at: `2026-01-01T00:00:00Z${'0'.repeat(40)}` } } }), {}, 'resets_at is a bounded ISO time');
});

test('teeCommand quotes the binary and data dir; refuses a quote, a control character or a bad key', () => {
  assert.equal(teeCommand('/d', 'p1'), "'/d/integrations/bin/xaibo-statusline' '/d' p1");
  assert.throws(() => teeCommand("/d'x", 'p1'));
  assert.throws(() => teeCommand('/d\nx', 'p1'));
  assert.throws(() => teeCommand('relative', 'p1'));
  assert.throws(() => teeCommand('/d', 'a b'));
  assert.throws(() => teeCommand('/d', '..'));
});

test('findOriginal: only a claude-tee entry (applied or pending) whose owned command is exactly ours', () => {
  const cmd = teeCommand('/d', 'p1');
  const e = (owned: unknown[], route = 'claude-tee', state = 'applied') => ({ route, state, owned });
  const own = (old: unknown, value = cmd) => [{ pointer: '/statusLine/command', value, old }];
  assert.equal(findOriginal([e(own('printf A'))], '/d', 'p1'), 'printf A');
  assert.equal(findOriginal([e(own('printf A', `${cmd}x`))], '/d', 'p1'), null);
  assert.equal(findOriginal([e([{ pointer: '/statusLine', value: { type: 'command', command: cmd } }])], '/d', 'p1'), null);
  assert.equal(findOriginal([e(own(42))], '/d', 'p1'), null);
  assert.equal(findOriginal([e(own(''))], '/d', 'p1'), null);
  assert.equal(findOriginal([e(own('printf A'), 'claude-plugin')], '/d', 'p1'), null);
  assert.equal(findOriginal([e(own('printf A'), 'claude-tee', 'pending')], '/d', 'p1'), 'printf A', 'pending: a crash after the rename never blanks the status line (review M2)');
  assert.equal(findOriginal([e(own('printf A'), 'claude-tee', 'reverted')], '/d', 'p1'), null);
  assert.equal(findOriginal('nonsense', '/d', 'p1'), null);
  assert.equal(findOriginal([null, 7, e(own('printf B'))], '/d', 'p1'), 'printf B');
});

test('review M2: a pending entry (a crash between the rename and the applied write) still runs the original', () => {
  golden('printf pending-ok', JSON_IN, 'pending entry');
  same(viaTee(dataDir('printf pending-ok', 'pending')), direct('printf pending-ok'), 'pending');
});

test('review M1: a stdin read error ends the original\'s stdin; an original reading to EOF never hangs', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'xt-')));
  const fd = openSync(dir, 'r'); // reading a directory fails with EISDIR
  try {
    const t = spawnSync(process.execPath, [TEE, dataDir('cat >/dev/null; printf done'), KEY], { stdio: [fd, 'pipe', 'pipe'], env: ENV, timeout: 5_000 });
    assert.equal(t.error, undefined, 'the tee did not time out');
    assert.equal(t.stdout.toString(), 'done');
    assert.equal(t.status, 0);
  } finally { closeSync(fd); }
});

test('the tee forwards SIGINT and SIGHUP too (review L4)', async () => {
  for (const sig of ['SIGINT', 'SIGHUP'] as const) {
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'xt-')));
    const ready = join(work, 'ready');
    // the original ends itself with the forwarded signal's name as exit code (130 SIGINT, 129 SIGHUP)
    const tee = spawn(process.execPath, [TEE, dataDir(`trap 'exit 130' INT; trap 'exit 129' HUP; : > '${ready}'; while :; do sleep 0.05; done`), KEY], { env: ENV });
    tee.stdin.end(JSON_IN);
    const deadline = Date.now() + 5000;
    while (!existsSync(ready)) { assert.ok(Date.now() < deadline, 'the original never started'); await new Promise((r) => setTimeout(r, 20)); }
    tee.kill(sig);
    const [code] = await new Promise<[number | null, string | null]>((r) => tee.on('exit', (c, s) => r([c, s])));
    assert.equal(code, sig === 'SIGINT' ? 130 : 129, sig);
  }
});
