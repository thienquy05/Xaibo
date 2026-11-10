// S12 query timings (P0-S12-T3) on the T2 corpus. Runs on the packaged Electron runtime (ELECTRON_RUN_AS_NODE=1)
// via run.ts --queries. Warm: one process and connection, statements prepared once, 5 warm-up runs, then N timed.
// "Cold" (OQ-A11): N new processes (this file with --one), each opens a new connection and runs every query once,
// prepare included; the OS page cache stays warm (no `sudo purge`). Times are the DB portion only (no IPC, no paint).
// Writes .cache/spike-results/s12/queries.json (raw) and spikes/s12/evidence/queries.json (reduced; no paths).
import { spawnSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { envRecord, hr, summary } from '../shared/bench.ts';
import { openDb } from '../s1/db.ts';

const REPO = join(import.meta.dirname, '..', '..', '..', '..'); // compiled to spikes/app/build/s12/
const DB = join(REPO, '.cache', 'spike-data', 's12', 'corpus.db');
const RAW = join(REPO, '.cache', 'spike-results', 's12', 'queries.json');
const EVIDENCE = join(REPO, 'spikes', 's12', 'evidence', 'queries.json');
const LIST_PAGE = 50, FTS_PAGE = 20, CONTENT_ROWS = 50, CONTENT_ITEM_CAP = 64 * 1024; // bounded page: <= 50 rows x 64 Ki characters (substr counts characters)
const DAY = 86_400_000;
// DB-portion budgets: the M12/M13 totals include IPC and paint, so the DB share must leave room (judged at Gates 1-5).
const BUDGET = { list: 1500, content: 300, search: 500 };

// Terms come from the T2 generator record (common = Zipf rank 1, CJK = first CJK word, rare = the marker).
const TERMS = { common: 'kape', cjk: '"嘶泷"', rare: 'zqxrare' };
const BIG = 1; // the 50 MB session

type Q = { name: string; budget: keyof typeof BUDGET | null; sql: string; args: (i: number) => (string | number)[] };
const LIST_COLS = 'id, agent, project_id, last_activity, bytes, items';
const FTS = (order: string) => `SELECT f.rowid AS id, e.session_id, snippet(events_fts, 0, '[', ']', '…', 12) AS snip
  FROM events_fts f JOIN events e ON e.id = f.rowid WHERE events_fts MATCH ? ORDER BY ${order} LIMIT ${FTS_PAGE}`;
// substr counts characters, not bytes: the cap is 64 Ki characters, up to ~192 KiB of UTF-8 for CJK text.
const CONTENT = `SELECT id, source_seq, ts, kind, length(body) AS len, substr(body, 1, ${CONTENT_ITEM_CAP}) AS body
  FROM events WHERE session_id = ? AND source_seq > ? ORDER BY source_seq LIMIT ${CONTENT_ROWS}`;
const QUERIES: Q[] = [
  { name: 'list_unfiltered', budget: 'list', sql: `SELECT ${LIST_COLS} FROM sessions WHERE trashed_at IS NULL ORDER BY last_activity DESC, id DESC LIMIT ${LIST_PAGE}`, args: () => [] },
  { name: 'list_by_agent', budget: 'list', sql: `SELECT ${LIST_COLS} FROM sessions WHERE agent = ? AND trashed_at IS NULL ORDER BY last_activity DESC, id DESC LIMIT ${LIST_PAGE}`, args: (i) => [i % 2 ? 'codex' : 'claude'] },
  { name: 'list_by_project', budget: 'list', sql: `SELECT ${LIST_COLS} FROM sessions WHERE project_id = ? AND trashed_at IS NULL ORDER BY last_activity DESC, id DESC LIMIT ${LIST_PAGE}`, args: (i) => [1 + (i % 10)] },
  { name: 'fts_common_bm25', budget: 'search', sql: FTS('rank'), args: () => [TERMS.common] },
  { name: 'fts_common_recent', budget: 'search', sql: FTS('f.rowid DESC'), args: () => [TERMS.common] },
  { name: 'fts_rare_bm25', budget: 'search', sql: FTS('rank'), args: () => [TERMS.rare] },
  { name: 'fts_cjk_bm25', budget: 'search', sql: FTS('rank'), args: () => [TERMS.cjk] },
  { name: 'fts_cjk_recent', budget: 'search', sql: FTS('f.rowid DESC'), args: () => [TERMS.cjk] },
  // Content: page 1 from seq 0; next 5 pages by keyset (each page timed separately, cursors taken from page 1 run).
  { name: 'content_page1', budget: 'content', sql: CONTENT, args: () => [BIG, 0] },
  ...[2, 3, 4, 5, 6].map((p): Q => ({ name: `content_page${p}`, budget: 'content', sql: CONTENT, args: () => [BIG, (p - 1) * CONTENT_ROWS] })),
  { name: 'quota_45d_one_scope', budget: null, sql: `SELECT limit_id, as_of, used_percent, resets_at, kind FROM usage_snapshots
      WHERE usage_scope_id = 0 AND limit_id IN ('5h', '7d') AND as_of BETWEEN ? AND ? ORDER BY limit_id, as_of`, args: () => [Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1) + 45 * DAY] },
  { name: 'month_totals_sessions', budget: null, sql: `SELECT strftime('%Y-%m', started_at / 1000, 'unixepoch') AS month, agent, count(*) AS sessions,
      sum(items) AS items, sum(bytes) AS bytes FROM sessions WHERE trashed_at IS NULL GROUP BY month, agent ORDER BY month`, args: () => [] },
  { name: 'month_quota_peaks', budget: null, sql: `SELECT strftime('%Y-%m', as_of / 1000, 'unixepoch') AS month, limit_id, max(used_percent) AS peak,
      sum(kind = 'transition') AS resets FROM usage_snapshots WHERE usage_scope_id = 0 GROUP BY month, limit_id`, args: () => [] },
];

