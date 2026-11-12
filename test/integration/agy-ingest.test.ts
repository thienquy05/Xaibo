// XAIBO-PROD-211 (P2-T11, EC-80) agy ingest from the synthetic 1.5.6 fixture: session = conversation folder, cwd from
// history.jsonl (prompt text never stored), events, unlinked tool calls, per-step usage (cache read inside input).
// Revisions (agy rewrite semantics unverified, D-P2-02 (2)): a rewritten/truncated transcript and a lower-step append
// converge on the latest projection; older rows stay as superseded/rewound history; FTS holds current rows only;
// usage per step is replaced, never added; a replay changes nothing; FTS integrity holds. Boot wires the catalog root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AgyAdapter } from '../../src/service/adapters/agy/index.ts';
import { boot } from '../../src/service/boot.ts';
import { loadCatalog, type Catalog } from '../../src/service/catalog/validate.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { count } from '../helpers/claude-profile.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'agy', '1.5.6', 'basic');
const SID = '00000000-0000-4000-8000-0000000a0001';
const line = (step: number, type: string, content: string, extra = '') =>
  `{"step_index":${step},"source":"MODEL","type":"${type}","status":"DONE","created_at":"2026-01-01T00:01:0${step}Z","content":"${content}"${extra}}`;

async function profile() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xagy-')));
  const root = join(tmp, 'home', '.gemini', 'antigravity-cli');
  mkdirSync(root, { recursive: true });
  cpSync(FIX, root, { recursive: true, filter: (s) => !s.endsWith('expected.json') });
  const store = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'b') });
  store.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('pa', 'agy', ?, 'default')").run(root);
  const writer = new Writer(store.db);
  const transcript = join(root, 'brain', SID, '.system_generated', 'logs', 'transcript_full.jsonl');
  const run = async () => { const a = new AgyAdapter({ db: store.db, writer, profileId: 'pa', root, intervalMs: 60_000 }); await a.start(); a.stop(); };
  return { tmp, root, db: store.db, transcript, run };
}
const events = (db: DatabaseSync) => db.prepare('SELECT source_seq AS step, kind, content, revision_status AS status FROM events ORDER BY source_seq, id')
  .all().map((r) => ({ ...r }) as { step: number; kind: string; content: string | null; status: string });
const current = (db: DatabaseSync) => events(db).filter((e) => e.status === 'current').map((e) => [e.step, e.content]);
const fts = (db: DatabaseSync, q: string) => count(db, 'SELECT count(*) FROM event_fts WHERE event_fts MATCH ?', q);
const usage = (db: DatabaseSync) => db.prepare('SELECT identity, uncached_input AS un, cache_read AS cr, cache_write AS cw, output AS out FROM usage ORDER BY identity')
  .all().map((r) => ({ ...r }));
const integrity = (db: DatabaseSync) => db.exec("INSERT INTO event_fts (event_fts) VALUES ('integrity-check')");

test('backfill: session, cwd from history, events, tool calls, usage; prompt text never stored; restart and tail add once', async () => {
  const p = await profile();
  await p.run();
  const s = p.db.prepare('SELECT agent, native_session_id AS id, cwd, native_available AS avail FROM sessions').all().map((r) => ({ ...r }));
  assert.deepEqual(s, [{ agent: 'agy', id: SID, cwd: '/tmp/xaibo-fixture/agy', avail: 1 }]);
  assert.equal(count(p.db, "SELECT count(*) FROM cwd_history WHERE cwd = '/tmp/xaibo-fixture/agy'"), 1);
  assert.deepEqual(events(p.db).map((e) => e.kind), ['user', 'system', 'assistant', 'tool_output', 'assistant']);
  assert.equal(count(p.db, "SELECT count(*) FROM events WHERE kind = 'system' AND injected = 1"), 1);
  assert.equal(count(p.db, "SELECT count(*) FROM tool_calls WHERE tool = 'read_file' AND args_event_id IS NOT NULL AND result_event_id IS NULL"), 1, 'unlinked');
  assert.deepEqual(usage(p.db), [
    { identity: 'step:2', un: 400, cr: 800, cw: null, out: 40 },
    { identity: 'step:4', un: 200, cr: 1100, cw: null, out: 25 },
  ]);
  assert.equal(fts(p.db, 'bravo'), 2);
  const canary = "SELECT count(*) FROM events e, sessions s WHERE e.content LIKE '%CANARY_AGY%' OR e.raw LIKE '%CANARY_AGY%' OR s.cwd LIKE '%CANARY_AGY%' OR s.title LIKE '%CANARY_AGY%'";
  assert.equal(count(p.db, canary), 0, 'history.jsonl display text is never stored');
  assert.equal(count(p.db, "SELECT count(*) FROM cwd_history WHERE cwd LIKE '%CANARY%'"), 0);

  const before = events(p.db);
  await p.run();
  assert.deepEqual(events(p.db), before, 'a restart adds nothing');
  appendFileSync(p.transcript, `${line(5, 'PLANNER_RESPONSE', 'charlie appended', ',"input_tokens":10,"cache_read_tokens":0,"output_tokens":2')}\n`);
  await p.run();
  assert.equal(events(p.db).length, 6);
  assert.equal(fts(p.db, 'charlie'), 1);
  integrity(p.db);
});

