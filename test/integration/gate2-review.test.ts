// XAIBO-PROD-215: Gate 2 review fixes (Codex + Claude review of 524279f, decisions 335/336). Each test names its finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AgyAdapter } from '../../src/service/adapters/agy/index.ts';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { openStore } from '../../src/service/store/db.ts';
import { commitBatch, Writer, type Batch, type EventRow } from '../../src/service/store/writer.ts';
import { priceUsage } from '../../src/service/usage/cost.ts';
import { loadPrices } from '../../src/service/usage/prices.ts';
import { claudeProfile, count, FIXTURES } from '../helpers/claude-profile.ts';

const near = (a: unknown, b: number) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-12, `${String(a)} != ${b}`);
const CODEX_SID = '00000000-0000-4000-8000-0000000c0915';
const ts = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;
const usageObj = (input: number, cached: number, output: number) =>
  ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });

/** A minimal Codex 0.160.0 rollout (fixture shapes) written line by line. */
function rollout(tmp: string) {
  const root = join(tmp, 'codex');
  const dir = join(root, 'sessions', '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-01-01T00-00-00-${CODEX_SID}.jsonl`);
  let ord = 0;
  const put = (s: number, type: string, payload: object) => appendFileSync(file, `${JSON.stringify({ timestamp: ts(s), ordinal: ord++, type, payload })}\n`);
  return {
    root, file,
    meta: (s: number, extra: object = {}) => put(s, 'session_meta', { id: CODEX_SID, timestamp: ts(s), cwd: '/tmp/xaibo-fixture/g2', originator: 'codex-tui', cli_version: '0.160.0', source: 'cli', ...extra }),
    turn: (s: number, id: string) => {
      put(s, 'turn_context', { turn_id: id, root_turn_id: id, cwd: '/tmp/xaibo-fixture/g2', model: 'gpt-6.1-sol', collaboration_mode: { mode: 'default', settings: { model: 'gpt-6.1-sol', reasoning_effort: null } } });
      put(s + 1, 'event_msg', { type: 'task_started', turn_id: id, started_at: 0, model_context_window: 200000 });
    },
    tokens: (s: number, total: object, last: object) => put(s, 'event_msg', { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 200000 } }),
    settings: (s: number, tier: string) => put(s, 'event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.1-sol', service_tier: tier } }),
  };
}
async function codexStore() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xg2-')));
  const store = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'b') });
  const writer = new Writer(store.db);
  const r = rollout(tmp);
  store.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', ?, 'default')").run(r.root);
  const run = async () => { const a = new CodexAdapter({ db: store.db, writer, profileId: 'p2', root: r.root, intervalMs: 60_000 }); await a.start(); a.stop(); };
  return { tmp, db: store.db, r, run };
}
const estimates = (db: DatabaseSync) => db.prepare('SELECT covered_scope AS scope, amount_usd AS amount, unavailable_reason AS reason, price_revision_id AS rev FROM cost_estimates ORDER BY covered_scope')
  .all().map((x) => ({ ...x }) as { scope: string; amount: number | null; reason: string | null; rev: number | null });

test('G2-1: stored Codex session_meta keeps no account identifiers', async () => {
  const s = await codexStore();
  s.r.meta(0, { creator_account_id: 'acct-CANARY-G2', creator_user_id: 'user-CANARY-G2' });
  await s.run();
  assert.equal(count(s.db, "SELECT count(*) FROM events WHERE raw LIKE '%CANARY-G2%' OR content LIKE '%CANARY-G2%'"), 0);
  assert.equal(count(s.db, "SELECT count(*) FROM events WHERE kind = 'session' AND raw LIKE '%cli_version%'"), 1, 'the rest of the record is kept');
});

