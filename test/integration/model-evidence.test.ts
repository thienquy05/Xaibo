// XAIBO-PROD-208 (P2-T08, EC-101, FR-51): ingest records the model (and effort when exposed) per turn and as the
// session's current model; evidence with an older source time never reverts newer state; the list row carries
// "<display name> · <effort>", the raw id when unlisted, "Model unavailable" without evidence. Variants are built from
// the synthetic Codex 0.160.0 model-effort fixture (turn_context model + collaboration_mode reasoning_effort).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { listSessions } from '../../src/service/api.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { loadModels } from '../../src/service/usage/models.ts';
import { claudeProfile } from '../helpers/claude-profile.ts';

const models = loadModels().models;
const FIX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0', 'model-effort');
const sid = (n: string) => `00000000-0000-4000-8000-0000000c${n}`;
const labels = (db: DatabaseSync) => {
  const ids = new Map((db.prepare('SELECT id, native_session_id AS n FROM sessions').all() as { id: number; n: string }[]).map((r) => [r.id, r.n]));
  return Object.fromEntries(listSessions(db, null, 50, [], models).rows.map((r) => [ids.get(r.id), r.model]));
};
const current = (db: DatabaseSync, n: string) => ({ ...(db.prepare('SELECT current_model AS model, current_effort AS effort FROM sessions WHERE native_session_id = ?').get(n) as object) });
const turnModels = (db: DatabaseSync) => db.prepare('SELECT native_turn_id AS id, model_id AS model, effort FROM turns WHERE model_id IS NOT NULL ORDER BY native_turn_id').all().map((r) => ({ ...r }));

/** A turn_context line like the fixture's, for another turn, time, model and effort. */
function turnContext(template: string, turn: string, ts: string, model: string, effort: string | null) {
  const r = JSON.parse(template) as { timestamp: string; payload: Record<string, unknown> & { collaboration_mode: { settings: Record<string, unknown> } } };
  r.timestamp = ts;
  r.payload.turn_id = turn;
  r.payload.model = model;
  r.payload.collaboration_mode.settings.model = model;
  r.payload.collaboration_mode.settings.reasoning_effort = effort;
  return JSON.stringify(r);
}

test('Codex: turn_context model and effort per turn; a switch updates the current model; delayed evidence does not revert it', async () => {
  const name = readdirSync(FIX).find((f) => f.startsWith('rollout-'))!;
  const lines = readFileSync(join(FIX, name), 'utf8').split('\n').filter(Boolean);
  const tc = lines.find((l) => l.includes('"type":"turn_context"'))!;
  const tmp = mkdtempSync(join(tmpdir(), 'xmodel-'));
  const root = join(tmp, 'codex');
  const dated = join(root, 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  writeFileSync(join(dated, name), lines.join('\n') + '\n'); // as recorded: gpt-6.1-sol, effort exposed as null
  const switched = name.replace('0000000c000a', '0000000c00fa');
  writeFileSync(join(dated, switched), [...lines,
    turnContext(tc, sid('20fa'), '2026-01-01T00:00:05.000Z', 'gpt-6.1-sol-next', 'high'),
    turnContext(tc, sid('21fa'), '2026-01-01T00:00:03.000Z', 'gpt-6.1-sol', 'low'), // older source time, written later
  ].join('\n').replaceAll('0000000c000a', '0000000c00fa') + '\n');
  const { db } = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'codex', ?, 'default')").run(root);
  const a = new CodexAdapter({ db, writer: new Writer(db), profileId: 'p1', root, intervalMs: 60_000 });
  await a.start();
  a.stop();
  assert.deepEqual(current(db, sid('000a')), { model: 'gpt-6.1-sol', effort: null });
  assert.deepEqual(current(db, sid('00fa')), { model: 'gpt-6.1-sol-next', effort: 'high' }, 'the 00:00:03 evidence came later but is older');
  assert.deepEqual(turnModels(db), [
    { id: sid('1016'), model: 'gpt-6.1-sol', effort: null },
    { id: sid('1016'), model: 'gpt-6.1-sol', effort: null }, // the same recorded turn in the copied session
    { id: sid('20fa'), model: 'gpt-6.1-sol-next', effort: 'high' },
    { id: sid('21fa'), model: 'gpt-6.1-sol', effort: 'low' },
  ], 'every turn keeps its own model and effort');
  assert.deepEqual(labels(db), { [sid('000a')]: 'GPT-6.1 Sol', [sid('00fa')]: 'gpt-6.1-sol-next · high' }, 'listed name; unlisted raw id with effort');
});

test('Claude: message.model is the current model (no effort in transcripts); no evidence -> Model unavailable', async () => {
  const p = await claudeProfile(['usage-basic']);
  const dir = join(p.root, 'projects', '-tmp-xaibo-fixture-plain');
  mkdirSync(dir, { recursive: true });
  const plain = '00000000-0000-4000-8000-0000000d0101';
  writeFileSync(join(dir, `${plain}.jsonl`), JSON.stringify({ parentUuid: null, type: 'user', uuid: '00000000-0000-4000-8000-0000000d0102',
    timestamp: '2026-01-01T00:00:01.000Z', cwd: '/tmp/xaibo-fixture/plain', sessionId: plain, entrypoint: 'cli', message: { role: 'user', content: 'x' } }) + '\n');
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start();
  a.stop();
  assert.deepEqual(current(p.db, '00000000-0000-4000-8000-000000001000'), { model: 'claude-opus-5-5', effort: null });
  assert.deepEqual(turnModels(p.db), [{ id: '00000000-0000-4000-8000-000000001001', model: 'claude-opus-5-5', effort: null }]);
  assert.deepEqual(labels(p.db), { '00000000-0000-4000-8000-000000001000': 'Claude Opus 5.5', [plain]: 'Model unavailable' });
});
