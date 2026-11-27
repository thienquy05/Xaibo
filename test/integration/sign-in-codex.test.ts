// XAIBO-PROD-573 (P6-T01a slice 4; S-38, FR-54, EC-109; design .handoff/p6-t01a-design.md "Evaluator and production
// wiring", security review of slice 4): Codex rollout sign-in evidence through the real adapter and writer. The bundled
// catalog ships no rule, so production stays Unknown; synthetic rules (exact version, plan literal) exercise the path.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { changeSignIn, effectiveMethod, readSignIn } from '../../src/service/usage/sign-in-state.ts';
import type { MethodRule } from '../../src/service/usage/sign-in.ts';

const PID = '00000000-0000-4000-8000-0000000c5301';
const sid = (n: number) => '00000000-0000-4000-8000-0000000c53' + String(n).padStart(2, '0');
const rule = (id: string, plan: string, method: MethodRule['method'], version = '0.160.0'): MethodRule => ({ id, source: 'codex-rollout', version,
  record: { type: 'event_msg', 'payload.type': 'token_count' }, field: 'payload.rate_limits.plan_type', test: { oneOf: [plan] }, method });
const RULES = [rule('syn-plan-subscription', 'synthplus', 'subscription'), rule('syn-plan-key', 'synthkey', 'api-key')];
const MIN = 60_000;
const NOW = Math.floor(Date.now() / MIN) * MIN;

function line(t: number, plan: string, i: number): string {
  const u = { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 120 * (i + 1) };
  return JSON.stringify({ timestamp: new Date(t).toISOString(), type: 'event_msg', payload: { type: 'token_count',
    info: { total_token_usage: u, last_token_usage: { ...u, total_tokens: 120 }, model_context_window: 200000 },
    rate_limits: { limit_id: 'codex', plan_type: plan, primary: { used_percent: 10 + i, window_minutes: 300, resets_at: Math.floor(t / 1000) + 3600 } } } }) + '\n';
}
function rollout(id: string, version: string, recs: [number, string][]): string {
  const meta = JSON.stringify({ timestamp: new Date(recs[0]![0]).toISOString(), type: 'session_meta', payload: { id, timestamp: new Date(recs[0]![0]).toISOString(),
    cwd: '/tmp/xaibo-fixture/alpha', originator: 'codex-tui', cli_version: version, source: 'cli' } }) + '\n';
  return meta + recs.map(([t, plan], i) => line(t, plan, i)).join('');
}

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
async function setup(rules: MethodRule[] | null = RULES) { // null: the production default (no rule passed)
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'xsic-')));
  dirs.push(d);
  const s = await openStore({ file: join(d, 'data', 'xaibo.db'), backupDir: join(d, 'data', 'b') });
  const root = join(d, 'home', '.codex');
  const day = join(root, 'sessions', '2026', '01', '01');
  mkdirSync(day, { recursive: true });
  s.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES (?, 'codex', ?, 'manual')").run(PID, root);
  const writer = new Writer(s.db);
  const file = (n: number) => join(day, 'rollout-2026-01-01T00-00-00-' + sid(n) + '.jsonl');
  const ingest = async () => {
    const a = new CodexAdapter({ db: s.db, writer, profileId: PID, root, intervalMs: 60_000, ...(rules ? { signInRules: rules } : {}) });
    await a.start(); a.stop();
  };
  const scopes = () => s.db.prepare('SELECT s.sign_in_generation AS g, count(h.id) AS n FROM usage_scopes s LEFT JOIN usage_history h ON h.usage_scope_id = s.id GROUP BY s.id ORDER BY g')
    .all().map((x) => ({ ...x }));
  return { d, db: s.db, writer, root, day, file, ingest, scopes };
}

test('the bundled catalog ships no rule: a Codex profile stays Unknown whatever its plan says', async () => {
  const s = await setup(null);
  writeFileSync(s.file(1), rollout(sid(1), '0.160.0', [[NOW - 10 * MIN, 'synthplus']]));
  await s.ingest();
  assert.equal(effectiveMethod(readSignIn(s.db, PID)), 'unknown');
  assert.equal((s.db.prepare('SELECT count(*) AS n FROM profile_sign_in').get() as { n: number }).n, 0);
});

test('exact version and plan literal give the method; the triggering reading shares the new generation', async () => {
  const s = await setup();
  writeFileSync(s.file(1), rollout(sid(1), '0.160.0', [[NOW - 20 * MIN, 'pro'], [NOW - 10 * MIN, 'synthplus']]));
  await s.ingest();
  const st = readSignIn(s.db, PID);
  assert.deepEqual([effectiveMethod(st), st.generation, st.boundaryAt, st.evidence?.sourceAt, st.evidence?.ruleId, st.evidence?.version],
    ['subscription', 1, NOW - 10 * MIN, NOW - 10 * MIN, 'syn-plan-subscription', '0.160.0']);
  assert.deepEqual(s.scopes(), [{ g: 0, n: 1 }, { g: 1, n: 1 }]);
});

test('another version never matches', async () => {
  const s = await setup();
  writeFileSync(s.file(1), rollout(sid(1), '0.161.0', [[NOW - 10 * MIN, 'synthplus']]));
  await s.ingest();
  assert.equal(effectiveMethod(readSignIn(s.db, PID)), 'unknown');
});