test('G2-3: a zero cumulative reading starts a new counter segment (1000 -> 0 -> 1500 = 2500)', async () => {
  const s = await codexStore();
  s.r.meta(0);
  s.r.turn(1, '00000000-0000-4000-8000-0000000c1915');
  s.r.tokens(3, usageObj(800, 0, 200), usageObj(800, 0, 200));
  s.r.tokens(4, usageObj(0, 0, 0), usageObj(0, 0, 0));
  s.r.tokens(5, usageObj(1200, 0, 300), usageObj(1200, 0, 300));
  await s.run();
  const seg = s.db.prepare("SELECT segment, json_extract(raw, '$.total_tokens') AS total FROM usage WHERE scope = 'session' ORDER BY segment").all().map((x) => ({ ...x }));
  assert.deepEqual(seg, [{ segment: 0, total: 1000 }, { segment: 1, total: 1500 }]);
});

test('G2-2/G2-11: Codex requests use the tier in effect; a later settings event re-prices earlier requests', async () => {
  const s = await codexStore();
  s.r.meta(0);
  s.r.settings(1, 'default');
  s.r.turn(2, '00000000-0000-4000-8000-0000000c1916');
  s.r.tokens(5, usageObj(1000, 600, 200), usageObj(1000, 600, 200));
  s.r.settings(6, 'priority');
  s.r.turn(7, '00000000-0000-4000-8000-0000000c1917');
  s.r.tokens(10, usageObj(2400, 1200, 400), usageObj(1400, 600, 200));
  await s.run();
  const prices = loadPrices({ db: s.db, overridePath: join(s.tmp, 'none.json') });
  priceUsage(s.db, prices);
  const e = estimates(s.db);
  near(e[0]!.amount, (400 * 2 + 600 * 0.1 + 200 * 10) / 1e6); // default tier in effect
  assert.deepEqual({ amount: e[1]!.amount, reason: e[1]!.reason }, { amount: null, reason: 'unsupported-service_tier' });

  // A session whose first explicit tier is committed after its first request: that request is re-priced.
  const t = await codexStore();
  t.r.meta(0);
  t.r.turn(1, '00000000-0000-4000-8000-0000000c1918');
  t.r.tokens(5, usageObj(1000, 600, 200), usageObj(1000, 600, 200));
  await t.run();
  const p2 = loadPrices({ db: t.db, overridePath: join(t.tmp, 'none.json') });
  priceUsage(t.db, p2);
  near(estimates(t.db)[0]!.amount, (400 * 2 + 600 * 0.1 + 200 * 10) / 1e6); // no tier stated yet: default (D-P2-08)
  t.r.settings(6, 'priority');
  await t.run();
  priceUsage(t.db, p2, { afterUsageId: Number.MAX_SAFE_INTEGER }); // a per-commit pass: no new usage rows
  assert.deepEqual({ amount: estimates(t.db)[0]!.amount, reason: estimates(t.db)[0]!.reason }, { amount: null, reason: 'unsupported-service_tier' });
});

test('G2-2/G2-10: Claude usage updated later (latest line wins) re-prices the estimate with its own revision', async () => {
  const p = await claudeProfile(['usage-basic']);
  const file = join(p.tmp, 'models.override.json');
  const run = async () => { const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 }); await a.start(); a.stop(); };
  await run();
  const first = loadPrices({ db: p.db, overridePath: file });
  priceUsage(p.db, first);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 'owner-g2', currency: 'USD', prices_as_of: '2026-11-12',
    sources: [{ id: 'owner', url: 'https://example.com/p', retrieved: '2026-11-12' }],
    models: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', source: 'owner', prices_verified: true, qualifiers: { service_tier: ['standard'], speed: ['standard'] },
      rates: { input: 40, output: 200, cache_read: 2, cache_write: { '5m': 50, '1h': 80 } } }] }));
  const second = loadPrices({ db: p.db, overridePath: file, previous: first });
  const dir = join(p.root, 'projects', '-tmp-xaibo-fixture-usage-basic');
  const name = readdirSync(dir).find((f) => f.endsWith('.jsonl'))!;
  const last = readFileSync(join(FIXTURES, 'usage-basic', name), 'utf8').split('\n').filter(Boolean).findLast((l) => l.includes('"msg_fixture_0002"'))!;
  appendFileSync(join(dir, name), `${last.replace(/"uuid":"[^"]+"/, '"uuid":"00000000-0000-4000-8000-000000001920"').replace('"output_tokens":40', '"output_tokens":99')}\n`);
  await run();
  assert.equal(count(p.db, "SELECT output FROM usage WHERE identity = 'msg_fixture_0002'"), 99, 'latest line wins');
  priceUsage(p.db, second, { afterUsageId: Number.MAX_SAFE_INTEGER });
  const e = estimates(p.db).find((x) => x.scope === 'usage:transcript:msg_fixture_0002')!;
  near(e.amount, (5 * 4 + 140 * 0.2 + 15 * 8 + 99 * 20) / 1e6); // first revision's rates, new evidence
  assert.equal(e.rev, first.revisionId);
});

