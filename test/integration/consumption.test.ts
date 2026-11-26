// XAIBO-PROD-583 (P6-T10a unit 2; design .handoff/p6-t10a-design.md, review R1/R5/R6/R7, D-P6-17): retained observed
// consumption per profile, sign-in generation and Codex account epoch, from stored message-scope usage rows and their
// per-request estimates only. Each request counted once in its own group; generation from the profile's boundaries at the
// row's trusted source time, else its event's stored generation (the quota rule); an agent-reported session total is never
// added; gaps, unpriced requests, a reported total and the cap mark coverage partial; purging sessions excluded; the
// account epoch never leaves the service (a matching verified Codex scope id is the join key). Synthetic rows only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumptionByProfile } from '../../src/service/usage/consumption.ts';
import { scopeKey } from '../../src/service/usage/snapshots.ts';
import { answerUsage } from '../../src/service/api.ts';
import { openStore } from '../../src/service/store/db.ts';
import { parsePortMessage } from '../../src/shared/ipc.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const C = '00000000-0000-4000-8000-0000000c8301', X = '00000000-0000-4000-8000-0000000c8302';
const T = Date.parse('2026-03-01T00:00:00.000Z');

async function store() {
  const dir = mkdtempSync(join(tmpdir(), 'xcons-'));
  dirs.push(dir);
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'b') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES (?, 'claude', '/tmp/xaibo-fixture/c', 'manual'), (?, 'codex', '/tmp/xaibo-fixture/x', 'manual')").run(C, X);
  let n = 0;
  const session = (profile: string, agent: string, epoch: string | null = null) =>
    Number(db.prepare('INSERT INTO sessions (agent, profile_id, native_session_id, account_epoch) VALUES (?, ?, ?, ?)').run(agent, profile, `s${++n}`, epoch).lastInsertRowid);
  const event = (sid: number, gen: number, sourceTs: number | null, received: number) =>
    Number(db.prepare(`INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, source_seq, source_ts, received_ts, sign_in_generation)
      VALUES (?, 1, 'fixture', 'confirmed', ?, 'assistant', 1, ?, ?, ?)`).run(sid, `e${++n}`, sourceTs, received, gen).lastInsertRowid);
  /** One request: tokens [uncached, cacheRead, cacheWrite, output], its estimate (undefined: none) and times. */
  const request = (sid: number, o: { tokens?: (number | null)[]; usd?: number | null; coverage?: string; sourceTs?: number | null; gen?: number; received?: number; scope?: string; basis?: string } = {}) => {
    const id = `r${++n}`, t = o.tokens ?? [100, 10, 0, 50], received = o.received ?? T;
    const ev = event(sid, o.gen ?? 0, null, received);
    db.prepare(`INSERT INTO usage (session_id, schema_version, source, identity, scope, event_id, uncached_input, cache_read, cache_write, output, source_ts)
      VALUES (?, 1, 'fixture', ?, ?, ?, ?, ?, ?, ?, ?)`).run(sid, id, o.scope ?? 'message', ev, t[0]!, t[1]!, t[2]!, t[3]!, o.sourceTs === undefined ? received : o.sourceTs);
    if (o.usd !== undefined) db.prepare(`INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, amount_usd, basis, coverage)
      VALUES (?, 1, 'fixture', ?, ?, ?, ?)`).run(sid, `usage:fixture:${id}`, o.usd, o.basis ?? 'token_table', JSON.stringify({ coverage: o.coverage ?? (o.usd === null ? 'none' : 'full') }));
  };
  return { db, session, request };
}

test('each request counted once in its profile and generation; only message rows; per-request estimates summed', async () => {
  const { db, session, request } = await store();
  const s = session(C, 'claude');
  request(s, { usd: 0.25 });
  request(s, { usd: 0.5, tokens: [10, 0, 0, 5] });
  request(s, { scope: 'turn', usd: 9 }); // a turn total: never a request
  const c = consumptionByProfile(db).groups.get(C)!;
  assert.deepEqual(c, [{ generation: 0, scope: null, tokens: 175, estimatedUsd: 0.75, coverage: 'full', from: T, to: T, limited: false }]);
});

test('generation from the boundary at the trusted source time, else the event generation; each its own group', async () => {
  const { db, session, request } = await store();
  db.prepare("INSERT INTO sign_in_boundaries (profile_id, generation, revision, at, reason, method) VALUES (?, 1, 1, ?, 'method', 'api-key')").run(C, T + 1000);
  const s = session(C, 'claude');
  request(s, { usd: 1, sourceTs: T, received: T });               // before the boundary: generation 0
  request(s, { usd: 2, sourceTs: T + 2000, received: T + 2000 }); // after it: generation 1
  request(s, { usd: 4, sourceTs: null, received: T + 3000, gen: 1 }); // no source time: its event's generation
  request(s, { usd: 8, sourceTs: T + 10 * 60_000, received: T, gen: 0 }); // a source time too far ahead is not trusted: the event's
  const c = consumptionByProfile(db).groups.get(C)!;
  assert.deepEqual(c.map((g) => [g.generation, g.estimatedUsd]).sort(), [[0, 9], [1, 6]]);
});

