// XAIBO-PROD-210 (P2-T10, EC-95, EC-96 link) through ingest and the store: Claude usage-basic and a Codex simple-turn
// rollout (service tier "default" set in the test) priced with the bundled table (golden values); a price edit keeps
// already priced requests on their revision and prices new usage with the new one; an unpriced model gets priced once
// an owner fallback names it; a Codex counter reset never yields a negative estimate; boot prices after commits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { boot } from '../../src/service/boot.ts';
import { loadCatalog, type Catalog } from '../../src/service/catalog/validate.ts';
import { priceUsage, sessionCost } from '../../src/service/usage/cost.ts';
import { loadPrices } from '../../src/service/usage/prices.ts';
import { claudeProfile, FIXTURES } from '../helpers/claude-profile.ts';

const CODEX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0', 'simple-turn');
const CLAUDE_SID = '00000000-0000-4000-8000-000000001000';
const CODEX_SID = '00000000-0000-4000-8000-0000000c0030';
const near = (a: number | null | undefined, b: number, why = '') => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-12, `${a} != ${b} ${why}`);
const estimates = (db: DatabaseSync, sid: string) => db.prepare(`SELECT e.covered_scope AS scope, e.amount_usd AS amount, e.basis, e.price_revision_id AS rev,
  e.unavailable_reason AS reason FROM cost_estimates e JOIN sessions s ON s.id = e.session_id WHERE s.native_session_id = ? ORDER BY e.covered_scope`)
  .all(sid).map((r) => ({ ...r }) as { scope: string; amount: number | null; basis: string; rev: number | null; reason: string | null });
const sessionId = (db: DatabaseSync, sid: string) => (db.prepare('SELECT id FROM sessions WHERE native_session_id = ?').get(sid) as { id: number }).id;
const override = (o: object) => JSON.stringify({ schemaVersion: 1, revision: 'owner-1', currency: 'USD', prices_as_of: '2026-11-12',
  sources: [{ id: 'owner', url: 'https://example.com/p', retrieved: '2026-11-12' }], models: [], ...o });

function codexHome(tmp: string, edit: (t: string) => string = (t) => t, tier: string | null = 'default') {
  const dated = join(tmp, 'codex', 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  const name = readdirSync(CODEX).find((f) => f.startsWith('rollout-'))!;
  const raw = readFileSync(join(CODEX, name), 'utf8');
  const text = edit(tier === null ? raw : raw.replace('"thread_settings":{', `"thread_settings":{"service_tier":"${tier}",`));
  writeFileSync(join(dated, name), text);
  return { root: join(tmp, 'codex'), file: join(dated, name) };
}

test('EC-95: ingested Claude and Codex requests priced per component with the bundled table (golden)', async () => {
  const p = await claudeProfile(['usage-basic']);
  const cx = codexHome(p.tmp);
  p.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', ?, 'default')").run(cx.root);
  for (const a of [new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 }),
    new CodexAdapter({ db: p.db, writer: p.writer, profileId: 'p2', root: cx.root, intervalMs: 60_000 })]) { await a.start(); a.stop(); }
  const prices = loadPrices({ db: p.db, overridePath: join(p.tmp, 'none.json') });
  priceUsage(p.db, prices);

  const c = estimates(p.db, CLAUDE_SID);
  assert.deepEqual(c.map((e) => e.scope), ['usage:transcript:msg_fixture_0001', 'usage:transcript:msg_fixture_0002']);
  near(c[0]!.amount, (10 * 4 + 100 * 0.2 + 30 * 5 + 20 * 20) / 1e6); // opus: in 4, out 20, read 0.2, 5m write 5
  near(c[1]!.amount, (5 * 4 + 140 * 0.2 + 15 * 8 + 40 * 20) / 1e6); // 1h write 8
  assert.ok(c.every((e) => e.basis === 'token_table' && e.rev === prices.revisionId));
  const cs = sessionCost(p.db, sessionId(p.db, CLAUDE_SID));
  near(cs.amountUsd, 1578 / 1e6);
  assert.equal(cs.coverage, 'full');

  const x = estimates(p.db, CODEX_SID);
  assert.equal(x.length, 1);
  near(x[0]!.amount, (400 * 2 + 600 * 0.1 + 200 * 10) / 1e6); // gpt-6.1-sol from turn_context; cached ⊂ input; reasoning ⊂ output
  assert.equal(sessionCost(p.db, sessionId(p.db, CODEX_SID)).coverage, 'partial', 'Codex cache write unverified');

  priceUsage(p.db, prices);
  assert.equal(estimates(p.db, CLAUDE_SID).length + estimates(p.db, CODEX_SID).length, 3, 'a second pass adds nothing');
});

