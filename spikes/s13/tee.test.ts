// P0-S13-T3 tee golden tests G1–G11 (sandbox-safe part; socket-binding cases live in tee.unsandboxed-test.ts).
// Every case compares the tee against `/bin/sh -c <original>` run directly. Synthetic originals only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEE = join(import.meta.dirname, 'tee.ts');
const orig = (name: string) => `'${join(import.meta.dirname, 'originals', name)}'`;
const NO_SOCKET = join(tmpdir(), 'xaibo-s13-no-listener.sock');

function direct(original: string, input: string | Buffer = '', env: NodeJS.ProcessEnv = {}) {
  return spawnSync('/bin/sh', ['-c', original], { input, env: { ...process.env, ...env } });
}
function viaTee(original: string | undefined, input: string | Buffer = '', env: NodeJS.ProcessEnv = {}) {
  const e: NodeJS.ProcessEnv = { ...process.env, XAIBO_TEE_SOCKET: NO_SOCKET, ...env };
  if (original === undefined) delete e.XAIBO_TEE_ORIGINAL; else e.XAIBO_TEE_ORIGINAL = original;
  return spawnSync(process.execPath, [TEE], { input, env: e, timeout: 10_000 });
}
function same(a: ReturnType<typeof direct>, b: ReturnType<typeof direct>, what: string) {
  assert.ok(a.stdout.equals(b.stdout), `${what}: stdout bytes differ`);
  assert.ok(a.stderr.equals(b.stderr), `${what}: stderr bytes differ`);
  assert.equal(a.status, b.status, `${what}: exit code`);
  assert.equal(a.signal, b.signal, `${what}: signal`);
}
const STATUS_JSON = JSON.stringify({ session_id: 'synthetic-session', model: { id: 'synthetic-model', display_name: 'Synthetic' } });

test('G1 stdout and stderr byte-identical to the original run directly', () => {
  same(viaTee(orig('bytes.sh'), STATUS_JSON), direct(orig('bytes.sh'), STATUS_JSON), 'bytes.sh');
});

test('G2 exit code preserved for every exit fixture', () => {
  for (const n of [0, 1, 3, 255]) {
    const t = viaTee(orig(`exit-${n}.sh`), STATUS_JSON);
    assert.equal(t.status, n, `exit-${n}.sh`);
    same(t, direct(orig(`exit-${n}.sh`), STATUS_JSON), `exit-${n}.sh`);
  }
});

test('G3 a signal-killed original is mirrored (OQ-B8)', () => {
  const d = direct(orig('sig.sh'));
  assert.equal(d.signal, 'SIGTERM', 'fixture really dies of SIGTERM');
  same(viaTee(orig('sig.sh')), d, 'sig.sh');
  // A signal Node cannot re-raise on itself (SIGPIPE is ignored in Node) falls back to exit 128+signal.
  assert.equal(direct('kill -PIPE $$').signal, 'SIGPIPE');
  const t = viaTee('kill -PIPE $$');
  assert.equal(t.status, 128 + 13);
  assert.equal(t.stdout.length + t.stderr.length, 0);
});

