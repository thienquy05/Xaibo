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

// Gate 5 round 3 G5Ss1-3 (Codex): the writer recomputes a no-prompt session's excerpt on every batch with a user record,
// so the candidate scan must be bounded by examined records, not by returned rows: a session of 20,000 records with no
// prompt costs a batch the same as one of 200 (the scan reads only the session's first records by source_seq).
test('G5Ss1-3: the excerpt recompute of a 20,000-record no-prompt session examines a bounded number of records per batch', async (t) => {
  const { StatementSync } = await import('node:sqlite');
  const hasStat = typeof (StatementSync.prototype as unknown as { stat?: unknown }).stat === 'function';
  let sql = '';
  const { commitBatch } = await import('../../src/service/store/writer.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'xexcerpt-scan-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { db } = await openStore({ file: join(tmp, 'xaibo.db'), backupDir: join(tmp, 'backups') });
  t.after(() => db.close());
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/a', 'default')").run();
  const ev = db.prepare(`INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, role, source_seq, received_ts, content)
    VALUES (?, 1, 'transcript', 'confirmed', ?, 'message', 'assistant', ?, 1, 'synthetic reply')`);
  /** A no-prompt session of `n` assistant records; returns the VM steps of the excerpt query while a batch adds one
   *  (injected, so never a prompt) user record to it. */
  const stepsFor = (native: string, n: number) => {
    const id = Number(db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id, last_activity) VALUES ('claude', 'p1', ?, 5)").run(native).lastInsertRowid);
    db.exec('BEGIN');
    for (let i = 1; i <= n; i++) ev.run(id, `${native}-${i}`, i);
    db.exec('COMMIT');
    const proto = StatementSync.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const orig = Object.fromEntries(['all', 'get', 'iterate', 'run'].map((m) => [m, proto[m]!]));
    const first = new Map<{ stat(c: string): number; sourceSQL: string }, number>();
    for (const m of Object.keys(orig)) proto[m] = function (this: { stat(c: string): number; sourceSQL: string }, ...a: unknown[]) {
      if (this.sourceSQL.includes('octet_length') && !first.has(this)) first.set(this, hasStat ? this.stat('vmStep') : 0);
      return orig[m]!.apply(this, a);
    };
    try {
      commitBatch(db, { profileId: 'p1', agent: 'claude', sessions: [{ nativeSessionId: native }],
        events: [{ nativeSessionId: native, source: 'transcript', confidence: 'confirmed', nativeId: `${native}-u`, kind: 'user', role: 'user', sourceSeq: n + 1,
          receivedTs: 2, injected: true, content: 'synthetic injected context' }] });
    } finally { Object.assign(proto, orig); }
    assert.equal(first.size, 1, 'fixture: the batch recomputed the excerpt');
    sql = [...first.keys()][0]!.sourceSQL;
    return hasStat ? [...first].reduce((s, [st, v]) => s + st.stat('vmStep') - v, 0) : 0;
  };
  const small = stepsFor('small', 200), big = stepsFor('big', 20_000);
  if (hasStat) assert.ok(big <= 2 * small, `excerpt query VM steps: ${big} for 20,000 records vs ${small} for 200`);
  // Electron's Node (24) has no StatementSync#stat: there the plan shows the bound (the window from events_current_seq
  // is the outer loop; the session's records are only looked up by id, never scanned)
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);
  assert.ok(plan.filter((d) => /SEARCH events USING COVERING INDEX events_current_seq/.test(d)).length === 2, plan.join('\n'));
  assert.ok(plan.includes('SEARCH e USING INTEGER PRIMARY KEY (rowid=?)') && !plan.some((d) => /^SCAN (e|events)\b/.test(d)), plan.join('\n'));
});

// Gate 5 round 3 G5Ss1-3 (design review 3002): the candidate window is the session's first 64 current records per source;
// a first prompt past that window gives no excerpt (null), a prompt inside it is found.
test('G5Ss1-3: a prompt inside the first 64 current records is the excerpt; one past them gives null', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'xexcerpt-window-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { db } = await openStore({ file: join(tmp, 'xaibo.db'), backupDir: join(tmp, 'backups') });
  t.after(() => db.close());
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/a', 'default')").run();
  const ev = db.prepare(`INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, role, source_seq, received_ts, content, raw)
    VALUES (?, 1, 'transcript', 'confirmed', ?, 'message', ?, ?, 1, ?, ?)`);
  const rec = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const sessionWithPromptAt = (native: string, at: number) => {
    const id = Number(db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id, last_activity) VALUES ('claude', 'p1', ?, 5)").run(native).lastInsertRowid);
    for (let i = 1; i < at; i++) ev.run(id, `${native}-${i}`, 'assistant', i, 'synthetic reply', null);
    ev.run(id, `${native}-p`, 'user', at, 'Synthetic window prompt', rec('Synthetic window prompt'));
    return id;
  };
  assert.equal(computeExcerpt(db, 'claude', sessionWithPromptAt('inside', 64)), 'Synthetic window prompt');
  assert.equal(computeExcerpt(db, 'claude', sessionWithPromptAt('past', 65)), null);
});