test('EC-96/EC-95: a price edit keeps priced requests on their revision; new usage uses the new one; a fallback prices an unlisted model', async () => {
  const p = await claudeProfile(['usage-basic']);
  const file = join(p.tmp, 'models.override.json');
  const run = async () => { const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 }); await a.start(); a.stop(); };
  await run();
  const first = loadPrices({ db: p.db, overridePath: file });
  priceUsage(p.db, first);
  const before = estimates(p.db, CLAUDE_SID);

  writeFileSync(file, override({ models: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', source: 'owner', prices_verified: true,
    qualifiers: { service_tier: ['standard'], speed: ['standard'] }, rates: { input: 40, output: 200, cache_read: 2, cache_write: { '5m': 50, '1h': 80 } } }] }));
  const second = loadPrices({ db: p.db, overridePath: file, previous: first });
  assert.notEqual(second.revisionId, first.revisionId);

  // New usage: a later message, and one from a model no table lists.
  const transcript = readdirSync(join(p.root, 'projects', '-tmp-xaibo-fixture-usage-basic')).find((f) => f.endsWith('.jsonl'))!;
  const path = join(p.root, 'projects', '-tmp-xaibo-fixture-usage-basic', transcript);
  const lines = readFileSync(join(FIXTURES, 'usage-basic', transcript), 'utf8').split('\n').filter(Boolean);
  const last = lines.findLast((l) => l.includes('"msg_fixture_0002"'))!;
  appendFileSync(path, `${last.replaceAll('msg_fixture_0002', 'msg_fixture_0003').replace(/"uuid":"[^"]+"/, '"uuid":"00000000-0000-4000-8000-000000001903"')}\n`);
  appendFileSync(path, `${last.replaceAll('msg_fixture_0002', 'msg_fixture_0004').replace(/"uuid":"[^"]+"/, '"uuid":"00000000-0000-4000-8000-000000001904"')
    .replace('"model":"claude-opus-5-5"', '"model":"synthetic-unlisted-model"')}\n`);
  await run();
  priceUsage(p.db, second);

  const after = estimates(p.db, CLAUDE_SID);
  assert.deepEqual(after.slice(0, 2), before, 'already priced requests keep amount and revision');
  near(after[2]!.amount, (5 * 40 + 140 * 2 + 15 * 80 + 40 * 200) / 1e6);
  assert.equal(after[2]!.rev, second.revisionId);
  assert.deepEqual({ amount: after[3]!.amount, reason: after[3]!.reason }, { amount: null, reason: 'unpriced-model' });
  const mixed = sessionCost(p.db, sessionId(p.db, CLAUDE_SID));
  assert.equal(mixed.coverage, 'partial', 'known subtotal while one request is unpriced');

  const fallback = (qualifiers?: object) => override({ fallbacks: [{ models: ['synthetic-unlisted-model'], agent: 'claude', ...(qualifiers ? { qualifiers } : {}),
    rates: { input: 1, output: 1, cache_read: 1, cache_write: { '1h': 1 } } }] });
  writeFileSync(file, fallback());
  const noQualifiers = loadPrices({ db: p.db, overridePath: file, previous: second });
  priceUsage(p.db, noQualifiers);
  assert.deepEqual({ amount: estimates(p.db, CLAUDE_SID)[3]!.amount, reason: estimates(p.db, CLAUDE_SID)[3]!.reason },
    { amount: null, reason: 'unsupported-service_tier' }, 'a fallback covers only the qualifiers it lists');

  writeFileSync(file, fallback({ service_tier: ['standard'], speed: ['standard'] }));
  const third = loadPrices({ db: p.db, overridePath: file, previous: noQualifiers });
  priceUsage(p.db, third);
  const fb = estimates(p.db, CLAUDE_SID)[3]!;
  assert.equal(fb.basis, 'owner_fallback');
  assert.equal(fb.rev, third.revisionId);
  near(fb.amount, (5 + 140 + 15 + 40) / 1e6);
  assert.deepEqual(estimates(p.db, CLAUDE_SID).slice(0, 3), after.slice(0, 3), 'priced rows untouched by later edits');
});

