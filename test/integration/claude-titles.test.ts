// XAIBO-PROD-507 (P5-T02a, D-P5-03): Claude session titles. `custom-title` {customTitle} is the user's rename and
// `ai-title` {aiTitle} the generated title (shapes from the Claude Code 2.1.325 program code). They are stored apart
// (sessions.title, sessions.ai_title) so an AI title re-appended on resume never replaces a rename; the latest record of
// each kind wins; the row shows the rename, else the AI title, else nothing (the renderer's "Untitled").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { listSessions } from '../../src/service/api.ts';
import { loadMigrations, openStore, schemaSnapshot } from '../../src/service/store/db.ts';
import { claudeProfile } from '../helpers/claude-profile.ts';

const sid = (n: string) => `00000000-0000-4000-8000-0000000e${n}`;
const user = (s: string, n: string, text: string) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: sid(n),
  timestamp: '2026-01-01T00:00:01.000Z', cwd: '/tmp/xaibo-fixture/titles', sessionId: s, entrypoint: 'cli', message: { role: 'user', content: text } });
const custom = (s: string, t: unknown) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: s });
const ai = (s: string, t: unknown) => JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: s });
const lines = (...l: string[]) => l.join('\n') + '\n';

const titles = (db: DatabaseSync) => {
  const ids = new Map((db.prepare('SELECT id, native_session_id AS n FROM sessions').all() as { id: number; n: string }[]).map((r) => [r.id, r.n]));
  return Object.fromEntries(listSessions(db, null, 50, [], []).rows.map((r) => [ids.get(r.id), r.title]));
};
const stored = (db: DatabaseSync, s: string) => ({ ...(db.prepare('SELECT title, ai_title FROM sessions WHERE native_session_id = ?').get(s) as object) });

test('Claude titles: rename and AI title stored apart; latest per kind wins; rename shown first; empty and subagent titles ignored', async () => {
  const p = await claudeProfile([]);
  const dir = join(p.root, 'projects', '-tmp-xaibo-fixture-titles');
  mkdirSync(join(dir, sid('0010'), 'subagents'), { recursive: true });
  const file = (s: string) => join(dir, `${s}.jsonl`);
  writeFileSync(file(sid('0001')), lines(user(sid('0001'), '0101', 'p'), ai(sid('0001'), 'Generated one'))); // AI title only
  writeFileSync(file(sid('0002')), lines(user(sid('0002'), '0201', 'p'), ai(sid('0002'), 'Generated two'), custom(sid('0002'), 'My rename')));
  writeFileSync(file(sid('0003')), lines(user(sid('0003'), '0301', 'p'))); // no title
  writeFileSync(file(sid('0004')), lines(user(sid('0004'), '0401', 'p'), custom(sid('0004'), ''), ai(sid('0004'), 7), custom(sid('0004'), '   ')));
  writeFileSync(file(sid('0010')), lines(user(sid('0010'), '1001', 'p')));
  writeFileSync(join(dir, sid('0010'), 'subagents', 'agent-a1.jsonl'), lines(custom(sid('0010'), 'Subagent rename'), ai(sid('0010'), 'Subagent AI')));
  const sum = () => createHash('sha256').update(readFileSync(file(sid('0002')))).digest('hex');

  const run = async () => { const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 }); await a.start(); a.stop(); };
  await run();
  assert.deepEqual(stored(p.db, sid('0001')), { title: null, ai_title: 'Generated one' });
  assert.deepEqual(stored(p.db, sid('0002')), { title: 'My rename', ai_title: 'Generated two' });
  assert.deepEqual(stored(p.db, sid('0004')), { title: null, ai_title: null }, 'empty, blank and non-string titles are ignored');
  assert.deepEqual(stored(p.db, sid('0010')), { title: null, ai_title: null }, 'subagent transcripts never title the session');
  assert.deepEqual(titles(p.db), { [sid('0001')]: 'Generated one', [sid('0002')]: 'My rename', [sid('0003')]: null, [sid('0004')]: null, [sid('0010')]: null });

  // Resume: Claude re-appends custom-title then ai-title; a newer AI title and later a second rename follow.
  appendFileSync(file(sid('0002')), lines(custom(sid('0002'), 'My rename'), ai(sid('0002'), 'Generated newer')));
  appendFileSync(file(sid('0001')), lines(ai(sid('0001'), 'Generated one, newer')));
  await run();
  assert.deepEqual(stored(p.db, sid('0002')), { title: 'My rename', ai_title: 'Generated newer' });
  assert.equal(titles(p.db)[sid('0002')], 'My rename', 'an AI title after a rename never replaces it');
  assert.equal(titles(p.db)[sid('0001')], 'Generated one, newer');
  appendFileSync(file(sid('0002')), lines(custom(sid('0002'), 'Second rename')));
  await run();
  assert.equal(titles(p.db)[sid('0002')], 'Second rename');
  const was = sum();
  await run();
  assert.equal(sum(), was, 'native transcript unchanged by ingest');
});

test('016: backup first; sessions ingested before it get their latest stored rename and AI title; schema.sql matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xtitle-mig-'));
  const opts = { file: join(dir, 'xaibo.db'), backupDir: join(dir, 'backups') };
  const before = await openStore({ ...opts, migrations: loadMigrations().filter((m) => m.version < 16) });
  const db = before.db;
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  for (const s of ['s1', 's2', 's3']) db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id) VALUES ('claude', 'p1', ?)").run(s);
  const ev = db.prepare(`INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, subagent_native_id, source_seq, received_ts, raw)
    VALUES ((SELECT id FROM sessions WHERE native_session_id = ?), 1, 'transcript', 'confirmed', ?, ?, ?, ?, 1, ?)`);
  let n = 0;
  const put = (s: string, kind: string, raw: string, sub: string | null = null) => { n += 1; ev.run(s, `h:${n}`, kind, sub, n, raw); };
  put('s1', 'custom-title', custom('s1', 'Old rename'));
  put('s1', 'ai-title', ai('s1', 'Old AI'));
  put('s1', 'custom-title', custom('s1', 'New rename'));
  put('s1', 'ai-title', ai('s1', 'New AI'));
  put('s2', 'ai-title', ai('s2', 'Only AI'));
  put('s2', 'custom-title', custom('s2', ''));
  put('s3', 'custom-title', custom('s3', 'Subagent rename'), 'a1');
  put('s3', 'custom-title', 'not json');
  db.close();

  const s = await openStore(opts);
  assert.equal(s.readOnly, false);
  assert.ok(readdirSync(opts.backupDir).includes('xaibo-v15.db'), 'the recovery path backed up the v15 database first');
  assert.deepEqual(stored(s.db, 's1'), { title: 'New rename', ai_title: 'New AI' });
  assert.deepEqual(stored(s.db, 's2'), { title: null, ai_title: 'Only AI' });
  assert.deepEqual(stored(s.db, 's3'), { title: null, ai_title: null });
  assert.equal(schemaSnapshot(s.db), readFileSync(new URL('../../src/service/store/schema.sql', import.meta.url), 'utf8'));
});
