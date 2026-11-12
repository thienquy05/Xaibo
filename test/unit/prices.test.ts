// XAIBO-PROD-209 (P2-T09, EC-96): bundled models.json plus the private models.override.json (untrusted local file).
// A valid edit is a new immutable revision; an invalid one reports a fixed code and keeps the last valid revision (also
// across a restart); an unknown model has no rates; an owner fallback applies only to its exact ids (and agent), labelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/service/store/db.ts';
import { loadModels } from '../../src/service/usage/models.ts';
import { loadPrices, ratesFor } from '../../src/service/usage/prices.ts';

const bundled = loadModels();
const override = (o: Record<string, unknown> = {}) => ({
  schemaVersion: 1, revision: 'owner-1', currency: 'USD', prices_as_of: '2026-11-12',
  sources: [{ id: 'owner', url: 'https://example.com/prices', retrieved: '2026-11-12' }],
  models: [
    { id: 'claude-opus-5-5', display_name: 'Opus (owner)', source: 'owner', prices_verified: true, rates: { input: 3, output: 15 } },
    { id: 'synthetic-model-x', display_name: 'Synthetic X', source: 'owner', prices_verified: true, rates: { input: 1, output: 2 } },
  ],
  ...o,
});

async function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'xprices-'));
  const store = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'backups') });
  const file = join(tmp, 'models.override.json');
  const write = (v: unknown) => writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v));
  const revisions = () => Number((store.db.prepare('SELECT count(*) AS n FROM price_revisions').get() as { n: number }).n);
  return { tmp, db: store.db, file, write, revisions };
}

test('EC-96: absent override -> bundled only, accepted once as a revision', async () => {
  const s = await setup();
  const p = loadPrices({ db: s.db, overridePath: s.file });
  assert.equal(p.error, null);
  assert.equal(p.source, 'bundled');
  assert.equal(p.table.revision, bundled.revision);
  assert.ok(p.revisionId);
  assert.equal(loadPrices({ db: s.db, overridePath: s.file }).revisionId, p.revisionId, 'same content, same revision');
  assert.equal(s.revisions(), 1);
});

test('EC-96: a valid edit is a new revision; entries merge by exact id; display names follow the override', async () => {
  const s = await setup();
  const first = loadPrices({ db: s.db, overridePath: s.file });
  s.write(override());
  const p = loadPrices({ db: s.db, overridePath: s.file, previous: first });
  assert.equal(p.error, null);
  assert.equal(p.source, 'override');
  assert.notEqual(p.revisionId, first.revisionId);
  assert.equal(p.table.revision, 'owner-1');
  assert.deepEqual(ratesFor(p.table, 'claude', 'claude-opus-5-5')?.rates, { input: 3, output: 15 });
  assert.equal(ratesFor(p.table, 'claude', 'claude-opus-5-5')?.basis, 'token_table');
  assert.equal(ratesFor(p.table, 'claude', 'claude-sonnet-5-5')?.rates.input, 2, 'bundled entries the override does not name stay');
  assert.equal(p.table.models.find((m) => m.id === 'claude-opus-5-5')?.display_name, 'Opus (owner)');
  assert.equal(s.revisions(), 2);
  const body = JSON.parse((s.db.prepare('SELECT body FROM price_revisions WHERE id = ?').get(p.revisionId) as { body: string }).body) as Record<string, unknown>;
  assert.equal(body.bundled_revision, bundled.revision, 'provenance names the bundled revision under the override');
  assert.throws(() => s.db.prepare("UPDATE price_revisions SET body = '{}'").run(), /immutable/);
});

test('EC-96: an invalid edit reports a fixed code and keeps the last valid revision, also after a restart', async () => {
  const s = await setup();
  s.write(override());
  const good = loadPrices({ db: s.db, overridePath: s.file });
  const cases: [unknown, string][] = [
    ['{"schemaVersion": 1, CANARY-not-json', 'override_json'],
    [override({ extra: true }), 'override_schema'],
    [override({ models: [{ id: 'm', display_name: 'M', source: 'nowhere', prices_verified: true, rates: { input: 1, output: 1 } }] }), 'override_schema'],
    [override({ models: [{ id: 'm', display_name: 'M', source: 'owner', prices_verified: true, rates: { input: -1, output: 1 } }] }), 'override_schema'],
  ];
  for (const [content, code] of cases) {
    s.write(content);
    const p = loadPrices({ db: s.db, overridePath: s.file, previous: good });
    assert.equal(p.error, code);
    assert.equal(p.revisionId, good.revisionId);
    assert.deepEqual(p.table, good.table);
    const restarted = loadPrices({ db: s.db, overridePath: s.file }); // no in-memory state: the kv pointer
    assert.equal(restarted.error, code);
    assert.equal(restarted.revisionId, good.revisionId);
    assert.deepEqual(restarted.table, good.table);
  }
  assert.equal(s.revisions(), 1, 'nothing invalid is ever written');
});