test('EC-95: a Codex counter reset gives no negative estimate; every request row priced once', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xcost-')));
  const cx = codexHome(tmp);
  const tc = readFileSync(cx.file, 'utf8').split('\n').find((l) => l.includes('"type":"token_count"'))!;
  // A later reading with a lower cumulative total (a reset), then an advance.
  const lower = tc.replace(/"total_token_usage":\{[^}]*\}/, '"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0,"total_tokens":110}')
    .replace(/"last_token_usage":\{[^}]*\}/, '"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0,"total_tokens":110}');
  appendFileSync(cx.file, `${lower}\n`);
  const store = await import('../../src/service/store/db.ts').then((m) => m.openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'b') }));
  const { Writer } = await import('../../src/service/store/writer.ts');
  store.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', ?, 'default')").run(cx.root);
  const a = new CodexAdapter({ db: store.db, writer: new Writer(store.db), profileId: 'p2', root: cx.root, intervalMs: 60_000 });
  await a.start(); a.stop();
  priceUsage(store.db, loadPrices({ db: store.db, overridePath: join(tmp, 'none.json') }));
  const rows = estimates(store.db, CODEX_SID);
  const requests = Number((store.db.prepare("SELECT count(*) AS n FROM usage WHERE scope = 'message'").get() as { n: number }).n);
  assert.equal(rows.length, requests);
  assert.equal(requests, 2, 'the reset reading is a new segment with its own request');
  assert.ok(rows.every((r) => r.amount === null || r.amount >= 0));
});

test('D-P2-08: Codex tier from thread settings in effect; none stated -> default tier; an explicit unlisted tier -> unavailable', async () => {
  const price = async (tier: string | null) => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xtier-')));
    const cx = codexHome(tmp, (t) => t, tier);
    const { openStore } = await import('../../src/service/store/db.ts');
    const { Writer } = await import('../../src/service/store/writer.ts');
    const store = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'b') });
    store.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', ?, 'default')").run(cx.root);
    const a = new CodexAdapter({ db: store.db, writer: new Writer(store.db), profileId: 'p2', root: cx.root, intervalMs: 60_000 });
    await a.start(); a.stop();
    priceUsage(store.db, loadPrices({ db: store.db, overridePath: join(tmp, 'none.json') }));
    return estimates(store.db, CODEX_SID)[0]!;
  };
  near((await price(null)).amount, (400 * 2 + 600 * 0.1 + 200 * 10) / 1e6);
  assert.deepEqual(await price('priority').then((e) => ({ amount: e.amount, reason: e.reason })), { amount: null, reason: 'unsupported-service_tier' });
});

test('P2-T14: an incremental pass prices only usage rows above the high-water mark; the result equals a full pass', async () => {
  const p = await claudeProfile(['usage-basic']);
  const cx = codexHome(p.tmp);
  p.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', ?, 'default')").run(cx.root);
  for (const a of [new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 }),
    new CodexAdapter({ db: p.db, writer: p.writer, profileId: 'p2', root: cx.root, intervalMs: 60_000 })]) { await a.start(); a.stop(); }
  const prices = loadPrices({ db: p.db, overridePath: join(p.tmp, 'none.json') });
  const ids = (p.db.prepare("SELECT id FROM usage WHERE scope = 'message' ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  assert.equal(ids.length, 3);
  assert.equal(priceUsage(p.db, prices, { afterUsageId: ids[1]! }), 1, 'only the row above the mark');
  assert.equal(estimates(p.db, CLAUDE_SID).length + estimates(p.db, CODEX_SID).length, 1);
  assert.equal(priceUsage(p.db, prices, { afterUsageId: ids[2]! }), 0);
  assert.equal(priceUsage(p.db, prices), 2, 'a full pass picks up the rest');
  near(sessionCost(p.db, sessionId(p.db, CLAUDE_SID)).amountUsd, 1578 / 1e6);
  near(estimates(p.db, CODEX_SID)[0]!.amount, (400 * 2 + 600 * 0.1 + 200 * 10) / 1e6);
});

test('boot prices after ingest commits', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xcost-boot-')));
  const home = join(tmp, 'home');
  const project = join(home, '.claude', 'projects', '-tmp-xaibo-fixture-project');
  mkdirSync(project, { recursive: true });
  for (const f of readdirSync(join(FIXTURES, 'usage-basic')).filter((f) => f.endsWith('.jsonl'))) writeFileSync(join(project, f), readFileSync(join(FIXTURES, 'usage-basic', f)));
  const catalog: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((x) => ({ ...x, detection: { ...x.detection, locations: ['~/.local/bin'] } })) };
  const svc = await boot({ dataDir: join(tmp, 'data'), home, catalog, intervalMs: 60_000 });
  await svc.done;
  near(sessionCost(svc.store.db, sessionId(svc.store.db, CLAUDE_SID)).amountUsd, 1578 / 1e6);
  svc.stop();
});
