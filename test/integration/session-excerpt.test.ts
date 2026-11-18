// XAIBO-PROD-509 (P5-T02c, EC-66): a session with no rename, AI title or thread name shows "Untitled" plus an excerpt
// of its first real prompt, in-app only. The excerpt is the first item the transcript classifier calls a prompt
// (injected reminders, Claude meta records and tool results never are), whitespace collapsed and cut to 120 units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AgyAdapter } from '../../src/service/adapters/agy/index.ts';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { EXCERPT_MAX, listSessions } from '../../src/service/api.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { parsePortMessage } from '../../src/shared/ipc.ts';
import { claudeProfile } from '../helpers/claude-profile.ts';

const sid = (n: string) => `00000000-0000-4000-8000-0000000f${n}`;
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'synthetic');
let u = 0;
const user = (s: string, content: unknown, extra: object = {}) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user',
  uuid: sid(`9${String(++u).padStart(3, '0')}`), timestamp: `2026-01-01T00:00:0${u % 10}.000Z`, cwd: '/tmp/xaibo-fixture/excerpt', sessionId: s,
  entrypoint: 'cli', message: { role: 'user', content }, ...extra });
const lines = (...l: string[]) => l.join('\n') + '\n';
const rows = (db: DatabaseSync) => {
  const ids = new Map((db.prepare('SELECT id, native_session_id AS n FROM sessions').all() as { id: number; n: string }[]).map((r) => [r.id, r.n]));
  return Object.fromEntries(listSessions(db, null, 50, [], []).rows.map((r) => [ids.get(r.id), { title: r.title, excerpt: r.excerpt ?? null }]));
};

test('Claude: the first typed prompt is the excerpt; reminders, meta and tool results are skipped; titled rows carry none', async () => {
  const p = await claudeProfile([]);
  const dir = join(p.root, 'projects', '-tmp-xaibo-fixture-excerpt');
  mkdirSync(dir, { recursive: true });
  const put = (s: string, ...l: string[]) => writeFileSync(join(dir, `${s}.jsonl`), lines(...l));
  put(sid('0001'), user(sid('0001'), '<system-reminder>synthetic reminder</system-reminder>'),
    user(sid('0001'), [{ type: 'text', text: 'Skill expansion text' }], { isMeta: true }),
    user(sid('0001'), [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'tool output' }]),
    user(sid('0001'), 'Fix   the\n\tflaky   login test'), user(sid('0001'), 'A later prompt'));
  put(sid('0002'), user(sid('0002'), 'Prompt of a renamed session'), JSON.stringify({ type: 'custom-title', customTitle: 'Renamed', sessionId: sid('0002') }));
  put(sid('0003'), user(sid('0003'), `${'é'.repeat(EXCERPT_MAX - 2)}😀 and more`)); // the cut lands on a surrogate pair
  put(sid('0004'), JSON.stringify({ type: 'ai-title', aiTitle: 'Only AI', sessionId: sid('0004') }));
  put(sid('0005'), user(sid('0005'), '   '));
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start();
  a.stop();
  const r = rows(p.db);
  assert.deepEqual(r[sid('0001')], { title: null, excerpt: 'Fix the flaky login test' });
  assert.deepEqual(r[sid('0002')], { title: 'Renamed', excerpt: null }, 'a titled row carries no excerpt');
  assert.deepEqual(r[sid('0004')], { title: 'Only AI', excerpt: null });
  assert.deepEqual(r[sid('0005')], { title: null, excerpt: null }, 'a blank prompt is no excerpt');
  const cut = r[sid('0003')]!.excerpt!;
  assert.ok(cut.length <= EXCERPT_MAX && cut.endsWith('…'), 'cut to EXCERPT_MAX with an ellipsis');
  assert.ok(!/[\uD800-\uDBFF]…$/.test(cut), 'never ends inside a surrogate pair');

  // The row with an excerpt survives the renderer's IPC parse; a non-string excerpt fails it.
  const page = { v: 1, type: 'sessions', rows: listSessions(p.db, null, 50, [], []).rows };
  const parsed = parsePortMessage(JSON.parse(JSON.stringify(page))) as { rows: { excerpt?: string | null }[] } | null;
  assert.ok(parsed && parsed.rows.some((x) => x.excerpt === 'Fix the flaky login test'));
  assert.equal(parsePortMessage({ ...page, rows: [{ ...page.rows[0], excerpt: 7 }] }), null, 'a non-string excerpt fails the parse');
});

