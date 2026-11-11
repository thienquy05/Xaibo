// Test artifacts (P1-T13, EC-35): text a test helper writes under test-results/ goes through sanitize(), and the global
// teardown sanitizes Playwright's own text output (e.g. error-context.md) when a run ends. Screenshots, videos and
// traces stay off: binary output cannot be sanitized.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sanitize } from '../../src/shared/sanitize.ts';

const TEXT = /\.(md|txt|json|log|html|xml)$/i;

export function saveArtifact(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(name));
  writeFileSync(file, sanitize(content));
  return file;
}

export function sanitizeTree(dir: string): void {
  let entries: string[];
  try { entries = readdirSync(dir, { recursive: true }).map(String); } catch { return; }
  for (const rel of entries) {
    const file = path.join(dir, rel);
    if (TEXT.test(file) && statSync(file).isFile()) writeFileSync(file, sanitize(readFileSync(file, 'utf8')));
  }
}
