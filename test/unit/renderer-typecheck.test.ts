// Gate 5 round 2: the packaged build (vite/esbuild) does not type-check, so a renderer type error can pass build, unit
// and E2E runs. This guard runs the renderer's own tsc project and fails on any type error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');

test('the renderer type-checks (tsc -p src/renderer --noEmit)', () => {
  const tsc = path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', path.join(repo, 'src', 'renderer')], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(r.status, 0, `renderer type errors:\n${r.stdout}${r.stderr}`);
});
