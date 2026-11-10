// P0-S9-T7: recomputes every Codex 0.160.0 fixture's expected.json from its input lines.
// The parser is a tiny local reader for the fixtures only (tolerant: malformed and partial lines are counted, skipped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0');
const FACTS = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'spikes', 's9', 'evidence', 'facts.json'), 'utf8')).codex;
const KNOWN = new Set<string>(FACTS.recordTypes);
const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

type Obj = Record<string, any>;
const readJson = (...p: string[]): Obj => JSON.parse(readFileSync(join(ROOT, ...p), 'utf8'));
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

function parseLines(text: string) {
  const parts = text.split('\n');
  const partialTrailing = parts.pop() !== '';
  const records: Obj[] = [];
  const malformedLines: number[] = [];
  parts.forEach((line, i) => {
    if (!line) return;
    try { records.push(JSON.parse(line)); } catch { malformedLines.push(i + 1); }
  });
  return { lines: parts.length, malformedLines, partialTrailing, records };
}

// Codex cached input is a subset of input (PRD §5.5): uncached = input - cached; reasoning stays inside output.
const norm = (u: Obj) => ({
  uncachedInput: u.input_tokens - u.cached_input_tokens, cacheRead: u.cached_input_tokens,
  cacheWrite: u.cache_write_input_tokens, output: u.output_tokens, reasoningOutput: u.reasoning_output_tokens, total: u.total_tokens,
});
const window = (w: Obj) => ({ usedPercent: w.used_percent, windowMinutes: w.window_minutes, resetsAtMs: w.resets_at * 1000 });
const uniq = <T>(xs: T[]) => [...new Set(xs)];

function summarizeRollout(name: string, text: string) {
  const { lines, malformedLines, partialTrailing, records } = parseLines(text);
  const recordTypes: Record<string, number> = {};
  for (const r of records) recordTypes[r.type] = (recordTypes[r.type] ?? 0) + 1;
  const unknownRecords = records.filter((r) => !KNOWN.has(r.type)).length;
  const meta = records.find((r) => r.type === 'session_meta')?.payload;
  const turns = records.filter((r) => r.type === 'turn_context').map((r) => r.payload);
  const infos = records.filter((r) => r.type === 'event_msg' && r.payload?.type === 'token_count' && r.payload.info).map((r) => r.payload.info);
  const limits = records.filter((r) => r.type === 'event_msg' && r.payload?.rate_limits).map((r) => r.payload.rate_limits);
  const usages = infos.flatMap((i) => [i.total_token_usage, i.last_token_usage]);
  const last = infos.at(-1);
  const rl = limits.at(-1);
  return {
    lines, malformedLines, partialTrailing, recordTypes, unknownRecords,
    unknownShareAbove5pct: records.length > 0 && unknownRecords / records.length > 0.05,
    session: meta ? {
      id: meta.id, filenameIdMatchesMeta: ROLLOUT.exec(name)?.[1] === meta.id, source: meta.source,
      originator: meta.originator, cwd: meta.cwd, cliVersion: meta.cli_version,
    } : null,
    turnIds: uniq(turns.map((t) => t.turn_id)),
    models: uniq(turns.map((t) => t.model)),
    efforts: uniq(turns.filter((t) => t.collaboration_mode?.settings && 'reasoning_effort' in t.collaboration_mode.settings)
      .map((t) => t.collaboration_mode.settings.reasoning_effort)),
    usage: last ? {
      tokenCountEvents: infos.length, modelContextWindow: last.model_context_window,
      total: norm(last.total_token_usage), last: norm(last.last_token_usage),
      cumulativeNonDecreasing: infos.every((i, k) => k === 0 || Object.keys(i.total_token_usage)
        .every((key) => i.total_token_usage[key] >= infos[k - 1].total_token_usage[key])),
      cachedSubsetOfInput: usages.every((u) => u.cached_input_tokens <= u.input_tokens),
      reasoningSubsetOfOutput: usages.every((u) => u.reasoning_output_tokens <= u.output_tokens),
    } : null,
    rateLimits: rl ? { primary: window(rl.primary), secondary: window(rl.secondary) } : null,
  };
}

function summarizeHooks(text: string) {
  const { lines, malformedLines, records } = parseLines(text);
  const events: Record<string, number> = {};
  const turns: Record<string, string[]> = {};
  for (const r of records) {
    events[r.hook_event_name] = (events[r.hook_event_name] ?? 0) + 1;
    if (r.turn_id) (turns[r.turn_id] ??= []).push(r.hook_event_name);
  }
  return { lines, malformedLines, events, sessionIds: uniq(records.map((r) => r.session_id)), turns, interrupted: 'Interrupt' in events };
}

