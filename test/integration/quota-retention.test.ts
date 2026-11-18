// XAIBO-PROD-518 (P5-T11; EC-99, PRD §5.11, FR-12, FR-52): quota retention through the real Codex ingest path.
// Account-level history (a scope with no session) expires 45 elapsed days after measurement whatever the session
// setting, Keep, Trash or purge; session-linked history and snapshots follow their session. A reading the retention job
// already expired never comes back when the rollout is read again (checkpoint reset, restart). Nothing is interpolated.
// The expiry and paged history queries search the usage_history_stream index.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import * as api from '../../src/service/api.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import * as job from '../../src/service/retention/job.ts';
import { DAY } from '../../src/service/retention/policy.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';

const SALT = Buffer.alloc(32, 7);
const SECRET = Buffer.alloc(32, 9);
const T0 = Date.UTC(2026, 0, 1);
const NOW = T0 + 46 * DAY;
const at = (day: number, min: number) => T0 + day * DAY + min * 60_000;
const sid = (n: number) => `00000000-0000-4000-8000-0000000c99${String(n).padStart(2, '0')}`;

type Count = { day: number; min: number; used: number };
/** A rollout whose token_count records carry a 5 h primary window; the reset moves with the reading's 5 h block. */
function rollout(id: string, account: string | null, counts: Count[]): string {
  const first = counts[0]!;
  const meta = { id, timestamp: new Date(at(first.day, first.min)).toISOString(), cwd: '/tmp/xaibo-fixture/quota', originator: 'codex-tui', cli_version: '0.160.0',
    source: 'cli', ...(account ? { creator_account_id: account } : {}) };
  const lines: unknown[] = [{ timestamp: meta.timestamp, type: 'session_meta', payload: meta }];
  let total = 0;
  for (const c of counts) {
    total += 120;
    const ts = at(c.day, c.min);
    const u = { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: total };
    lines.push({ timestamp: new Date(ts).toISOString(), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: u, last_token_usage: { ...u, total_tokens: 120 }, model_context_window: 200000 },
      rate_limits: { limit_id: 'codex', plan_type: 'pro', primary: { used_percent: c.used, window_minutes: 300, resets_at: Math.ceil((ts + 1) / (300 * 60_000)) * 300 * 60 } } } });
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

async function quotaStore() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xqr-')));
  const dataDir = join(tmp, 'data');
  const store = await openStore({ file: join(dataDir, 'xaibo.db'), backupDir: join(dataDir, 'backups') });
  const db = store.db;
  const writer = new Writer(db);
  const root = join(tmp, 'c1', '.codex');
  const dir = join(root, 'sessions', '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('c1', 'codex', ?, 'manual')").run(root);
  const write = (id: string, text: string, mtime: number) => {
    const f = join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
    writeFileSync(f, text);
    utimesSync(f, new Date(mtime), new Date(mtime)); // the native file as the agent left it
  };
  const ingest = async () => {
    const a = new CodexAdapter({ db, writer, profileId: 'c1', root, intervalMs: 60_000, accountSalt: SALT });
    await a.start();
    a.stop();
  };
  const overlay = (id: string, o: { keep?: boolean; trashedAt?: number }) => db.prepare(`INSERT INTO overlays (agent, profile_id, native_session_id, keep, trashed_at)
    VALUES ('codex', 'c1', ?, ?, ?)`).run(id, o.keep ? 1 : 0, o.trashedAt ?? null);
  const retain = () => job.runRetention(writer, db, { dataDir, backupDir: join(dataDir, 'backups'), secret: SECRET, now: NOW, active: () => false });
  return { db, write, ingest, overlay, retain };
}

type Row = { native: string | null; used: number; day: number };
/** Stored history: the owning session's native id (null = account level), percent and day. */
const history = (db: DatabaseSync) => db.prepare(`SELECT s.native_session_id AS native, h.used_percent AS used, cast((h.measured_at - ?) / ${DAY} AS integer) AS day FROM usage_history h
  JOIN usage_scopes sc ON sc.id = h.usage_scope_id LEFT JOIN sessions s ON s.id = sc.session_id ORDER BY h.measured_at, h.id`).all(T0).map((r) => ({ ...r })) as Row[];
