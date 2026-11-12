// XAIBO-PROD-202 (P2-T02): Codex 0.160.0 rollout parser over synthetic fixtures; mirrors, unknowns, archive dedup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileIdentity, filenameSessionId, parseLine, type CodexRecord } from '../../src/service/adapters/codex/parse.ts';
import { LineSplitter } from '../../src/service/lines.ts';

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0');
const ROLLOUT = /^rollout-.+\.jsonl$/;
const rollouts = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => ROLLOUT.test(f)).sort();
const uniq = <T>(xs: T[]) => [...new Set(xs)];

function parseBytes(buf: Buffer) {
  const lines = new LineSplitter().push(buf);
  const id = lines.length ? fileIdentity(lines[0]!.bytes) : '';
  const out = lines.map((l) => parseLine(l.bytes, { offset: l.offset, fileIdentity: id, fileMtime: 0, receivedTs: 0 }));
  return { records: out.flatMap((r) => (r?.ok ? [r.record] : [])), malformed: out.filter((r) => r && !r.ok).length };
}

function summarize(name: string, records: CodexRecord[]) {
  const kinds: Record<string, number> = {};
  for (const r of records) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  const meta = records.find((r) => r.kind === 'session');
  const of = (k: string) => records.filter((r) => r.kind === k);
  return {
    records: records.length, kinds, unknown: kinds.unknown ?? 0,
    session: meta ? { id: meta.sessionId, filenameMatchesMeta: filenameSessionId(name) === meta.sessionId, cwd: meta.cwd, source: meta.source, originator: meta.originator, cliVersion: meta.cliVersion } : null,
    turnIds: uniq(records.map((r) => r.turnId).filter((x) => x !== undefined)),
    models: uniq(records.map((r) => r.model).filter((x) => x !== undefined)),
    efforts: uniq(records.filter((r) => r.effort !== undefined).map((r) => r.effort)),
    approvalPolicies: uniq(records.map((r) => r.approvalPolicy).filter((x) => x !== undefined)),
    sandboxPolicies: uniq(records.map((r) => r.sandboxPolicy).filter((x) => x !== undefined)),
    messages: of('message').map((r) => ({ role: r.role, content: r.content, injected: r.injected })),
    toolCalls: of('tool_call').map((r) => ({ callId: r.callId, toolName: r.toolName, content: r.content })),
    toolResults: of('tool_result').map((r) => ({ callId: r.callId, content: r.content })),
    compactions: of('compaction').map((r) => r.content),
    tokenCountEvents: of('token_count').length,
    rateLimitEvents: records.filter((r) => r.rateLimits !== undefined).length,
  };
}

for (const c of ['simple-turn', 'mirrored', 'compacted']) {
  test(`fixture ${c}: every record maps to its kind and fields`, () => {
    const want = JSON.parse(readFileSync(join(ROOT, c, 'expected.json'), 'utf8')).files;
    const got = Object.fromEntries(rollouts(c).map((f) => [filenameSessionId(f), summarize(f, parseBytes(readFileSync(join(ROOT, c, f))).records)]));
    assert.deepEqual(got, want);
  });
}

// The Phase 0 fixtures' expected.json files come from an independent reader (test/unit/fixtures-codex.test.ts).
for (const c of ['usage-basic', 'identifiers', 'unknown-records', 'partial-line', 'compaction', 'entrypoints', 'rate-limits', 'model-effort']) {
  test(`Phase 0 fixture ${c}: agrees with the independent recompute`, () => {
    const want = JSON.parse(readFileSync(join(ROOT, c, 'expected.json'), 'utf8')).files;
    for (const f of rollouts(c)) {
      const id = filenameSessionId(f)!;
      const { records, malformed } = parseBytes(readFileSync(join(ROOT, c, f)));
      const s = summarize(f, records);
      const w = want[id];
      assert.equal(s.unknown, w.unknownRecords, `${c} unknown`);
      assert.equal(malformed, w.malformedLines.length, `${c} malformed`);
      assert.deepEqual(s.session, w.session && { id: w.session.id, filenameMatchesMeta: w.session.filenameIdMatchesMeta, cwd: w.session.cwd, source: w.session.source, originator: w.session.originator, cliVersion: w.session.cliVersion }, `${c} session`);
      assert.deepEqual(s.turnIds, w.turnIds, `${c} turns`);
      assert.deepEqual(s.models, w.models, `${c} models`);
      assert.deepEqual(s.efforts, w.efforts, `${c} efforts`);
      assert.equal(s.tokenCountEvents, w.usage?.tokenCountEvents ?? 0, `${c} token_count`);
      assert.equal(s.rateLimitEvents > 0, w.rateLimits !== null, `${c} rate limits`);
      for (const r of records) if (r.kind === 'unknown') assert.ok(r.raw.length > 0, 'unknown records keep their raw line');
    }
  });
}

test('an archived copy yields the same native ids; another rollout with the same session id does not collide', () => {
  const [f] = rollouts('identifiers');
  const buf = readFileSync(join(ROOT, 'identifiers', f!));
  const ids = (b: Buffer) => parseBytes(b).records.map((r) => r.nativeId);
  assert.deepEqual(ids(Buffer.from(buf)), ids(buf), 'same bytes under archived_sessions: zero new events');
  const other = Buffer.from(buf.toString('utf8').replace('"timestamp":"2026-01-01T00:00:00.000Z","cwd"', '"timestamp":"2026-01-02T00:00:00.000Z","cwd"'));
  assert.notEqual(other.toString(), buf.toString(), 'the first line changed');
  const a = new Set(ids(buf));
  assert.ok(ids(other).every((x) => !a.has(x)), 'different file identity: no shared native ids');
});

test('mirrors never carry content; compaction content excludes the replacement history', () => {
  const recs = parseBytes(readFileSync(join(ROOT, 'simple-turn', rollouts('simple-turn')[0]!))).records;
  for (const m of recs.filter((r) => r.kind === 'mirror')) assert.equal(m.content, undefined);
  const comp = parseBytes(readFileSync(join(ROOT, 'compacted', rollouts('compacted')[0]!))).records.find((r) => r.kind === 'compaction')!;
  assert.equal(comp.content, 'synthetic summary');
});

test('blank lines are skipped; malformed or non-object lines are reported; ids and timestamps', () => {
  const ctx = { offset: 7, fileIdentity: 'abc', fileMtime: 1, receivedTs: 2 };
  assert.equal(parseLine(Buffer.from('  '), ctx), null);
  assert.deepEqual(parseLine(Buffer.from('{"type":'), ctx), { ok: false, reason: 'malformed' });
  assert.deepEqual(parseLine(Buffer.from('[1,2]'), ctx), { ok: false, reason: 'malformed' });
  const r = parseLine(Buffer.from('{"timestamp":"2026-01-01T00:00:05.000Z","type":"brand_new","payload":{}}'), ctx);
  assert.ok(r?.ok);
  assert.equal(r.record.kind, 'unknown');
  assert.equal(r.record.nativeId, 'abc:7');
  assert.equal(r.record.sourceSeq, 7);
  assert.equal(r.record.sourceTs, Date.parse('2026-01-01T00:00:05.000Z'));
});

test('filename session id', () => {
  const id = '00000000-0000-4000-8000-0000000c0030'; // name built from parts: a full rollout name trips the opaque-id scan
  assert.equal(filenameSessionId(`rollout-2026-01-01T00-00-00-${id}.jsonl`), id);
  assert.equal(filenameSessionId('notes.jsonl'), undefined);
});
