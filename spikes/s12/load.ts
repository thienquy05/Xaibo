// S12 live load + worker isolation (P0-S12-T4) and usage retention cost (P0-S12-T5), personal profile (owner decision
// 2026-11-10: 5 sessions ~20 events/s, bursts ~50/s; one ~3x probe 15 sessions ~60/s, bursts ~150/s). All profile
// values are estimates (~). Service side runs on the packaged Electron runtime with ELECTRON_RUN_AS_NODE=1 (NOT the
// GUI utilityProcess); the load generator is a separate system-Node process (`node spikes/s12/load.ts --gen ...`).
// Each run works on an APFS clone of the T2 corpus (copy-on-write; deleted after the run).
//   A: everything on the dispatch loop.  B: writer worker; backfill parse + reads on the dispatch loop.
//   C: dispatch loop + writer worker + bounded parser worker (backfill) + reads in a reader worker (off the loop).
// Live parse + publish is on the dispatch loop in every variant (append->watch->parse->publish, M2 hop).
// Modes: --all (T4 driver), --usage (T5 driver), --run (one run), --gen (generator, system Node).
// Writes .cache/spike-results/s12/load-<name>.json (raw) and spikes/s12/evidence/{load,usage}.json (reduced; no paths).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, watch, writeFileSync, writeSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { connect, Socket } from 'node:net';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { isMainThread, MessageChannel, parentPort, Worker, workerData, type MessagePort } from 'node:worker_threads';
import { envRecord, hr, mulberry32, summary } from '../shared/bench.ts';
import { openDb } from '../s1/db.ts';
import { frame, startReceiver } from '../s3/receiver.ts';
import { itemBytes, LIVE, liveSizes, SCALE, SEEDS, TextPool, TS_BASE } from './gen.ts';

const SEED_MIX = SEEDS.build + 3; // 12008: file/hook choice and live bodies
const SEED_BACKFILL = SEEDS.build + 4; // 12009: backfill file
const LIVE_SID = 1_000_000, BACK_SID = 2_000_000;
const KINDS = ['user', 'assistant', 'tool_use', 'tool_result'];
const MIB = 2 ** 20, DAY = 86_400_000;
const BACKFILL = { fileBytes: 32 * MIB, chunkBytes: 256 * 1024, everyMs: 100 }; // bounded: <= 256 KiB per 100 ms tick
const RECONCILE_MS = 5000; // T6 OQ-A10 result for the ~1k-file personal tree (sync scan)
const READ_EVERY_MS = 1000, DRAIN_TIMEOUT_MS = 30_000, SAMPLE_MS = 1000;
const T4 = { queueAgeP95Ms: 1000, drainMs: 5000 };

const REPO = join(import.meta.dirname, '..', '..', '..', '..'); // compiled to spikes/app/build/s12/ (unused by --gen)
const DATA = join(REPO, '.cache', 'spike-data', 's12', 'load');
const RAW = join(REPO, '.cache', 'spike-results', 's12');
const EV = join(REPO, 'spikes', 's12', 'evidence');
const CORPUS_DB = join(REPO, '.cache', 'spike-data', 's12', 'corpus.db');
const BACKFILL_FILE = join(DATA, 'backfill.jsonl');
const GEN = join(REPO, 'spikes', 's12', 'load.ts');

interface Row { sid: number; seq: number; ts: number; kind: string; body: string; tEnq: bigint }
interface Batch { rows: number; ms: number; bytes: number }
const since = (t: bigint) => Number(hr() - t) / 1e6;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const brief = (s: number[]) => { if (!s.length) return null; const x = summary(s); return { n: x.n, p50: r3(x.p50), p95: r3(x.p95), p99: r3(x.p99), max: r3(x.max) }; };
const one = (db: DatabaseSync, sql: string, ...a: (string | number)[]) => Object.values(db.prepare(sql).get(...a) ?? {})[0] as number;
const log = (m: string) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- T3-style reads (subset of queries.ts; one every READ_EVERY_MS, cycling) ----
const FTS = (order: string) => `SELECT f.rowid AS id, e.session_id, snippet(events_fts, 0, '[', ']', '…', 12) AS snip
  FROM events_fts f JOIN events e ON e.id = f.rowid WHERE events_fts MATCH ? ORDER BY ${order} LIMIT 20`;
const READS: [string, string, (string | number)[]][] = [
  ['list_unfiltered', 'SELECT id, agent, project_id, last_activity, bytes, items FROM sessions WHERE trashed_at IS NULL ORDER BY last_activity DESC, id DESC LIMIT 50', []],
  ['fts_common_recent', FTS('f.rowid DESC'), ['kape']],
  ['fts_cjk_bm25', FTS('rank'), ['"嘶泷"']],
  ['content_page1', 'SELECT id, source_seq, ts, kind, length(body) AS len, substr(body, 1, 65536) AS body FROM events WHERE session_id = ? AND source_seq > ? ORDER BY source_seq LIMIT 50', [1, 0]],
  ['quota_45d', `SELECT limit_id, as_of, used_percent, resets_at, kind FROM usage_snapshots WHERE usage_scope_id = 0 AND limit_id IN ('5h', '7d') AND as_of BETWEEN ? AND ? ORDER BY limit_id, as_of`, [TS_BASE, TS_BASE + 45 * DAY]],
  ['fts_common_bm25', FTS('rank'), ['kape']],
];

