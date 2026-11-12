// XAIBO-PROD-208 (P2-T08, EC-101, FR-51, OQ-P2-05): display names — an agent-provided name only for its own model id,
// then the bundled list's display_name, then the raw id; no evidence -> "Model unavailable"; never a family guess.
// The label adds effort only when the agent exposes it. The bundled models.json is strict, sourced (URL + retrieval
// date) and unverified until the owner checks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayName, loadModels, modelLabel, validateModels } from '../../src/service/usage/models.ts';

const list = loadModels();
const models = list.models;

test('EC-101: no evidence, listed id, unlisted id (raw, no family guess)', () => {
  assert.equal(displayName(models, null), 'Model unavailable');
  assert.equal(displayName(models, 'claude-opus-5-5'), 'Claude Opus 5.5');
  assert.equal(displayName(models, 'gpt-6.1-sol'), 'GPT-6.1 Sol');
  assert.equal(displayName(models, 'claude-opus-5-5-experimental'), 'claude-opus-5-5-experimental');
  assert.equal(displayName(models, 'CLAUDE-OPUS-5-5'), 'CLAUDE-OPUS-5-5', 'exact ids only');
});

test('EC-101: an agent-provided name wins only for the matching model id; a stale name is ignored', () => {
  assert.equal(displayName(models, 'claude-opus-5-5', { modelId: 'claude-opus-5-5', name: 'Opus 5.5 (1M context)' }), 'Opus 5.5 (1M context)');
  assert.equal(displayName(models, 'claude-sonnet-5-5', { modelId: 'claude-opus-5-5', name: 'Opus 5.5' }), 'Claude Sonnet 5.5', 'name for an older model id');
  assert.equal(displayName(models, null, { modelId: 'claude-opus-5-5', name: 'Opus 5.5' }), 'Model unavailable');
});

test('label: effort beside the name only when exposed; agy (no Phase 2 evidence) stays unavailable, effort omitted', () => {
  assert.equal(modelLabel('GPT-6.1 Sol', 'high'), 'GPT-6.1 Sol · high');
  assert.equal(modelLabel('Claude Opus 5.5', null), 'Claude Opus 5.5');
  assert.equal(modelLabel(displayName(models, null), null), 'Model unavailable');
});

test('bundled models.json: sourced, dated, unique ids, observed models present, owner-verified (OQ-P2-05, D-P2-05)', () => {
  assert.deepEqual(validateModels(list), []);
  assert.equal(list.currency, 'USD');
  assert.match(list.prices_as_of, /^\d{4}-\d{2}-\d{2}$/);
  const sources = new Set(list.sources.map((s) => s.id));
  assert.ok(list.sources.every((s) => s.url.startsWith('https://') && /^\d{4}-\d{2}-\d{2}$/.test(s.retrieved)));
  assert.ok(models.every((m) => sources.has(m.source)), 'every entry names a listed source');
  assert.equal(new Set(models.map((m) => m.id)).size, models.length);
  for (const id of ['claude-opus-5-5', 'gpt-6.1-sol']) assert.ok(models.some((m) => m.id === id), `${id} (seen in S9) is listed`);
  assert.ok(models.every((m) => m.prices_verified === true), 'owner verified the drafted rates 2026-11-12 (D-P2-05)');
});

test('schema refuses unknown fields, missing names, negative rates, non-https sources and tiers without a threshold', () => {
  const m = models[0]!;
  const withModel = (x: object) => ({ ...list, models: [x] });
  assert.deepEqual(validateModels(withModel(m)), []);
  const { display_name: _d, ...noName } = m;
  for (const [what, bad] of [
    ['extra field', withModel({ ...m, guess: true })],
    ['no display name', withModel(noName)],
    ['negative rate', withModel({ ...m, rates: { ...m.rates, input: -1 } })],
    ['tier without threshold', withModel({ ...m, tiers: [{ rates: m.rates }] })],
    ['http source', { ...list, sources: [{ ...list.sources[0]!, url: 'http://example.com' }] }],
    ['schema version', { ...list, schemaVersion: 2 }],
  ] as const) assert.notDeepEqual(validateModels(bad), [], what);
});
