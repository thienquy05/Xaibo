// Preloaded into every test run (npm test, test:electron through --import): the first process points TMPDIR at one private
// folder for the whole run and removes it at exit; test files inherit it, so no suite leaves mkdtemp folders in the user temp dir
// (memory note "test temp-folder leak": ~1 GiB per run). ponytail: a run killed with SIGKILL still leaves its xrun- folder.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.TEST_TMP_ROOT) {
  const root = mkdtempSync(join(tmpdir(), 'xrun-'));
  process.env.TMPDIR = process.env.TEST_TMP_ROOT = root;
  process.once('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
}