test('G2-4: a missing transcript, then the deleted conversation folder -> native unavailable', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xg2-agy-')));
  const root = join(tmp, 'antigravity-cli');
  mkdirSync(root, { recursive: true });
  cpSync(join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'agy', '1.5.6', 'basic'), root, { recursive: true, filter: (f) => !f.endsWith('expected.json') });
  const store = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'b') });
  store.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('pa', 'agy', ?, 'default')").run(root);
  const a = new AgyAdapter({ db: store.db, writer: new Writer(store.db), profileId: 'pa', root, intervalMs: 60_000 });
  await a.start();
  const conv = join(root, 'brain', '00000000-0000-4000-8000-0000000a0001');
  rmSync(join(conv, '.system_generated', 'logs', 'transcript_full.jsonl'));
  await a.wake();
  assert.equal(count(store.db, 'SELECT native_available FROM sessions'), 1);
  renameSync(conv, join(tmp, 'aside'));
  await a.wake();
  assert.equal(count(store.db, 'SELECT native_available FROM sessions'), 0);
  a.stop();
});

test('G2-5: the revision step reads current rows through a partial index', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xg2-idx-'));
  const { db } = await openStore({ file: join(tmp, 'x.db'), backupDir: join(tmp, 'b') });
  const plan = (db.prepare(`EXPLAIN QUERY PLAN UPDATE events SET revision_status = CASE WHEN source_seq = ? THEN 'superseded' ELSE 'rewound' END
    WHERE session_id = ? AND source = ? AND source_seq >= ? AND revision_status = 'current' AND native_id != ?`).all(1, 1, 't', 1, 'x') as { detail: string }[]).map((r) => r.detail);
  assert.ok(plan.some((d) => d.includes('events_current_seq')), plan.join(' | '));
});

test('G2-6: tool-call fields never depend on arrival order (EC-10)', async () => {
  const obs = { hook: undefined, otel: 'Zulu', transcript: 'Alpha' } as const;
  const tool = async (order: (keyof typeof obs)[]) => {
    const tmp = mkdtempSync(join(tmpdir(), 'xg2-tc-'));
    const { db } = await openStore({ file: join(tmp, 'x.db'), backupDir: join(tmp, 'b') });
    db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/r', 'default')").run();
    order.forEach((source, i) => {
      const e: EventRow = { nativeSessionId: '00000000-0000-4000-8000-000000001930', source, confidence: 'confirmed', nativeId: `e${i}`, kind: 'tool', sourceSeq: i, receivedTs: 1,
        toolCalls: [{ callId: 'call_g2', part: 'args', ...(obs[source] ? { tool: obs[source] } : {}) }] };
      const b: Batch = { profileId: 'p1', agent: 'claude', file: { path: `/tmp/xaibo-fixture/${i}.jsonl`, kind: 'transcript', dev: 1, ino: i, size: 0, mtime: 0, offset: 0, headHash: '', status: 'ok' },
        sessions: [{ nativeSessionId: '00000000-0000-4000-8000-000000001930' }], events: [e] };
      commitBatch(db, b);
    });
    return { ...(db.prepare("SELECT tool, sources FROM tool_calls WHERE native_call_id = 'call_g2'").get() as { tool: string; sources: string }) };
  };
  const a = await tool(['otel', 'hook', 'transcript']);
  const b = await tool(['transcript', 'hook', 'otel']);
  assert.deepEqual(a, b);
  assert.equal(a.tool, 'Alpha', 'transcript outranks otel');
});
