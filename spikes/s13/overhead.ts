// P0-S13-T5 tee added wait (OQ-B6: p95 <= 100 ms, the original's own runtime excluded by pairing).
//   node spikes/s13/overhead.ts --runtime system-node|sea [--n 200] [--handicap-ms 200]
// Each iteration runs the original alone and through the tee, both as `/bin/sh -c <cmd>` with the same stdin (as Claude
// does); added = tee - alone. Variants: listener up, no listener, listener that never reads. Exits 1 when a variant's
// added p95 is over the bound, an exit is non-zero or the stdout byte count differs. --handicap-ms proves the check bites.
// Binds a Unix socket: run unsandboxed. Writes aggregates only to spikes/s13/evidence/overhead-<runtime>.json.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { envRecord, hr, summary } from '../shared/bench.ts';

const BOUND_MS = 100;
const HERE = import.meta.dirname;
const { values } = parseArgs({ options: { runtime: { type: 'string' }, n: { type: 'string' }, 'handicap-ms': { type: 'string' } } });
const runtime = values.runtime ?? '';
const N = Number(values.n ?? 200);
const handicap = Number(values['handicap-ms'] ?? 0);
const TEE: Record<string, string> = {
  'system-node': `'${process.execPath}' '${join(HERE, 'tee.ts')}'`,
  sea: `'${join(HERE, '..', '..', '.cache', 'sea', 'xaibo-tee-sea')}'`, // built by spikes/s13/build-sea.sh
};
if (!TEE[runtime]) { console.log('usage: --runtime system-node|sea [--n 200] [--handicap-ms 200]'); process.exit(2); }
const ORIGINAL = `'${join(HERE, 'originals', 'bytes.sh')}'`;
const teeCmd = (handicap ? `sleep ${handicap / 1000}; ` : '') + TEE[runtime];
const STDIN = JSON.stringify({
  session_id: 'synthetic-session', model: { id: 'synthetic-model-1', display_name: 'Synthetic Model' }, effort: { level: 'high' },
  cost: { total_cost_usd: 0.5 }, context_window: { context_window_size: 200000, used_percentage: 12 },
  rate_limits: { five_hour: { used_percentage: 12, resets_at: 1767225600 } },
});

function run(cmd: string, env: NodeJS.ProcessEnv): Promise<{ ms: number; out: number; code: number | null }> {
  return new Promise((res) => {
    const t0 = hr();
    const c = spawn('/bin/sh', ['-c', cmd], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = 0;
    c.stdout.on('data', (d: Buffer) => { out += d.length; });
    c.stdin.on('error', () => {});
    c.on('close', (code) => res({ ms: Number(hr() - t0) / 1e6, out, code }));
    c.stdin.end(STDIN);
  });
}

// A connection that is never read never sees the tee's EOF, so close() destroys what is still open.
const listen = (path: string, read: boolean) => new Promise<() => Promise<void>>((res) => {
  const open = new Set<Socket>();
  const s = createServer((c) => { open.add(c); c.on('close', () => open.delete(c)); c.on('error', () => {}); if (read) c.resume(); });
  s.listen(path, () => res(() => new Promise((done) => { for (const c of open) c.destroy(); s.close(() => done()); })));
});

const dir = mkdtempSync(join(tmpdir(), 's13-')); // Unix socket paths must stay under 104 bytes
const sock = join(dir, 'c.sock');
const PATH = '/usr/bin:/bin'; // the tee must not need a system Node on PATH
const results: Record<string, unknown> = {};
let ok = true;
try {
  for (const variant of ['up', 'nolistener', 'noread'] as const) {
    const close = variant === 'nolistener' ? null : await listen(sock, variant === 'up');
    const added: number[] = []; let bad = 0;
    for (let i = 0; i < N; i++) {
      const a = await run(ORIGINAL, { PATH });
      const b = await run(teeCmd, { PATH, XAIBO_TEE_ORIGINAL: ORIGINAL, XAIBO_TEE_SOCKET: sock });
      if (a.code !== 0 || b.code !== 0 || a.out !== b.out) bad++;
      added.push(b.ms - a.ms);
    }
    await close?.();
    const s = summary(added);
    const pass = bad === 0 && s.p95 <= BOUND_MS;
    ok &&= pass;
    results[variant] = { addedMs: s, mismatches: bad, pass };
    console.log(`${runtime} ${variant}: ${pass ? 'pass' : 'FAIL'} (added p50 ${s.p50.toFixed(1)} p95 ${s.p95.toFixed(1)} max ${s.max.toFixed(1)} ms, mismatches ${bad})`);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
if (!handicap) {
  const out = join(HERE, 'evidence', `overhead-${runtime}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ runtime, n: N, boundMs: BOUND_MS, env: envRecord({ claude: '2.1.319' }), results }, null, 2)}\n`);
}
process.exit(ok ? 0 : 1);
