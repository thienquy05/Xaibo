// XAIBO-PROD-417 (P4-T07a; PRD FR-48, US-18, §5.12; design §6.3.2): the session cost breakdown over the port, through
// ingest and the pricing engine. Requests group by (model, price revision, basis); each component carries exact tokens,
// the applied rate and its ~$ from that rate only; revisions are listed separately with their Prices as of and sources;
// an unpriced request keeps its reason; an owner fallback is its own basis; a reported estimate is never added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { answerCost } from '../../src/service/api.ts';
import { priceUsage } from '../../src/service/usage/cost.ts';
import { loadPrices } from '../../src/service/usage/prices.ts';
import type { CostComponent, CostDetail } from '../../src/shared/ipc.ts';
import { claudeProfile, FIXTURES } from '../helpers/claude-profile.ts';

const CLAUDE_SID = '00000000-0000-4000-8000-000000001000';
const CODEX_SID = '00000000-0000-4000-8000-0000000c0030';
const CODEX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0', 'simple-turn');
const near = (a: number | null | undefined, b: number, why = '') => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-12, `${a} != ${b} ${why}`);
const sid = (db: DatabaseSync, native: string) => (db.prepare('SELECT id FROM sessions WHERE native_session_id = ?').get(native) as { id: number }).id;
const cost = (db: DatabaseSync, session: number): CostDetail | null => answerCost(db, { v: 1, type: 'cost', id: 7, session }).cost;
const comp = (c: CostComponent[], name: CostComponent['name']) => c.find((x) => x.name === name)!;
const override = (o: object) => JSON.stringify({ schemaVersion: 1, revision: 'owner-1', currency: 'USD', prices_as_of: '2026-11-12',
  sources: [{ id: 'owner', url: 'https://example.com/p', retrieved: '2026-11-12' }], models: [], ...o });

