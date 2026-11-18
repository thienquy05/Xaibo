// XAIBO-PROD-517 (P5-T09; FR-12, US-6, §5.11, FR-52): one retention run purges sessions inactive for N days (reason
// retention) and expired Trash (reason manual; Keep does not protect Trash), keeps recent, Keep and in-Trash sessions,
// sessions whose native files changed since the cutoff and sessions that became ineligible meanwhile, and expires
// account-level quota history 45 days after measurement whatever the setting or Keep, while session-linked quota follows
// its session. Every deletion settles first: monthly totals do not change.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { runRetention } from '../../src/service/retention/job.ts';
import { DAY, setRetention } from '../../src/service/retention/policy.ts';
import { liveMonthly } from '../../src/service/usage/monthly.ts';
import { hookStore } from '../helpers/hook-store.ts';
import { request, sample, SECRET, session, turn } from '../helpers/monthly.ts';

const NOW = Date.UTC(2026, 10, 18, 12);

async function seeded() {
  const h = await hookStore();
  const db = h.db;
  const add = (sid: string, last: number, o: { keep?: boolean; trashedAt?: number } = {}) => {
    const id = session(db, { sid, last, started: last });
    turn(db, id, `${sid}-t`, last, 'claude-x');
    request(db, id, { identity: `${sid}:1`, ts: last, model: 'claude-x', input: 3, output: 5 });
    if (o.keep || o.trashedAt !== undefined) {
      db.prepare("INSERT INTO overlays (agent, profile_id, native_session_id, keep, trashed_at) VALUES ('claude', 'p1', ?, ?, ?)").run(sid, o.keep ? 1 : 0, o.trashedAt ?? null);
    }
    return id;
  };
  /** A native file of the session written just now (continued while Xaibo was off; not synced yet). */
  const touched = (id: number, name: string) => {
    const path = join(h.dir, `${name}.jsonl`);
    writeFileSync(path, '{}\n', { mode: 0o600 });
    db.prepare("INSERT INTO source_files (profile_id, session_id, path, kind, size, offset, mtime) VALUES ('p1', ?, ?, 'transcript', 3, 3, ?)").run(id, path, NOW - 50 * DAY);
  };
  const ids = {
    old: add('old', NOW - 50 * DAY),
    unknownAge: add('unknown-age', NOW - 50 * DAY),
    recent: add('recent', NOW - 10 * DAY),
    kept: add('kept', NOW - 50 * DAY, { keep: true }),
    stuck: add('stuck', NOW - 50 * DAY),
    resumed: add('resumed', NOW - 50 * DAY),
    inTrash: add('in-trash', NOW - 50 * DAY, { trashedAt: NOW - 10 * DAY }),
    trashExpired: add('trash-expired', NOW - 20 * DAY, { trashedAt: NOW - 31 * DAY }),
    keptTrash: add('kept-trash', NOW - 20 * DAY, { keep: true, trashedAt: NOW - 30 * DAY }),
    trashRecent: add('trash-recent', NOW - 2 * 3600_000, { trashedAt: NOW - 31 * DAY }),
  };
  db.prepare('UPDATE sessions SET last_activity = NULL WHERE id = ?').run(ids.unknownAge); // review L2: falls back to its start
  touched(ids.resumed, 'resumed');
  const scope = (key: string, sessionId: number | null) => Number(db.prepare("INSERT INTO usage_scopes (scope_key, profile_id, agent, session_id, verified) VALUES (?, 'p1', 'claude', ?, ?)")
    .run(key, sessionId, sessionId === null ? 1 : 0).lastInsertRowid);
  const account = scope('account', null), linked = scope('linked', ids.kept);
  sample(db, account, { percent: 10, at: NOW - 46 * DAY, locator: 'expired' });
  sample(db, account, { percent: 20, at: NOW - 44 * DAY, locator: 'fresh' });
  sample(db, linked, { percent: 30, at: NOW - 50 * DAY, locator: 'linked' });
  const snapshot = (locator: string, at: number) => db.prepare(`INSERT INTO usage_snapshots (schema_version, agent, profile_id, session_id, source, source_locator, as_of, observed_at)
    VALUES (1, 'claude', 'p1', NULL, 'statusline', ?, ?, ?)`).run(locator, at, at);
  snapshot('snap-expired', NOW - 46 * DAY);
  snapshot('snap-fresh', NOW - 44 * DAY);
  // the engine still holds a busy state for 'stuck' from 50 days ago: not live (review L1)
  const run = (o: { now?: number; batch?: number; active?: (native: string) => boolean } = {}) => runRetention(h.writer, db, { dataDir: h.dir,
    backupDir: join(h.dir, 'backups'), secret: SECRET, now: o.now ?? NOW, active: (_agent, _profile, native) => (o.active ?? ((n) => n === 'stuck'))(native),
    ...(o.batch ? { batch: o.batch } : {}) });
  return { ...h, ids, run, add, touched };
}
const left = (db: DatabaseSync) => (db.prepare('SELECT native_session_id AS n FROM sessions ORDER BY n').all() as { n: string }[]).map((r) => r.n);
const reasons = (db: DatabaseSync) => Object.fromEntries((db.prepare('SELECT native_session_id AS n, reason FROM suppressions').all() as { n: string; reason: string }[]).map((r) => [r.n, r.reason]));
const quota = (db: DatabaseSync) => (db.prepare('SELECT source_locator AS l FROM usage_history ORDER BY l').all() as { l: string }[]).map((r) => r.l);
const snapshots = (db: DatabaseSync) => (db.prepare('SELECT source_locator AS l FROM usage_snapshots ORDER BY l').all() as { l: string }[]).map((r) => r.l);