// Keyed by the filename UUID: full rollout names trip the privacy scanner's opaque-id rule.
function rollouts(dir: string, override: Record<string, string> = {}) {
  return Object.fromEntries(readdirSync(join(ROOT, dir)).filter((f) => ROLLOUT.test(f))
    .map((f) => [ROLLOUT.exec(f)![1], summarizeRollout(f, override[f] ?? read(dir, f))]));
}

for (const c of ['usage-basic', 'identifiers', 'unknown-records', 'partial-line', 'compaction', 'entrypoints', 'rate-limits', 'model-effort']) {
  test(`codex 0.160.0 ${c}`, () => assert.deepEqual(rollouts(c), readJson(c, 'expected.json').files));
}

test('codex 0.160.0 compaction stays unverified and unfixtured', () => {
  assert.equal(readJson('compaction', 'expected.json').compaction.verified, FACTS.compaction.recorded);
  assert.equal(KNOWN.has('compacted'), false);
});

test('codex 0.160.0 model-effort: only null effort observed', () => {
  assert.deepEqual(FACTS.effortValues, []);
  assert.equal(readJson('model-effort', 'expected.json').effort.nonNullValuesVerified, false);
});

test('codex 0.160.0 compressed-source round-trips through zstd', () => {
  const [name] = readdirSync(join(ROOT, 'compressed-source')).filter((f) => ROLLOUT.test(f));
  const plain = read('compressed-source', name);
  const unpacked = zstdDecompressSync(zstdCompressSync(Buffer.from(plain))).toString('utf8');
  assert.deepEqual(unpacked.split('\n'), plain.split('\n'));
  assert.deepEqual({ [ROLLOUT.exec(name)![1]]: summarizeRollout(name, unpacked) }, readJson('compressed-source', 'expected.json').files);
});

test('codex 0.160.0 canary never reaches the summary', () => {
  // Credential-shaped string assembled at test time; never a committed literal.
  const canary = ['sk', 'proj', randomBytes(24).toString('base64url')].join('-');
  const [name] = readdirSync(join(ROOT, 'canary')).filter((f) => ROLLOUT.test(f));
  const line = JSON.stringify({
    timestamp: '2026-01-01T00:00:04.000Z', ordinal: 4, type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: canary }] },
  });
  const files = rollouts('canary', { [name]: `${read('canary', name)}${line}\n` });
  assert.deepEqual(files, readJson('canary', 'expected.json').files);
  assert.equal(JSON.stringify(files).includes(canary), false);
});

// Hook payloads: every key path is in the S5 schema, always-present keys are there, allowlisted values match.
const S5 = join(import.meta.dirname, '..', '..', 'spikes', 's5', 'evidence', 'hooks');
const REDUCED = JSON.parse(readFileSync(join(S5, 'reduced.json'), 'utf8'));
function walk(v: unknown, p: string, out: Map<string, unknown[]>) {
  if (p) out.set(p, [...(out.get(p) ?? []), v]);
  if (Array.isArray(v)) for (const x of v) walk(x, `${p}[]`, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k, out);
}

for (const c of ['simple-turn', 'interrupted-turn']) {
  test(`codex 0.160.0 hooks ${c}`, () => {
    const text = read('hooks', c, 'hooks.jsonl');
    assert.deepEqual(summarizeHooks(text), readJson('hooks', c, 'expected.json').hooks);
    for (const payload of parseLines(text).records) {
      const event = payload.hook_event_name;
      const schema = new Set(Object.keys(JSON.parse(readFileSync(join(S5, `${event}.schema.json`), 'utf8'))));
      const paths = new Map<string, unknown[]>();
      walk(payload, '', paths);
      assert.deepEqual([...paths.keys()].filter((k) => !schema.has(k)), [], `${event}: keys outside the S5 schema`);
      const red = REDUCED[event];
      for (const [k, x] of Object.entries<any>(red.keys)) {
        if (x.present === red.count) assert.ok(paths.has(k), `${event}: always-present key ${k} missing`);
        if (x.values) for (const v of paths.get(k) ?? []) assert.ok(x.values.includes(v), `${event}: ${k} value not observed`);
      }
    }
  });
}

test('codex 0.160.0 hooks untrusted-installed: no hook lines, rollout still written', () => {
  const expected = readJson('hooks', 'untrusted-installed', 'expected.json');
  assert.equal(read('hooks', 'untrusted-installed', 'hooks.jsonl'), '');
  assert.deepEqual(summarizeHooks(''), expected.hooks);
  assert.equal(expected.rolloutsStillWritten, true);
  assert.deepEqual(rollouts(join('hooks', 'untrusted-installed')), expected.files);
});

test('codex 0.160.0 hooks permission: PermissionRequest not verified, no payload fixtured', () => {
  assert.equal(readJson('hooks', 'permission', 'expected.json').verified, false);
  assert.equal(existsSync(join(ROOT, 'hooks', 'permission', 'hooks.jsonl')), false);
});
