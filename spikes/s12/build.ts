// S12 corpus build (P0-S12-T2). Runs on the packaged Electron runtime (ELECTRON_RUN_AS_NODE=1) via run.ts --build.
// S1 schema shape + §7.4 pragmas/indexes; FTS5 external content over a view that exposes the first 64 KiB of each
// item, so integrity-check and snippet() see exactly what was indexed. Data: .cache/spike-data/s12/ (git-ignored).
// Writes .cache/spike-results/s12/build.json (raw) and spikes/s12/evidence/corpus.json (reduced; no paths).
import { mkdirSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envRecord, hr, mulberry32, summary } from '../shared/bench.ts';
import { openDb } from '../s1/db.ts';
import { checkCorpus, checkUsage, CORPUS, corpusPlan, corpusStats, ITEM, itemBytes, SEEDS, TextPool, TEXT, TS_BASE, USAGE, usagePlan, usageRows } from './gen.ts';

const REPO = join(import.meta.dirname, '..', '..', '..', '..'); // compiled to spikes/app/build/s12/
const DATA = join(REPO, '.cache', 'spike-data', 's12');
const RAW = join(REPO, '.cache', 'spike-results', 's12');
const EVIDENCE = join(REPO, 'spikes', 's12', 'evidence', 'corpus.json');
const DB = join(DATA, 'corpus.db');
const GIB = 2 ** 30;
const MIN_FREE_START = 10 * GIB; // personal profile: ~2-4 GiB DB + WAL + headroom
const MIN_FREE_DURING = 5 * GIB;
const BATCH_BYTES = 64 * 2 ** 20; // build-time batch bound (bulk load, not the live writer's bounds)
const BATCH_ROWS = 20_000;
const BUILD_CACHE_KIB = 262_144; // build-only cache_size; §7.4 pragmas otherwise as S1
const RARE_P = 1e-5;
const AGENTS = ['claude', 'codex']; // personal profile: Claude + Codex mix
const KINDS = ['user', 'assistant', 'tool_use', 'tool_result'];
const DAY = 86_400_000;

const freeBytes = () => { const s = statfsSync(DATA); return s.bavail * s.bsize; };
const ms = (t0: bigint) => Math.round(Number(hr() - t0) / 1e6);
const log = (m: string) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);

mkdirSync(DATA, { recursive: true });
mkdirSync(RAW, { recursive: true });
const free0 = freeBytes();
if (free0 < MIN_FREE_START) { log(`ABORT free disk ${(free0 / GIB).toFixed(1)} GiB < 10 GiB`); process.exit(1); }

const plan = corpusPlan();
const usage = usagePlan();
const pool = new TextPool();
const genFails = [...checkCorpus(plan), ...checkUsage(usage), ...pool.check()];
if (genFails.length) { log(`ABORT generator self-check: ${genFails.join('; ')}`); process.exit(1); }

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
const db = openDb(DB);
db.exec(`PRAGMA cache_size = -${BUILD_CACHE_KIB}`);
db.exec(`
  CREATE TABLE sessions(id INTEGER PRIMARY KEY, agent TEXT NOT NULL, project_id INTEGER NOT NULL, started_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL, trashed_at INTEGER, bytes INTEGER NOT NULL, items INTEGER NOT NULL);
  CREATE TABLE events(id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id), source_seq INTEGER NOT NULL,
    ts INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
  CREATE VIEW events_fts_src AS SELECT id, CAST(substr(CAST(body AS BLOB), 1, ${ITEM.ftsPrefixBytes}) AS TEXT) AS body FROM events;
  CREATE VIRTUAL TABLE events_fts USING fts5(body, content='events_fts_src', content_rowid='id', tokenize='unicode61');
  CREATE TABLE checkpoints(session_id INTEGER PRIMARY KEY REFERENCES sessions(id), path TEXT NOT NULL, dev INTEGER NOT NULL,
    ino INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, offset INTEGER NOT NULL, head_hash TEXT NOT NULL);
  CREATE TABLE context_snapshots(id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id), generation INTEGER NOT NULL,
    model TEXT NOT NULL, used_tokens INTEGER NOT NULL, window_tokens INTEGER NOT NULL, as_of INTEGER NOT NULL, observed_at INTEGER NOT NULL);
  CREATE TABLE usage_snapshots(id INTEGER PRIMARY KEY, usage_scope_id INTEGER NOT NULL, limit_id TEXT NOT NULL, as_of INTEGER NOT NULL,
    observed_at INTEGER NOT NULL, used_percent REAL NOT NULL, resets_at INTEGER NOT NULL, kind TEXT NOT NULL);
  CREATE TABLE price_provenance(id INTEGER PRIMARY KEY, model TEXT NOT NULL, component TEXT NOT NULL, usd_per_mtok REAL NOT NULL,
    effective_from INTEGER NOT NULL, source TEXT NOT NULL, revision INTEGER NOT NULL);`);

