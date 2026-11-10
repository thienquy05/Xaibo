// P0-T03 smoke: packaged app, mode idle, temp data dir. Run unsandboxed (also used by the P0-T05 nesting probe).
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

const BIN = join(import.meta.dirname, '..', '..', 'dist/spike/mac-arm64/XaiboSpike.app/Contents/MacOS/XaiboSpike');
const STEP_TIMEOUT_MS = 20_000;
const ORPHAN_WAIT_MS = 2_000;

const dataDir = mkdtempSync(join(tmpdir(), 'xaibo-smoke-'));
const env: NodeJS.ProcessEnv = { ...process.env, XAIBO_DATA_DIR: dataDir, XAIBO_SPIKE_MODE: 'idle' };
delete env.ELECTRON_RUN_AS_NODE; // the VS Code host exports it; it would turn the app into plain Node

const child = spawn(BIN, [], { env, stdio: ['ignore', 'pipe', 'inherit'] });
const seen = new Set<string>();
let buf = '';
child.stdout.on('data', (d: Buffer) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
    try { const m = JSON.parse(buf.slice(0, i)); if (m.smoke) seen.add(m.smoke); } catch { /* not ours */ }
  }
});
const exited = new Promise<number | null>((res, rej) => { child.on('exit', res); child.on('error', rej); });

async function waitFor(tag: string) {
  const end = Date.now() + STEP_TIMEOUT_MS;
  while (!seen.has(tag)) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${tag}`);
    await Promise.race([sleep(50), exited.then(() => { throw new Error(`exited before ${tag}`); })]);
  }
}

try {
  await waitFor('service-ready');
  await waitFor('paint-ack');
  child.kill('SIGTERM');
  const code = await Promise.race([exited, sleep(STEP_TIMEOUT_MS).then(() => 'timeout')]);
  assert.equal(code, 0, 'clean exit on quit');
  await sleep(ORPHAN_WAIT_MS);
  let orphans = '';
  try { orphans = execFileSync('/usr/bin/pgrep', ['-f', 'XaiboSpike'], { encoding: 'utf8' }); } catch { /* exit 1 = none */ }
  assert.equal(orphans.trim(), '', 'no orphan processes');
  assert.ok(readdirSync(dataDir).length > 0, 'userData redirected into XAIBO_DATA_DIR');
  console.log('smoke: pass');
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true });
}
