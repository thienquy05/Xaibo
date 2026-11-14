// XAIBO-PROD-319 (P3-T15, EC-91, EC-92, PRD §5.11/§5.12, FR-46..FR-48): usage history through the real ingest paths.
// Codex rollouts backfill timestamped samples, at most one ordinary sample per UTC minute per scope and stream (latest
// kept), reset changes as transitions, nothing interpolated across a sleep gap, nothing added by a restart. Sessions of
// one account (same salted marker) share a scope inside a profile only. Claude tee snapshots: per-session unverified
// scope, an unchanged re-emission keeps its first observation, context from the reported window, the reported session
// cost replaces the token-table total. agy reports an explicit "Unavailable from passive sources" status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { captureRecord } from '../../src/forwarder/statusline-tee.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { sessionCost } from '../../src/service/usage/cost.ts';
import { usageStatusList } from '../../src/service/usage/snapshots.ts';
import { count } from '../helpers/claude-profile.ts';
import { envelope, hookStore, SESSION } from '../helpers/hook-store.ts';

const SALT = Buffer.alloc(32, 7);
const iso = (min: number, sec = 0) => new Date(Date.UTC(2026, 0, 1, 0, min, sec)).toISOString();
const RESET = Date.UTC(2026, 0, 1, 5, 0, 0) / 1000;
const sid = (n: number) => `00000000-0000-4000-8000-0000000c15${String(n).padStart(2, '0')}`;

/** `used: null` writes `primary: null` (the window became unavailable). */
function rollout(id: string, account: string | null, counts: { min: number; sec?: number; used: number | null; reset?: number }[]): string {
  const meta = { id, timestamp: iso(0), cwd: '/tmp/xaibo-fixture/alpha', originator: 'codex-tui', cli_version: '0.160.0', source: 'cli',
    ...(account ? { creator_account_id: account } : {}) };
  const lines: unknown[] = [{ timestamp: iso(0), type: 'session_meta', payload: meta }];
  let total = 0;
  for (const c of counts) {
    total += 120;
    const u = { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: total };
    lines.push({ timestamp: iso(c.min, c.sec), type: 'event_msg', payload: { type: 'token_count',
      info: { total_token_usage: u, last_token_usage: { ...u, total_tokens: 120 }, model_context_window: 200000 },
      rate_limits: { limit_id: 'codex', plan_type: 'pro', primary: c.used === null ? null : { used_percent: c.used, window_minutes: 300, resets_at: c.reset ?? RESET } } } });
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

async function codexStore() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xuh-')));
  const store = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'backups') });
  const db = store.db;
  const profile = (id: string) => {
    const root = join(tmp, id, '.codex');
    mkdirSync(join(root, 'sessions', '2026', '01', '01'), { recursive: true });
    db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES (?, 'codex', ?, 'manual')").run(id, root);
    return {
      root,
      write: (id: string, text: string) => writeFileSync(join(root, 'sessions', '2026', '01', '01', `rollout-2026-01-01T00-00-00-${id}.jsonl`), text),
    };
  };
  const ingest = async (id: string, root: string) => {
    const a = new CodexAdapter({ db, writer: new Writer(db), profileId: id, root, intervalMs: 60_000, accountSalt: SALT });
    await a.start();
    a.stop();
  };
  return { db, profile, ingest };
}

type H = { stream: string; kind: string; used: number | null; minute: number; as_of: number | null };
const history = (db: DatabaseSync) => db.prepare(`SELECT h.limit_id AS stream, h.kind, h.used_percent AS used, h.minute, h.as_of FROM usage_history h
  ORDER BY h.measured_at, h.id`).all() as H[];

