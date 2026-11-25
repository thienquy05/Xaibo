// XAIBO-PROD-571 (P6-T01a slice 2; S-38, FR-54, EC-109; design .handoff/p6-t01a-design.md, security review 3636):
// migration 027, sign-in state through trusted service functions (revision checks, atomicity, restart) and usage epochs
// through the real ingest paths: readings land in the generation of their trusted source time, a live statusLine reading
// in the generation current when it arrived; scopes split by generation, never merge, verification never changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { loadMigrations, openStore, schemaSnapshot } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { accountMarker } from '../../src/service/usage/snapshots.ts';
import { changeSignIn, emptySignIn, MAX_BOUNDARIES, readSignIn } from '../../src/service/usage/sign-in-state.ts';
import { envelope, hookStore, SESSION } from '../helpers/hook-store.ts';

const SALT = Buffer.alloc(32, 7);
const sid = (n: number) => '00000000-0000-4000-8000-0000000c27' + String(n).padStart(2, '0');
const dir = () => realpathSync(mkdtempSync(join(tmpdir(), 'xsi-')));
const count = (db: { prepare(s: string): { get(...a: unknown[]): unknown } }, sql: string) => (db.prepare(sql).get() as { n: number }).n;

test('027: existing profiles read Unknown with no invented times; existing scope keys unchanged; schema.sql matches', async () => {
  const d = dir();
  const opts = { file: join(d, 'xaibo.db'), backupDir: join(d, 'backups') };
  const before = await openStore({ ...opts, migrations: loadMigrations().filter((m) => m.version < 27) });
  before.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('c1', 'codex', '/tmp/xaibo-fixture/c1', 'manual')").run();
  const key = JSON.stringify(['c1', 'codex', 'marker', null]);
  before.db.prepare("INSERT INTO usage_scopes (scope_key, profile_id, agent, epoch, session_id, verified) VALUES (?, 'c1', 'codex', 'marker', NULL, 1)").run(key);
  assert.deepEqual(readSignIn(before.db, 'c1'), emptySignIn(), 'before 027 (or on a newer-schema probe without the table): Unknown');
  before.db.close();
  const s = await openStore(opts);
  assert.equal(s.readOnly, false);
  assert.deepEqual(s.db.prepare('SELECT scope_key, sign_in_generation FROM usage_scopes').all().map((r) => ({ ...r })), [{ scope_key: key, sign_in_generation: 0 }]);
  assert.deepEqual(readSignIn(s.db, 'c1'), emptySignIn());
  assert.equal(count(s.db, 'SELECT count(*) AS n FROM profile_sign_in'), 0, 'lazy rows: nothing invented');
  assert.equal(schemaSnapshot(s.db), readFileSync(new URL('../../src/service/store/schema.sql', import.meta.url), 'utf8'));
});

async function store() {
  const d = dir();
  const opts = { file: join(d, 'xaibo.db'), backupDir: join(d, 'backups') };
  const s = await openStore(opts);
  s.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('c1', 'codex', ?, 'manual')").run(join(d, 'c1', '.codex'));
  return { d, opts, db: s.db, writer: new Writer(s.db) };
}

test('readSignIn treats only a missing table as Unknown; any other store error is rethrown (code review M2)', () => {
  const failing = { prepare: () => { throw new Error('disk I/O error'); } } as unknown as Parameters<typeof readSignIn>[0];
  assert.throws(() => readSignIn(failing, 'c1'), /disk I\/O error/);
});

test('declarations persist across a restart with service-assigned times; the same declaration is a no-op', async () => {
  const s = await store();
  const r1 = s.writer.transact((db) => changeSignIn(db, 'c1', { kind: 'declare', method: 'api-key' }, 1_000, 0));
  assert.equal(r1.code, 'ok');
  assert.deepEqual([r1.state.revision, r1.state.declaration], [1, { method: 'api-key', at: 1_000 }]);
  const r2 = s.writer.transact((db) => changeSignIn(db, 'c1', { kind: 'declare', method: 'api-key' }, 2_000, 1));
  assert.deepEqual([r2.code, r2.state.revision, r2.state.declaration?.at], ['ok', 1, 1_000]);
  s.db.close();
  const again = await openStore(s.opts);
  assert.deepEqual(readSignIn(again.db, 'c1'), r1.state);
});

test('revision checks: stale, a replayed lost reply and a second first write never apply twice (review M3)', async () => {
  const s = await store();
  const first = s.writer.transact((db) => changeSignIn(db, 'c1', { kind: 'account-change' }, 1_000, 0));
  assert.equal(first.code, 'ok');
  const replay = s.writer.transact((db) => changeSignIn(db, 'c1', { kind: 'account-change' }, 1_001, 0));
  assert.deepEqual([replay.code, replay.state], ['stale', first.state]);
  assert.equal(count(s.db, 'SELECT count(*) AS n FROM sign_in_boundaries'), 1, 'a retried account change adds no second epoch');
  assert.equal(s.writer.transact((db) => changeSignIn(db, 'c1', { kind: 'clear' }, 1_002, 7)).code, 'stale');
  assert.equal(s.writer.transact((db) => changeSignIn(db, 'nope', { kind: 'declare', method: 'gateway' }, 1_003, 0)).code, 'profile-not-found');
  assert.equal(count(s.db, "SELECT count(*) AS n FROM profile_sign_in WHERE profile_id = 'nope'"), 0);
});

