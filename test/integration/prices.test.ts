// XAIBO-PROD-209 (P2-T09, EC-96) through the real service boot: prices load at start from the data dir and on
// reloadPrices(); an invalid edit logs a fixed code (never file content) and keeps the revision; estimates already
// priced keep their revision, so a session can show mixed revisions in its provenance; no socket or HTTP request is
// made while prices load (diagnostics channels watched, as the E2E connection audit does for the app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../../src/service/boot.ts';
import { loadCatalog, type Catalog } from '../../src/service/catalog/validate.ts';
import { ratesFor } from '../../src/service/usage/prices.ts';
import { createLogger, loadInstallSecret } from '../../src/shared/log.ts';

const catalog: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((a) => ({ ...a, detection: { ...a.detection, locations: ['~/.local/bin'] } })) };
const CHANNELS = ['net.client.socket', 'http.client.request.start', 'undici:request:create', 'undici:client:connected'];
const override = (input: number, revision: string) => JSON.stringify({
  schemaVersion: 1, revision, currency: 'USD', prices_as_of: '2026-11-12',
  sources: [{ id: 'owner', url: 'https://example.com/prices', retrieved: '2026-11-12' }],
  models: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', source: 'owner', prices_verified: true, rates: { input, output: 20 } }],
});

test('EC-96: boot and reload price from the latest valid revision; old estimates keep theirs; no network', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xprices-boot-')));
  const home = join(tmp, 'home');
  const dataDir = join(tmp, 'data');
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'models.override.json');
  const logDir = join(dataDir, 'logs', 'service');
  const log = createLogger({ dir: logDir, secret: loadInstallSecret(dataDir) });

  const seen: string[] = [];
  const handlers = CHANNELS.map((c) => [c, () => { seen.push(c); }] as const);
  for (const [c, h] of handlers) subscribe(c, h);
  try {
    writeFileSync(file, override(3, 'owner-1'));
    const svc = await boot({ dataDir, home, catalog, intervalMs: 60_000, log });
    await svc.done;
    const db = svc.store.db;
    const first = svc.prices()!;
    assert.equal(first.error, null);
    assert.equal(ratesFor(first.table, 'claude', 'claude-opus-5-5')?.rates.input, 3);

    db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('px', 'claude', '/tmp/xaibo-fixture/none', 'default')").run();
    const sid = (db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id) VALUES ('claude', 'px', '00000000-0000-4000-8000-000000009601') RETURNING id").get() as { id: number }).id;
    const estimate = (scope: string, rev: number | null) => db.prepare(`INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, amount_usd,
      basis, price_revision_id) VALUES (?, 1, 'test', ?, 0.01, 'token_table', ?)`).run(sid, scope, rev);
    estimate('message:a', first.revisionId); // priced with the first revision

    writeFileSync(file, override(5, 'owner-2'));
    const second = svc.reloadPrices()!;
    assert.equal(second.error, null);
    assert.notEqual(second.revisionId, first.revisionId);
    assert.equal(ratesFor(second.table, 'claude', 'claude-opus-5-5')?.rates.input, 5, 'new usage priced with the new revision');
    estimate('message:b', second.revisionId);

    const mixed = db.prepare(`SELECT e.covered_scope AS scope, r.revision FROM cost_estimates e JOIN price_revisions r ON r.id = e.price_revision_id
      WHERE e.session_id = ? ORDER BY e.covered_scope`).all(sid).map((r) => ({ ...r }));
    assert.deepEqual(mixed, [{ scope: 'message:a', revision: 'owner-1' }, { scope: 'message:b', revision: 'owner-2' }], 'no automatic repricing; mixed revisions visible');

    writeFileSync(file, '{"CANARY_PRICE_CONTENT": ');
    const bad = svc.reloadPrices()!;
    assert.equal(bad.error, 'override_json');
    assert.equal(bad.revisionId, second.revisionId, 'last valid revision kept');
    svc.stop();

    const logs = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('');
    assert.match(logs, /"prices_invalid"/);
    assert.match(logs, /override_json/);
    assert.doesNotMatch(logs, /CANARY_PRICE_CONTENT|models\.override/, 'no file content or path in logs');
  } finally {
    for (const [c, h] of handlers) unsubscribe(c, h);
  }
  assert.deepEqual(seen, [], 'no socket or HTTP request while prices load');
});

test('G2-8: reloadPrices prices usage that was unpriced (an owner fallback added later), through boot only', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xprices-reload-')));
  const home = join(tmp, 'home');
  const project = join(home, '.claude', 'projects', '-tmp-xaibo-fixture-project');
  mkdirSync(project, { recursive: true });
  const fixture = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'claude', '2.1.319', 'usage-basic');
  for (const f of readdirSync(fixture).filter((n) => n.endsWith('.jsonl'))) {
    writeFileSync(join(project, f), readFileSync(join(fixture, f), 'utf8').replaceAll('"model":"claude-opus-5-5"', '"model":"synthetic-unlisted-model"'));
  }
  const dataDir = join(tmp, 'data');
  const svc = await boot({ dataDir, home, catalog, intervalMs: 60_000 });
  await svc.done;
  const rows = () => svc.store.db.prepare('SELECT amount_usd AS amount, basis, unavailable_reason AS reason, price_revision_id AS rev FROM cost_estimates ORDER BY covered_scope')
    .all().map((r) => ({ ...r }) as { amount: number | null; basis: string; reason: string | null; rev: number | null });
  assert.deepEqual(rows().map((r) => [r.amount, r.reason]), [[null, 'unpriced-model'], [null, 'unpriced-model']]);
  writeFileSync(join(dataDir, 'models.override.json'), JSON.stringify({
    schemaVersion: 1, revision: 'owner-fallback', currency: 'USD', prices_as_of: '2026-11-12', sources: [{ id: 'owner', url: 'https://example.com/prices', retrieved: '2026-11-12' }],
    models: [], fallbacks: [{ models: ['synthetic-unlisted-model'], agent: 'claude', qualifiers: { service_tier: ['standard'], speed: ['standard'] },
      rates: { input: 1, output: 1, cache_read: 1, cache_write: { '5m': 1, '1h': 1 } } }],
  }));
  const next = svc.reloadPrices()!;
  const after = rows();
  assert.ok(after.every((r) => r.basis === 'owner_fallback' && r.rev === next.revisionId && r.reason === null));
  assert.deepEqual(after.map((r) => Math.round(r.amount! * 1e6)), [10 + 100 + 30 + 20, 5 + 140 + 15 + 40]);
  svc.stop();
});