test('Codex account epochs stay apart; the epoch never leaves the service; a matching verified scope is the join key', async () => {
  const { db, session, request } = await store();
  const verified = Number(db.prepare("INSERT INTO usage_scopes (scope_key, profile_id, agent, epoch, verified, sign_in_generation) VALUES (?, ?, 'codex', 'epoch-a', 1, 0)").run(scopeKey({ profileId: X, agent: 'codex', epoch: 'epoch-a', nativeSessionId: '' }).key, X).lastInsertRowid);
  request(session(X, 'codex', 'epoch-a'), { usd: 1 });
  request(session(X, 'codex', 'epoch-b'), { usd: 2 });
  const c = consumptionByProfile(db).groups.get(X)!;
  assert.deepEqual(c.map((g) => [g.scope, g.estimatedUsd]).sort((a, b) => (a[1] as number) - (b[1] as number)), [[verified, 1], [null, 2]]);
  assert.ok(!JSON.stringify(c).includes('epoch-'), 'no account epoch in the reply');
});

test('a reported session total is never added; gaps and unpriced requests make coverage partial; none priced: no amount', async () => {
  const { db, session, request } = await store();
  const s = session(C, 'claude');
  request(s, { usd: 0.25 });
  db.prepare(`INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, amount_usd, basis, coverage)
    VALUES (?, 1, 'statusline', 'session:statusline', 99, 'agent_reported', '{"coverage":"full"}')`).run(s);
  let c = consumptionByProfile(db).groups.get(C)![0]!;
  assert.equal(c.estimatedUsd, 0.25, 'the reported total is not added');
  assert.equal(c.coverage, 'partial', 'a session with a reported total: the requests may not be all of it');
  const t = session(C, 'claude');
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('00000000-0000-4000-8000-0000000c8303', 'claude', '/tmp/xaibo-fixture/g', 'manual')").run();
  const g = session('00000000-0000-4000-8000-0000000c8303', 'claude');
  request(g, { tokens: [100, null, 0, 50], usd: 0.1 });
  c = consumptionByProfile(db).groups.get('00000000-0000-4000-8000-0000000c8303')![0]!;
  assert.deepEqual([c.tokens, c.coverage], [150, 'partial'], 'a token gap: known subtotal, partial');
  request(t, {}); // no estimate at all
  request(t, { usd: null });
  const all = consumptionByProfile(db).groups.get(C)![0]!;
  assert.deepEqual([all.estimatedUsd, all.coverage], [0.25, 'partial']);
  const none = await store();
  none.request(none.session(C, 'claude'), { usd: null });
  assert.deepEqual(consumptionByProfile(none.db).groups.get(C)!.map((x) => [x.estimatedUsd, x.coverage]), [[null, 'partial']]);
});

test('purging sessions excluded; the read is capped newest first and says so', async () => {
  const { db, session, request } = await store();
  const gone = session(C, 'claude');
  request(gone, { usd: 5 });
  db.prepare("INSERT INTO suppressions (agent, profile_id, native_session_id, reason, at, purge_phase) SELECT agent, profile_id, native_session_id, 'manual', 1, 'rows' FROM sessions WHERE id = ?").run(gone);
  const s = session(C, 'claude');
  for (let i = 0; i < 5; i++) request(s, { usd: 1, sourceTs: T + i, received: T + i });
  assert.equal(consumptionByProfile(db).groups.get(C)![0]!.estimatedUsd, 5, 'the purging session left');
  const capped = consumptionByProfile(db, 3).groups.get(C)![0]!;
  assert.deepEqual([capped.estimatedUsd, capped.coverage, capped.limited, capped.from, capped.to], [3, 'partial', true, T + 2, T + 4], 'the newest 3, never complete');
});

test('review M1: an owner-fallback per-request estimate counts, as in Session Cost and the ledger', async () => {
  const { db, session, request } = await store();
  const s = session(C, 'claude');
  request(s, { usd: 0.25 });
  request(s, { usd: 0.5, basis: 'owner_fallback' });
  assert.deepEqual(consumptionByProfile(db).groups.get(C)!.map((g) => [g.estimatedUsd, g.coverage]), [[0.75, 'full']]);
});

test('review M3: a profile whose rows all fall beyond the cap says the read was capped, never "nothing used"', async () => {
  const { db, session, request } = await store();
  request(session(C, 'claude'), { usd: 1, sourceTs: T, received: T }); // the oldest row
  const x = session(X, 'codex');
  for (let i = 1; i <= 3; i++) request(x, { usd: 1, sourceTs: T + i, received: T + i });
  const r = consumptionByProfile(db, 3);
  assert.equal(r.limited, true);
  assert.equal(r.groups.get(C), undefined, 'none of its rows were read');
  const reply = answerUsage(db, { v: 1, type: 'usage', id: 2 }, '/tmp/xaibo-fixture/home');
  assert.equal(reply.profiles.find((p) => p.profileId === C)!.consumptionLimited, false, 'the real read is not capped here');
});

test('the usage reply lists consumption per profile (a consumption-only profile too) and parses', async () => {
  const { db, session, request } = await store();
  request(session(C, 'claude'), { usd: 0.25 });
  const reply = answerUsage(db, { v: 1, type: 'usage', id: 1 }, '/tmp/xaibo-fixture/home');
  assert.equal(reply.profiles.find((p) => p.profileId === C)!.consumption[0]!.estimatedUsd, 0.25, 'no quota scope needed');
  assert.deepEqual(reply.profiles.find((p) => p.profileId === X)!.consumption, []);
  assert.ok(parsePortMessage(reply));
});

test('G6E-1: the cap bounds the rows scanned, not only those returned: newer non-message rows count and mark the read limited', async () => {
  const { db, session, request } = await store();
  const s = session(C, 'claude');
  request(s, { usd: 1 }); // the only message row, the oldest
  for (let i = 0; i < 3; i++) request(s, { scope: 'turn', usd: 1 });
  assert.equal(consumptionByProfile(db, 2).limited, true);
});