function readerCore(dbPath: string) {
  const db = openDb(dbPath, { readOnly: true });
  const st = READS.map(([n, sql, a]) => ({ n, s: db.prepare(sql), a }));
  const out: Record<string, number[]> = {};
  let i = 0;
  const iv = setInterval(() => { const q = st[i++ % st.length]; const t = hr(); q.s.all(...q.a); (out[q.n] ??= []).push(since(t)); }, READ_EVERY_MS);
  return { stop: () => { clearInterval(iv); db.close(); return out; } };
}

// ---- bounded backfill parser: <= chunkBytes per tick; each pass over the file is a new synthetic session ----
function parserCore(file: string, sink: (rows: Row[]) => void) {
  const fd = openSync(file, 'r');
  const size = fstatSync(fd).size, buf = Buffer.allocUnsafe(BACKFILL.chunkBytes), chunkMs: number[] = [];
  let off = 0, pass = 0, bytes = 0, rows = 0, carry = Buffer.alloc(0);
  const iv = setInterval(() => {
    const t = hr();
    if (off >= size) { off = 0; pass++; carry = Buffer.alloc(0); }
    const n = readSync(fd, buf, 0, buf.length, off);
    off += n; bytes += n;
    const data = Buffer.concat([carry, buf.subarray(0, n)]), out: Row[] = [];
    let s = 0, nl: number;
    while ((nl = data.indexOf(10, s)) !== -1) {
      const o = JSON.parse(data.toString('utf8', s, nl));
      out.push({ sid: BACK_SID + pass, seq: o.q, ts: o.t, kind: o.k, body: o.b, tEnq: 0n });
      s = nl + 1;
    }
    carry = Buffer.from(data.subarray(s));
    rows += out.length;
    if (out.length) sink(out);
    chunkMs.push(since(t));
  }, BACKFILL.everyMs);
  return { stop: () => { clearInterval(iv); closeSync(fd); return { bytes, rows, passes: pass + 1, chunkMs: brief(chunkMs) }; } };
}

