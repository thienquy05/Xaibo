// P0-T08 hook recorder: record-hook.mjs <agent> <event>. Reads stdin (keeps up to 1 MiB, drains the rest),
// appends one JSON line to $XAIBO_SPIKE_RAW/<agent>.jsonl, writes 0 bytes to stdout/stderr, always exits 0.
// `--self-test` checks exactly that by spawning itself.
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_STDIN = 1024 * 1024;
const [agent = 'unknown', event = 'unknown'] = process.argv.slice(2);

if (agent === '--self-test') {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'));
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'synthetic', 'SelfTest'], { input: '{"x":1}', env: { ...process.env, XAIBO_SPIKE_RAW: dir } });
  const lines = readFileSync(join(dir, 'synthetic.jsonl'), 'utf8').trim().split('\n');
  rmSync(dir, { recursive: true, force: true });
  const ok = r.status === 0 && r.stdout.length === 0 && r.stderr.length === 0 && lines.length === 1 && JSON.parse(lines[0]).payload.x === 1;
  process.stdout.write(ok ? 'self-test ok\n' : 'self-test FAILED\n');
  process.exit(ok ? 0 : 1);
}

const chunks = [];
let kept = 0;
let total = 0;
process.stdin.on('data', (c) => {
  total += c.length;
  if (kept < MAX_STDIN) { const part = c.subarray(0, MAX_STDIN - kept); chunks.push(part); kept += part.length; }
});
process.stdin.on('end', () => {
  try {
    const raw = process.env.XAIBO_SPIKE_RAW;
    if (!raw || !/^[A-Za-z0-9_-]+$/.test(agent)) return;
    const text = Buffer.concat(chunks).toString('utf8');
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { unparsed: true }; }
    const line = { agent, event, ts_mono_ns: process.hrtime.bigint().toString(), argv_len: process.argv.length - 2, stdin_bytes: total, truncated: total > kept, payload };
    appendFileSync(join(raw, `${agent}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch { /* never disturb the agent */ }
});
process.stdin.on('error', () => {});
