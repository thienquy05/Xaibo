// S3 follow-up (P0-S3-T8): is an async Stop command hook delivered in `claude -p`, vs a synchronous one; and what
// does the agent print when an http hook's receiver is down. Temp profile only; restores its settings afterwards.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO = join(import.meta.dirname, '..', '..');
const APP = join(REPO, 'dist/spike/mac-arm64/XaiboSpike.app');
const CONFIG = join(homedir(), '.xaibo-spike-profiles', 'claude-a', 'home', '.claude');
const DATA = join(homedir(), '.xaibo-spike-profiles', 'claude-a', 'xaibo-data');
const PROJECT = join(REPO, '.cache', 'spike-projects', 's3');
const settingsFile = join(CONFIG, 'settings.json');
const REFUSED_PORT = 1; // nothing listens there: models a receiver that is down
const shim = (e: string) => `XAIBO_FWD_CANDIDATE=sea XAIBO_APP='${APP}' '${join(REPO, 'spikes/s3/shim.sh')}' claude ${e}`;
const claude = () => spawnSync('/bin/bash', [join(REPO, 'spikes/shared/in-profile.sh'), '--spike', 's3', 'claude', 'a', '--', 'claude', '-p', 'Reply with the single word OK.'], { cwd: PROJECT, encoding: 'utf8', timeout: 180_000 });
const spooled = () => { const s = join(DATA, 'spool'); return existsSync(s) ? readdirSync(s).flatMap((f) => readFileSync(join(s, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).event as string)) : []; };

const original = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null;
try {
  for (const asyncStop of [true, false]) {
    rmSync(join(DATA, 'spool'), { recursive: true, force: true });
    const env: NodeJS.ProcessEnv = { ...process.env, XAIBO_DATA_DIR: DATA, XAIBO_SPIKE_MODE: 's3' };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = spawn(join(APP, 'Contents/MacOS/XaiboSpike'), [], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    app.stdout.on('data', (d: Buffer) => { out += d; });
    while (!out.includes('s3-ready')) await sleep(50);
    writeFileSync(settingsFile, JSON.stringify({ hooks: {
      Stop: [{ hooks: [{ type: 'command', async: asyncStop, command: shim('Stop') }] }],
      SessionEnd: [{ hooks: [{ type: 'command', async: true, command: shim('SessionEnd') }] }],
    } }), { mode: 0o600 });
    const r = claude();
    await sleep(2000);
    const events = [...out.matchAll(/"event":"(\w+)"/g)].map((m) => m[1]);
    app.kill('SIGTERM');
    await sleep(500);
    console.log(`Stop async=${asyncStop}: reply ${r.stdout.trim()}; received ${[...new Set(events)].sort().join(',') || '-'}; spooled ${spooled().join(',') || '-'}`);
  }
  const token = readFileSync(join(DATA, 'run', 'token'), 'utf8');
  writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: `http://127.0.0.1:${REFUSED_PORT}/hook`, headers: { 'X-Xaibo-Token': token } }] }] } }), { mode: 0o600 });
  const r = claude();
  console.log(`http receiver down: reply ${r.stdout.trim()}; stderr: ${JSON.stringify(r.stderr.replaceAll(homedir(), '~'))}`);
} finally {
  if (original === null) rmSync(settingsFile, { force: true }); else writeFileSync(settingsFile, original);
}
