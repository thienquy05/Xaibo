// P5-T11 (EC-99, PRD §6.6 TP): quota history at the personal profile. The packaged app imports the tp corpus (1,455 sessions
// plus 2 Codex quota streams x 45 days, scripts/gen-perf-corpus.ts --case tp); the import must reach the TP workload
// (>= 1,450 sessions, >= ~2.4 GiB DB, G5e-1) or the probe stops with that message; after backfill_done, with the app still running,
// every day of both streams is paged the way the Observed history panel asks (one UTC day, 50 records a page) on the
// service's query (answerUsageHistory) over a read-only connection: first page and every page timed. Reported: row counts,
// table and index bytes (dbstat), DB/WAL bytes, the query plans. Then, app closed, one retention run on the imported store
// with the clock 46 days past the last reading (session retention Never, so only quota expires): rows expired, total time
// and the longest settle + delete transaction. ponytail: query time on the service side, not the UI path; the M13 UI
// measurement (selection -> first page, cold and warm) is P5-T20.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { answerUsageHistory, USAGE_HISTORY_PAGE } from '../../src/service/api.ts';
import { runRetention, QUOTA_EXPIRED, QUOTA_STREAM } from '../../src/service/retention/job.ts';
import { setRetention } from '../../src/service/retention/policy.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { agyRoot, close, environment, fileBytes, launch, query, serviceLog, stats, tpWorkload, waitForEvent } from './app.ts';

const DAY = 86_400_000;
const PAGE = 50; // src/renderer/model.ts PAGE
const FIRST_PAGE_TARGET_MS = 300; // M13 first bounded page p95, a ceiling for the query part alone

