// XAIBO-PROD-212 (P2-T12, EC-74 tag and count part): a Codex rollout started by Claude Code (app-server source
// "vscode", originator "Claude Code", built in the test from the synthetic usage-basic rollout) ingested next to a
// Claude session stays one Codex session tagged with its originator, is listed with the cross-agent badge, and each
// session's usage counts once under its own agent (per-agent sums equal the single-agent ingests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { CodexAdapter } from '../../src/service/adapters/codex/index.ts';
import { listSessions } from '../../src/service/api.ts';
import { loadCatalog } from '../../src/service/catalog/validate.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { claudeProfile } from '../helpers/claude-profile.ts';

const CODEX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0', 'usage-basic');
const SID = '00000000-0000-4000-8000-0000000c0001';

function codexRoot(tmp: string) {
  const root = join(tmp, 'codex');
  const dated = join(root, 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  const name = readdirSync(CODEX).find((f) => f.startsWith('rollout-'))!;
  const text = readFileSync(join(CODEX, name), 'utf8').replace('"originator":"codex-tui"', '"originator":"Claude Code"').replace('"source":"cli"', '"source":"vscode"');
  assert.ok(text.includes('"originator":"Claude Code"') && text.includes('"source":"vscode"'));
  writeFileSync(join(dated, name), text);
  return root;
}

const ingest = async (db: DatabaseSync, writer: Writer, agents: { claude?: string; codex?: string }) => {
  if (agents.claude) { const a = new ClaudeAdapter({ db, writer, profileId: 'p1', root: agents.claude, intervalMs: 60_000 }); await a.start(); a.stop(); }
  if (agents.codex) {
    db.prepare("INSERT OR IGNORE INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', ?, 'default')").run(agents.codex);
    const a = new CodexAdapter({ db, writer, profileId: 'p2', root: agents.codex, intervalMs: 60_000 }); await a.start(); a.stop();
  }
};
const perAgent = (db: DatabaseSync) => Object.fromEntries((db.prepare(`SELECT s.agent, count(DISTINCT s.id) AS sessions,
  sum(coalesce(u.uncached_input, 0) + coalesce(u.cache_read, 0) + coalesce(u.cache_write, 0) + coalesce(u.output, 0)) AS tokens
  FROM usage u JOIN sessions s ON s.id = u.session_id
  WHERE (s.agent = 'claude' AND u.scope = 'message') OR (s.agent = 'codex' AND u.scope = 'session') GROUP BY s.agent`).all() as
  { agent: string; sessions: number; tokens: number }[]).map((r) => [r.agent, { sessions: r.sessions, tokens: r.tokens }]));

test('EC-74: the cross-agent Codex session is tagged, badged and counted once per agent', async () => {
  const both = await claudeProfile(['usage-basic']);
  const codexHome = codexRoot(both.tmp);
  await ingest(both.db, both.writer, { claude: both.root, codex: codexHome });

  const s = both.db.prepare('SELECT agent, originator, entrypoint FROM sessions WHERE native_session_id = ?').all(SID).map((r) => ({ ...r }));
  assert.deepEqual(s, [{ agent: 'codex', originator: 'Claude Code', entrypoint: 'vscode' }], 'one Codex session with its originator');

  const row = listSessions(both.db, null, 50, loadCatalog().sessionKinds).rows.find((r) => r.agent === 'codex');
  assert.equal(row?.origin, 'via Claude Code');
  assert.equal(row?.interactive, false);

  // Single-agent ingests of the same inputs give the reference sums.
  const claudeOnly = await claudeProfile(['usage-basic']);
  await ingest(claudeOnly.db, claudeOnly.writer, { claude: claudeOnly.root });
  const tmp = mkdtempSync(join(tmpdir(), 'xcross-'));
  const store = await openStore({ file: join(tmp, 'data', 'xaibo.db'), backupDir: join(tmp, 'data', 'backups') });
  await ingest(store.db, new Writer(store.db), { codex: codexRoot(tmp) });

  const sums = perAgent(both.db);
  assert.deepEqual(sums.claude, perAgent(claudeOnly.db).claude);
  assert.deepEqual(sums.codex, perAgent(store.db).codex);
  assert.equal(sums.claude?.sessions, 1);
  assert.equal(sums.codex?.sessions, 1);
  assert.ok((sums.codex?.tokens ?? 0) > 0 && (sums.claude?.tokens ?? 0) > 0);

  await ingest(both.db, both.writer, { claude: both.root, codex: codexHome });
  assert.deepEqual(perAgent(both.db), sums, 'a restart adds nothing');
});
