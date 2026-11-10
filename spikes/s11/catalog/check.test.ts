import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_IDS, checkEntry, loadJson, validate } from './check.ts';

const HERE = import.meta.dirname;
const SCHEMA = join(HERE, 'agents.catalog.schema.draft.json');
const NEG = join(HERE, 'negative');

// How each fixture is loaded: bundled entries ship with the app, everything else is a private import.
const POSITIVE: Record<string, boolean> = { 'gemini.entry.json': false, 'synthetic-agent.entry.json': true };
// Negative file -> substring its first error must contain.
const NEGATIVE: Record<string, string> = {
  'unknown-field.json': 'additionalProperties',
  'shell-string-launch.json': 'pattern',
  'shell-binary-launch.json': '/detection/binaries/0/names/0: pattern',
  'imported-shadows-bundled.json': 'shadows bundled',
  'profile-root-escape.json': 'pattern',
  'code-field.json': 'additionalProperties',
  'acp-declaration.json': 'additionalProperties',
};

test('positive entries validate with no errors', () => {
  const schema = loadJson(SCHEMA);
  for (const [f, imported] of Object.entries(POSITIVE)) assert.deepEqual(checkEntry(schema, loadJson(join(HERE, f)), { imported }), [], f);
});

test('every negative entry fails for its intended reason', () => {
  const schema = loadJson(SCHEMA);
  assert.deepEqual(readdirSync(NEG).sort(), Object.keys(NEGATIVE).sort(), 'negative set is exactly the declared one');
  for (const [f, reason] of Object.entries(NEGATIVE)) {
    const errs = checkEntry(schema, loadJson(join(NEG, f)), { imported: true });
    assert.ok(errs.length > 0, `${f} must fail`);
    assert.ok(errs.some((e) => e.includes(reason)), `${f}: expected "${reason}" in ${JSON.stringify(errs)}`);
  }
});

test('every object schema in the draft sets additionalProperties: false', () => {
  const open: string[] = [];
  const walk = (s: unknown, at: string): void => {
    if (!s || typeof s !== 'object') return;
    const o = s as Record<string, unknown>;
    if (o.type === 'object' && o.additionalProperties !== false) open.push(at || '/');
    for (const [k, v] of Object.entries(o)) walk(v, `${at}/${k}`);
  };
  walk(loadJson(SCHEMA), '');
  assert.deepEqual(open, []);
});

test('bundled IDs stay bundled-only; the checker refuses schema keywords it does not implement', () => {
  assert.deepEqual([...BUNDLED_IDS], ['claude', 'codex', 'gemini']);
  assert.throws(() => validate({ type: 'object', oneOf: [] }, {}), /unsupported keyword oneOf/);
  assert.throws(() => validate({ $ref: 'https://example.invalid/s.json' }, {}), /local \$ref only/);
});
