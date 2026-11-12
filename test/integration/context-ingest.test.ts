// XAIBO-PROD-207 (P2-T07, EC-94, EC-93): ingest keeps one context_snapshots row per generation with its latest
// reading. Claude compaction fixture: generation 0 from msg_fixture_0008, the boundary opens generation 1 (interim from
// postTokens), msg_fixture_0009 replaces the interim reading; no window (D-P2-04). Codex: last total over the reported
// model_context_window; a model switch (variant built from usage-basic) opens a new generation. Usage rows unchanged.
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

const snaps = (db: DatabaseSync, session: string) => db.prepare(`SELECT c.generation AS g, c.model_id AS model, c.used_tokens AS used, c.window_tokens AS window,
  c.window_basis AS basis, c.percentage AS pct, c.source FROM context_snapshots c JOIN sessions s ON s.id = c.session_id
  WHERE s.native_session_id = ? ORDER BY c.generation`).all(session).map((r) => ({ ...r }));

test('Claude: compaction opens a generation; the interim postTokens reading is replaced by the next usage; usage unchanged', async () => {
  const p = await claudeProfile(['compaction']);
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start();
  a.stop();
  assert.deepEqual(snaps(p.db, '00000000-0000-4000-8000-000000005000'), [
    { g: 0, model: 'claude-opus-5-5', used: 46, window: null, basis: 'unavailable', pct: null, source: 'transcript' },
    { g: 1, model: 'claude-opus-5-5', used: 33, window: null, basis: 'unavailable', pct: null, source: 'transcript' },
  ]);
  assert.equal(count(p.db, 'SELECT count(*) FROM usage'), 2, 'consumption rows unchanged by compaction');
});

test('Claude: a compaction with no usage after it keeps the labelled interim reading', async () => {
  const p = await claudeProfile([]);
  const fix = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'claude', '2.1.319', 'compaction', '00000000-0000-4000-8000-000000005000.jsonl');
  const lines = readFileSync(fix, 'utf8').split('\n').filter(Boolean);
  const dir = join(p.root, 'projects', '-tmp-xaibo-fixture-compaction');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '00000000-0000-4000-8000-000000005000.jsonl'), lines.slice(0, lines.findIndex((l) => l.includes('compact_boundary')) + 1).join('\n') + '\n');
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start();
  a.stop();
  assert.deepEqual(snaps(p.db, '00000000-0000-4000-8000-000000005000').at(-1),
    { g: 1, model: 'claude-opus-5-5', used: 300, window: null, basis: 'unavailable', pct: null, source: 'compaction' });
});

test('EC-93 Codex: reported effective window, no second reduction; a model switch is a new generation', async () => {
  const fix = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0', 'usage-basic');
  const name = readdirSync(fix).find((f) => f.startsWith('rollout-'))!;
  const lines = readFileSync(join(fix, name), 'utf8').split('\n').filter(Boolean);
  const tmp = mkdtempSync(join(tmpdir(), 'xctx-'));
  const root = join(tmp, 'codex');
  const dated = join(root, 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  writeFileSync(join(dated, name), lines.join('\n') + '\n');
  let tc = 0; // the second turn_context switches model in the variant
  const variant = lines.map((l) => (l.includes('"type":"turn_context"') && ++tc === 2 ? l.replaceAll('gpt-6.1-sol', 'gpt-6.1-sol-next') : l));
  writeFileSync(join(dated, name.replace('0000000c0001', '0000000c00e1')), variant.join('\n').replaceAll('0000000c0001', '0000000c00e1') + '\n');
  const { db } = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'codex', ?, 'default')").run(root);
  const usageBefore = () => count(db, 'SELECT count(*) FROM usage');
  const a = new CodexAdapter({ db, writer: new Writer(db), profileId: 'p1', root, intervalMs: 60_000 });
  await a.start();
  a.stop();
  assert.deepEqual(snaps(db, '00000000-0000-4000-8000-0000000c0001'), [
    { g: 0, model: 'gpt-6.1-sol', used: 1800, window: 200000, basis: 'reported', pct: 0.9, source: 'rollout' },
  ], 'the duplicate token_count leaves the reading as it was');
  assert.deepEqual(snaps(db, '00000000-0000-4000-8000-0000000c00e1'), [
    { g: 0, model: 'gpt-6.1-sol', used: 1200, window: 200000, basis: 'reported', pct: 0.6, source: 'rollout' },
    { g: 1, model: 'gpt-6.1-sol-next', used: 1800, window: 200000, basis: 'reported', pct: 0.9, source: 'rollout' },
  ]);
  assert.equal(usageBefore(), 6, 'usage rows as in T06 (3 per session)');
});