export async function quotaProbe(corpus: string) {
  const summary = JSON.parse(readFileSync(path.join(corpus, 'summary.json'), 'utf8')) as { case: string; files: number; quota: { days: number } };
  if (summary.case !== 'tp') throw new Error('needs the TP corpus: node scripts/gen-perf-corpus.ts --case tp');
  const home = path.join(corpus, 'home');
  // close() removes the launch root, so the store lives beside it until the expiry run on it is done
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-quota-'));
  const l = await launch(path.join(home, '.claude'), { codex: path.join(home, '.codex'), agy: agyRoot(home), dataDir: path.join(dataRoot, 'data') });
  let env: Awaited<ReturnType<typeof environment>> | undefined;
  let importMs: number | null = null;
  let workload: ReturnType<typeof tpWorkload> | undefined;
  let appRetentionRan = false; // the app's own run (10 min after boot, real clock) would purge the corpus mid-measurement
  const pages: number[] = [], firstPages: number[] = [];
  let rows: Record<string, number> = {}, bytes: Record<string, number> = {}, plans: Record<string, string> = {};
  const streams: { scope: number; stream: string; rows: number; transitions: number; first: number; last: number }[] = [];
  try {
    env = await environment(l.app);
    const done = await waitForEvent(l.dataDir, 'backfill_done', 30 * 60_000);
    if (done === null) throw new Error('no backfill_done within 30 min');
    importMs = done - l.created;
    workload = tpWorkload(l.dataDir); // G5e-1: throws (app closed below) when the import is smaller than TP
    const db = new DatabaseSync(path.join(l.dataDir, 'xaibo.db'), { readOnly: true });
    try {
      const count = (sql: string) => Number(Object.values(db.prepare(sql).get() ?? {})[0]);
      const next = db.prepare(QUOTA_STREAM);
      for (const { id: scope } of db.prepare('SELECT id FROM usage_scopes WHERE session_id IS NULL ORDER BY id').all() as { id: number }[]) {
        for (let s = (next.get(scope, '') as { l: string | null }).l; s !== null; s = (next.get(scope, s) as { l: string | null }).l) {
          const r = db.prepare(`SELECT count(*) AS n, sum(kind = 'transition') AS t, min(measured_at) AS first, max(measured_at) AS last FROM usage_history
            WHERE usage_scope_id = ? AND limit_id = ?`).get(scope, s) as { n: number; t: number; first: number; last: number };
          streams.push({ scope, stream: s, rows: r.n, transitions: r.t, first: r.first, last: r.last });
        }
      }
      // every UTC day of every stream, paged as the panel pages it
      let id = 0;
      for (const s of streams) {
        for (let from = Math.floor(s.first / DAY) * DAY; from <= s.last; from += DAY) {
          let cursor: { measuredAt: number; id: number } | null = null;
          for (let page = 0; ; page++) {
            const t = performance.now();
            const m = answerUsageHistory(db, { v: 1, type: 'usageHistory', id: ++id, scope: s.scope, stream: s.stream, from, to: from + DAY, cursor, limit: PAGE });
            const ms = performance.now() - t;
            pages.push(ms);
            if (page === 0) firstPages.push(ms);
            if (!m.next) break;
            cursor = m.next;
          }
        }
      }
      const plan = (sql: string, ...a: (number | string | null)[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a) as { detail: string }[]).map((r) => r.detail).join(' | ');
      const s0 = streams[0];
      if (s0) plans = { page: plan(USAGE_HISTORY_PAGE, s0.scope, s0.stream, 0, 1, null, null, null, PAGE), expired: plan(QUOTA_EXPIRED, s0.scope, s0.stream, 0), stream: plan(QUOTA_STREAM, s0.scope, '') };
      rows = Object.fromEntries(['sessions', 'events', 'usage', 'cost_estimates', 'context_snapshots', 'usage_snapshots', 'usage_history', 'usage_scopes']
        .map((t) => [t, count(`SELECT count(*) FROM ${t}`)]));
      rows.pricedEstimates = count('SELECT count(*) FROM cost_estimates WHERE price_revision_id IS NOT NULL');
      bytes = Object.fromEntries((db.prepare(`SELECT name, sum(pgsize) AS b FROM dbstat WHERE name IN ('usage_history', 'usage_history_minute', 'usage_history_stream',
        'usage_snapshots', 'usage_snapshots_limit', 'context_snapshots', 'usage', 'cost_estimates') OR name LIKE 'sqlite_autoindex_usage%' GROUP BY name ORDER BY name`)
        .all() as { name: string; b: number }[]).map((r) => [r.name, r.b]));
    } finally { db.close(); }
    appRetentionRan = serviceLog(l.dataDir).some((e) => e.event === 'retention_run');
    bytes.db = fileBytes(path.join(l.dataDir, 'xaibo.db'));
    bytes.wal = fileBytes(path.join(l.dataDir, 'xaibo.db-wal'));
  } finally { await close(l); }

  // retention on the imported store, app closed: quota only (session retention Never)
  const account = 'SELECT count(*) FROM usage_history h JOIN usage_scopes s ON s.id = h.usage_scope_id WHERE s.session_id IS NULL';
  const before = query<number>(l.dataDir, account);
  const store = await openStore({ file: path.join(l.dataDir, 'xaibo.db'), backupDir: path.join(l.dataDir, 'backups') });
  const writer = new Writer(store.db);
  setRetention(store.db, 'never');
  const tx: number[] = [];
  const transact = writer.transact.bind(writer);
  writer.transact = ((fn: Parameters<typeof transact>[0]) => { const t = performance.now(); try { return transact(fn); } finally { tx.push(performance.now() - t); } }) as typeof writer.transact;
  const last = Math.max(...streams.map((s) => s.last));
  const t = performance.now();
  const expiry = await runRetention(writer, store.db, { dataDir: l.dataDir, backupDir: path.join(l.dataDir, 'backups'), secret: Buffer.alloc(32, 1), now: last + 46 * DAY, active: () => false });
  const expiryMs = performance.now() - t;
  store.db.close();
  const left = query<number>(l.dataDir, account);
  rmSync(dataRoot, { recursive: true, force: true });

  const first = stats(firstPages), all = stats(pages);
  return {
    tier: 'TP', metric: 'quota-history', importMs, workload, appRetentionRan, streams, rows, bytes, plans,
    firstPageMs: first, allPagesMs: all, targetFirstPageP95Ms: FIRST_PAGE_TARGET_MS,
    expiry: { ...expiry, ms: Math.round(expiryMs), transactions: tx.length, longestTransactionMs: Math.round(Math.max(0, ...tx)), accountRowsBefore: before, accountRowsLeft: left },
    pass: !appRetentionRan && first.p95 <= FIRST_PAGE_TARGET_MS && streams.length === 2 && before > 0 && expiry.quota === before && left === 0 && streams.every((s) => s.rows >= summary.quota.days * 1440),
    env,
  };
}