test('Codex backfill: one sample per UTC minute (latest kept), a reset change is a transition, no interpolation, restart adds nothing', async () => {
  const s = await codexStore();
  const p = s.profile('c1');
  p.write(sid(1), rollout(sid(1), null, [
    { min: 1, sec: 5, used: 10 }, { min: 1, sec: 50, used: 11 }, // same minute: the latest stays
    { min: 2, used: 12 },
    { min: 190, used: 3, reset: RESET + 5 * 3600 }, // after a 3 h sleep gap, a new window: transition, nothing between
  ]));
  await s.ingest('c1', p.root);
  const h = history(s.db);
  assert.deepEqual(h.map((r) => [r.stream, r.kind, r.used]), [['codex:primary', 'sample', 11], ['codex:primary', 'sample', 12], ['codex:primary', 'transition', 3]]);
  assert.deepEqual(h.map((r) => r.as_of), [Date.parse(iso(1, 50)), Date.parse(iso(2)), Date.parse(iso(190))], 'source time kept per reading');
  await s.ingest('c1', p.root); // restart: the same records replayed
  assert.equal(history(s.db).length, 3);
});

test('review M1: an older reading backfilled after a newer one reclassifies the next row; a stale same-minute reading never overwrites', async () => {
  const s = await codexStore();
  const account = `acct-${crypto.randomUUID()}`;
  const p = s.profile('c1');
  p.write(sid(6), rollout(sid(6), account, [{ min: 10, used: 50, reset: RESET + 5 * 3600 }])); // newest first: no previous row
  await s.ingest('c1', p.root);
  p.write(sid(7), rollout(sid(7), account, [{ min: 1, sec: 5, used: 10 }, { min: 1, sec: 50, used: 11 }])); // older window, read later
  await s.ingest('c1', p.root);
  p.write(sid(8), rollout(sid(8), account, [{ min: 1, sec: 20, used: 99, reset: RESET + 9 * 3600 }])); // stale in a filled minute
  await s.ingest('c1', p.root);
  assert.deepEqual(history(s.db).map((r) => [r.kind, r.used]), [['sample', 11], ['transition', 50]]);
});

test('EC-92: sessions with the same account marker share one verified scope; another profile or no marker stays separate', async () => {
  const s = await codexStore();
  const account = `acct-${crypto.randomUUID()}`; // runtime value, never stored raw
  const a = s.profile('c1');
  a.write(sid(2), rollout(sid(2), account, [{ min: 1, used: 20 }]));
  a.write(sid(3), rollout(sid(3), account, [{ min: 5, used: 25 }]));
  a.write(sid(4), rollout(sid(4), null, [{ min: 6, used: 25 }]));
  const b = s.profile('c2');
  b.write(sid(5), rollout(sid(5), account, [{ min: 1, used: 20 }]));
  await s.ingest('c1', a.root);
  await s.ingest('c2', b.root);
  const scopes = s.db.prepare('SELECT profile_id AS p, verified AS v, epoch IS NOT NULL AS e, session_id IS NOT NULL AS perSession FROM usage_scopes ORDER BY profile_id, verified').all()
    .map((r) => ({ ...r }));
  assert.deepEqual(scopes, [{ p: 'c1', v: 0, e: 0, perSession: 1 }, { p: 'c1', v: 1, e: 1, perSession: 0 }, { p: 'c2', v: 1, e: 1, perSession: 0 }]);
  assert.equal(count(s.db, 'SELECT count(*) FROM usage_scopes WHERE epoch = ?', account), 0);
  const list = usageStatusList(s.db, Date.parse(iso(7)));
  const c1 = list.find((x) => x.profileId === 'c1' && x.verified);
  assert.equal(c1?.status.usedPercent, 25, 'newest eligible measurement within the scope');
  assert.equal(c1?.status.state, 'current');
});

