// P4-T03: the window has one status region, the service health (Health.tsx); other polite announcements (list
// pagination) use aria-live without the status role, so assistive tech and tests find exactly one status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', '..', '..', 'src', 'renderer');
const tsx = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsx(join(d, e.name)) : e.name.endsWith('.tsx') ? [join(d, e.name)] : []));

test('exactly one role="status" in the renderer: the health status', () => {
  const hits = tsx(DIR).flatMap((f) => (readFileSync(f, 'utf8').match(/role="status"/g) ?? []).map(() => f.slice(DIR.length + 1)));
  assert.deepEqual(hits, ['Health.tsx']);
});