test('EC-80: a rewritten, shorter transcript converges on the new projection; history kept; usage replaced, not added', async () => {
  const p = await profile();
  await p.run();
  const lines = readFileSync(p.transcript, 'utf8').split('\n').filter(Boolean);
  writeFileSync(p.transcript, `${[lines[0], lines[1], line(2, 'PLANNER_RESPONSE', 'rewritten delta plan', ',"input_tokens":1500,"cache_read_tokens":900,"output_tokens":60')].join('\n')}\n`);
  await p.run();
  assert.deepEqual(current(p.db), [[0, 'Read the fixture notes file'], [1, 'synthetic system context'], [2, 'rewritten delta plan']]);
  assert.deepEqual(events(p.db).filter((e) => e.status !== 'current').map((e) => [e.step, e.status]), [[2, 'superseded'], [3, 'rewound'], [4, 'rewound']]);
  assert.equal(count(p.db, 'SELECT count(*) FROM sessions'), 1);
  assert.equal(fts(p.db, 'delta'), 1);
  assert.equal(fts(p.db, 'bravo'), 0, 'rewound and superseded text is not searchable');
  assert.deepEqual(usage(p.db), [
    { identity: 'step:2', un: 600, cr: 900, cw: null, out: 60 }, // replaced by identity
    { identity: 'step:4', un: 200, cr: 1100, cw: null, out: 25 }, // consumed before the rewind: kept, never negative
  ]);
  integrity(p.db);
  const snapshot = events(p.db);
  await p.run();
  assert.deepEqual(events(p.db), snapshot, 'a replay changes nothing');
});

test('EC-80: a lower step appended after higher ones supersedes in source order; unknown types are counted', async () => {
  const p = await profile();
  await p.run();
  appendFileSync(p.transcript, `${line(3, 'GENERIC', 'echo replaced output')}\n${line(4, 'FUTURE_TYPE', 'unknown kind')}\n`);
  await p.run();
  assert.deepEqual(current(p.db).slice(3), [[3, 'echo replaced output'], [4, 'unknown kind']]);
  assert.deepEqual(events(p.db).filter((e) => e.status !== 'current').map((e) => [e.step, e.status]), [[3, 'superseded'], [4, 'superseded']], 'old step 4: rewound by step 3, then replaced by the new step 4');
  assert.equal(count(p.db, 'SELECT unknown_count FROM sessions'), 1);
  assert.equal(fts(p.db, 'echo'), 1);
  assert.equal(fts(p.db, 'bravo'), 0, 'the replaced steps 3 and 4 no longer match');
  integrity(p.db);
});

test('boot: the catalog agy profile root is ingested', async () => {
  const p = await profile();
  const home = join(p.tmp, 'home');
  const catalog: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((a) => ({ ...a, detection: { ...a.detection, locations: ['~/.local/bin'] } })) };
  const svc = await boot({ dataDir: join(p.tmp, 'data2'), home, catalog, intervalMs: 60_000 });
  await svc.done;
  assert.equal(count(svc.store.db, "SELECT count(*) FROM sessions WHERE agent = 'agy'"), 1);
  assert.equal(svc.agents()?.find((a) => a.agent === 'agy')?.state, 'not-detected', 'no agy binary in the temp home');
  svc.stop();
});
