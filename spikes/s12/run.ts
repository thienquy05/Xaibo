// S12 dispatcher (`npm run spike:s12 -- --<step>`). DB steps compile spikes/ and run on the packaged Electron
// runtime (ELECTRON_RUN_AS_NODE=1); --self-check and --check run on system Node. Other T3-T6 steps add a line.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const BIN = join(REPO, 'dist/spike/mac-arm64/XaiboSpike.app/Contents/MacOS/XaiboSpike');
const STEPS: Record<string, { script: string; electron: boolean }> = {
  '--self-check': { script: 'spikes/s12/gen.ts', electron: false },
  '--check': { script: 'spikes/s12/check.ts', electron: false },
  '--build': { script: 'spikes/app/build/s12/build.js', electron: true },
  '--queries': { script: 'spikes/app/build/s12/queries.js', electron: true },
  '--watch': { script: 'spikes/app/build/s12/watch.js', electron: true },
  '--load': { script: 'spikes/app/build/s12/load.js', electron: true },
  '--usage': { script: 'spikes/app/build/s12/load.js', electron: true },
};

const [flag, ...rest] = process.argv.slice(2);
const step = STEPS[flag ?? ''];
if (!step) { console.error(`usage: spike:s12 -- ${Object.keys(STEPS).join('|')} (T3-T6 steps not implemented here yet)`); process.exit(2); }
if (step.electron) {
  if (!existsSync(BIN)) { console.error('packaged app missing: run npm run dist:mac first'); process.exit(2); }
  execFileSync(join(REPO, 'node_modules/.bin/tsc'), ['-p', join(REPO, 'spikes')], { stdio: 'inherit' });
}
const args = flag === '--self-check' ? ['--self-check', ...rest] : flag === '--load' ? ['--all', ...rest] : flag === '--usage' ? ['--usage', ...rest] : rest;
const res = step.electron
  ? spawnSync(BIN, [join(REPO, step.script), ...args], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  : spawnSync(process.execPath, [join(REPO, step.script), ...args], { stdio: 'inherit' });
process.exit(res.status ?? 1);
