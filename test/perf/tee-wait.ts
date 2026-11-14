// P3-T14 dev added-wait histogram for the statusLine tee (OQ-B6: p95 <= 100 ms, excluding the original's own runtime;
// the packaged figure is P3-T16). Runs the SEA build (.cache/sea/xaibo-statusline; `npm run build && sh
// scripts/build-forwarder.sh` first) from a temp data dir's integrations/bin, as installed, against `/bin/sh -c
// <original>` alone: paired runs, same stdin, added = tee - direct. Modes: listener up (the real socket server,
// accepting) and no listener. Binds a Unix socket, so it runs outside the command sandbox.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { teeCommand } from '../../src/forwarder/statusline-tee.ts';
import { startSocketServer } from '../../src/service/receivers/socket.ts';
import { REPO, stats } from './app.ts';
import { RESOURCES } from './emitter.ts';

const BOUND_MS = 100;
const ORIGINAL = "printf 'synthetic status %s' ok";
const STDIN = JSON.stringify({ session_id: 'synthetic-session', model: { id: 'synthetic-model', display_name: 'Synthetic' },
  cost: { total_cost_usd: 0.1 }, rate_limits: { five_hour: { used_percentage: 10, resets_at: 1767225600 } } });

function timed(command: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const c = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('error', reject);
    c.on('exit', () => resolve(performance.now() - t0));
    c.stdin.end(STDIN);
  });
}

/** Counts per 10 ms bucket of added wait, e.g. {"20-30": 41}. */
function histogram(xs: number[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const x of xs) { const b = Math.max(0, Math.floor(x / 10) * 10); h[`${b}-${b + 10}`] = (h[`${b}-${b + 10}`] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(h).sort((a, b) => parseInt(a[0]) - parseInt(b[0])));
}

/** `packaged` (P3-T16b): the tee from the packaged app (npm run dist:mac) instead of the dev SEA build. */
export async function teeWait(runs: number, packaged = false) {
  const sea = packaged ? path.join(RESOURCES, 'xaibo-statusline') : path.join(REPO, '.cache', 'sea', 'xaibo-statusline');
  if (!existsSync(sea)) throw new Error(packaged ? 'packaged tee missing: npm run dist:mac' : 'tee SEA missing: npm run build && sh scripts/build-forwarder.sh');
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'xtw-')));
  try {
    mkdirSync(path.join(dir, 'integrations', 'bin'), { recursive: true, mode: 0o700 });
    copyFileSync(sea, path.join(dir, 'integrations', 'bin', 'xaibo-statusline'));
    const command = teeCommand(dir, 'p1');
    writeFileSync(path.join(dir, 'integrations', 'manifest.json'), JSON.stringify({ v: 1, entries: [{ route: 'claude-tee', state: 'applied',
      owned: [{ pointer: '/statusLine/command', value: command, old: ORIGINAL }] }] }), { mode: 0o600 });
    const modes: Record<string, unknown> = {};
    let delivered = 0;
    for (const mode of ['listener-up', 'no-listener'] as const) {
      const server = mode === 'listener-up'
        ? await startSocketServer({ dataDir: dir, onEnvelope: async () => { delivered++; return { status: 'accepted', code: 'ok' }; } })
        : null;
      const added: number[] = [];
      try {
        for (let i = 0; i < runs; i++) added.push(await timed(command) - await timed(ORIGINAL));
      } finally { await server?.close(); }
      modes[mode] = { ...stats(added), histogramMs: histogram(added) };
    }
    const p95s = Object.values(modes).map((m) => (m as { p95: number }).p95);
    return { probe: 'tee-added-wait', runtime: packaged ? 'SEA (packaged app)' : 'SEA (dev build, not packaged)', boundMs: BOUND_MS, runs, delivered, modes, pass: p95s.every((p) => p <= BOUND_MS) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
