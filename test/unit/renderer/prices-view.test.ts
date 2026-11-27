// XAIBO-PROD-568 (P6-T11; design §6.6 Local prices / Owner-set fallback, C30, §6.11 price rates): the Settings price texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asOfText, checkText, errorText, fallbackRows, rateText, reloadText, revealText, sourceText } from '../../../src/renderer/settings/prices-view.ts';
import { PRICE_ERRORS, type PriceView } from '../../../src/shared/ipc.ts';

const view = (o: Partial<PriceView> = {}): PriceView => ({ source: 'bundled', revision: '2026-11-12.1', pricesAsOf: '2026-11-12', error: null, fallbacks: [], ...o });

test('current revision line (C30) and source', () => {
  assert.equal(asOfText(view()), 'Prices as of 2026-11-12, revision 2026-11-12.1');
  assert.equal(sourceText(view()), 'Bundled table');
  assert.equal(sourceText(view({ source: 'override' })), 'Override file');
});

test('every error code has plain text; Validate and Reload results never claim a switch they did not make', () => {
  for (const e of PRICE_ERRORS) assert.ok(errorText(e).length > 0, e);
  assert.equal(errorText('override_schema'), 'it does not match the price schema');
  assert.equal(checkText('valid'), 'The override file is valid. Reload to use it.');
  // code review 1: a deleted override is still in use until Reload, so Validate never claims bundled prices are in use
  assert.equal(checkText('absent'), 'No override file found. Reload would use the bundled prices.');
  assert.equal(checkText('override_json'), 'Not valid: it is not valid JSON. Prices are unchanged.');
  assert.equal(reloadText(view({ error: 'override_too_large', source: 'override' })), 'Override not used: it is larger than 1 MiB. The last valid prices stay in use.');
  assert.equal(reloadText(view({ source: 'override' })), 'Override prices loaded.');
  assert.equal(reloadText(view()), 'No override file: bundled prices are in use.');
});

test('reveal results: the file, a missing file, a path that is not a regular file, a failure (never a path)', () => {
  assert.equal(revealText('file'), 'Shown in Finder.');
  assert.equal(revealText('missing'), 'No override file yet. Its folder is shown in Finder.');
  assert.equal(revealText('folder'), 'The override path is not a regular file. Its folder is shown in Finder.');
  assert.equal(revealText('failed'), 'Finder could not show the file.');
});

test('rates are exact source decimals in USD per 1,000,000 tokens, never rounded or in exponent form', () => {
  assert.equal(rateText(0.2), '0.2');
  assert.equal(rateText(3), '3');
  assert.equal(rateText(0.0000001), '0.0000001');
  assert.equal(rateText(1.123456789), '1.123456789');
  assert.equal(rateText(100000), '100000');
});

test('owner-set fallbacks: exact models, scope and each rate component', () => {
  const rows = fallbackRows(view({ fallbacks: [
    { models: ['model-a', 'model-b'], agent: null, rates: { input: 1, output: 2, cache_read: 0.1, cache_write: { '5m': 1.25, '1h': 2 } } },
    { models: ['model-c'], agent: 'codex', rates: { input: 0.5, output: 4 } },
  ] }));
  assert.deepEqual(rows, [
    { key: '0', models: 'model-a, model-b', scope: 'All agents', rates: [
      { label: 'Input', text: 'USD 1 per 1,000,000 tokens' }, { label: 'Output', text: 'USD 2 per 1,000,000 tokens' },
      { label: 'Cache read', text: 'USD 0.1 per 1,000,000 tokens' }, { label: 'Cache write (5m)', text: 'USD 1.25 per 1,000,000 tokens' },
      { label: 'Cache write (1h)', text: 'USD 2 per 1,000,000 tokens' }] },
    { key: '1', models: 'model-c', scope: 'Agent codex', rates: [
      { label: 'Input', text: 'USD 0.5 per 1,000,000 tokens' }, { label: 'Output', text: 'USD 4 per 1,000,000 tokens' }] },
  ]);
  assert.deepEqual(fallbackRows(view()), []);
});