test('Claude: groups by model and revision, components from applied rates, mixed revisions listed, unpriced reason kept, fallback labeled', async () => {
  const p = await claudeProfile(['usage-basic']);
  const file = join(p.tmp, 'models.override.json');
  const run = async () => { const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 }); await a.start(); a.stop(); };
  await run();
  const first = loadPrices({ db: p.db, overridePath: file });
  priceUsage(p.db, first);
  const id = sid(p.db, CLAUDE_SID);

  let c = cost(p.db, id)!;
  assert.equal(c.basis, 'token_table');
  assert.equal(c.coverage, 'full');
  near(c.amountUsd, 1578 / 1e6);
  assert.deepEqual([c.requests, c.priced, c.reportedUsd, c.more, c.gaps, c.reasons], [2, 2, null, false, [], []]);
  assert.equal(c.groups.length, 1);
  const g = c.groups[0]!;
  assert.deepEqual([g.model, g.revision, g.basis, g.requests, g.priced], ['claude-opus-5-5', first.revisionId, 'token_table', 2, 2]);
  assert.deepEqual(g.components.map((x) => x.name), ['uncached_input', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'output']);
  // usage-basic: msg 1 = in 10, read 100, 5m write 30, out 20; msg 2 = in 5, read 140, 1h write 15, out 40 (bundled opus 4/0.2/5/8/20)
  for (const [name, tokens, rate] of [['uncached_input', 15, 4], ['cache_read', 240, 0.2], ['cache_write_5m', 30, 5], ['cache_write_1h', 15, 8], ['output', 60, 20]] as const) {
    const x = comp(g.components, name);
    assert.deepEqual([x.tokens, x.missing, x.rate, x.rateVaries], [tokens, 0, rate, false], name);
    near(x.usd, (tokens * rate) / 1e6, name);
  }
  assert.equal(c.revisions.length, 1);
  const bundled = p.db.prepare('SELECT revision, prices_as_of AS asOf FROM price_revisions WHERE id = ?').get(first.revisionId!) as { revision: string; asOf: string };
  assert.deepEqual([c.revisions[0]!.id, c.revisions[0]!.label, c.revisions[0]!.pricesAsOf, c.revisions[0]!.source], [first.revisionId, bundled.revision, bundled.asOf, 'bundled']);
  assert.ok(c.revisions[0]!.references.length >= 1 && c.revisions[0]!.references.every((r) => /^[\w.-]+: \S+ \(retrieved [\d-]+\)$/.test(r)), JSON.stringify(c.revisions[0]!.references));

  // A price edit: msg 3 (opus) prices under the new revision, msg 4 (unlisted model) stays unpriced with its reason.
  writeFileSync(file, override({ models: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', source: 'owner', prices_verified: true,
    qualifiers: { service_tier: ['standard'], speed: ['standard'] }, rates: { input: 40, output: 200, cache_read: 2, cache_write: { '5m': 50, '1h': 80 } } }] }));
  const second = loadPrices({ db: p.db, overridePath: file, previous: first });
  const transcript = readdirSync(join(p.root, 'projects', '-tmp-xaibo-fixture-usage-basic')).find((f) => f.endsWith('.jsonl'))!;
  const path = join(p.root, 'projects', '-tmp-xaibo-fixture-usage-basic', transcript);
  const last = readFileSync(join(FIXTURES, 'usage-basic', transcript), 'utf8').split('\n').filter(Boolean).findLast((l) => l.includes('"msg_fixture_0002"'))!;
  appendFileSync(path, `${last.replaceAll('msg_fixture_0002', 'msg_fixture_0003').replace(/"uuid":"[^"]+"/, '"uuid":"00000000-0000-4000-8000-000000001903"')}\n`);
  appendFileSync(path, `${last.replaceAll('msg_fixture_0002', 'msg_fixture_0004').replace(/"uuid":"[^"]+"/, '"uuid":"00000000-0000-4000-8000-000000001904"')
    .replace('"model":"claude-opus-5-5"', '"model":"synthetic-unlisted-model"')}\n`);
  await run();
  priceUsage(p.db, second);

  c = cost(p.db, id)!;
  assert.equal(c.coverage, 'partial');
  near(c.amountUsd, (1578 + 5 * 40 + 140 * 2 + 15 * 80 + 40 * 200) / 1e6);
  assert.deepEqual([c.requests, c.priced, c.reasons], [4, 3, ['unpriced-model']]);
  const by = (model: string, rev: number | null) => c.groups.find((x) => x.model === model && x.revision === rev)!;
  assert.equal(c.groups[0]!.revision, first.revisionId, 'the earliest requests come first');
  const newer = by('claude-opus-5-5', second.revisionId);
  assert.deepEqual([newer.requests, newer.priced, comp(newer.components, 'output').rate], [1, 1, 200]);
  near(comp(newer.components, 'output').usd, (40 * 200) / 1e6);
  const unpriced = by('synthetic-unlisted-model', second.revisionId);
  assert.deepEqual([unpriced.requests, unpriced.priced], [1, 0]);
  for (const x of unpriced.components) assert.deepEqual([x.rate, x.usd], [null, null], x.name); // never 0 without a rate
  assert.equal(comp(unpriced.components, 'output').tokens, 40, 'tokens stay readable without a price');
  assert.deepEqual(c.revisions.map((r) => [r.id, r.source]), [[first.revisionId, 'bundled'], [second.revisionId, 'override']]);
  const owner = c.revisions.find((r) => r.id === second.revisionId)!;
  assert.deepEqual([owner.label, owner.pricesAsOf, owner.references], ['owner-1', '2026-11-12', ['owner: https://example.com/p (retrieved 2026-11-12)']]);

  // An owner fallback prices the unlisted model on its own basis and revision.
  writeFileSync(file, override({ fallbacks: [{ models: ['synthetic-unlisted-model'], agent: 'claude', qualifiers: { service_tier: ['standard'], speed: ['standard'] },
    rates: { input: 1, output: 1, cache_read: 1, cache_write: { '1h': 1 } } }] }));
  const third = loadPrices({ db: p.db, overridePath: file, previous: second });
  priceUsage(p.db, third);
  c = cost(p.db, id)!;
  const fb = c.groups.find((x) => x.basis === 'owner_fallback')!;
  assert.deepEqual([fb.model, fb.revision, fb.priced], ['synthetic-unlisted-model', third.revisionId, 1]);
  assert.ok(c.revisions.find((r) => r.id === third.revisionId)!.references.includes('Owner-set fallback'));
  assert.deepEqual([c.requests, c.priced, c.reasons], [4, 4, []]);
});

test('reported estimate: selected, never added; a reported zero stays 0; groups still listed', async () => {
  const p = await claudeProfile(['usage-basic']);
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start(); a.stop();
  priceUsage(p.db, loadPrices({ db: p.db, overridePath: join(p.tmp, 'none.json') }));
  const id = sid(p.db, CLAUDE_SID);
  p.db.prepare(`INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, amount_usd, basis, coverage)
    VALUES (?, 1, 'statusline', 'session:statusline', 0, 'agent_reported', '{"coverage":"full"}')`).run(id);
  const c = cost(p.db, id)!;
  assert.deepEqual([c.amountUsd, c.basis, c.coverage, c.reportedUsd, c.requests], [0, 'agent_reported', 'full', 0, 2]);
  assert.equal(c.groups.length, 1);
});