const snapshotsOf = (db: DatabaseSync, native: string) => Number((db.prepare(`SELECT count(*) AS n FROM usage_snapshots u JOIN sessions s ON s.id = u.session_id
  WHERE s.native_session_id = ?`).get(native) as { n: number }).n);
const sessions = (db: DatabaseSync) => (db.prepare('SELECT native_session_id AS n FROM sessions ORDER BY n').all() as { n: string }[]).map((r) => r.n);

test('EC-99: account history expires at 45 days although its session has Keep; the session and its snapshots stay', async () => {
  const s = await quotaStore();
  s.write(sid(1), rollout(sid(1), 'acct-1', [{ day: 0, min: 1, used: 10 }, { day: 0, min: 2, used: 20 }, { day: 0, min: 40, used: 30 }]), at(0, 40));
  s.write(sid(2), rollout(sid(2), 'acct-1', [{ day: 44, min: 0, used: 40 }]), at(44, 0));
  await s.ingest();
  s.overlay(sid(1), { keep: true });
  assert.deepEqual(history(s.db), [{ native: null, used: 10, day: 0 }, { native: null, used: 20, day: 0 }, { native: null, used: 30, day: 0 }, { native: null, used: 40, day: 44 }],
    'one row per stored reading, account level, nothing interpolated across the gap');
  const r = await s.retain();
  assert.equal(r.quota, 3);
  assert.deepEqual(history(s.db), [{ native: null, used: 40, day: 44 }]);
  assert.deepEqual(sessions(s.db), [sid(1), sid(2)], 'Keep and a recent session stay');
  assert.equal(snapshotsOf(s.db, sid(1)), 3, 'session-linked snapshots follow the kept session');
});

test('EC-99: a purged session continued natively is read again from the start; its expired readings stay gone, new ones land', async () => {
  const s = await quotaStore();
  const old = [{ day: 0, min: 1, used: 10 }, { day: 0, min: 2, used: 20 }];
  s.write(sid(3), rollout(sid(3), 'acct-1', old), at(0, 2));
  s.write(sid(4), rollout(sid(4), 'acct-1', [{ day: 44, min: 0, used: 40 }]), at(44, 0));
  await s.ingest();
  const r = await s.retain();
  assert.deepEqual([r.sessions, r.quota], [1, 2], 'sid 3 purged by retention; its account readings expired');
  assert.deepEqual(history(s.db), [{ native: null, used: 40, day: 44 }]);
  // the agent continues the session after the purge: new native activity clears the retention marker and the whole
  // rollout is read again from the start (P5-T08), including the readings retention expired
  s.write(sid(3), rollout(sid(3), 'acct-1', [...old, { day: 46, min: 60, used: 50 }]), at(46, 60));
  await s.ingest();
  await s.ingest();
  assert.deepEqual(sessions(s.db), [sid(3), sid(4)], 're-imported');
  // ponytail: the reading in the batch that clears the marker lands in a per-session scope (that batch has no session_meta,
  // so no account marker yet); P5-T08 follow-up, outside EC-99. Compared here without the scope.
  assert.deepEqual(history(s.db).map((h) => [h.used, h.day]), [[40, 44], [50, 46]], 'expired readings stay gone');
});

test('EC-99: session-linked history and snapshots follow Keep, Trash auto-empty and retention purge', async () => {
  const s = await quotaStore();
  const day0 = [{ day: 0, min: 1, used: 10 }, { day: 0, min: 2, used: 20 }];
  for (const n of [5, 6, 7]) s.write(sid(n), rollout(sid(n), null, day0), at(0, 2)); // no account: per-session scopes
  await s.ingest();
  s.overlay(sid(5), { keep: true });
  s.overlay(sid(6), { trashedAt: at(15, 0) });
  const r = await s.retain();
  assert.deepEqual([r.sessions, r.trash], [1, 1], 'sid 7 by retention, sid 6 by Trash auto-empty');
  assert.deepEqual(sessions(s.db), [sid(5)]);
  assert.deepEqual(history(s.db), [{ native: sid(5), used: 10, day: 0 }, { native: sid(5), used: 20, day: 0 }], 'kept past 45 days with its session');
  assert.equal(snapshotsOf(s.db, sid(5)), 2);
  assert.equal(Number((s.db.prepare('SELECT count(*) AS n FROM usage_snapshots').get() as { n: number }).n), 2, 'purged sessions took theirs');
});

