// P0-S13-T1 probe contract on synthetic input: records invocation facts without values, prints XAIBO-PROBE,
// exits 0; with XAIBO_PROBE_SLEEP_MS it records which signal ended it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROBE = join(import.meta.dirname, 'statusline-probe.mjs');
const STDIN = JSON.stringify({
  session_id: 'synthetic-session', transcript_path: '/tmp/xaibo-fixture/t.jsonl', cwd: '/tmp/xaibo-fixture/p',
  model: { id: 'synthetic-model-1', display_name: 'Synthetic Model' }, effort: { level: 'high' },
  cost: { total_cost_usd: 0.5 }, context_window: { current_usage: null, used_percentage: 5 },
  rate_limits: { five_hour: { used_percentage: 12, resets_at: 1767225600 } },
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 's13p-'));
  const cwd = join(dir, 'spike-projects', 'p'); mkdirSync(cwd, { recursive: true });
  return { dir, cwd, env: { ...process.env, XAIBO_SPIKE_RAW: dir, XAIBO_SYNTHETIC_SECRET: 'never-recorded-value' } };
}
const lines = (dir: string) => readFileSync(join(dir, 'statusline.jsonl'), 'utf8').trim().split('\n');

test('probe records invocation facts, keys and types only; prints XAIBO-PROBE; exits 0', () => {
  const { dir, cwd, env } = setup();
  try {
    const r = spawnSync(process.execPath, [PROBE], { input: STDIN, cwd, env });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.toString(), 'XAIBO-PROBE\n');
    assert.equal(r.stderr.length, 0, r.stderr.toString());
    const [line] = lines(dir);
    const rec = JSON.parse(line!);
    assert.equal(rec.kind, 'invocation');
    assert.equal(rec.stdin_bytes, Buffer.byteLength(STDIN));
    assert.equal(rec.stdin_is_tty, false);
    assert.equal(rec.argv_count, 0);
    const psWorks = spawnSync('ps', ['-o', 'comm=', '-p', String(process.pid)]).status === 0; // ps is blocked in the command sandbox
    assert.equal(rec.parent_comm, psWorks ? 'node' : 'unavailable');
    assert.equal(rec.cwd_category, 'project');
    assert.deepEqual(rec.env_names, [...rec.env_names].sort());
    assert.ok(rec.env_names.includes('XAIBO_SYNTHETIC_SECRET'));
    assert.deepEqual(rec.key_types['transcript_path'], ['string']);
    assert.deepEqual(rec.key_types['context_window.current_usage'], ['null']);
    assert.deepEqual(rec.key_types['rate_limits.five_hour.resets_at'], ['number']);
    assert.deepEqual(rec.values, { 'model.id': ['synthetic-model-1'], 'model.display_name': ['<other>'], 'effort.level': ['high'] });
    for (const banned of ['never-recorded-value', 'xaibo-fixture', 'synthetic-session', '0.5', '1767225600']) {
      assert.ok(!line!.includes(banned), `must not record ${banned}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probe with XAIBO_PROBE_SLEEP_MS records the signal that cancelled it', async () => {
  const { dir, cwd, env } = setup();
  try {
    const p = spawn(process.execPath, [PROBE], { cwd, env: { ...env, XAIBO_PROBE_SLEEP_MS: '5000' } });
    p.stdin.end('{}');
    await new Promise((r) => p.stdout.once('data', r));
    p.kill('SIGTERM');
    const code = await new Promise((r) => p.on('exit', (c) => r(c)));
    assert.equal(code, 128 + 15);
    const rec = JSON.parse(lines(dir)[1]!);
    assert.equal(rec.kind, 'signal');
    assert.equal(rec.signal, 'SIGTERM');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