test('G4 the original receives byte-identical stdin, incl. 2 MiB', () => {
  const dir = mkdtempSync(join(tmpdir(), 's13-'));
  try {
    for (const input of [Buffer.from(STATUS_JSON), randomBytes(2 * 1024 * 1024)]) {
      const out = join(dir, 'hash');
      const t = viaTee(orig('stdin-hash.sh'), input, { XAIBO_HASH_OUT: out });
      assert.equal(t.status, 0);
      assert.equal(readFileSync(out, 'utf8').trim(), createHash('sha256').update(input).digest('hex'), `${input.length} bytes`);
      rmSync(out);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('G5 no original configured: 0 bytes stdout/stderr, exit 0', () => {
  for (const original of [undefined, '']) {
    const t = viaTee(original, STATUS_JSON);
    assert.equal(t.status, 0, `original=${String(original)}`);
    assert.equal(t.stdout.length + t.stderr.length, 0);
  }
});

test('G6 capture failure: the original still runs with G1/G2 output', () => {
  const dir = mkdtempSync(join(tmpdir(), 's13-'));
  try {
    const notSocket = join(dir, 'plain-file'); writeFileSync(notSocket, '');
    const cases: [string, string | Buffer, NodeJS.ProcessEnv][] = [
      ['no listener', STATUS_JSON, {}],
      ['socket env unset', STATUS_JSON, { XAIBO_TEE_SOCKET: '' }],
      ['unwritable target (regular file)', STATUS_JSON, { XAIBO_TEE_SOCKET: notSocket }],
      ['unwritable target (missing dir)', STATUS_JSON, { XAIBO_TEE_SOCKET: join(dir, 'nope', 'x.sock') }],
      ['malformed JSON', '{"session_id": ', {}],
      ['oversized stdin', Buffer.concat([Buffer.from('{"a":"'), Buffer.alloc(1024 * 1024, 0x61), Buffer.from('"}')]), {}],
      ['deeply nested JSON under the cap', `{"cost":${'['.repeat(100_000)}${']'.repeat(100_000)}}`, {}],
    ];
    for (const [what, input, env] of cases) {
      same(viaTee(orig('bytes.sh'), input, env), direct(orig('bytes.sh'), input), what);
      same(viaTee(orig('exit-3.sh'), input, env), direct(orig('exit-3.sh'), input), what);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function timed(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((res, rej) => {
    const t0 = performance.now();
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('error', rej);
    c.on('exit', () => res(performance.now() - t0));
    c.stdin.end(STATUS_JSON);
  });
}

// OQ-B6 bounds added wait at p95 <= 100 ms on S3's packaged runtime. System Node's bare startup alone is ~90 ms on
// the reference machine, so this logic check subtracts the same runtime's startup (an empty .mts through the same
// TS loader) and holds the tee's own share to 100 ms minus the SEA's startup p95 (~40 ms, S3 §2.4/2.5) = 60 ms.
// The packaged-runtime total is P0-S13-T5.
const TEE_SHARE_BOUND_MS = 60;
const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1]!;

test('G7 slow original: tee share of added wall time p95 <= 60 ms (OQ-B6 logic check, system Node, no listener)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 's13-'));
  const empty = join(dir, 'empty.mts'); writeFileSync(empty, '');
  const added: number[] = []; const boot: number[] = []; const share: number[] = [];
  try {
    // ponytail: 30 rounds in batches of 5 concurrent rounds (each round starts together) keeps this ~13 s; T5 does N=200.
    for (let b = 0; b < 6; b++) {
      const rounds = await Promise.all(Array.from({ length: 5 }, () => Promise.all([
        timed('/bin/sh', ['-c', orig('slow.sh')], {}),
        timed(process.execPath, [TEE], { XAIBO_TEE_ORIGINAL: orig('slow.sh'), XAIBO_TEE_SOCKET: NO_SOCKET }),
        timed(process.execPath, [empty], {}),
      ])));
      for (const [d, tee, bare] of rounds) {
        assert.ok(tee >= 1900, 'the tee really ran the 2 s original');
        added.push(tee - d); boot.push(bare); share.push(tee - d - bare);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const fmt = (xs: number[]) => `p50 ${pct(xs, 0.5).toFixed(1)} p95 ${pct(xs, 0.95).toFixed(1)} max ${pct(xs, 1).toFixed(1)}`;
  t.diagnostic(`n=${added.length} ms | added (system Node total) ${fmt(added)} | bare runtime startup ${fmt(boot)} | tee share ${fmt(share)}`);
  assert.ok(pct(share, 0.95) <= TEE_SHARE_BOUND_MS, `tee share p95 ${pct(share, 0.95).toFixed(1)} ms`);
});

test('G8 original ignores stdin: EPIPE handled silently', () => {
  for (const input of [STATUS_JSON, randomBytes(2 * 1024 * 1024)]) {
    const t = viaTee(orig('nostdin.sh'), input);
    assert.equal(t.status, 0);
    assert.equal(t.stdout.toString(), 'NOSTDIN');
    assert.equal(t.stderr.length, 0, t.stderr.toString());
  }
});

test('G9 tee receives SIGTERM: forwarded to the child, child exit mirrored, no orphan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's13-'));
  try {
    const pidFile = join(dir, 'pid');
    const tee = spawn(process.execPath, [TEE], {
      env: { ...process.env, XAIBO_TEE_ORIGINAL: `echo $$ > '${pidFile}'; exec sleep 5`, XAIBO_TEE_SOCKET: NO_SOCKET },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const bytes: Buffer[] = [];
    tee.stdout.on('data', (c: Buffer) => bytes.push(c)); tee.stderr.on('data', (c: Buffer) => bytes.push(c));
    tee.stdin.end(STATUS_JSON);
    const deadline = Date.now() + 3000;
    while (!existsSync(pidFile) || !readFileSync(pidFile, 'utf8').trim()) {
      assert.ok(Date.now() < deadline, 'child never started'); await new Promise((r) => setTimeout(r, 20));
    }
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const t0 = performance.now();
    tee.kill('SIGTERM');
    const [code, signal] = await new Promise<[number | null, string | null]>((r) => tee.on('exit', (c, s) => r([c, s])));
    assert.ok(performance.now() - t0 < 1000, 'tee exits promptly');
    assert.deepEqual([code, signal], [null, 'SIGTERM'], 'child died of the forwarded SIGTERM and the tee mirrors it');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'child is gone');
    assert.equal(Buffer.concat(bytes).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('G10 capture record keeps only the allowed fields (unit; end-to-end in tee.unsandboxed-test.ts)', async () => {
  const { captureRecord } = await import('./tee.ts') as { captureRecord: (v: unknown, ts: number) => Record<string, unknown> | undefined };
  const rec = captureRecord(SYNTHETIC_FULL, 1234);
  assert.deepEqual(rec, EXPECTED_RECORD);
  assert.equal(captureRecord('not an object', 1), undefined);
  assert.deepEqual(captureRecord({}, 7), { received_ts: 7 });
});

test('G11 the tee itself contributes no bytes', () => {
  for (const name of ['exit-0.sh', 'exit-1.sh', 'exit-255.sh']) {
    for (const input of ['', STATUS_JSON, 'garbage']) {
      const t = viaTee(orig(name), input);
      assert.equal(t.status, Number(name.slice(5, -3)), `${name} ran`);
      assert.equal(t.stdout.length + t.stderr.length, 0, `${name} with ${JSON.stringify(input).slice(0, 20)}`);
    }
  }
});

// Synthetic statusLine stdin shaped after the documented Claude schema plus content that must never be captured.
const SYNTHETIC_FULL = {
  session_id: 'synthetic-session',
  transcript_path: '/tmp/xaibo-fixture/transcript.jsonl',
  cwd: '/tmp/xaibo-fixture/project',
  workspace: { current_dir: '/tmp/xaibo-fixture/project', project_dir: '/tmp/xaibo-fixture/project' },
  version: '0.0.0-synthetic',
  output_style: { name: 'default' },
  model: { id: 'synthetic-model-1', display_name: 'Synthetic Model', extra: 'drop-me' },
  effort: { level: 'high', note: 'drop me' },
  cost: { total_cost_usd: 0.5, total_duration_ms: 1000, total_lines_added: 3 },
  context_window: {
    total_input_tokens: 10, context_window_size: 200000, used_percentage: 5, prompt_text: 'SECRET PROMPT CONTENT',
    note: 'SECRET', file: 'notes.md', last_prompt: 'deploy-to-prod', // single-token content passes no identifier-like test
    current_usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
  },
  rate_limits: {
    five_hour: { used_percentage: 12, resets_at: '2026-01-01T00:00:00Z' }, seven_day: { used_percentage: 3, resets_at: 1767225600 },
    plan: 'max', account_uuid: '00000000-0000-4000-8000-000000000000', org_id: 12345, user: 'synthetic',
  },
};
const EXPECTED_RECORD = {
  received_ts: 1234,
  session_id: 'synthetic-session',
  model: { id: 'synthetic-model-1', display_name: 'Synthetic Model' },
  effort: { level: 'high' },
  cost: { total_cost_usd: 0.5, total_duration_ms: 1000, total_lines_added: 3 },
  context_window: {
    total_input_tokens: 10, context_window_size: 200000, used_percentage: 5,
    current_usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
  },
  rate_limits: { five_hour: { used_percentage: 12, resets_at: '2026-01-01T00:00:00Z' }, seven_day: { used_percentage: 3, resets_at: 1767225600 } },
};