const open = (): DatabaseSync => openDb(DB, { readOnly: true });
const timeOne = (db: DatabaseSync, q: Q, i: number, prepared?: ReturnType<DatabaseSync['prepare']>) => {
  const t = hr();
  const rows = (prepared ?? db.prepare(q.sql)).all(...q.args(i));
  return { ms: Number(hr() - t) / 1e6, rows: rows.length };
};

const { values: v } = parseArgs({ options: { one: { type: 'boolean' }, n: { type: 'string' } } });
if (v.one) {
  const t = hr();
  const db = open();
  const openMs = Number(hr() - t) / 1e6;
  process.stdout.write(JSON.stringify({ openMs, q: Object.fromEntries(QUERIES.map((q) => [q.name, timeOne(db, q, 0).ms])) }));
  db.close();
  process.exit(0);
}

const N = Number(v.n ?? 200);
const log = (m: string) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const db = open();
const warm: Record<string, number[]> = {}, rows: Record<string, number> = {};
for (const q of QUERIES) {
  const st = db.prepare(q.sql);
  for (let i = 0; i < 5; i++) timeOne(db, q, i, st);
  warm[q.name] = [];
  for (let i = 0; i < N; i++) { const r = timeOne(db, q, i, st); warm[q.name].push(r.ms); rows[q.name] = r.rows; }
  log(`warm ${q.name} p95 ${summary(warm[q.name]).p95.toFixed(2)} ms rows ${rows[q.name]}`);
}
db.close();

const cold: Record<string, number[]> = Object.fromEntries(QUERIES.map((q) => [q.name, []]));
const coldOpen: number[] = [], coldSpawn: number[] = [];
for (let i = 0; i < N; i++) {
  const t = hr();
  const res = spawnSync(process.execPath, [import.meta.filename, '--one'], { encoding: 'utf8', env: process.env });
  coldSpawn.push(Number(hr() - t) / 1e6);
  if (res.status !== 0) throw new Error(`cold run ${i} failed: ${res.stderr}`);
  const o = JSON.parse(res.stdout) as { openMs: number; q: Record<string, number> };
  coldOpen.push(o.openMs);
  for (const [k, ms] of Object.entries(o.q)) cold[k].push(ms);
  if ((i + 1) % 50 === 0) log(`cold ${i + 1}/${N}`);
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const brief = (s: number[]) => { const x = summary(s); return { n: x.n, p50: r3(x.p50), p95: r3(x.p95), p99: r3(x.p99), max: r3(x.max) }; };
const table = QUERIES.map((q) => {
  const w = brief(warm[q.name]), c = brief(cold[q.name]);
  const budget = q.budget ? BUDGET[q.budget] : null;
  return { query: q.name, rows: rows[q.name], warmMs: w, coldMs: c, budgetMs: budget, budgetOf: q.budget, withinBudgetP99: budget === null ? null : Math.max(w.p99, c.p99) <= budget };
});
const out = {
  tag: 'spike, not gate evidence',
  task: 'P0-S12-T3',
  profile: 'personal (owner decision 2026-11-10); corpus from P0-S12-T2 (seeds in corpus.json)',
  runtime: 'packaged Electron runtime (ELECTRON_RUN_AS_NODE=1), node:sqlite DatabaseSync, read-only connection, default cache_size',
  env: envRecord(),
  dbBytes: statSync(DB).size,
  method: { n: N, warm: 'one connection, prepared once, 5 warm-up runs', cold: 'new process + connection per run, prepare included, OS page cache warm (OQ-A11); true cold not run',
    listPage: LIST_PAGE, ftsPage: FTS_PAGE, contentPage: { rows: CONTENT_ROWS, itemCapCharacters: CONTENT_ITEM_CAP }, terms: { common: TERMS.common, cjk: TERMS.cjk, rare: TERMS.rare } },
  budgetsMs: { ...BUDGET, note: 'M12 list <= 1.5 s and M13 content <= 300 ms / search <= 500 ms are end-to-end incl. paint; these are DB-portion times' },
  coldProcessMs: { open: brief(coldOpen), spawnTotal: brief(coldSpawn) },
  queries: table,
};
const text = JSON.stringify(out, null, 1) + '\n';
writeFileSync(RAW, text);
writeFileSync(EVIDENCE, text);
for (const t of table) log(`${t.query.padEnd(22)} warm p50/p95/p99 ${t.warmMs.p50}/${t.warmMs.p95}/${t.warmMs.p99}  cold ${t.coldMs.p50}/${t.coldMs.p95}/${t.coldMs.p99}  budget ${t.budgetMs ?? '-'} ${t.withinBudgetP99 ?? ''}`);
