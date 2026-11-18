// XAIBO-PROD-504 (P5-T01): migration 014 runs through the recovery path (backup first), changes no existing row and
// constrains overlay values; overlay ops never touch native files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadMigrations, openStore } from '../../src/service/store/db.ts';
import { applyOverlay } from '../../src/service/history/overlay.ts';
import type { OverlayOp } from '../../src/shared/ipc.ts';

const one = (db: DatabaseSync, sql: string) => Object.values(db.prepare(sql).get() ?? {})[0];

test('014: backup first, every session kept, overlay values constrained; native files untouched by overlay ops', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xoverlay-mig-'));
  const opts = { file: join(dir, 'xaibo.db'), backupDir: join(dir, 'backups') };
  const before = await openStore({ ...opts, migrations: loadMigrations().filter((m) => m.version < 14) });
  before.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  before.db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id, cwd, last_activity) VALUES ('claude', 'p1', 's1', '/tmp/xaibo-fixture/alpha', 1)").run();
  const sessions = JSON.stringify(before.db.prepare('SELECT * FROM sessions').all());
  before.db.close();

  const s = await openStore(opts);
  assert.equal(s.readOnly, false);
  assert.ok(Number(one(s.db, 'PRAGMA user_version')) >= 14);
  assert.deepEqual(readdirSync(opts.backupDir), ['xaibo-v13.db'], 'the recovery path backed up the v13 database first');
  assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM sessions').all()), sessions);
  assert.throws(() => s.db.prepare("INSERT INTO overlays (agent, profile_id, native_session_id, pinned) VALUES ('claude', 'p1', 's1', 2)").run(), /CHECK/);
  assert.throws(() => s.db.prepare("INSERT INTO projects (name, created_at) VALUES ('', 1)").run(), /CHECK/);

  const native = join(dir, 'native', 'projects', '-tmp-xaibo-fixture-alpha');
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, 's1.jsonl'), '{"type":"user"}\n');
  const sum = () => createHash('sha256').update(readFileSync(join(native, 's1.jsonl'))).digest('hex');
  const was = sum();
  const ops: OverlayOp[] = [{ kind: 'pin', session: 1, on: true }, { kind: 'archive', session: 1, on: true }, { kind: 'confirmLabel', session: 1 }];
  for (const op of ops) assert.ok(applyOverlay(s.db, op, { readOnly: false, now: 2 }).ok);
  assert.equal(sum(), was, 'native transcript unchanged');
});