// ---- single writer: live first, then backfill, within one batch bound (rows / ms / bytes) per transaction ----
function writerCore(dbPath: string, batch: Batch, report: (m: any) => void) {
  const db = openDb(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS monthly_usage_totals(month TEXT NOT NULL, agent TEXT NOT NULL, sessions INTEGER NOT NULL, items INTEGER NOT NULL,
      bytes INTEGER NOT NULL, PRIMARY KEY(month, agent));
    CREATE TABLE IF NOT EXISTS monthly_quota_peaks(month TEXT NOT NULL, usage_scope_id INTEGER NOT NULL, limit_id TEXT NOT NULL, peak REAL NOT NULL,
      resets INTEGER NOT NULL, PRIMARY KEY(month, usage_scope_id, limit_id));`);
  const insS = db.prepare('INSERT OR IGNORE INTO sessions(id, agent, project_id, started_at, last_activity, trashed_at, bytes, items) VALUES (?, ?, 0, ?, ?, NULL, 0, 0)');
  const insE = db.prepare('INSERT INTO events(session_id, source_seq, ts, kind, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, source_seq) DO NOTHING');
  const insF = db.prepare('INSERT INTO events_fts(rowid, body) SELECT id, body FROM events_fts_src WHERE id = ?');
  const sessions = new Set<number>();
  const ensure = (sid: number) => { if (!sessions.has(sid)) { sessions.add(sid); insS.run(sid, sid % 2 ? 'codex' : 'claude', Date.now(), Date.now()); } };
  const walSize = () => { try { return statSync(`${dbPath}-wal`).size; } catch { return 0; } };
  let live: Row[] = [], back: Row[] = [], liveBytes = 0, backlogMax = 0, expiring = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = (d: number) => { timer ??= setTimeout(flush, d); };
  const over = () => live.length >= batch.rows || liveBytes >= batch.bytes;
  function flush() {
    clearTimeout(timer); timer = undefined;
    if (!live.length && !back.length) return;
    const t = hr();
    let n = 0, nb = 0, bytes = 0, dup = 0;
    const put = (r: Row) => { ensure(r.sid); const res = insE.run(r.sid, r.seq, r.ts, r.kind, r.body); if (res.changes === 0) dup++; else insF.run(res.lastInsertRowid); bytes += r.body.length; };
    db.exec('BEGIN IMMEDIATE');
    while (n < live.length && n < batch.rows && (n === 0 || bytes < batch.bytes)) put(live[n++]);
    while (nb < back.length && n + nb < batch.rows && bytes < batch.bytes) put(back[nb++]);
    db.exec('COMMIT');
    const tc = hr();
    const done = live.splice(0, n);
    back.splice(0, nb);
    liveBytes = live.reduce((a, r) => a + r.body.length, 0);
    report({ t: 'commit', n, nb, dup, ms: since(t), tc, expiring, ages: done.map((r) => Number(tc - r.tEnq) / 1e6) });
    if (live.length || back.length) arm(over() ? 0 : batch.ms);
  }
  const ckpt = setInterval(() => report({ t: 'ckpt', wal: walSize(), ...(db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as object) }), SAMPLE_MS);

  // T5: one day's expiry — 1/45 of quota history, then the oldest day's sessions; settle + delete per batch transaction.
  async function expiry() {
    expiring = true;
    const t0 = hr(), wal0 = walSize(), batchMs: number[] = [];
    let walMax = wal0, quotaRows = 0, eventsDeleted = 0;
    const step = (fn: () => void) => { const t = hr(); db.exec('BEGIN IMMEDIATE'); fn(); db.exec('COMMIT'); batchMs.push(since(t)); walMax = Math.max(walMax, walSize()); };
    const yieldNow = () => new Promise((r) => setTimeout(r, 0));
    const cut = one(db, 'SELECT min(as_of) FROM usage_snapshots') + DAY;
    const pickQ = db.prepare('SELECT id FROM usage_snapshots WHERE usage_scope_id = ? AND limit_id = ? AND as_of < ? ORDER BY as_of LIMIT 1000');
    const settleQ = db.prepare(`INSERT INTO monthly_quota_peaks(month, usage_scope_id, limit_id, peak, resets)
      SELECT strftime('%Y-%m', as_of / 1000, 'unixepoch'), usage_scope_id, limit_id, max(used_percent), sum(kind = 'transition') FROM usage_snapshots
      WHERE id IN (SELECT value FROM json_each(?)) GROUP BY 1, 2, 3
      ON CONFLICT(month, usage_scope_id, limit_id) DO UPDATE SET peak = max(peak, excluded.peak), resets = resets + excluded.resets`);
    const delQ = db.prepare('DELETE FROM usage_snapshots WHERE id IN (SELECT value FROM json_each(?))');
    for (const s of db.prepare('SELECT DISTINCT usage_scope_id AS scope, limit_id AS lim FROM usage_snapshots').all() as { scope: number; lim: string }[]) {
      for (;;) {
        const ids = JSON.stringify((pickQ.all(s.scope, s.lim, cut) as { id: number }[]).map((x) => x.id));
        if (ids === '[]') break;
        step(() => { settleQ.run(ids); delQ.run(ids); });
        quotaRows += JSON.parse(ids).length;
        await yieldNow();
      }
    }
    const tQuota = since(t0);
    const sFirst = one(db, 'SELECT min(last_activity) FROM sessions WHERE id < ? AND id <> 1', LIVE_SID);
    const old = db.prepare('SELECT id, agent, last_activity AS la, items, bytes FROM sessions WHERE id < ? AND id <> 1 AND last_activity < ?').all(LIVE_SID, sFirst + DAY) as { id: number; agent: string; la: number; items: number; bytes: number }[];
    const pickE = db.prepare('SELECT id FROM events WHERE session_id = ? LIMIT 1000');
    const ftsDel = db.prepare(`INSERT INTO events_fts(events_fts, rowid, body) SELECT 'delete', id, body FROM events_fts_src WHERE id IN (SELECT value FROM json_each(?))`);
    const delE = db.prepare('DELETE FROM events WHERE id IN (SELECT value FROM json_each(?))');
    const settleS = db.prepare(`INSERT INTO monthly_usage_totals(month, agent, sessions, items, bytes) VALUES (strftime('%Y-%m', ? / 1000, 'unixepoch'), ?, 1, ?, ?)
      ON CONFLICT(month, agent) DO UPDATE SET sessions = sessions + 1, items = items + excluded.items, bytes = bytes + excluded.bytes`);
    const delS = ['DELETE FROM checkpoints WHERE session_id = ?', 'DELETE FROM context_snapshots WHERE session_id = ?', 'DELETE FROM sessions WHERE id = ?'].map((q) => db.prepare(q));
    for (const s of old) {
      for (;;) {
        const ids = JSON.stringify((pickE.all(s.id) as { id: number }[]).map((x) => x.id));
        if (ids === '[]') break;
        step(() => { ftsDel.run(ids); delE.run(ids); });
        eventsDeleted += JSON.parse(ids).length;
        await yieldNow();
      }
      step(() => { settleS.run(s.la, s.agent, s.items, s.bytes); for (const d of delS) d.run(s.id); });
    }
    const tDelete = since(t0);
    const freelistBefore = one(db, 'PRAGMA freelist_count'), vacMs: number[] = [];
    const tv = hr();
    for (let k = 0; k < 100_000 && one(db, 'PRAGMA freelist_count') > 0; k++) {
      const t = hr(); db.exec('PRAGMA incremental_vacuum(2000)'); vacMs.push(since(t)); walMax = Math.max(walMax, walSize());
      await yieldNow();
    }
    expiring = false;
    report({ t: 'expiry', totalMs: since(t0), quotaMs: tQuota, deleteMs: tDelete - tQuota, quotaRows, sessions: old.length, sessionBytes: old.reduce((a, s) => a + s.bytes, 0),
      eventsDeleted, batches: batchMs.length, batchMs: brief(batchMs), walStart: wal0, walMax, walEnd: walSize(),
      vacuum: { freelistPagesBefore: freelistBefore, ms: since(tv), chunks: vacMs.length, chunkMs: brief(vacMs), freelistPagesAfter: one(db, 'PRAGMA freelist_count') } });
  }

  db.exec('BEGIN');
  for (let k = 0; k < SCALE.sessions; k++) ensure(LIVE_SID + k);
  db.exec('COMMIT');
  report({ t: 'ready' });
  return {
    handle(m: any) {
      if (m.t === 'live') { live.push(m.row); liveBytes += m.row.body.length; if (over()) flush(); else arm(batch.ms); }
      else if (m.t === 'back') { back.push(...m.rows); backlogMax = Math.max(backlogMax, back.length); arm(batch.ms); }
      else if (m.t === 'expiry') void expiry();
      else if (m.t === 'stop') { while (live.length || back.length) flush(); clearInterval(ckpt); db.close(); report({ t: 'final', backlogMax }); }
    },
  };
}

// ---- worker entry ----
if (!isMainThread) {
  const d = workerData as { role: string; dbPath: string; batch: Batch; file: string; port: MessagePort };
  const port = parentPort!;
  if (d.role === 'writer') {
    const w = writerCore(d.dbPath, d.batch, (m) => port.postMessage(m));
    port.on('message', (m) => (m.t === 'port' ? (m.port as MessagePort).on('message', w.handle) : w.handle(m)));
  } else if (d.role === 'parser') {
    const p = parserCore(d.file, (rows) => d.port.postMessage({ t: 'back', rows }));
    port.on('message', () => port.postMessage(p.stop()));
  } else {
    const r = readerCore(d.dbPath);
    port.on('message', () => port.postMessage(r.stop()));
  }
}

const { values: v } = parseArgs({
  options: {
    gen: { type: 'boolean' }, run: { type: 'boolean' }, all: { type: 'boolean' }, usage: { type: 'boolean' }, reduce: { type: 'boolean' },
    dir: { type: 'string' }, profile: { type: 'string', default: 'personal' }, seconds: { type: 'string', default: '120' }, hook: { type: 'string', default: '0' },
    sock: { type: 'string' }, token: { type: 'string' }, arch: { type: 'string', default: 'C' }, mix: { type: 'string', default: 'file' },
    batch: { type: 'string', default: '500,100,4' }, 'expiry-at': { type: 'string' }, name: { type: 'string' }, runs: { type: 'string' },
  },
  args: isMainThread ? process.argv.slice(2) : [],
});

// ---- generator (system Node): the liveSizes schedule, each event to its session file or as one framed hook delivery ----
async function generator() {
  const P = v.profile === 'scale' ? SCALE : LIVE;
  const plan = liveSizes({ ...P, seconds: Number(v.seconds), seed: SEEDS.live });
  const fds = Array.from({ length: P.sessions }, (_, k) => openSync(join(v.dir!, `s${k}.jsonl`), 'a'));
  const pool = new TextPool(), r = mulberry32(SEED_MIX), hookFrac = Number(v.hook);
  // Hook transport: the S3 Unix socket when the service could bind it, else the same frames over an inherited pipe (fd 3).
  const token = !hookFrac ? '' : v.sock ? readFileSync(v.token!, 'utf8') : process.env.XAIBO_SPIKE_TOKEN!;
  const pipe = hookFrac && !v.sock ? new Socket({ fd: 3, readable: false, writable: true }) : undefined;
  const seqs = new Array<number>(P.sessions).fill(0), pending: Promise<void>[] = [];
  let file = 0, hook = 0, hookFail = 0, slip = 0, rss = 0;
  const send = (obj: object) => new Promise<void>((res) => {
    const c = connect(v.sock!);
    let acked = false;
    c.on('data', () => { acked = true; });
    c.on('error', () => {});
    c.on('close', () => { if (!acked) hookFail++; res(); });
    c.end(frame(obj));
  });
  const t0 = performance.now();
  for (let i = 0; i < plan.bytes.length; i++) {
    const wait = plan.atMs[i] - (performance.now() - t0);
    if (wait > 1) await sleep(wait); else slip = Math.max(slip, -wait);
    const s = plan.session[i];
    const rec = { i, s, q: ++seqs[s], k: KINDS[i % 4], b: pool.slice(r, Math.max(32, plan.bytes[i] - 100)), t: '' };
    const isHook = r() < hookFrac;
    rec.t = String(hr());
    if (isHook) { hook++; const d = { v: 1, token, delivery_id: `h${i}`, ...rec }; if (pipe) pipe.write(frame(d)); else pending.push(send(d)); }
    else { file++; writeSync(fds[s], JSON.stringify(rec) + '\n'); }
    if (i % 500 === 0) rss = Math.max(rss, process.memoryUsage().rss);
  }
  const tLast = String(hr());
  await Promise.all(pending);
  if (pipe) await new Promise<void>((res) => pipe.end(res));
  for (const fd of fds) closeSync(fd);
  process.stdout.write(JSON.stringify({ sent: plan.bytes.length, file, hook, hookFail, tLast, maxSlipMs: Math.round(slip), meanBytes: Math.round(summary(plan.bytes).mean), rssMiB: Math.round(rss / MIB), node: process.version }));
}

// ---- one run (packaged runtime) ----
async function service() {
  const arch = v.arch as 'A' | 'B' | 'C', name = v.name ?? `${arch}-${v.mix}`, seconds = Number(v.seconds);
  const P = v.profile === 'scale' ? SCALE : LIVE, hookFrac = v.mix === 'hook25' ? 0.25 : 0;
  const [rows, ms, mib] = v.batch!.split(',').map(Number);
  const batch: Batch = { rows, ms, bytes: mib * MIB };
  const runDir = join(DATA, 'run'), filesDir = join(runDir, 'files'), dbPath = join(runDir, 'db.sqlite');
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(filesDir, { recursive: true });
  execFileSync('/bin/cp', ['-c', CORPUS_DB, dbPath]); // APFS clonefile (libuv FICLONE_FORCE is ENOSYS here)
  const files = Array.from({ length: P.sessions }, (_, k) => join(filesDir, `s${k}.jsonl`));
  for (const f of files) writeFileSync(f, '');

  const appendPub: number[] = [], recvPub: number[] = [], sendPub: number[] = [], ages: number[] = [], agesExpiry: number[] = [], commitMs: number[] = [];
  const seen = new Set<number>(), ckpts: { log: number; checkpointed: number; busy: number }[] = [];
  let pubDup = 0, writerDup = 0, committedLive = 0, committedBack = 0, lastCommit = 0n, walMax = 0, rssMax = 0, fdMax = 0;
  let ready = false, final: any, expiryOut: any, expiryLoop: any;
  const onWriter = (m: any) => {
    if (m.t === 'commit') {
      committedLive += m.n; committedBack += m.nb; writerDup += m.dup; commitMs.push(m.ms);
      for (const a of m.ages) ages.push(a);
      if (m.expiring) for (const a of m.ages) agesExpiry.push(a);
      if (m.n) lastCommit = m.tc;
    } else if (m.t === 'ckpt') { ckpts.push(m); walMax = Math.max(walMax, m.wal); }
    else if (m.t === 'ready') ready = true;
    else if (m.t === 'expiry') { expiryOut = m; hExp?.disable(); expiryLoop = hExp && { p99: r3(hExp.percentile(99) / 1e6), max: r3(hExp.max / 1e6) }; }
    else if (m.t === 'final') final = m;
  };
  const until = async (ok: () => boolean, timeoutMs: number) => { const t = Date.now(); while (!ok() && Date.now() - t < timeoutMs) await sleep(10); return ok(); };

  const load0 = loadavg();
  const h = monitorEventLoopDelay({ resolution: 1 });
  let hExp: ReturnType<typeof monitorEventLoopDelay> | undefined;
  let writerW: Worker | undefined;
  let toWriter: (m: any) => void;
  if (arch === 'A') { const w = writerCore(dbPath, batch, onWriter); toWriter = w.handle; }
  else { const w = new Worker(import.meta.filename, { workerData: { role: 'writer', dbPath, batch } }); w.on('message', onWriter); writerW = w; toWriter = (m) => w.postMessage(m); }
  await until(() => ready, 30_000);
  const usageBefore = v['expiry-at'] ? usageSizes(dbPath) : undefined;

  let parserStop: () => Promise<any>, readerStop: () => Promise<any>;
  if (arch === 'C') {
    const ch = new MessageChannel();
    writerW!.postMessage({ t: 'port', port: ch.port1 }, [ch.port1]);
    const pw = new Worker(import.meta.filename, { workerData: { role: 'parser', file: BACKFILL_FILE, port: ch.port2 }, transferList: [ch.port2] });
    const rw = new Worker(import.meta.filename, { workerData: { role: 'reader', dbPath } });
    const ask = (w: Worker) => () => new Promise<any>((res) => { w.once('message', (m) => { res(m); void w.terminate(); }); w.postMessage('stop'); });
    parserStop = ask(pw); readerStop = ask(rw);
  } else {
    const p = parserCore(BACKFILL_FILE, (rows) => toWriter({ t: 'back', rows }));
    const rd = readerCore(dbPath);
    parserStop = async () => p.stop(); readerStop = async () => rd.stop();
  }

  // Dispatch loop: publish (MessagePort to a stand-in renderer) before persistence, then enqueue for the writer.
  const { port1: pub, port2: sink } = new MessageChannel();
  sink.on('message', () => {});
  const publish = (o: any): bigint | undefined => {
    if (seen.has(o.i)) { pubDup++; return; }
    seen.add(o.i);
    pub.postMessage({ i: o.i, s: o.s, q: o.q, k: o.k, b: o.b });
    const tPub = hr();
    toWriter({ t: 'live', row: { sid: LIVE_SID + o.s, seq: o.q, ts: Date.now(), kind: o.k, body: o.b, tEnq: tPub } satisfies Row });
    return tPub;
  };
  const fdsR = files.map((f) => openSync(f, 'r')), offs = files.map(() => 0), carry = files.map(() => Buffer.alloc(0));
  const drain = (k: number) => {
    const size = fstatSync(fdsR[k]).size;
    if (size <= offs[k]) return;
    const buf = Buffer.allocUnsafe(size - offs[k]);
    readSync(fdsR[k], buf, 0, buf.length, offs[k]);
    offs[k] = size;
    const data = carry[k].length ? Buffer.concat([carry[k], buf]) : buf;
    let s = 0, nl: number;
    while ((nl = data.indexOf(10, s)) !== -1) {
      const o = JSON.parse(data.toString('utf8', s, nl));
      const tp = publish(o);
      if (tp) appendPub.push(Number(tp - BigInt(o.t)) / 1e6);
      s = nl + 1;
    }
    carry[k] = Buffer.from(data.subarray(s));
  };
  const watchers = files.map((f, k) => watch(f, () => drain(k))); // T6 strategy (b): per-active-file kqueue watch
  const reconcile = setInterval(() => files.forEach((_, k) => drain(k)), RECONCILE_MS);
  const onHook = (d: any, tRecv: bigint) => { const tp = publish(d); if (tp) { recvPub.push(Number(tp - tRecv) / 1e6); sendPub.push(Number(tp - BigInt(String(d.t))) / 1e6); } };
  let rcv: Awaited<ReturnType<typeof startReceiver>> | undefined, transport = hookFrac ? 'socket' : 'none';
  try { if (hookFrac) rcv = await startReceiver({ dataDir: join(runDir, 'hook'), ackPoint: 'volatile', publish: (st) => onHook(st.d, st.t_recv) }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e; transport = 'pipe'; } // sandbox: bind() on a Unix socket is EPERM
  // Pipe fallback: same 4-byte big-endian framing, version + token check (timing-safe), JSON parse, publish on the dispatch loop.
  const token = Buffer.from(randomBytes(32).toString('hex'));
  let pipeBuf: Buffer = Buffer.alloc(0), pipeRejected = 0;
  const onPipe = (chunk: Buffer) => {
    pipeBuf = pipeBuf.length ? Buffer.concat([pipeBuf, chunk]) : chunk;
    while (pipeBuf.length >= 4 && pipeBuf.length >= 4 + pipeBuf.readUInt32BE(0)) {
      const n = pipeBuf.readUInt32BE(0), tRecv = hr();
      const d = JSON.parse(pipeBuf.toString('utf8', 4, 4 + n));
      pipeBuf = pipeBuf.subarray(4 + n);
      const t = Buffer.from(String(d.token ?? ''));
      if (d.v !== 1 || t.length !== token.length || !timingSafeEqual(t, token)) { pipeRejected++; continue; }
      delete d.token;
      onHook(d, tRecv);
    }
  };
  const sampler = setInterval(() => { rssMax = Math.max(rssMax, process.memoryUsage().rss); fdMax = Math.max(fdMax, readdirSync('/dev/fd').length); }, SAMPLE_MS);

  h.enable();
  if (v['expiry-at']) setTimeout(() => { hExp = monitorEventLoopDelay({ resolution: 1 }); hExp.enable(); toWriter({ t: 'expiry' }); }, Number(v['expiry-at']) * 1000);
  log(`${name}: arch ${arch} mix ${v.mix} (hook transport ${transport}) profile ${v.profile} ${seconds}s batch ${v.batch}`);
  const gen = spawn('node', [GEN, '--gen', '--dir', filesDir, '--profile', v.profile!, '--seconds', String(seconds), '--hook', String(hookFrac),
    ...(rcv ? ['--sock', rcv.socketPath, '--token', join(runDir, 'hook', 'run', 'token')] : [])],
  { stdio: ['ignore', 'pipe', 'inherit', 'pipe'], env: { ...process.env, XAIBO_SPIKE_TOKEN: token.toString() } });
  let genText = '';
  gen.stdout!.on('data', (b) => { genText += b; });
  (gen.stdio[3] as NodeJS.ReadableStream).on('data', onPipe);
  const genCode = await new Promise<number | null>((res) => gen.on('exit', res));
  if (genCode !== 0) throw new Error(`generator exit ${genCode}`);
  const g = JSON.parse(genText);
  const drained = await until(() => committedLive >= g.sent - g.hookFail, DRAIN_TIMEOUT_MS);
  const drainMs = drained ? Number(lastCommit - BigInt(g.tLast)) / 1e6 : null;
  if (v['expiry-at']) await until(() => expiryOut !== undefined, 120_000);
  h.disable();
  clearInterval(reconcile); clearInterval(sampler);
  for (const w of watchers) w.close();
  const parser = await parserStop(), reads = await readerStop();
  toWriter({ t: 'stop' });
  await until(() => final !== undefined, 60_000);
  await writerW?.terminate();
  await rcv?.close();
  for (const fd of fdsR) closeSync(fd);

  const ro = openDb(dbPath, { readOnly: true });
  const liveRows = one(ro, 'SELECT count(*) FROM events WHERE session_id BETWEEN ? AND ?', LIVE_SID, LIVE_SID + 999);
  const distinct = one(ro, 'SELECT count(*) FROM (SELECT DISTINCT session_id, source_seq FROM events WHERE session_id BETWEEN ? AND ?)', LIVE_SID, LIVE_SID + 999);
  ro.close();
  const usageAfter = v['expiry-at'] ? usageSizes(dbPath) : undefined;
  const lost = g.sent - liveRows, duplicated = pubDup + writerDup + (liveRows - distinct);
  const qa = brief(ages);
  const out = {
    tag: 'spike, not gate evidence', name, arch, mix: v.mix, profile: v.profile, declared: P, seconds, batch: { rows, ms, mib },
    gen: g, events: { sent: g.sent, file: g.file, hook: g.hook, hookFail: g.hookFail, hookTransport: transport, pipeRejected, published: seen.size, persistedLive: liveRows },
    loopDelayMs: { p50: r3(h.percentile(50) / 1e6), p99: r3(h.percentile(99) / 1e6), max: r3(h.max / 1e6) },
    appendToPublishMs: brief(appendPub), receiveToPublishMs: brief(recvPub), sendToPublishMs: brief(sendPub),
    queueAgeMs: qa, queueAgeP95Ms: qa?.p95 ?? null, drainMs: drainMs === null ? null : r3(drainMs), lost, duplicated,
    pass: qa !== null && qa.p95 <= T4.queueAgeP95Ms && drainMs !== null && drainMs <= T4.drainMs && lost === 0 && duplicated === 0,
    commits: { n: commitMs.length, ms: brief(commitMs) }, backfill: { ...parser, rowsCommitted: committedBack, writerBacklogMaxRows: final?.backlogMax },
    reads: Object.fromEntries(Object.entries(reads as Record<string, number[]>).map(([k, s]) => [k, brief(s)])),
    wal: { maxBytes: walMax, checkpoints: ckpts.length, maxLogFrames: Math.max(0, ...ckpts.map((c) => c.log)), maxUncheckpointedFrames: Math.max(0, ...ckpts.map((c) => c.log - c.checkpointed)), busy: ckpts.filter((c) => c.busy).length },
    rssMaxMiB: Math.round(rssMax / MIB), fdMax, dbBytesAfter: statSync(dbPath).size, hostLoadAvg1m: { start: r3(load0[0]), end: r3(loadavg()[0]) },
    ...(v['expiry-at'] ? { expiry: { atS: Number(v['expiry-at']), ...expiryOut, loopDelayDuringMs: expiryLoop, queueAgeDuringMs: brief(agesExpiry) }, usageBefore, usageAfter } : {}),
  };
  mkdirSync(RAW, { recursive: true });
  writeFileSync(join(RAW, `load-${name}.json`), JSON.stringify(out, null, 1) + '\n');
  rmSync(runDir, { recursive: true, force: true });
  log(`${name}: loop p99/max ${out.loopDelayMs.p99}/${out.loopDelayMs.max} ms, append->pub p95 ${out.appendToPublishMs?.p95}, recv->pub p95 ${out.receiveToPublishMs?.p95 ?? '-'}, queue age p95 ${out.queueAgeP95Ms}, drain ${out.drainMs}, lost ${lost}, dup ${duplicated}, pass ${out.pass}`);
}

// T5 sizes: rows per stream and table/index bytes (DBSTAT) for the usage-side tables.
function usageSizes(dbPath: string) {
  const db = openDb(dbPath, { readOnly: true });
  const names = ['usage_snapshots', 'usage_scope_limit_asof', 'context_snapshots', 'context_session_generation', 'price_provenance',
    'monthly_usage_totals', 'sqlite_autoindex_monthly_usage_totals_1', 'monthly_quota_peaks', 'sqlite_autoindex_monthly_quota_peaks_1'];
  const bytes = Object.fromEntries(names.map((n) => [n, one(db, 'SELECT coalesce(sum(pgsize), 0) FROM dbstat WHERE name = ? AND aggregate = TRUE', n)]));
  const streams = db.prepare(`SELECT usage_scope_id AS scope, limit_id AS lim, count(*) AS rows, sum(kind = 'transition') AS transitions FROM usage_snapshots GROUP BY 1, 2`).all();
  const rows = Object.fromEntries(['context_snapshots', 'price_provenance', 'monthly_usage_totals', 'monthly_quota_peaks'].map((t) => [t, one(db, `SELECT count(*) FROM ${t}`)]));
  db.close();
  return { streams, rows, bytes };
}

// ---- drivers (packaged runtime): each run is its own process ----
function makeBackfill() {
  if (existsSync(BACKFILL_FILE)) return;
  mkdirSync(DATA, { recursive: true });
  const pool = new TextPool(), r = mulberry32(SEED_BACKFILL), tmp = `${BACKFILL_FILE}.tmp`, fd = openSync(tmp, 'w');
  for (let n = 0, q = 1; n < BACKFILL.fileBytes; q++) {
    const line = JSON.stringify({ q, t: TS_BASE + q * 1000, k: KINDS[q % 4], b: pool.slice(r, itemBytes(r)) }) + '\n';
    writeSync(fd, line); n += Buffer.byteLength(line);
  }
  closeSync(fd);
  renameSync(tmp, BACKFILL_FILE);
}
const only = v.runs ? new Set(v.runs.split(',')) : undefined;
function runOne(name: string, args: string[]): any {
  if (!v.reduce && (!only || only.has(name))) {
    const res = spawnSync(process.execPath, [import.meta.filename, '--run', '--name', name, ...args], { stdio: 'inherit', env: process.env });
    if (res.status !== 0) log(`${name}: exit ${res.status}`);
  }
  const f = join(RAW, `load-${name}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}
const reduceRun = (r: any) => r && ({
  name: r.name, arch: r.arch, mix: r.mix, profile: r.profile, seconds: r.seconds, batch: r.batch, events: r.events, loopDelayMs: r.loopDelayMs,
  appendToPublishMs: r.appendToPublishMs, receiveToPublishMs: r.receiveToPublishMs, sendToPublishMs: r.sendToPublishMs, queueAgeMs: r.queueAgeMs,
  queueAgeP95Ms: r.queueAgeP95Ms, drainMs: r.drainMs, lost: r.lost, duplicated: r.duplicated, pass: r.pass, commits: r.commits, backfill: r.backfill,
  reads: r.reads, wal: r.wal, rssMaxMiB: r.rssMaxMiB, genRssMiB: r.gen.rssMiB, fdMax: r.fdMax, genMaxSlipMs: r.gen.maxSlipMs, dbBytesAfter: r.dbBytesAfter, hostLoadAvg1m: r.hostLoadAvg1m ?? null,
});
const meta = () => ({
  tag: 'spike, not gate evidence', profile: { name: 'personal (owner decision 2026-11-10; overrides plan scale)', live: LIVE, scaleProbe: SCALE, estimate: '~' },
  runtime: 'packaged Electron runtime with ELECTRON_RUN_AS_NODE=1 (not the GUI utilityProcess); generator on system Node', env: envRecord(),
  seeds: { ...SEEDS, mix: SEED_MIX, backfill: SEED_BACKFILL }, corpusDbBytes: statSync(CORPUS_DB).size,
  method: { db: 'APFS clone of the T2 corpus per run', watcher: 'per-active-file fs.watch + reconcile every 5 s', hook: 'S3 receiver (private Unix socket, framed, volatile ack, one connection per delivery); when bind() is EPERM (command sandbox) the same frames + token check over an inherited pipe; see runs[].events.hookTransport', loopDelay: 'monitorEventLoopDelay resolution 1 ms',
    publish: 'MessagePort post before persistence', backfill: BACKFILL, readsEveryMs: READ_EVERY_MS, reads: READS.map((x) => x[0]), checkpointProbe: 'PRAGMA wal_checkpoint(PASSIVE) every 1 s in the writer (autocheckpoint left on)', thresholds: T4 },
});

if (isMainThread && v.gen) await generator();
else if (isMainThread && v.run) { makeBackfill(); await service(); process.exit(0); } // exit: open MessagePorts keep the loop alive
else if (isMainThread && v.all) {
  makeBackfill();
  const base: any[] = [];
  for (const arch of ['A', 'B', 'C']) for (const mix of ['file', 'hook25']) base.push(runOne(`${arch}-${mix}`, ['--arch', arch, '--mix', mix, '--seconds', '120']));
  const ok = (a: string) => base.filter((r) => r?.arch === a).length === 2 && base.filter((r) => r?.arch === a).every((r) => r.pass);
  const passing = ['A', 'B', 'C'].filter(ok);
  const smallest = passing[0] ?? null;
  const loopOf = (a: string) => Math.max(...base.filter((r) => r?.arch === a).map((r) => r.loopDelayMs.p99));
  const best = passing.length ? passing.reduce((x, y) => (loopOf(y) < loopOf(x) ? y : x)) : 'C';
  const sweep = ['100,50,1', '500,100,4', '500,100,16'].map((b) => runOne(`sweep-${best}-${b.replaceAll(',', '-')}`, ['--arch', best, '--mix', 'hook25', '--seconds', '60', '--batch', b]));
  const scaleArchs = [...new Set([smallest ?? 'C', 'C'])];
  const scale = scaleArchs.map((a) => runOne(`scale-${a}`, ['--arch', a, '--mix', 'hook25', '--profile', 'scale', '--seconds', '120']));
  const cmp = (s: any) => {
    const p = base.find((r) => r?.arch === s.arch && r.mix === 'hook25');
    const m: [string, number, number][] = [['loopDelayP99Ms', p.loopDelayMs.p99, s.loopDelayMs.p99], ['loopDelayMaxMs', p.loopDelayMs.max, s.loopDelayMs.max],
      ['appendToPublishP95Ms', p.appendToPublishMs.p95, s.appendToPublishMs.p95], ['receiveToPublishP95Ms', p.receiveToPublishMs.p95, s.receiveToPublishMs.p95],
      ['queueAgeP95Ms', p.queueAgeP95Ms, s.queueAgeP95Ms], ['drainMs', p.drainMs, s.drainMs], ['commitP95Ms', p.commits.ms.p95, s.commits.ms.p95],
      ['walMaxBytes', p.wal.maxBytes, s.wal.maxBytes], ['rssMaxMiB', p.rssMaxMiB, s.rssMaxMiB], ['fdMax', p.fdMax, s.fdMax]];
    return { arch: s.arch, vsRun: p.name, metrics: m.map(([k, a, b]) => ({ metric: k, personal: a, scale: b, ratio: a ? r3(b / a) : null })).sort((x, y) => (y.ratio ?? 0) - (x.ratio ?? 0)), pass: s.pass };
  };
  const out = { ...meta(), task: 'P0-S12-T4', runs: [...base, ...sweep].filter(Boolean).map(reduceRun), smallestPassingVariant: smallest, bestVariantByLoopP99: best,
    scaleProbe: { runs: scale.filter(Boolean).map(reduceRun), vsPersonal: scale.filter(Boolean).map(cmp) } };
  writeFileSync(join(EV, 'load.json'), JSON.stringify(out, null, 1) + '\n');
  log(`load.json written: smallest passing ${smallest}, best ${best}`);
} else if (isMainThread && v.usage) {
  makeBackfill();
  const r = runOne('usage-C', ['--arch', 'C', '--mix', 'hook25', '--seconds', '60', '--expiry-at', '15']);
  if (!r) process.exit(1);
  const b = r.usageBefore, perStream = (b.bytes.usage_snapshots + b.bytes.usage_scope_limit_asof) / b.streams.length;
  const out = { ...meta(), task: 'P0-S12-T5', sizes: b, sizesAfterExpiry: r.usageAfter,
    perStream: { rows: b.streams[0].rows, tableAndIndexBytes: Math.round(perStream), bytesPerRow: r3(perStream / b.streams[0].rows),
      scaling: 'linear in streams x minutes (one row per minute sample + transitions, same index); N streams ~= N x tableAndIndexBytes' },
    expiry: r.expiry, concurrentLoad: reduceRun(r) };
  writeFileSync(join(EV, 'usage.json'), JSON.stringify(out, null, 1) + '\n');
  log(`usage.json written: expiry ${r.expiry?.totalMs} ms`);
}