test('a failing transaction leaves state and boundaries unchanged', async () => {
  const s = await store();
  assert.throws(() => s.writer.transact((db) => { changeSignIn(db, 'c1', { kind: 'declare', method: 'subscription' }, 1_000, 0); throw new Error('injected'); }), /injected/);
  assert.deepEqual(readSignIn(s.db, 'c1'), emptySignIn());
  assert.equal(count(s.db, 'SELECT count(*) AS n FROM sign_in_boundaries'), 0);
});

test('boundaries hold only opaque fields and stop at the cap (review H2, L5)', async () => {
  const s = await store();
  let rev = 0;
  for (let i = 0; i < MAX_BOUNDARIES; i++) rev = s.writer.transact((db) => changeSignIn(db, 'c1', { kind: 'account-change' }, 1_000 + i, rev)).state.revision;
  assert.equal(s.writer.transact((db) => changeSignIn(db, 'c1', { kind: 'account-change' }, 9_000, rev)).code, 'limit');
  const cols = (s.db.prepare("SELECT name FROM pragma_table_info('sign_in_boundaries') ORDER BY cid").all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols, ['profile_id', 'generation', 'revision', 'at', 'reason', 'method']);
  assert.equal(count(s.db, 'SELECT count(*) AS n FROM sign_in_boundaries'), MAX_BOUNDARIES);
});

function rollout(id: string, at: number[]): string {
  const iso = (t: number) => new Date(t).toISOString();
  const meta = { id, timestamp: iso(at[0]!), cwd: '/tmp/xaibo-fixture/alpha', originator: 'codex-tui', cli_version: '0.160.0', source: 'cli', creator_account_id: 'acct-synthetic' };
  const lines: unknown[] = [{ timestamp: iso(at[0]!), type: 'session_meta', payload: meta }];
  let total = 0;
  at.forEach((t, i) => {
    total += 120;
    const u = { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: total };
    lines.push({ timestamp: iso(t), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u, last_token_usage: { ...u, total_tokens: 120 }, model_context_window: 200000 },
      rate_limits: { limit_id: 'codex', plan_type: 'pro', primary: { used_percent: 10 + i, window_minutes: 300, resets_at: Math.floor(t / 1000) + 3600 } } } });
  });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
const SCOPES = 'SELECT s.scope_key, s.sign_in_generation AS g, s.verified, s.epoch, count(h.id) AS n FROM usage_scopes s '
  + 'LEFT JOIN usage_history h ON h.usage_scope_id = s.id GROUP BY s.id ORDER BY s.sign_in_generation';

test('Codex readings land in the epoch of their source time; scopes split by generation, stay verified, never merge', async () => {
  const s = await store();
  const root = join(s.d, 'c1', '.codex');
  const day = join(root, 'sessions', '2026', '01', '01');
  mkdirSync(day, { recursive: true });
  const ingest = async () => { const a = new CodexAdapter({ db: s.db, writer: s.writer, profileId: 'c1', root, intervalMs: 60_000, accountSalt: SALT }); await a.start(); a.stop(); };
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  writeFileSync(join(day, 'rollout-2026-01-01T00-00-00-' + sid(1) + '.jsonl'), rollout(sid(1), [now - 20 * 60_000, now - 19 * 60_000]));
  await ingest();
  const r = s.writer.transact((db) => changeSignIn(db, 'c1', { kind: 'declare', method: 'subscription' }, now, 0));
  assert.equal(r.state.generation, 1);
  writeFileSync(join(day, 'rollout-2026-01-01T00-00-00-' + sid(2) + '.jsonl'), rollout(sid(2), [now - 10 * 60_000, now + 60_000])); // one lagged, one after
  await ingest();
  const marker = accountMarker(SALT, 'acct-synthetic');
  assert.deepEqual(s.db.prepare(SCOPES).all().map((x) => ({ ...x })), [
    { scope_key: JSON.stringify(['c1', 'codex', marker, null]), g: 0, verified: 1, epoch: marker, n: 3 },
    { scope_key: JSON.stringify(['c1', 'codex', marker, null, 1]), g: 1, verified: 1, epoch: marker, n: 1 },
  ]);
  await ingest(); // restart: the same records replayed add nothing and change no state
  assert.equal(count(s.db, 'SELECT count(*) AS n FROM usage_history'), 4);
  assert.deepEqual(readSignIn(s.db, 'c1'), r.state);
});

test('Claude statusLine readings after a declared account change go to a new per-session scope; earlier ones stay (review M4)', async () => {
  const h = await hookStore();
  const tee = (used: number) => h.intake.deliver(envelope({ event: 'statusline', cwd: null, payload: { session_id: SESSION,
    rate_limits: { five_hour: { used_percentage: used, resets_at: 1767243600 } } } }));
  await tee(10);
  h.writer.transact((db) => changeSignIn(db, 'p1', { kind: 'account-change' }, Date.now(), 0));
  await tee(20);
  const q = 'SELECT s.scope_key, s.sign_in_generation AS g, s.verified, max(h.used_percent) AS used FROM usage_scopes s '
    + 'JOIN usage_history h ON h.usage_scope_id = s.id GROUP BY s.id ORDER BY s.sign_in_generation';
  assert.deepEqual(h.db.prepare(q).all().map((x) => ({ ...x })), [
    { scope_key: JSON.stringify(['p1', 'claude', null, SESSION]), g: 0, verified: 0, used: 10 },
    { scope_key: JSON.stringify(['p1', 'claude', null, SESSION, 1]), g: 1, verified: 0, used: 20 },
  ]);
  assert.deepEqual((h.db.prepare("SELECT sign_in_generation AS g FROM events WHERE source = 'statusline' ORDER BY id").all() as { g: number }[]).map((x) => x.g), [0, 1]);
});