test('one run: retention (45 days), Trash auto-empty and account usage expiry; the rest stays; months unchanged', async () => {
  const h = await seeded();
  const before = liveMonthly(h.db, SECRET);
  const r = await h.run();
  assert.deepEqual(r, { sessions: 3, trash: 2, quota: 2, skipped: null });
  assert.deepEqual(left(h.db), ['in-trash', 'kept', 'recent', 'resumed', 'trash-recent']);
  assert.deepEqual(reasons(h.db), { old: 'retention', 'unknown-age': 'retention', stuck: 'retention', 'trash-expired': 'manual', 'kept-trash': 'manual' });
  assert.deepEqual(quota(h.db), ['fresh', 'linked'], 'account quota expires at 45 days; session-linked follows its (Keep) session');
  assert.deepEqual(snapshots(h.db), ['snap-fresh'], 'account-level snapshots expire at 45 days too (review L5)');
  assert.deepEqual(liveMonthly(h.db, SECRET), before, 'every deletion settled first (FR-52)');
  assert.deepEqual(await h.run(), { sessions: 0, trash: 0, quota: 0, skipped: null }, 'a second run finds nothing');
});

test('Never keeps every session; Trash auto-empty and account usage expiry still run; an unreadable setting purges no session', async () => {
  const h = await seeded();
  assert.equal(setRetention(h.db, 'never'), true);
  assert.deepEqual(await h.run(), { sessions: 0, trash: 2, quota: 2, skipped: null });
  assert.ok(left(h.db).includes('old'));
  const g = await seeded();
  g.db.prepare("INSERT INTO kv (key, value) VALUES ('retention.sessions', 'garbled')").run();
  assert.deepEqual(await g.run(), { sessions: 0, trash: 2, quota: 2, skipped: 'invalid-setting' }, 'review M1');
});

test('review H2: a session that became ineligible after it was picked (Keep set meanwhile) is not purged', async () => {
  const h = await seeded();
  const r = await h.run({ active: (n) => { // asked just before its purge: the owner sets Keep at that moment
    if (n === 'old') h.db.prepare("INSERT INTO overlays (agent, profile_id, native_session_id, keep) VALUES ('claude', 'p1', 'old', 1)").run();
    // diff review L1: a trashed session with new activity at that moment waits too
    if (n === 'trash-expired') h.db.prepare("UPDATE sessions SET last_activity = ? WHERE native_session_id = 'trash-expired'").run(NOW - 3600_000);
    return false;
  } });
  assert.equal(r.sessions, 2);
  assert.ok(left(h.db).includes('old'));
  assert.equal(r.trash, 1);
  assert.ok(left(h.db).includes('trash-expired'));
});

test('review H3: a run whose clock is behind the last run purges nothing', async () => {
  const h = await seeded();
  await h.run();
  h.add('newly-old', NOW - 60 * DAY);
  assert.deepEqual(await h.run({ now: NOW - DAY }), { sessions: 0, trash: 0, quota: 0, skipped: 'clock-behind' });
  assert.ok(left(h.db).includes('newly-old'));
});

test('batches continue past skipped sessions; owed purge file work is finished first (review M3)', async () => {
  const h = await seeded();
  for (let i = 0; i < 5; i++) session(h.db, { sid: `more-${i}`, last: NOW - (60 + i) * DAY });
  h.touched((h.db.prepare("SELECT id FROM sessions WHERE native_session_id = 'more-4'").get() as { id: number }).id, 'more-4'); // the oldest: skipped
  h.db.prepare("INSERT INTO suppressions (agent, profile_id, native_session_id, reason, at, pending) VALUES ('claude', 'p1', 'earlier', 'manual', 1, '[]')").run();
  const r = await h.run({ batch: 2 });
  assert.equal(r.sessions, 7);
  assert.deepEqual(left(h.db), ['in-trash', 'kept', 'more-4', 'recent', 'resumed', 'trash-recent']);
  assert.equal((h.db.prepare("SELECT pending FROM suppressions WHERE native_session_id = 'earlier'").get() as { pending: string | null }).pending, null);
});
