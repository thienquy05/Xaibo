// P0-S13-T3/T4 socket-binding cases (Unix sockets cannot be bound in the command sandbox): G10 end to end through
// capture-listener.ts, G6 with a listener that never reads, and the listener's own contract. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEE = join(import.meta.dirname, 'tee.ts');
const LISTENER = join(import.meta.dirname, 'capture-listener.ts');
const BYTES = `'${join(import.meta.dirname, 'originals', 'bytes.sh')}'`;
const short = () => mkdtempSync(join(tmpdir(), 's13-')); // Unix socket paths must stay under 104 bytes

const tee = (sock: string, input: string) =>
  spawnSync(process.execPath, [TEE], { input, env: { ...process.env, XAIBO_TEE_ORIGINAL: BYTES, XAIBO_TEE_SOCKET: sock }, timeout: 10_000 });

const STDIN = {
  session_id: 'synthetic-session', transcript_path: '/tmp/xaibo-fixture/t.jsonl', cwd: '/tmp/xaibo-fixture/p',
  workspace: { current_dir: '/tmp/xaibo-fixture/p' }, version: '0.0.0-synthetic',
  model: { id: 'synthetic-model-1', display_name: 'Synthetic Model' }, effort: { level: 'high' },
  cost: { total_cost_usd: 0.5 }, context_window: { context_window_size: 200000, current_usage: null, note: 'SECRET CONTENT' },
  rate_limits: { five_hour: { used_percentage: 12, resets_at: 1767225600 } },
};

test('G10 end to end: listener receives only the allowed fields; listener prints nothing, file 0600, stops on SIGTERM', async () => {
  const dir = short();
  const sock = join(dir, 'c.sock'); const out = join(dir, 'capture.jsonl');
  const l = spawn(process.execPath, [LISTENER, sock, out], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((r) => l.on('exit', (c) => r(c)));
  const printed: Buffer[] = [];
  l.stdout.on('data', (c: Buffer) => printed.push(c)); l.stderr.on('data', (c: Buffer) => printed.push(c));
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(sock)) { assert.ok(Date.now() < deadline, 'listener never bound'); await new Promise((r) => setTimeout(r, 20)); }
    for (let i = 0; i < 3; i++) assert.equal(tee(sock, JSON.stringify(STDIN)).status, 0);
    await new Promise((r) => setTimeout(r, 100));
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    const rec = JSON.parse(lines[0]!);
    assert.deepEqual(Object.keys(rec).sort(), ['context_window', 'cost', 'effort', 'model', 'rate_limits', 'received_ts', 'session_id']);
    assert.equal(rec.session_id, 'synthetic-session');
    assert.deepEqual(rec.model, STDIN.model);
    assert.deepEqual(rec.context_window, { context_window_size: 200000, current_usage: null });
    for (const banned of ['transcript_path', 'xaibo-fixture', 'cwd', 'workspace', 'SECRET', '0.0.0-synthetic']) {
      assert.ok(!lines[0]!.includes(banned), `record must not contain ${banned}`);
    }
    assert.equal(statSync(out).mode & 0o777, 0o600);
  } finally {
    l.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.equal(Buffer.concat(printed).length, 0, 'listener printed nothing');
    assert.ok(!existsSync(sock), 'socket removed on SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G6 listener that accepts but never reads, or drops the connection: original output intact, tee bounded', async () => {
  const dir = short();
  const expected = spawnSync('/bin/sh', ['-c', BYTES]);
  for (const mode of ['never-reads', 'drops'] as const) {
    const sock = join(dir, `${mode}.sock`);
    const held: import('node:net').Socket[] = [];
    const srv = createServer((s) => { if (mode === 'drops') s.destroy(); else { s.pause(); held.push(s); } });
    await new Promise<void>((r, j) => { srv.once('error', j); srv.listen(sock, r); });
    try {
      // A 256 KiB-capped capture of a large JSON overfills the socket buffer when nobody reads.
      const big = JSON.stringify({ ...STDIN, cost: { total_cost_usd: 0.5, pad: 'x'.repeat(200_000) } });
      // Run async: a synchronous spawn would block this process's event loop and with it the listener under test.
      const t0 = performance.now();
      const r = await new Promise<{ out: Buffer; err: Buffer; code: number | null }>((res) => {
        const c = spawn(process.execPath, [TEE], { env: { ...process.env, XAIBO_TEE_ORIGINAL: BYTES, XAIBO_TEE_SOCKET: sock } });
        const o: Buffer[] = []; const e: Buffer[] = [];
        c.stdout.on('data', (b: Buffer) => o.push(b)); c.stderr.on('data', (b: Buffer) => e.push(b));
        c.on('close', (code) => res({ out: Buffer.concat(o), err: Buffer.concat(e), code }));
        c.stdin.on('error', () => {}); c.stdin.end(big);
      });
      assert.ok(r.out.equals(expected.stdout), `${mode}: stdout`);
      assert.ok(r.err.equals(expected.stderr), `${mode}: stderr`);
      assert.equal(r.code, 0);
      assert.ok(performance.now() - t0 < 1000, `${mode}: tee did not wait on the capture`);
    } finally {
      held.forEach((s) => s.destroy());
      await new Promise((r) => srv.close(r));
    }
  }
  rmSync(dir, { recursive: true, force: true });
});