test('Claude tee: per-session unverified scope; unchanged re-emission keeps its first observation; context and reported cost', async () => {
  let now = Date.parse(iso(10));
  const h = await hookStore({ intake: { now: () => now } });
  const tee = (payload: Record<string, unknown>) => h.intake.deliver(envelope({ event: 'statusline', cwd: null, payload: { session_id: SESSION, ...payload } }));
  const snap = { model: { id: 'claude-opus-5-5' }, cost: { total_cost_usd: 0.5 },
    context_window: { context_window_size: 200000, current_usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 70 } },
    rate_limits: { five_hour: { used_percentage: 40, resets_at: RESET }, seven_day: { used_percentage: 101 } } };
  await tee(snap);
  now += 30 * 60_000;
  await tee({ ...snap, effort: { level: 'high' } }); // a new snapshot, same rate limits: not a newer measurement
  const rows = h.db.prepare('SELECT limit_id AS stream, used_percent AS used, as_of, first_observed_at AS first FROM usage_history ORDER BY limit_id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { stream: 'five_hour', used: 40, as_of: null, first: Date.parse(iso(10)) },
    { stream: 'seven_day', used: 101, as_of: null, first: Date.parse(iso(10)) },
  ]);
  const [st] = usageStatusList(h.db, now).filter((x) => x.stream === 'five_hour');
  assert.equal(st?.verified, false);
  assert.equal(st?.status.state, 'stale', 'age counts from the first observation');
  assert.equal(st?.status.label, `Source time unknown; observed ${iso(10)}`);
  const ctx = h.db.prepare("SELECT used_tokens AS used, window_tokens AS window, window_basis AS basis, source FROM context_snapshots").all().map((r) => ({ ...r }));
  assert.deepEqual(ctx, [{ used: 100, window: 200000, basis: 'reported', source: 'statusline' }]);
  const session = (h.db.prepare('SELECT id FROM sessions WHERE native_session_id = ?').get(SESSION) as { id: number }).id;
  h.db.prepare(`INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, amount_usd, basis, coverage)
    VALUES (?, 1, 'transcript', 'usage:transcript:m1', 2, 'token_table', '{"coverage":"full"}')`).run(session);
  assert.deepEqual(sessionCost(h.db, session), { amountUsd: 0.5, basis: 'agent_reported', coverage: 'full', opaqueExcluded: false }, 'replaces, never adds');
});

test('G3e-1 (EC-91): a Claude window that turns null through the tee and intake is shown unavailable, not the old value', async () => {
  let now = Date.parse(iso(10));
  const h = await hookStore({ intake: { now: () => now } });
  const tee = (rl: Record<string, unknown>) => h.intake.deliver(envelope({ event: 'statusline', cwd: null,
    payload: captureRecord({ session_id: SESSION, rate_limits: rl })! }));
  await tee({ five_hour: { used_percentage: 40, resets_at: RESET } });
  now += 60_000;
  await tee({ five_hour: null });
  const [st] = usageStatusList(h.db, now).filter((x) => x.stream === 'five_hour');
  assert.equal(st?.status.usedPercent, null);
  assert.equal(st?.status.measuredAt, now, 'measured at the observation of the gap');
});

test('G3e-1: a Codex window that turns null is a new all-null measurement, not the old value', async () => {
  const s = await codexStore();
  const p = s.profile('c1');
  p.write(sid(9), rollout(sid(9), null, [{ min: 1, used: 40 }, { min: 2, used: null }]));
  await s.ingest('c1', p.root);
  const [st] = usageStatusList(s.db, Date.parse(iso(3))).filter((x) => x.stream === 'codex:primary');
  assert.equal(st?.status.usedPercent, null);
  assert.equal(st?.status.measuredAt, Date.parse(iso(2)));
});

test('agy: an explicit unavailable usage status per profile (FR-46)', async () => {
  const h = await hookStore();
  h.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('g1', 'agy', '/tmp/xaibo-fixture/agy', 'default')").run();
  const agy = usageStatusList(h.db, 0).filter((x) => x.agent === 'agy');
  assert.deepEqual(agy.map((x) => [x.profileId, x.stream, x.status.state, x.status.label]), [['g1', null, 'unavailable', 'Unavailable from passive sources']]);
});
