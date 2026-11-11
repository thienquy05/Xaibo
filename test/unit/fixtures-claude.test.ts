// P0-S9-T7: each Claude 2.1.319 synthetic fixture's expected.json is recomputed from its input lines
// with a tiny tolerant parser; hook fixtures are checked against the S4 payload schemas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'claude', '2.1.319');
const SPIKES = join(import.meta.dirname, '..', '..', 'spikes');
const readJson = (...p: string[]) => JSON.parse(readFileSync(join(...p), 'utf8'));
const KNOWN = new Set<string>(readJson(SPIKES, 's9', 'evidence', 'facts.json').claude.recordTypes);
const CANARY_PLACEHOLDER = '__XAIBO_CANARY__';

type Rec = Record<string, any>;
const uniq = (xs: unknown[]) => [...new Set(xs.filter((x): x is string => typeof x === 'string'))].sort();

// Tolerant: a line that is not a JSON object is counted as malformed; a last line without '\n' is partial.
function parseLines(text: string) {
  const lines = text.split('\n');
  const tail = lines.pop();
  const records: Rec[] = [];
  const malformed: number[] = [];
  lines.forEach((line, i) => {
    if (!line) return;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) records.push(v);
      else malformed.push(i + 1);
    } catch { malformed.push(i + 1); }
  });
  return { records, malformed, partialTrailing: tail ? lines.length + 1 : null };
}

function fileFacts(text: string) {
  const { records, malformed, partialTrailing } = parseLines(text);
  const types: Record<string, number> = {};
  for (const r of records) types[String(r.type)] = (types[String(r.type)] ?? 0) + 1;
  const unknown = records.filter((r) => !KNOWN.has(r.type)).length;
  const uuids = new Set(records.map((r) => r.uuid).filter((u) => typeof u === 'string'));
  const effort = uniq(records.map((r) => r.effort));
  return {
    records, facts: {
      records: records.length, malformed, partialTrailing, types, unknown,
      unknownAbove5pct: records.length > 0 && unknown / records.length > 0.05,
      sessionIds: uniq(records.map((r) => r.sessionId)),
      entrypoints: uniq(records.map((r) => r.entrypoint)),
      models: uniq(records.map((r) => r.message?.model)),
      effort: effort.length ? effort : 'unavailable',
      uuids: uuids.size,
      roots: records.filter((r) => r.parentUuid === null).length,
      danglingParents: records.filter((r) => typeof r.parentUuid === 'string' && !uuids.has(r.parentUuid)).length,
      sidechainRecords: records.filter((r) => r.isSidechain === true).length,
      compactions: records.filter((r) => r.type === 'system' && r.subtype === 'compact_boundary').map((r) => ({
        metadataKeys: Object.keys(r.compactMetadata ?? {}).sort(),
        preTokens: r.compactMetadata?.preTokens, postTokens: r.compactMetadata?.postTokens,
      })),
    },
  };
}

// Usage per message.id: latestWins keeps the last line's usage, otherwise the first (dedupe).
function usage(records: Rec[], latestWins: boolean) {
  const byId = new Map<string, Rec>();
  let lines = 0;
  for (const r of records) {
    const id = r.message?.id, u = r.message?.usage;
    if (r.type !== 'assistant' || typeof id !== 'string' || !u) continue;
    lines++;
    if (latestWins || !byId.has(id)) byId.set(id, u);
  }
  const sum = { messages: byId.size, lines, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 };
  for (const u of byId.values()) {
    sum.input_tokens += u.input_tokens ?? 0;
    sum.output_tokens += u.output_tokens ?? 0;
    sum.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    sum.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    sum.ephemeral_5m_input_tokens += u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    sum.ephemeral_1h_input_tokens += u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  }
  return sum;
}

