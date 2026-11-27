// Gate 5 G5b2-1 (EC-45): a store left read-only at an older schema (not enough space to migrate, or a failed migration)
// still answers the history list and the session detail from the columns it has: before migration 016 there is no
// ai_title, so the title comes from sessions.title alone. Synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerSession, answerUsage } from '../../src/service/api.ts';
import { listHistory } from '../../src/service/history/overlay.ts';
import { loadMigrations, openStore } from '../../src/service/store/db.ts';

test('G5b2-1: read-only at schema 15 (no ai_title), the history list and the session detail answer with sessions.title', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'xro-schema-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const opts = { file: join(tmp, 'xaibo.db'), backupDir: join(tmp, 'backups') };
  const old = await openStore({ ...opts, migrations: loadMigrations().filter((m) => m.version < 16) });
  old.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/a', 'default')").run();
  old.db.prepare(`INSERT INTO sessions (agent, profile_id, native_session_id, title, last_activity) VALUES
    ('claude', 'p1', 'a1', 'Synthetic title', 5), ('claude', 'p1', 'a2', NULL, 4)`).run();
  old.db.close();

  const s = await openStore({ ...opts, freeBytes: () => 0 }); // EC-45: too little space to back up and migrate
  t.after(() => s.db.close());
  assert.equal(s.readOnly, true);
  assert.equal(s.reason, 'insufficient-space');

  let list: { title: string | null }[] | Error;
  try { list = listHistory(s.db, { mode: 'all', agent: null, project: null, folder: null }, null, 50).rows; } catch (e) { list = e as Error; }
  assert.ok(Array.isArray(list), `the history list answers (got ${list instanceof Error ? list.message : 'rows'})`);
  assert.deepEqual(list.map((r) => r.title), ['Synthetic title', null]);
  const detail = answerSession(s.db, { v: 1, type: 'session', id: 1, session: 1 }).detail;
  assert.equal(detail?.row.title, 'Synthetic title', 'the session detail answers');
});

// XAIBO-PROD-582 review M1: a store left read-only before migration 027 (no sign-in generation or boundaries) still answers
// Usage: its scopes at generation 0, with no boundary (never invented).
test('read-only before migration 027: Usage still answers, generation 0 and no boundary', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'xro-schema-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const opts = { file: join(tmp, 'xaibo.db'), backupDir: join(tmp, 'backups') };
  const old = await openStore({ ...opts, migrations: loadMigrations().filter((m) => m.version < 27) });
  old.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('00000000-0000-4000-8000-0000000c8212', 'claude', '/tmp/xaibo-fixture/a', 'default')").run();
  const sc = Number(old.db.prepare("INSERT INTO usage_scopes (scope_key, profile_id, agent, epoch, verified) VALUES ('k1', '00000000-0000-4000-8000-0000000c8212', 'claude', NULL, 0)").run().lastInsertRowid);
  old.db.prepare(`INSERT INTO usage_history (schema_version, usage_scope_id, limit_id, kind, minute, used_percent, window_minutes, resets_at, plan, credits, as_of,
    first_observed_at, observed_at, measured_at, source, source_locator) VALUES (1, ?, 'five_hour', 'sample', 1, 40, 300, NULL, NULL, NULL, NULL, 60000, 60000, 60000, 'fixture', 'loc')`).run(sc);
  old.db.close();
  const s = await openStore({ ...opts, freeBytes: () => 0 });
  t.after(() => s.db.close());
  assert.equal(s.readOnly, true);
  const reply = answerUsage(s.db, { v: 1, type: 'usage', id: 1 }, '/tmp/xaibo-fixture/home');
  assert.deepEqual(reply.scopes.map((x) => [x.scope, x.stream, x.usedPercent, x.generation, x.boundary]), [[sc, 'five_hour', 40, 0, null]]);
  assert.equal(reply.profiles.length, 1);
});