test('EC-96: only a bounded regular file is read (symlink, directory, FIFO, oversize refused)', async () => {
  const s = await setup();
  const target = join(s.tmp, 'elsewhere.json');
  writeFileSync(target, JSON.stringify(override()));
  symlinkSync(target, s.file);
  assert.equal(loadPrices({ db: s.db, overridePath: s.file }).error, 'override_not_regular');
  const dir = join(s.tmp, 'dir.json');
  mkdirSync(dir);
  assert.equal(loadPrices({ db: s.db, overridePath: dir }).error, 'override_not_regular');
  const fifo = join(s.tmp, 'fifo.json');
  execFileSync('mkfifo', [fifo]);
  assert.equal(loadPrices({ db: s.db, overridePath: fifo }).error, 'override_not_regular', 'never blocks on a FIFO');
  const big = join(s.tmp, 'big.json');
  writeFileSync(big, ' '.repeat((1 << 20) + 1));
  assert.equal(loadPrices({ db: s.db, overridePath: big }).error, 'override_too_large');
});

test('EC-96: unknown model -> no rates; unverified rates price nothing', async () => {
  const s = await setup();
  s.write(override({ models: [{ id: 'unverified-y', display_name: 'Y', source: 'owner', prices_verified: false, rates: { input: 1, output: 1 } }] }));
  const p = loadPrices({ db: s.db, overridePath: s.file });
  assert.equal(ratesFor(p.table, 'codex', 'no-such-model'), null);
  assert.equal(ratesFor(p.table, 'codex', 'unverified-y'), null);
  assert.equal(ratesFor(p.table, 'codex', null), null);
});

test('EC-96: owner fallback only for its exact ids and agent, labelled; a priced entry wins (D-P2-06)', async () => {
  const s = await setup();
  s.write(override({ fallbacks: [
    { models: ['gemini-3.8-flash-high', 'unverified-y'], agent: 'agy', rates: { input: 0.5, output: 1 } },
    { models: ['claude-opus-5-5'], rates: { input: 99, output: 99 } },
  ], models: [{ id: 'unverified-y', display_name: 'Y', source: 'owner', prices_verified: false, rates: { input: 1, output: 1 } }] }));
  const p = loadPrices({ db: s.db, overridePath: s.file });
  assert.equal(p.error, null);
  assert.deepEqual(ratesFor(p.table, 'agy', 'gemini-3.8-flash-high'), { modelId: 'gemini-3.8-flash-high', rates: { input: 0.5, output: 1 }, basis: 'owner_fallback' });
  assert.equal(ratesFor(p.table, 'agy', 'unverified-y')?.basis, 'owner_fallback');
  assert.equal(ratesFor(p.table, 'codex', 'gemini-3.8-flash-high'), null, 'outside the agent scope');
  assert.equal(ratesFor(p.table, 'agy', 'gemini-3.8-flash'), null, 'no prefix or family match');
  assert.equal(ratesFor(p.table, 'claude', 'claude-opus-5-5')?.basis, 'token_table', 'a verified table entry wins');
});

test('EC-96: a bundled list carrying fallbacks is refused (no silent fallback rate)', async () => {
  const s = await setup();
  const file = join(s.tmp, 'bundled.json');
  writeFileSync(file, JSON.stringify({ ...bundled, fallbacks: [{ models: ['x'], rates: { input: 1, output: 1 } }] }));
  assert.throws(() => loadPrices({ db: s.db, overridePath: s.file, bundled: new URL(`file://${file}`) }), /fallbacks/);
});

test('a read-only store: prices load in memory, nothing is written', async () => {
  const s = await setup();
  s.write(override());
  const p = loadPrices({ db: null, overridePath: s.file });
  assert.equal(p.error, null);
  assert.equal(p.revisionId, null);
  assert.equal(s.revisions(), 0);
});