function summarize(files: Record<string, string>) {
  const all: Rec[] = [];
  const out: Record<string, unknown> = {};
  for (const [rel, text] of Object.entries(files)) {
    const { records, facts } = fileFacts(text);
    all.push(...records);
    out[rel] = facts;
  }
  const subagents = Object.keys(files).flatMap((rel) => {
    const m = /^([^/]+)\/subagents\/agent-(.+)\.jsonl$/.exec(rel);
    return m ? [{ file: rel, parentSessionId: m[1], agentId: m[2], parentTranscriptPresent: `${m[1]}.jsonl` in files }] : [];
  });
  assert.deepEqual(usage(all, false), usage(all, true), 'S9: usage identical across partial lines, so dedupe equals latest-wins');
  return { files: out, subagents, usage: usage(all, true) };
}

const readCase = (dir: string) => Object.fromEntries(readdirSync(dir, { recursive: true }).map(String)
  .filter((f) => f.endsWith('.jsonl')).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

const cases = readdirSync(ROOT).filter((c) => c !== 'hooks').sort();

test('all Claude 2.1.319 transcript cases are present', () => {
  assert.deepEqual(cases, ['canary', 'compaction', 'compressed-source', 'entrypoints', 'identifiers',
    'model-effort', 'partial-line', 'unknown-records', 'usage-basic']);
});

for (const c of cases) {
  test(`claude 2.1.319 ${c}: expected.json recomputed from inputs`, () => {
    const dir = join(ROOT, c);
    const files = readCase(dir);
    let canary = '';
    if (c === 'canary') {
      // Credential-shaped string built at test time; never a literal in a committed file.
      canary = ['sk', 'ant', 'api03', randomBytes(24).toString('hex')].join('-');
      for (const [rel, text] of Object.entries(files)) {
        assert.ok(text.includes(CANARY_PLACEHOLDER));
        files[rel] = text.replaceAll(CANARY_PLACEHOLDER, canary);
      }
    }
    if (c === 'compressed-source') {
      for (const [rel, text] of Object.entries(files)) {
        const z = zstdCompressSync(Buffer.from(text));
        const back = zstdDecompressSync(z).toString('utf8');
        assert.deepEqual(back.split('\n'), text.split('\n'));
        files[rel] = back;
      }
    }
    const facts = summarize(files);
    assert.deepEqual(facts, readJson(dir, 'expected.json').facts);
    if (canary) assert.ok(!JSON.stringify(facts).includes(canary), 'canary leaked into facts');
  });
}

// Hooks: every payload key path is in the S4 schema, always-present keys are there, allowlisted values match.
const S4 = join(SPIKES, 's4', 'evidence', 'hooks');
const REDUCED = readJson(S4, 'reduced.json');
function walk(v: unknown, p: string, out: Map<string, unknown[]>) {
  if (p) out.set(p, [...(out.get(p) ?? []), v]);
  if (Array.isArray(v)) for (const x of v) walk(x, `${p}[]`, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k, out);
}

for (const c of readdirSync(join(ROOT, 'hooks')).sort()) {
  test(`claude 2.1.319 hooks/${c}: payloads match S4 schemas`, () => {
    const dir = join(ROOT, 'hooks', c);
    // One raw stdin payload per line, as the agent sends it (same shape as the Codex hook fixtures).
    const lines = readFileSync(join(dir, 'hooks.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.hook_event_name), readJson(dir, 'expected.json').events);
    for (const payload of lines) {
      const event = payload.hook_event_name;
      const schema = new Set(Object.keys(readJson(S4, `${event}.schema.json`)));
      const paths = new Map<string, unknown[]>();
      walk(payload, '', paths);
      assert.deepEqual([...paths.keys()].filter((k) => !schema.has(k)), [], `${event}: keys outside the S4 schema`);
      const red = REDUCED[event];
      for (const [k, x] of Object.entries<any>(red.keys)) {
        if (x.present === red.count) assert.ok(paths.has(k), `${event}: always-present key ${k} missing`);
        if (x.values) for (const v of paths.get(k) ?? []) assert.ok(x.values.includes(v), `${event}: ${k} value not observed`);
      }
    }
  });
}
