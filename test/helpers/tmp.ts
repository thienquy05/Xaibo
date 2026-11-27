// A temp folder removed when this test process exits (node --test runs each file in its own process). The suites used to leave
// every mkdtemp folder behind (tens of GiB in the user temp dir after a day of runs; memory note "test temp-folder leak").
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made: string[] = [];
process.once('exit', () => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
