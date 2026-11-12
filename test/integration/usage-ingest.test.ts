// XAIBO-PROD-206 (P2-T06, EC-51, EC-93): ingest writes usage rows and rate-limit snapshots. Claude: one row per
// message.id (multi-block lines once). Codex: one segment row per counter segment (consumption) and one request row per
// advance of the total; a duplicate cumulative adds nothing, a reset starts a new segment; a missing rate_limits reading
// writes no snapshot; token_usage_record shape drift is a gap row (D-P2-03). Compaction is an event and changes no
// usage. Variants (reset, drift, a later reading without rate_limits) are built in the test from the synthetic
// 0.160.0 fixtures; a restart adds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { claudeProfile, count } from '../helpers/claude-profile.ts';

const CODEX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0');
const at = (s: string) => Date.parse(`2026-01-01T00:00:${s}.000Z`);
const rows = (db: DatabaseSync, sql: string, ...p: string[]) => db.prepare(sql).all(...p).map((r) => ({ ...r }) as Record<string, unknown>);
const usage = (db: DatabaseSync, session: string) => rows(db, `SELECT u.scope, u.identity, u.segment, u.uncached_input AS uncached, u.cache_read AS cr,
  u.cache_write AS cw, u.output, u.completeness FROM usage u JOIN sessions s ON s.id = u.session_id WHERE s.native_session_id = ? ORDER BY u.scope, u.identity`, session);

test('Claude: one usage row per message.id with classes and model; compaction is an event and changes no usage (EC-51)', async () => {
  const p = await claudeProfile(['usage-basic', 'compaction']);
  const run = async () => { const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 }); await a.start(); a.stop(); };
  await run();
  const got = () => rows(p.db, `SELECT identity, scope, source, model_id AS model, uncached_input AS uncached, cache_read AS cr, cache_write AS cw,
    cache_write_classes AS classes, output FROM usage ORDER BY identity`);
  const expected = [
    { identity: 'msg_fixture_0001', scope: 'message', source: 'transcript', model: 'claude-opus-5-5', uncached: 10, cr: 100, cw: 30, classes: '{"5m":30,"1h":0}', output: 20 },
    { identity: 'msg_fixture_0002', scope: 'message', source: 'transcript', model: 'claude-opus-5-5', uncached: 5, cr: 140, cw: 15, classes: '{"5m":0,"1h":15}', output: 40 },
    { identity: 'msg_fixture_0008', scope: 'message', source: 'transcript', model: 'claude-opus-5-5', uncached: 6, cr: 0, cw: 40, classes: '{"5m":40,"1h":0}', output: 9 },
    { identity: 'msg_fixture_0009', scope: 'message', source: 'transcript', model: 'claude-opus-5-5', uncached: 3, cr: 30, cw: 0, classes: '{"5m":0,"1h":0}', output: 4 },
  ];
  assert.deepEqual(got(), expected, 'three lines of msg_fixture_0001 count once');
  assert.equal(count(p.db, "SELECT count(*) FROM events WHERE native_id = '00000000-0000-4000-8000-000000005003' AND kind = 'system'"), 1, 'compact_boundary recorded');
  const lines = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'claude', '2.1.319', 'compaction', '00000000-0000-4000-8000-000000005000.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(count(p.db, "SELECT count(*) FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.native_session_id = '00000000-0000-4000-8000-000000005000'"), lines, 'pre-compaction records kept');
  await run();
  assert.deepEqual(got(), expected, 'a second boot adds nothing');
});