const insSession = db.prepare('INSERT INTO sessions(id, agent, project_id, started_at, last_activity, trashed_at, bytes, items) VALUES (?, ?, ?, ?, ?, ?, ?, 0)');
const endSession = db.prepare('UPDATE sessions SET last_activity = ?, items = ? WHERE id = ?');
const insEvent = db.prepare('INSERT INTO events(session_id, source_seq, ts, kind, body) VALUES (?, ?, ?, ?, ?)');
const insFts = db.prepare('INSERT INTO events_fts(rowid, body) SELECT id, body FROM events_fts_src WHERE id BETWEEN ? AND ?');
const insCp = db.prepare('INSERT INTO checkpoints VALUES (?, ?, 1, ?, ?, ?, ?, ?)');
const insCtx = db.prepare('INSERT INTO context_snapshots(session_id, generation, model, used_tokens, window_tokens, as_of, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

const r = mulberry32(SEEDS.build);
let batchFirst = 0, batchLast = 0, batchBytes = 0, batchRows = 0, commits = 0, maxWal = 0;
const itemSizes: number[] = [];
const sessionBytes: number[] = [];
let rare = 0, ftsBytes = 0, overPrefix = 0, contentBytes = 0, ctxRows = 0;
const flush = () => {
  if (batchRows) insFts.run(batchFirst, batchLast);
  db.exec('COMMIT');
  commits++;
  try { maxWal = Math.max(maxWal, statSync(`${DB}-wal`).size); } catch { /* no WAL yet */ }
  if (freeBytes() < MIN_FREE_DURING) throw new Error('free disk below 5 GiB during build');
  batchFirst = batchBytes = batchRows = 0;
  db.exec('BEGIN');
};

const t0 = hr();
db.exec('BEGIN');
for (let i = 0; i < plan.sizes.length; i++) {
  const id = i + 1, target = plan.sizes[i];
  const agent = AGENTS[Math.floor(r() * r() * AGENTS.length)];
  const project = 1 + Math.floor(r() * r() * 30); // ~30 projects (personal)
  const started = TS_BASE - Math.floor(r() * 180 * DAY);
  insSession.run(id, agent, project, started, started, r() < 0.02 ? started + 30 * DAY : null, target);
  let acc = 0, seq = 0, ts = started;
  while (acc < target) {
    const want = Math.min(itemBytes(r), target - acc);
    const marked = want > 16 && r() < RARE_P;
    const body = marked ? `${TEXT.rareMarker} ${pool.slice(r, want - TEXT.rareMarker.length - 1)}` : pool.slice(r, want);
    const n = Buffer.byteLength(body);
    if (n === 0) continue;
    ts += 500 + Math.floor(r() * 5000);
    const rowid = Number(insEvent.run(id, ++seq, ts, KINDS[Math.floor(r() * KINDS.length)], body).lastInsertRowid);
    if (!batchFirst) batchFirst = rowid;
    batchLast = rowid;
    acc += n; batchBytes += n; batchRows++;
    itemSizes.push(n);
    ftsBytes += Math.min(n, ITEM.ftsPrefixBytes);
    if (n > ITEM.ftsPrefixBytes) overPrefix++;
    if (marked) rare++;
    if (batchBytes >= BATCH_BYTES || batchRows >= BATCH_ROWS) flush();
  }
  contentBytes += acc;
  sessionBytes.push(acc);
  endSession.run(ts, seq, id);
  insCp.run(id, `/tmp/xaibo-fixture/p${project}/${id}.jsonl`, id, acc, ts, acc, (id * 2654435761 >>> 0).toString(16).padStart(8, '0'));
  const gens = 1 + Math.floor(r() * USAGE.contextGenerationsMax);
  for (let g = 1; g <= gens; g++, ctxRows++) {
    const window = r() < 0.2 ? 1_000_000 : 200_000;
    insCtx.run(id, g, `model-${g % 4}`, Math.floor(r() * window), window, ts, ts);
  }
  if (id % 500 === 0) log(`sessions ${id}/${plan.sizes.length} content ${(contentBytes / GIB).toFixed(2)} GiB ${ms(t0)} ms`);
}
flush();
db.exec('COMMIT');
const loadMs = ms(t0);
log(`load done ${loadMs} ms`);

const t1 = hr();
db.exec('BEGIN');
const insUsage = db.prepare('INSERT INTO usage_snapshots(usage_scope_id, limit_id, as_of, observed_at, used_percent, resets_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?)');
let usageRowsN = 0, transitions = 0;
for (const [scope, limit, asOf, used, resets, kind] of usageRows(usage)) {
  insUsage.run(scope, limit, asOf, asOf, used, resets, kind);
  usageRowsN++;
  if (kind === 'transition') transitions++;
}
const insPrice = db.prepare('INSERT INTO price_provenance(model, component, usd_per_mtok, effective_from, source, revision) VALUES (?, ?, ?, ?, ?, ?)');
for (let m = 0; m < USAGE.priceModels; m++) for (const c of USAGE.priceComponents) for (let rev = 1; rev <= USAGE.priceRevisions; rev++) {
  insPrice.run(`model-${m}`, c, Math.round(r() * 7500) / 100, TS_BASE - (USAGE.priceRevisions - rev) * 30 * DAY, 'bundled', rev);
}
db.exec('COMMIT');
const usageMs = ms(t1);

const t2 = hr();
db.exec(`
  CREATE UNIQUE INDEX events_session_seq ON events(session_id, source_seq);
  CREATE INDEX sessions_agent_activity ON sessions(agent, last_activity);
  CREATE INDEX sessions_project ON sessions(project_id);
  CREATE INDEX sessions_trashed ON sessions(trashed_at);
  CREATE INDEX usage_scope_limit_asof ON usage_snapshots(usage_scope_id, limit_id, as_of);
  CREATE INDEX context_session_generation ON context_snapshots(session_id, generation);`);
const indexMs = ms(t2);
log(`usage ${usageMs} ms, indexes ${indexMs} ms`);

const one = (sql: string) => Object.values(db.prepare(sql).get() ?? {})[0] as any;
const walBytesBeforeCheckpoint = statSync(`${DB}-wal`).size;
const t3 = hr();
const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
const checkpointMs = ms(t3);
const walBytesAfterCheckpoint = statSync(`${DB}-wal`).size;
const pageSize = one('PRAGMA page_size'), pageCount = one('PRAGMA page_count'), freelist = one('PRAGMA freelist_count');

const tables = ['sessions', 'events', 'checkpoints', 'context_snapshots', 'usage_snapshots', 'price_provenance',
  'events_fts_data', 'events_fts_idx', 'events_fts_docsize', 'events_fts_config'];
const rows = Object.fromEntries(tables.map((t) => [t, one(`SELECT count(*) FROM ${t}`)]));
const t4 = hr();
const dbstat = Object.fromEntries((db.prepare('SELECT name, pgsize, payload, ncell FROM dbstat WHERE aggregate = TRUE ORDER BY pgsize DESC').all() as { name: string; pgsize: number; payload: number; ncell: number }[])
  .map((x) => [x.name, { bytes: x.pgsize, payload: x.payload }]));
const dbstatMs = ms(t4);
log(`dbstat ${dbstatMs} ms; integrity_check…`);
const t5 = hr();
const integrity = (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((x) => x.integrity_check).join('; ');
const integrityMs = ms(t5);
log(`integrity ${integrity} ${integrityMs} ms; FTS integrity-check…`);
const t6 = hr();
let ftsIntegrity = false;
try { db.exec(`INSERT INTO events_fts(events_fts) VALUES('integrity-check')`); ftsIntegrity = true; } catch (e) { log(`FTS integrity: ${(e as Error).message}`); }
const ftsIntegrityMs = ms(t6);
const pragmas = Object.fromEntries(['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout', 'auto_vacuum', 'temp_store'].map((p) => [p, one(`PRAGMA ${p}`)]));
db.close();

const actual = corpusStats(sessionBytes);
const out = {
  tag: 'spike, not gate evidence',
  task: 'P0-S12-T2',
  profile: { name: 'personal (owner decision 2026-11-10; overrides plan scale)', declared: CORPUS, estimate: '~' },
  runtime: 'packaged Electron runtime (ELECTRON_RUN_AS_NODE=1), node:sqlite DatabaseSync',
  env: envRecord(),
  seeds: SEEDS,
  generator: {
    sessions: actual,
    items: { ...summary(itemSizes), total: itemSizes.length, overFtsPrefix: overPrefix, ftsPrefixBytes: ITEM.ftsPrefixBytes, ftsIndexedBytes: ftsBytes },
    text: { ...pool.counts, cjkFraction: pool.counts.cjk / pool.counts.tokens, emojiFraction: pool.counts.emoji / pool.counts.tokens, vocabulary: TEXT.vocab, cjkWords: TEXT.cjkWords },
    terms: { common: pool.vocab[0], cjk: pool.cjk[0], rare: TEXT.rareMarker, rareItems: rare },
    bigSessionId: 1,
    usage: { streams: usage.streams.length, samplesPerStream: usage.minutes, transitionsPerStream: usage.streams[0].transitions, rows: usageRowsN, transitions, contextRows: ctxRows, priceRows: rows.price_provenance },
    contentBytes,
  },
  build: { loadMs, usageMs, indexMs, checkpointMs, totalMs: loadMs + usageMs + indexMs + checkpointMs, commits, batchBytes: BATCH_BYTES, batchRows: BATCH_ROWS, buildCacheKiB: BUILD_CACHE_KIB },
  db: { pageSize, pageCount, bytes: pageSize * pageCount, gib: (pageSize * pageCount) / GIB, freelistPages: freelist, walBytesMaxDuringLoad: maxWal, walBytesBeforeCheckpoint, walBytesAfterCheckpoint, checkpoint, pragmas },
  rows,
  dbstat,
  verify: { integrity, integrityMs, ftsIntegrity, ftsIntegrityMs, dbstatMs },
};
const text = JSON.stringify(out, null, 1) + '\n';
writeFileSync(join(RAW, 'build.json'), text);
writeFileSync(EVIDENCE, text);
log(`done: ${out.db.gib.toFixed(2)} GiB, integrity ${integrity}, fts ${ftsIntegrity}`);
process.exitCode = integrity === 'ok' && ftsIntegrity ? 0 : 1;