test('Codex: cache write stays unpriced (no rate, no ~$); unknown session null; no estimates is unavailable, never 0', async () => {
  const p = await claudeProfile(['usage-basic']);
  const dated = join(p.tmp, 'codex', 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  const name = readdirSync(CODEX).find((f) => f.startsWith('rollout-'))!;
  writeFileSync(join(dated, name), readFileSync(join(CODEX, name), 'utf8').replace('"thread_settings":{', '"thread_settings":{"service_tier":"default",'));
  p.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', ?, 'default')").run(join(p.tmp, 'codex'));
  const a = new CodexAdapter({ db: p.db, writer: p.writer, profileId: 'p2', root: join(p.tmp, 'codex'), intervalMs: 60_000 });
  await a.start(); a.stop();
  const none = cost(p.db, sid(p.db, CODEX_SID))!; // not priced yet
  assert.deepEqual([none.amountUsd, none.coverage, none.groups, none.revisions, none.requests], [null, 'unavailable', [], [], 0]);
  priceUsage(p.db, loadPrices({ db: p.db, overridePath: join(p.tmp, 'none.json') }));
  const c = cost(p.db, sid(p.db, CODEX_SID))!;
  assert.deepEqual(c.groups[0]!.components.map((x) => x.name), ['uncached_input', 'cache_read', 'cache_write', 'output']);
  const cw = comp(c.groups[0]!.components, 'cache_write');
  assert.deepEqual([cw.rate, cw.usd], [null, null]);
  near(comp(c.groups[0]!.components, 'uncached_input').usd, (400 * 2) / 1e6); // cached ⊂ input is not priced twice
  assert.equal(cost(p.db, 999_999), null);
});

test('review M1: a request priced without a component (its rate missing) leaves that component a known subtotal, not complete', async () => {
  const p = await claudeProfile(['usage-basic']);
  const file = join(p.tmp, 'models.override.json');
  // opus without a 1h cache-write rate: msg 2 (1h write 15) is priced partly with a cache_write gap
  writeFileSync(file, override({ models: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', source: 'owner', prices_verified: true,
    qualifiers: { service_tier: ['standard'], speed: ['standard'] }, rates: { input: 40, output: 200, cache_read: 2, cache_write: { '5m': 50 } } }] }));
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start(); a.stop();
  priceUsage(p.db, loadPrices({ db: p.db, overridePath: file }));
  const g = cost(p.db, sid(p.db, CLAUDE_SID))!.groups[0]!;
  assert.deepEqual([g.requests, g.priced], [2, 2]);
  const h1 = comp(g.components, 'cache_write_1h'), m5 = comp(g.components, 'cache_write_5m');
  assert.deepEqual([h1.tokens, h1.unpriced, h1.usd], [15, 1, null]);
  assert.deepEqual([m5.tokens, m5.unpriced], [30, 0], 'msg 2 has no 5m tokens, so 5m stays complete');
  near(m5.usd, (30 * 50) / 1e6);
});

test('review M2: an unreadable estimate row degrades the breakdown, never nulls a known session; review: more than 32 groups is capped', async () => {
  const p = await claudeProfile(['usage-basic']);
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start(); a.stop();
  priceUsage(p.db, loadPrices({ db: p.db, overridePath: join(p.tmp, 'none.json') }));
  const id = sid(p.db, CLAUDE_SID);
  p.db.prepare("UPDATE cost_estimates SET coverage = '{not json' WHERE id = (SELECT MIN(id) FROM cost_estimates WHERE session_id = ?)").run(id);
  const bad = cost(p.db, id)!;
  assert.notEqual(bad, null);
  assert.deepEqual([bad.groups, bad.revisions], [[], []]);
  assert.ok(bad.reasons.includes('breakdown-unavailable'), JSON.stringify(bad.reasons));

  const q = await claudeProfile(['usage-basic']);
  q.db.exec(`INSERT INTO sessions (id, agent, profile_id, native_session_id) VALUES (900, 'codex', 'p1', 'many');`);
  const u = q.db.prepare(`INSERT INTO usage (session_id, schema_version, source, identity, scope, uncached_input, cache_read, cache_write, output, source_ts)
    VALUES (900, 1, 'rollout', ?, 'message', 1, 0, 0, 1, ?)`);
  const e = q.db.prepare(`INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, amount_usd, basis, coverage, unavailable_reason, as_of)
    VALUES (900, 1, 'rollout', ?, NULL, 'token_table', ?, 'unpriced-model', ?)`);
  for (let i = 0; i < 33; i++) { u.run(`r${i}`, i); e.run(`usage:rollout:r${i}`, JSON.stringify({ coverage: 'none', gaps: [], model: `m${i}`, child: false }), i); }
  const many = cost(q.db, 900)!;
  assert.deepEqual([many.groups.length, many.more, many.requests, many.priced], [32, true, 33, 0]);
  assert.deepEqual([many.amountUsd, many.coverage], [null, 'unavailable']);
});
