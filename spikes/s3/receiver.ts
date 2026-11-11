// S3 receiver (P0-S3-T3): private Unix socket, 4-byte big-endian length framing, token + version validation,
// publish before persistence, ack after publish ('volatile') or after a small SQLite commit ('commit'),
// spool replay deduplicated by delivery_id. Pure Node; hosted by the packaged service in mode s3.
import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const MAX_FRAME = 1024 * 1024;
const READ_DEADLINE_MS = 1_000;
const ACK_SAMPLES = 10_000;

export type Delivery = Record<string, unknown> & { delivery_id: string; t_entry?: string; t_send?: string };
export interface Stamped { d: Delivery; t_recv: bigint; t_publish: bigint; replay: boolean }
export interface ReceiverOpts {
  dataDir: string;
  ackPoint: 'volatile' | 'commit';
  noAck?: boolean;                       // bench mode: accept but never ack
  publish?: (s: Stamped) => void;        // to the renderer; called before persistence
}

export function frame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

export async function startReceiver(o: ReceiverOpts) {
  const run = path.join(o.dataDir, 'run');
  mkdirSync(run, { recursive: true, mode: 0o700 });
  chmodSync(run, 0o700);
  const tokenFile = path.join(run, 'token');
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const token = Buffer.from(readFileSync(tokenFile, 'utf8'));
  const db = new DatabaseSync(path.join(o.dataDir, 's3.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; CREATE TABLE IF NOT EXISTS deliveries(delivery_id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  const insert = db.prepare('INSERT OR IGNORE INTO deliveries(delivery_id, body) VALUES (?, ?)');
  const known = new Set<string>((db.prepare('SELECT delivery_id FROM deliveries').all() as { delivery_id: string }[]).map((r) => r.delivery_id));
  const stats = { delivered: 0, replayed: 0, duplicates: 0, rejected: {} as Record<string, number>, ackUs: [] as number[] };
  const reject = (why: string, c?: Socket) => { stats.rejected[why] = (stats.rejected[why] ?? 0) + 1; c?.destroy(); };

  const accept = (d: Delivery, t_recv: bigint, replay: boolean) => {
    if (known.has(d.delivery_id)) { stats.duplicates++; return; }
    known.add(d.delivery_id);
    o.publish?.({ d, t_recv, t_publish: process.hrtime.bigint(), replay });
    if (o.ackPoint === 'commit' || replay) { db.exec('BEGIN IMMEDIATE'); insert.run(d.delivery_id, JSON.stringify(d)); db.exec('COMMIT'); }
    if (replay) stats.replayed++; else stats.delivered++;
  };

  // Replay the spool before serving; a file is removed only after all its lines were handled.
  const spool = path.join(o.dataDir, 'spool');
  if (existsSync(spool)) {
    for (const f of readdirSync(spool).filter((n) => n.endsWith('.jsonl'))) {
      for (const line of readFileSync(path.join(spool, f), 'utf8').split('\n').filter(Boolean)) {
        try { const d = JSON.parse(line) as Delivery; if (typeof d.delivery_id === 'string') accept(d, process.hrtime.bigint(), true); } catch { reject('spool-bad-line'); }
      }
      unlinkSync(path.join(spool, f));
    }
  }
  // The forwarders' spool byte counter only ever grows; after a replay it is reset to what is actually left, or the
  // 50 MB cap would refuse new spooling after enough cumulative outages.
  const left = existsSync(spool) ? readdirSync(spool).filter((n) => n.endsWith('.jsonl')).reduce((a, n) => a + statSync(path.join(spool, n)).size, 0) : 0;
  try { mkdirSync(path.join(o.dataDir, 'run'), { recursive: true, mode: 0o700 }); writeFileSync(path.join(o.dataDir, 'run', 'spool-bytes'), String(left), { mode: 0o600 }); } catch { /* counter best effort */ }

  const onConn = (c: Socket) => {
    let buf = Buffer.alloc(0);
    let need = -1; // -1 header pending, >=0 body length, -2 done
    const timer = setTimeout(() => reject('deadline', c), READ_DEADLINE_MS);
    c.on('error', () => {});
    c.on('close', () => clearTimeout(timer));
    c.on('end', () => { if (need !== -2) reject(buf.length ? 'truncated' : 'empty', c); });
    c.on('data', (chunk: Buffer) => {
      if (need === -2) return;
      buf = Buffer.concat([buf, chunk]);
      if (need === -1 && buf.length >= 4) {
        need = buf.readUInt32BE(0);
        if (need > MAX_FRAME) { need = -2; return reject('too-large', c); }
      }
      if (need < 0 || buf.length < 4 + need) return;
      const t_recv = process.hrtime.bigint();
      const body = buf.subarray(4, 4 + need);
      need = -2;
      clearTimeout(timer);
      let d: Delivery;
      try { d = JSON.parse(body.toString('utf8')) as Delivery; } catch { return reject('bad-json', c); }
      if (d?.v !== 1) return reject('bad-version', c);
      const t = Buffer.from(String(d.token ?? ''));
      if (t.length !== token.length || !timingSafeEqual(t, token)) return reject('bad-token', c);
      if (typeof d.delivery_id !== 'string') return reject('bad-json', c);
      delete d.token;
      accept(d, t_recv, false);
      if (o.noAck) return;
      c.end(Buffer.from([1]));
      if (stats.ackUs.length < ACK_SAMPLES) stats.ackUs.push(Number(process.hrtime.bigint() - t_recv) / 1e3); // ack-point latency
    });
  };

  const socketPath = path.join(run, 'xaibo.sock');
  if (existsSync(socketPath)) rmSync(socketPath); // stale socket from a previous run
  const server: Server = createServer(onConn);
  const old = process.umask(0o077);
  try { await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(socketPath, res); }); } finally { process.umask(old); }
  if ((statSync(socketPath).mode & 0o077) !== 0) throw new Error('socket not private');

  return {
    socketPath, stats,
    persisted: () => (db.prepare('SELECT count(*) AS n FROM deliveries').get() as { n: number }).n,
    close: () => new Promise<void>((res) => server.close(() => { db.close(); res(); })),
  };
}
