// XAIBO-PROD-205 (P2-T05, PRD §5.4/§5.5): ingest persists tool calls (Claude tool_use/tool_result ids, Codex
// custom_tool_call call_id) through the merge, and turns (Claude non-injected user prompt records; Codex
// task_started/task_complete/turn_aborted). A missing boundary stays NULL; a restart adds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { claudeProfile } from '../helpers/claude-profile.ts';

const CODEX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0');
const at = (s: string) => Date.parse(`2026-01-01T00:00:${s}.000Z`);
const toolCalls = (db: DatabaseSync) => db.prepare(`SELECT t.native_call_id AS id, t.sources, t.tool, a.native_id AS args, r.native_id AS result, a.kind AS argsKind
  FROM tool_calls t LEFT JOIN events a ON a.id = t.args_event_id LEFT JOIN events r ON r.id = t.result_event_id ORDER BY t.native_call_id`).all();
const turns = (db: DatabaseSync) => db.prepare(`SELECT native_turn_id AS id, source, started_at AS started, ended_at AS ended, outcome
  FROM turns ORDER BY native_turn_id`).all();
const plain = (rows: unknown[]) => rows.map((r) => ({ ...(r as object) }) as Record<string, unknown>);

test('Claude: tool_use and tool_result join on the id; the prompt record opens a turn; restart adds nothing', async () => {
  const p = await claudeProfile(['usage-basic']);
  const run = async () => { const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 }); await a.start(); a.stop(); };
  await run();
  const expected = {
    calls: [{ id: 'toolu_fixture_0001', sources: '["transcript"]', tool: 'Bash', args: '00000000-0000-4000-8000-000000001004',
      result: '00000000-0000-4000-8000-000000001005', argsKind: 'message' }],
    turns: [{ id: '00000000-0000-4000-8000-000000001001', source: 'transcript', started: at('01'), ended: null, outcome: null }],
  };
  assert.deepEqual({ calls: plain(toolCalls(p.db)), turns: plain(turns(p.db)) }, expected);
  await run();
  assert.deepEqual({ calls: plain(toolCalls(p.db)), turns: plain(turns(p.db)) }, expected, 'a second boot adds nothing');
});

test('Codex: call_id joins call and output; task_started/task_complete/turn_aborted bound turns; an end without a start keeps started NULL', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xturns-'));
  const root = join(tmp, 'codex');
  const dated = join(root, 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  for (const [c, id] of [['simple-turn', 'c0030'], ['unknown-records', 'c0004']] as const) {
    const f = readdirSync(join(CODEX, c)).find((x) => x.endsWith(`${id}.jsonl`))!;
    copyFileSync(join(CODEX, c, f), join(dated, f));
  }
  const { db } = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'codex', ?, 'default')").run(root);
  const writer = new Writer(db);
  const run = async () => { const a = new CodexAdapter({ db, writer, profileId: 'p1', root, intervalMs: 60_000 }); await a.start(); a.stop(); };
  await run();
  const calls = plain(toolCalls(db));
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0], args: undefined, result: undefined }, { id: 'call_synthetic_1', sources: '["rollout"]', tool: 'synthetic_tool', args: undefined, result: undefined, argsKind: 'tool_call' });
  assert.ok(calls[0]!.args && calls[0]!.result, 'call and output events are linked');
  const t = (n: string) => `00000000-0000-4000-8000-0000000c${n}`;
  const expected = [
    ...['1006', '1007', '1008', '1009'].map((n, i) => ({ id: t(n), source: 'rollout', started: null, ended: at(String(4 + 4 * i).padStart(2, '0')), outcome: 'completed' })),
    { id: t('100a'), source: 'rollout', started: null, ended: at('20'), outcome: 'aborted' },
    { id: t('1030'), source: 'rollout', started: at('02'), ended: at('14'), outcome: 'completed' },
  ];
  assert.deepEqual(plain(turns(db)), expected);
  await run();
  assert.deepEqual(plain(turns(db)), expected, 'a second boot adds nothing');
  assert.equal(plain(toolCalls(db)).length, 1);
});