test('EC-99: the expiry and paged history queries search the usage_history_stream index', async () => {
  const s = await quotaStore();
  const plan = (sql: string, ...a: (number | string | null)[]) => (s.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a) as { detail: string }[]).map((r) => r.detail).join(' | ');
  for (const [name, sql, args] of [['streams', job.QUOTA_STREAM, [1, '']], ['expired', job.QUOTA_EXPIRED, [1, 'x', 0]],
    ['page', api.USAGE_HISTORY_PAGE, [1, 'x', 0, 1, null, null, null, 10]]] as const) {
    assert.equal(typeof sql, 'string', `${name} query exported`);
    const p = plan(sql as string, ...args);
    assert.match(p, /USING (COVERING )?INDEX usage_history_stream/, `${name}: ${p}`);
    assert.doesNotMatch(p, /SCAN usage_history|TEMP B-TREE/, `${name}: ${p}`);
  }
});

// review M1: several account scopes and streams, one stream past the 500-row batch: every expired row goes, live ones stay
test('EC-99: expiry walks every account scope and stream, across batch boundaries', async () => {
  const s = await quotaStore();
  const scope = (key: string) => Number(s.db.prepare("INSERT INTO usage_scopes (scope_key, profile_id, agent, verified) VALUES (?, 'c1', 'codex', 1)").run(key).lastInsertRowid);
  const put = (sc: number, limit: string, at: number) => s.db.prepare(`INSERT INTO usage_history (schema_version, usage_scope_id, limit_id, kind, minute, used_percent, window_minutes,
    first_observed_at, observed_at, measured_at, source, source_locator) VALUES (1, ?, ?, 'sample', ?, 1, 300, ?, ?, ?, 'rollout', 'x')`).run(sc, limit, Math.floor(at / 60_000), at, at, at);
  let expired = 0;
  for (const key of ['acct-a', 'acct-b']) {
    const sc = scope(key);
    for (const limit of ['codex:primary', 'codex:secondary']) {
      const n = key === 'acct-a' && limit === 'codex:primary' ? 501 : 2;
      for (let i = 0; i < n; i++) put(sc, limit, NOW - 46 * DAY - i * 60_000);
      put(sc, limit, NOW - 44 * DAY);
      expired += n;
    }
  }
  assert.equal((await s.retain()).quota, expired);
  assert.equal(Number((s.db.prepare('SELECT count(*) AS n FROM usage_history').get() as { n: number }).n), 4, 'one live row per stream');
  assert.equal(Number((s.db.prepare('SELECT count(*) AS n FROM usage_history WHERE measured_at <= ?').get(NOW - 45 * DAY) as { n: number }).n), 0);
});

// review M2/M3: the writer's guard. Readings at the cutoff (last run - 45 x 24 h) and before are refused, after it kept;
// no recorded run, an unreadable value or a run time in the future (a clock that was set ahead) refuses nothing.
test('EC-99: the re-insert guard: exact cutoff, no run, unreadable value, a last run in the future', async () => {
  const counts = [{ day: 0, min: 1439, used: 1 }, { day: 1, min: 0, used: 2 }, { day: 1, min: 1, used: 3 }];
  for (const [last, kept] of [[String(at(46, 0)), [3]], [null, [1, 2, 3]], ['x', [1, 2, 3]], [String(Date.now() + 100 * DAY), [1, 2, 3]]] as const) {
    const s = await quotaStore();
    if (last !== null) s.db.prepare("INSERT INTO kv (key, value) VALUES ('retention.lastRunAt', ?)").run(last);
    s.write(sid(8), rollout(sid(8), 'acct-1', counts), at(1, 1));
    await s.ingest();
    assert.deepEqual(history(s.db).map((h) => h.used), kept, `last run ${last}`);
  }
});