test('Codex and agy: the first user prompt is the excerpt (agy sessions have no title source)', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xexcerpt-')));
  const { db } = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'b') });
  const writer = new Writer(db);
  const codex = join(tmp, 'codex');
  const dated = join(codex, 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  const simple = join(FIXTURES, 'codex', '0.160.0', 'simple-turn');
  const name = readdirSync(simple).find((f) => f.startsWith('rollout-'))!;
  writeFileSync(join(dated, name), readFileSync(join(simple, name)));
  // Review M2: a session whose first user messages are Codex context fragments (environment, AGENTS.md) before the prompt.
  const ctx = (text: string) => JSON.stringify({ timestamp: '2026-01-01T00:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const fixture = readFileSync(join(simple, name), 'utf8').replaceAll('0000000c0030', '0000000c0031').split('\n');
  const at = fixture.findIndex((l) => l.includes('"role":"user"'));
  fixture.splice(at, 0, ctx('<environment_context>\n  <cwd>/tmp/xaibo-fixture/ctx</cwd>\n</environment_context>'), ctx('# AGENTS.md instructions for /tmp/xaibo-fixture/ctx\n\n<INSTRUCTIONS>\nx\n</INSTRUCTIONS>'));
  writeFileSync(join(dated, name.replace('0000000c0030', '0000000c0031')), fixture.join('\n'));
  const agy = join(tmp, 'home', '.gemini', 'antigravity-cli');
  mkdirSync(agy, { recursive: true });
  cpSync(join(FIXTURES, 'agy', '1.5.6', 'basic'), agy, { recursive: true, filter: (s) => !s.endsWith('expected.json') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('pc', 'codex', ?, 'default'), ('pa', 'agy', ?, 'default')").run(codex, agy);
  for (const a of [new CodexAdapter({ db, writer, profileId: 'pc', root: codex, intervalMs: 60_000 }), new AgyAdapter({ db, writer, profileId: 'pa', root: agy, intervalMs: 60_000 })]) {
    await a.start();
    a.stop();
  }
  const r = rows(db);
  assert.deepEqual(r['00000000-0000-4000-8000-0000000c0030'], { title: null, excerpt: 'synthetic prompt' });
  assert.deepEqual(r['00000000-0000-4000-8000-0000000c0031'], { title: null, excerpt: 'synthetic prompt' }, 'context fragments are never the excerpt');
  assert.deepEqual(r['00000000-0000-4000-8000-0000000a0001'], { title: null, excerpt: 'Read the fixture notes file' });
});

// Review (re-review LOW): rows stored before the Codex context rule keep injected = 0 (inserts never update); migration
// 017 marks those Codex user messages injected with the same prefixes, so existing stores get the right excerpt too.
test('017: stored Codex context messages become injected; typed prompts and other agents are unchanged', async () => {
  const { loadMigrations } = await import('../../src/service/store/db.ts');
  const { CONTEXT_PREFIXES } = await import('../../src/service/adapters/codex/parse.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'xctx-mig-'));
  const opts = { file: join(tmp, 'xaibo.db'), backupDir: join(tmp, 'backups') };
  const before = await openStore({ ...opts, migrations: loadMigrations().filter((m) => m.version < 17) });
  const db = before.db;
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('pc', 'codex', '/tmp/xaibo-fixture/c', 'default'), ('p1', 'claude', '/tmp/xaibo-fixture/a', 'default')").run();
  db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id) VALUES ('codex', 'pc', 'c1'), ('claude', 'p1', 'a1')").run();
  const ev = db.prepare(`INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, role, source_seq, received_ts, content)
    VALUES ((SELECT id FROM sessions WHERE native_session_id = ?), 1, ?, 'confirmed', ?, 'message', ?, ?, 1, ?)`);
  let n = 0;
  const put = (s: string, role: string, content: string) => { n += 1; ev.run(s, s === 'c1' ? 'rollout' : 'transcript', `n${n}`, role, n, content); };
  for (const p of CONTEXT_PREFIXES) put('c1', 'user', `\n  ${p} synthetic`);
  put('c1', 'user', 'synthetic prompt about <environment_context>');
  put('c1', 'assistant', '<environment_context> in a reply');
  put('a1', 'user', '<environment_context> typed into Claude');
  db.close();

  const s = await openStore(opts);
  assert.equal(s.readOnly, false);
  const flags = s.db.prepare('SELECT e.role, e.content, e.injected FROM events e ORDER BY e.id').all() as { role: string; content: string; injected: number }[];
  assert.deepEqual(flags.slice(0, CONTEXT_PREFIXES.length).map((f) => f.injected), CONTEXT_PREFIXES.map(() => 1), 'every Codex context fragment');
  assert.deepEqual(flags.slice(CONTEXT_PREFIXES.length).map((f) => f.injected), [0, 0, 0], 'typed prompt, reply and other agents untouched');
  assert.equal(rows(s.db).c1!.excerpt, 'synthetic prompt about <environment_context>');
});