function codexRoot() {
  const tmp = mkdtempSync(join(tmpdir(), 'xusage-'));
  const root = join(tmp, 'codex');
  const dated = join(root, 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  const copy = (c: string, edit: (lines: string[]) => string[] = (l) => l, from?: string, to?: string) => {
    const name = readdirSync(join(CODEX, c)).find((f) => f.startsWith('rollout-'))!;
    let text = edit(readFileSync(join(CODEX, c, name), 'utf8').split('\n').filter(Boolean)).join('\n') + '\n';
    let out = name;
    if (from && to) { text = text.replaceAll(from, to); out = name.replace(from, to); }
    writeFileSync(join(dated, out), text);
  };
  return { tmp, root, copy };
}
const sid = (n: string) => `00000000-0000-4000-8000-0000000c${n}`;
const tokenCount = (l: string) => l.includes('"type":"token_count"');

test('Codex: segments, requests, reset, duplicate, snapshots, missing reading, drift gap, compaction (EC-51, EC-93)', async () => {
  const h = codexRoot();
  h.copy('usage-basic');
  h.copy('compacted');
  h.copy('usage-basic', (ls) => { // counter reset: the third token_count drops to a smaller cumulative total
    let n = 0;
    return ls.map((l) => (tokenCount(l) && ++n === 3 ? l.replace(/"total_token_usage":\{[^}]*\}/, '"total_token_usage":{"input_tokens":400,"cached_input_tokens":100,"cache_write_input_tokens":0,"output_tokens":100,"reasoning_output_tokens":0,"total_tokens":500}') : l));
  }, '0000000c0001', '0000000c00f1');
  h.copy('usage-basic', (ls) => ls.map((l) => (l.includes('"type":"token_usage_record"') ? l.replace('"usage":{', '"usage":{"new_tokens":1,') : l)), '0000000c0001', '0000000c00f2');
  h.copy('rate-limits', (ls) => { // a later token_count without rate_limits: no snapshot, the earlier as_of stays
    const last = ls.filter(tokenCount).at(-1)!;
    const later = JSON.parse(last) as { timestamp: string; payload: Record<string, unknown> };
    later.timestamp = '2026-01-01T00:00:07.000Z';
    delete later.payload.rate_limits;
    return [...ls, JSON.stringify(later)];
  });
  const { db } = await openStore({ file: join(h.tmp, 'data', 'xaibo.db'), backupDir: join(h.tmp, 'data', 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'codex', ?, 'default')").run(h.root);
  const writer = new Writer(db);
  const run = async () => { const a = new CodexAdapter({ db, writer, profileId: 'p1', root: h.root, intervalMs: 60_000 }); await a.start(); a.stop(); };
  await run();

  const C = JSON.stringify({ uncachedInput: 'reported', cacheRead: 'reported', cacheWrite: 'relation-unverified', output: 'reported' });
  const basic = [
    { scope: 'message', identity: '0:1200', segment: 0, uncached: 400, cr: 600, cw: null, output: 200, completeness: C },
    { scope: 'message', identity: '0:3000', segment: 0, uncached: 300, cr: 1200, cw: null, output: 300, completeness: C },
    { scope: 'session', identity: 'segment:0', segment: 0, uncached: 700, cr: 1800, cw: null, output: 500, completeness: C },
  ];
  assert.deepEqual(usage(db, sid('0001')), basic, 'the duplicate cumulative at 00:00:11 adds nothing');
  const reset = usage(db, sid('00f1'));
  assert.deepEqual(reset.filter((r) => r.scope === 'session').map((r) => [r.identity, r.output]), [['segment:0', 500], ['segment:1', 100]]);
  assert.equal(reset.filter((r) => r.scope === 'message').length, 3);
  assert.ok(reset.every((r) => (r.output as number) >= 0 && (r.uncached as number) >= 0), 'never negative');
  assert.deepEqual(usage(db, sid('00f2')).filter((r) => r.scope === 'turn').map((r) => [r.uncached, r.output, r.completeness]),
    [[null, null, JSON.stringify({ record: 'shape-drift' })]], 'drift is a gap row, never consumption');
  assert.equal(usage(db, sid('0001')).filter((r) => r.scope === 'turn').length, 0, 'a pinned-shape record writes no row');
  assert.deepEqual(usage(db, sid('0032')).filter((r) => r.scope === 'session').map((r) => r.output), [200], 'compacted: consumption unchanged');
  assert.equal(count(db, "SELECT count(*) FROM events WHERE kind = 'compaction'"), 1);

  const snaps = () => rows(db, 'SELECT s.native_session_id AS session, u.source, u.limit_id AS limitId, u.windows, u.as_of AS asOf FROM usage_snapshots u JOIN sessions s ON s.id = u.session_id ORDER BY u.as_of');
  const w = (p: number, q: number) => JSON.stringify([{ kind: 'primary', durationMinutes: 300, usedPercent: p, resetsAt: 1767243600000 },
    { kind: 'secondary', durationMinutes: 10080, usedPercent: q, resetsAt: 1767830400000 }]);
  const expectedSnaps = [
    { session: sid('0009'), source: 'rollout', limitId: null, windows: w(10, 38), asOf: at('03') },
    { session: sid('0009'), source: 'rollout', limitId: null, windows: w(12.5, 40), asOf: at('05') },
  ];
  assert.deepEqual(snaps(), expectedSnaps, 'no row for readings without rate_limits; the 00:00:07 event leaves as_of at 00:00:05');

  const before = count(db, 'SELECT count(*) FROM usage');
  await run();
  assert.equal(count(db, 'SELECT count(*) FROM usage'), before, 'a second boot adds nothing');
  assert.deepEqual(snaps(), expectedSnaps);
});