test('after a checkpoint restart the version is unknown until the next session_meta (review H2); replay, older records and an archive move change nothing', async () => {
  const s = await setup();
  writeFileSync(s.file(1), rollout(sid(1), '0.160.0', [[NOW - 20 * MIN, 'synthplus']]));
  await s.ingest();
  appendFileSync(s.file(1), line(NOW - 5 * MIN, 'synthkey', 1)); // a new adapter resumes after the checkpoint: no session_meta in what it reads
  await s.ingest();
  const st = readSignIn(s.db, PID);
  assert.deepEqual([effectiveMethod(st), st.generation], ['subscription', 1], 'no version, no evidence');
  await s.ingest(); // replay
  writeFileSync(s.file(2), rollout(sid(2), '0.160.0', [[NOW - 30 * MIN, 'synthplus']])); // an older rollout imported late
  await s.ingest();
  mkdirSync(join(s.root, 'archived_sessions'), { recursive: true });
  renameSync(s.file(1), join(s.root, 'archived_sessions', 'rollout-2026-01-01T00-00-00-' + sid(1) + '.jsonl'));
  await s.ingest();
  const again = readSignIn(s.db, PID);
  assert.deepEqual([effectiveMethod(again), again.generation, again.revision, again.evidence], ['subscription', 1, st.revision, st.evidence]);
});

test('a later session_meta switches the version for the records after it (review H2)', async () => {
  const s = await setup();
  const meta = (v: string, t: number) => JSON.stringify({ timestamp: new Date(t).toISOString(), type: 'session_meta', payload: { id: sid(1), timestamp: new Date(t).toISOString(), cwd: '/tmp/xaibo-fixture/alpha', originator: 'codex-tui', cli_version: v, source: 'cli' } }) + '\n';
  writeFileSync(s.file(1), rollout(sid(1), '0.160.0', [[NOW - 20 * MIN, 'synthplus']]) + meta('0.161.0', NOW - 15 * MIN) + line(NOW - 10 * MIN, 'synthkey', 1));
  await s.ingest();
  const st = readSignIn(s.db, PID);
  assert.deepEqual([effectiveMethod(st), st.evidence?.version], ['subscription', '0.160.0'], 'the 0.161.0 record has no rule');
});

test('evidence older than the latest boundary never overrides a newer owner decision (review M2)', async () => {
  const s = await setup();
  s.writer.transact((db) => changeSignIn(db, PID, { kind: 'declare', method: 'gateway' }, NOW - 5 * MIN, 0));
  s.writer.transact((db) => changeSignIn(db, PID, { kind: 'clear' }, NOW - 4 * MIN, 1));
  writeFileSync(s.file(1), rollout(sid(1), '0.160.0', [[NOW - 10 * MIN, 'synthplus']]));
  await s.ingest();
  assert.deepEqual([effectiveMethod(readSignIn(s.db, PID)), readSignIn(s.db, PID).evidence], ['unknown', null]);
});

test('an epoch from backfilled evidence starts at the newest stored reading, so stored history is never split (slice-4 review H1)', async () => {
  const s = await setup();
  writeFileSync(s.file(1), rollout(sid(1), '0.160.0', [[NOW - 5 * MIN, 'pro']])); // a newer reading stored first
  await s.ingest();
  writeFileSync(s.file(2), rollout(sid(2), '0.160.0', [[NOW - 20 * MIN, 'synthplus']])); // an older rollout imported late
  await s.ingest();
  const st = readSignIn(s.db, PID);
  assert.deepEqual([effectiveMethod(st), st.generation, st.boundaryAt], ['subscription', 1, NOW - 5 * MIN]);
  assert.deepEqual(s.db.prepare('SELECT sign_in_generation AS g FROM usage_scopes ORDER BY id').all().map((x) => ({ ...x })), [{ g: 0 }, { g: 1 }], 'the stored reading stays; the trigger is in the new epoch');
});

test('under a declaration, evidence is kept but starts no epoch', async () => {
  const s = await setup();
  s.writer.transact((db) => changeSignIn(db, PID, { kind: 'declare', method: 'gateway' }, NOW - 60 * MIN, 0));
  writeFileSync(s.file(1), rollout(sid(1), '0.160.0', [[NOW - 10 * MIN, 'synthplus']])); // newer than the declaration's boundary
  await s.ingest();
  const st = readSignIn(s.db, PID);
  assert.deepEqual([effectiveMethod(st), st.generation, st.evidence?.method], ['gateway', 1, 'subscription']);
});

test('disagreeing rules make the evidence ambiguous: no method, no epoch', async () => {
  const s = await setup([...RULES, rule('syn-plan-other', 'synthplus', 'gateway')]);
  writeFileSync(s.file(1), rollout(sid(1), '0.160.0', [[NOW - 20 * MIN, 'synthkey'], [NOW - 10 * MIN, 'synthplus']]));
  await s.ingest();
  const st = readSignIn(s.db, PID);
  assert.deepEqual([st.evidence?.method, st.evidence?.ambiguous, effectiveMethod(st), st.generation], ['api-key', true, 'unknown', 1]);
});
