// XAIBO-PROD-521 (P5-T14; PRD §5.7, design §6.4, Q-5.3, EC-58): scoped, paged FTS5 search over event_fts (unicode61).
// User text becomes quoted terms (never an FTS syntax error); one hit per session (its best-ranked event) with a plain-text
// snippet of at most 200 characters; keyset pages on (rank, session). Scope is the session list filter: All excludes
// Trash and includes archived, Archived and Trash restrict; suppressed never; injected and non-current never match.
// EC-58 documents the unicode61 baseline: a CJK run without spaces is one token (the whole run matches, a substring
// misses), emoji are separators (an emoji-only query finds nothing), diacritics fold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { applyOverlay } from '../../../src/service/history/overlay.ts';
import { openStore } from '../../../src/service/store/db.ts';
import { ftsPrefix } from '../../../src/service/store/writer.ts';
import { ftsQuery, searchSessions, SEARCH_COVERAGE, SEARCH_ITEM_LIMIT, SNIPPET_MAX } from '../../../src/service/search/query.ts';
import type { HistoryFilter } from '../../../src/shared/ipc.ts';

const T = 1_700_000_000_000;
const sid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

async function store() {
  const tmp = mkdtempSync(join(tmpdir(), 'xsearch-'));
  const { db } = await openStore({ file: join(tmp, 'xaibo.db'), backupDir: join(tmp, 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', '/tmp/xaibo-fixture/codex', 'default')").run();
  let n = 0, seq = 0;
  const session = (agent: 'claude' | 'codex' = 'claude') => Number(db.prepare('INSERT INTO sessions (agent, profile_id, native_session_id, last_activity) VALUES (?, ?, ?, ?)')
    .run(agent, agent === 'claude' ? 'p1' : 'p2', sid(++n), T + n).lastInsertRowid);
  /** An event with its FTS row as the writer stores it (the ftsPrefix of its content). */
  const ev = (session: number, content: string, o: { injected?: number; status?: string } = {}) => {
    const id = Number(db.prepare(`INSERT INTO events (session_id, schema_version, source, confidence, native_id, kind, role, source_seq, received_ts, injected, content, revision_status)
      VALUES (?, 1, 'transcript', 'observed', ?, 'user', 'user', ?, ?, ?, ?, ?)`).run(session, `n${++seq}`, seq, T, o.injected ?? 0, content, o.status ?? 'current').lastInsertRowid);
    db.prepare('INSERT INTO event_fts (rowid, content) VALUES (?, ?)').run(id, ftsPrefix(content));
    return id;
  };
  return { db, session, ev };
}

const ALL: HistoryFilter = { mode: 'all', agent: null, project: null, folder: null };
const find = (db: DatabaseSync, q: string, f: Partial<HistoryFilter> = {}, limit = 100) => searchSessions(db, q, { ...ALL, ...f }, null, limit);
const sessionsOf = (db: DatabaseSync, q: string, f: Partial<HistoryFilter> = {}) => find(db, q, f).hits.map((h) => h.session).sort((a, b) => a - b);

test('query escaping: user text is quoted terms, so FTS syntax in it never errors; empty input finds nothing', async () => {
  const { db, session, ev } = await store();
  const s = session();
  ev(s, 'fix the bug and say "hi" near col: done');
  assert.equal(ftsQuery(''), null);
  assert.equal(ftsQuery('   \t\n'), null);
  assert.equal(ftsQuery('bug AND'), '"bug" "AND"');
  assert.equal(ftsQuery('say "hi"'), '"say" """hi"""');
  for (const q of ['bug AND', 'NEAR(', '"', '*', 'col:bug', '-bug', '^bug', 'bug OR', '(bug', 'a" OR "b', '\u0000bug\u0007', 'x'.repeat(10_000), '"""', '{bug}', 'bug +']) {
    assert.doesNotThrow(() => find(db, q), `no error for ${JSON.stringify(q.slice(0, 20))}`);
  }
  assert.deepEqual(sessionsOf(db, 'bug AND'), [s], 'AND is a literal word, both terms present');
  assert.deepEqual(sessionsOf(db, 'say "hi"'), [s], 'quotes inside a term are literal');
  assert.deepEqual(find(db, ''), { hits: [], next: null });
  assert.ok(ftsQuery('w '.repeat(100))!.split(' ').length <= 16, 'term count is bounded');
  assert.ok([...ftsQuery('x'.repeat(10_000))!].length <= 258, 'query length is bounded');
});

test('EC-58: unicode61 baseline for CJK, Korean, emoji and diacritics (incl. the known CJK substring miss)', async () => {
  const { db, session, ev } = await store();
  const zh = session(), ja = session(), emoji = session(), ko = session(), fr = session(), rocket = session();
  ev(zh, '修复登录错误');
  ev(ja, '東京 タワー');
  ev(emoji, 'fix the bug 🐛 now');
  ev(ko, '한국어 테스트');
  ev(fr, 'café résumé');
  ev(rocket, 'launch 🚀🚀');
  assert.deepEqual(sessionsOf(db, '修复登录错误'), [zh], 'a whole CJK run (one token) matches');
  assert.deepEqual(sessionsOf(db, '登录'), [], 'known limitation: a CJK substring inside a run misses (trigram later)');
  assert.deepEqual(sessionsOf(db, '東京'), [ja], 'space-separated CJK words match');
  assert.deepEqual(sessionsOf(db, 'タワー'), [ja]);
  assert.deepEqual(sessionsOf(db, '한국어'), [ko], 'a whole Korean word matches');
  assert.deepEqual(sessionsOf(db, '테스'), [], 'a partial Korean word misses (exact tokens, no prefix)');
  assert.deepEqual(sessionsOf(db, '🐛'), [], 'emoji are separators: an emoji-only query finds nothing');
  assert.deepEqual(sessionsOf(db, '🚀'), []);
  assert.deepEqual(sessionsOf(db, 'bug'), [emoji], 'words next to an emoji still match');
  assert.deepEqual(sessionsOf(db, 'cafe resume'), [fr], 'diacritics fold');
  assert.deepEqual(sessionsOf(db, 'CAFÉ'), [fr], 'case folds');
});

test('Q-5.3 scope: All excludes Trash and includes archived; Archived and Trash restrict; suppressed never; agent filter', async () => {
  const { db, session, ev } = await store();
  const live = session(), arch = session(), trash = session(), supp = session(), cleared = session(), codex = session('codex');
  for (const s of [live, arch, trash, supp, cleared, codex]) ev(s, 'deploy the service');
  applyOverlay(db, { kind: 'archive', session: arch, on: true }, { readOnly: false, now: T });
  applyOverlay(db, { kind: 'trash', session: trash, on: true }, { readOnly: false, now: T });
  const mark = db.prepare("INSERT INTO suppressions (agent, profile_id, native_session_id, reason, at, cleared_at) SELECT agent, profile_id, native_session_id, 'manual', ?, ? FROM sessions WHERE id = ?");
  mark.run(T, null, supp);
  mark.run(T, T + 1, cleared); // a cleared marker (Re-import): the session is back
  assert.deepEqual(sessionsOf(db, 'deploy'), [live, arch, cleared, codex].sort((a, b) => a - b));
  assert.deepEqual(sessionsOf(db, 'deploy', { mode: 'archived' }), [arch]);
  assert.deepEqual(sessionsOf(db, 'deploy', { mode: 'trash' }), [trash]);
  assert.deepEqual(sessionsOf(db, 'deploy', { agent: 'codex' }), [codex]);
});

test('injected and non-current events never match; one hit per session (its best event) with a short plain-text snippet', async () => {
  const { db, session, ev } = await store();
  const a = session(), b = session(), c = session();
  ev(a, 'system reminder about quokka', { injected: 1 });
  ev(b, 'old quokka text', { status: 'superseded' });
  ev(c, 'one quokka here');
  const best = ev(c, 'quokka quokka quokka, all about the quokka');
  ev(c, `${'filler '.repeat(400)}quokka ${'tail '.repeat(400)}`);
  const r = find(db, 'quokka');
  assert.deepEqual(r.hits.map((h) => h.session), [c], 'injected and superseded rows never match; one hit per session');
  assert.equal(r.hits[0]!.event, best, 'the hit is the session\'s best-ranked event');
  const long = find(db, 'tail').hits[0]!;
  assert.ok([...long.snippet].length <= SNIPPET_MAX, `snippet at most ${SNIPPET_MAX} characters`);
  assert.match(long.snippet, /tail/);
  assert.doesNotMatch(r.hits[0]!.snippet, /[<>[\]]|<b>/, 'no markup in the snippet');
  assert.equal(typeof r.hits[0]!.rank, 'number');
});

test('coverage: only the first 64 KiB of an item is searchable; the notes state it', async () => {
  const { db, session, ev } = await store();
  const s = session();
  ev(s, `${'a '.repeat(40 * 1024)}wombat`); // ~80 KiB: the word lies past the indexed prefix
  ev(s, 'numbat early');
  assert.deepEqual(sessionsOf(db, 'wombat'), [], 'text past 64 KiB is not indexed');
  assert.deepEqual(sessionsOf(db, 'numbat'), [s]);
  assert.equal(SEARCH_COVERAGE, 'Search covers retained indexed content; incomplete sources may have gaps');
  assert.match(SEARCH_ITEM_LIMIT, /64 KiB/);
});

test('review M1: snippets come from a bounded prefix, so multi-MiB matching events keep a page fast; the snippet shows the match', async () => {
  const { db, session, ev } = await store();
  const big = `${'pad '.repeat(500)}kiwi ${'error '.repeat(1_400_000)}`; // ~8 MiB, under the parse cap: stored whole
  for (let i = 0; i < 3; i++) ev(session(), big);
  const t0 = performance.now();
  const r = find(db, 'error'); // a common word repeated through a big tool output: snippet() over full content took ~450 ms per hit
  const ms = performance.now() - t0;
  assert.equal(r.hits.length, 3);
  assert.ok(ms < 750, `three 8 MiB hits in ${ms.toFixed(0)} ms`); // snippet() took 1.4 s alone, 4 s under suite load
  for (const h of r.hits) { assert.match(h.snippet, /error/, 'the window holds the match'); assert.ok([...h.snippet].length <= SNIPPET_MAX); }
  assert.match(find(db, 'kiwi').hits[0]!.snippet, /kiwi/, 'a match past the first 200 characters is in the window');
});

test('review L5: tied ranks page once each; project scope; an open transaction is left open', async () => {
  const { db, session, ev } = await store();
  const ids: number[] = [];
  for (let i = 0; i < 20; i++) { const s = session(); ids.push(s); ev(s, 'iguana'); }
  const seen: number[] = [];
  let cursor = null, pages = 0;
  do { const p = searchSessions(db, 'iguana', ALL, cursor, 3); seen.push(...p.hits.map((h) => h.session)); cursor = p.next; assert.ok(++pages <= 8); } while (cursor);
  assert.deepEqual(seen, ids, 'equal ranks: session order, each once');
  const proj = applyOverlay(db, { kind: 'newProject', name: 'Alpha' }, { readOnly: false, now: T });
  assert.ok(proj.ok && proj.id);
  applyOverlay(db, { kind: 'move', session: ids[4]!, project: proj.id!, folder: null }, { readOnly: false, now: T });
  assert.deepEqual(sessionsOf(db, 'iguana', { project: proj.id! }), [ids[4]]);
  db.exec('BEGIN');
  assert.equal(find(db, 'iguana').hits.length, 20);
  assert.equal(db.isTransaction, true, "the caller's transaction is left open");
  db.exec('COMMIT');
});

test('keyset paging: pages progress, are disjoint, ordered by rank then session, and end; page size clamped', async () => {
  const { db, session, ev } = await store();
  const ids: number[] = [];
  for (let i = 0; i < 7; i++) { const s = session(); ids.push(s); ev(s, `${'gecko '.repeat(1 + (i % 3))}${'pad '.repeat(i)}`); }
  for (let i = 0; i < 120; i++) ev(session(), 'iguana');
  const seen: { session: number; rank: number }[] = [];
  let cursor = null, pages = 0;
  do {
    const p = searchSessions(db, 'gecko', ALL, cursor, 3);
    assert.ok(p.hits.length <= 3);
    seen.push(...p.hits);
    cursor = p.next;
    assert.ok(++pages <= 4, 'paging ends');
  } while (cursor);
  assert.deepEqual(seen.map((h) => h.session).sort((a, b) => a - b), ids, 'every session once');
  for (let i = 1; i < seen.length; i++) {
    const x = seen[i - 1]!, y = seen[i]!;
    assert.ok(x.rank < y.rank || (x.rank === y.rank && x.session < y.session), 'ordered by rank, then session');
  }
  assert.equal(searchSessions(db, 'iguana', ALL, null, 0).hits.length, 50, 'default page 50');
  assert.equal(searchSessions(db, 'iguana', ALL, null, 10_000).hits.length, 100, 'hard cap 100');
});
