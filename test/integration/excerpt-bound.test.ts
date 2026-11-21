// Gate 5 G5b2-3 (XAIBO-PROD-509 follow-up): an untitled row's excerpt reads a bounded amount of record text (round 2 A:
// when the writer computes it). A user
// record too large for the bound is skipped in the query (never loaded or parsed), so the excerpt comes from the next
// small prompt. Synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeExcerpt } from '../../src/service/history/excerpt.ts';
import { openStore } from '../../src/service/store/db.ts';

test('G5b2-3: a multi-MiB first user record is skipped; the excerpt is the next small prompt, and the big record is never parsed', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'xexcerpt-bound-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { db } = await openStore({ file: join(tmp, 'xaibo.db'), backupDir: join(tmp, 'backups') });
  t.after(() => db.close());
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/a', 'default')").run();
  db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id, last_activity) VALUES ('claude', 'p1', 'a1', 5)").run();
  const ev = db.prepare(`INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, role, source_seq, received_ts, content, raw)
    VALUES (1, 1, 'transcript', 'confirmed', ?, 'message', 'user', ?, 1, ?, ?)`);
  const rec = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const huge = 'synthetic filler '.repeat(200_000); // ~3.4 MB
  ev.run('n1', 1, huge, rec(huge));
  ev.run('n2', 2, 'Small synthetic prompt', rec('Small synthetic prompt'));

  const parse = JSON.parse;
  let largest = 0;
  JSON.parse = ((text: string, reviver?: (k: string, v: unknown) => unknown) => { largest = Math.max(largest, String(text).length); return parse(text, reviver); }) as typeof JSON.parse;
  let excerpt: string | null | undefined;
  try { excerpt = computeExcerpt(db, 'claude', 1); } finally { JSON.parse = parse; } // Gate 5 round 2 A: computed by the writer, stored
  assert.equal(excerpt, 'Small synthetic prompt');
  assert.ok(largest < 256 * 1024, `no oversized record parsed (largest JSON.parse input ${largest})`);
});

// Gate 5 round 2 security review (LOW): a store error while computing is "unknown" (undefined), never "no excerpt"
// (null): the writer keeps the stored excerpt instead of overwriting it with null.
test('round 2 review: computeExcerpt answers undefined when the store cannot be read, null only when there is no prompt', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  assert.equal(computeExcerpt(new DatabaseSync(':memory:'), 'claude', 1), undefined, 'no events table: unknown');
});
