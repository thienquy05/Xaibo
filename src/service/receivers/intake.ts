// Hook intake (P3-T04; EC-09, EC-44, EC-52; OQ-A1, D-18, PRD §5.5). Order per delivery: dedup by delivery_id, publish
// as pending durability, commit in its own immediate transaction ahead of queued backfill, publish as durable, then
// ack. Hook events are stored generically (events source 'hook', kind 'hook', the whole envelope raw, nothing indexed);
// one is attached to a session only when its profile_key names a profile of the same agent and it carries a session id,
// otherwise only the delivery row records it as unattributed. Hook paths are stored as given, never dereferenced.
// While the store is full, deliveries are rejected 'disk-full' (the forwarder spools, or fails silently) and remembered
// as an exact hook-only gap, one per delivery_id, written once a commit succeeds again and dropped when that delivery is
// later accepted (a retry or the spool replay; G3b-2).
import type { DatabaseSync } from 'node:sqlite';
import { errorCode } from '../../shared/crash.ts';
import type { Envelope } from '../../shared/hook-protocol.ts';
import type { Logger } from '../../shared/log.ts';
import { isStatusline, lastSnapshots, statuslineRecord } from '../adapters/claude/statusline.ts';
import { claudeReadings, statuslineContext, statuslineCost } from '../usage/snapshots.ts';
import { isDiskFull, type Batch, type Writer } from '../store/writer.ts';
import { openRegistry } from './registrations.ts';
import { createReportIntake } from './report.ts';
import { SocketError, startSocketServer, type IntakeResult, type SocketOptions, type SocketServer } from './socket.ts';
import { replaySpool, type ReplayResult } from './spool-replay.ts';

export interface IntakeOptions {
  db: DatabaseSync;
  writer: Writer;
  now?: () => number;
  /** Live projection (P3-T08): durable false before the commit, true after it. */
  publish?: (e: Envelope, durable: boolean) => void;
}
export interface Intake {
  deliver(e: Envelope): Promise<IntakeResult>;
  /** Writes the disk-full gaps held in memory; called once the store accepts writes again. */
  recovered(): void;
}

const MAX_GAP_KEYS = 1000;
const OVERFLOW_KEY = '\0';
interface Gap { agent: string | null; session: string | null; from: number; to: number; count: number; first: string }

export function createIntake(o: IntakeOptions): Intake {
  const now = o.now ?? Date.now;
  // A report registration's profile belongs to that registration's token, never to the install token (P3-T13b2 review).
  const profile = o.db.prepare("SELECT 1 FROM profiles WHERE id = ? AND agent = ? AND origin <> 'registration'");
  const stored = o.db.prepare('SELECT 1 FROM hook_delivery WHERE delivery_id = ?');
  const putGap = o.db.prepare(`INSERT INTO hook_gaps (reason, agent, native_session_id, from_ts, to_ts, count, locator, recorded_at)
    VALUES ('disk-full', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (locator) DO NOTHING`);
  const dropGap = o.db.prepare('DELETE FROM hook_gaps WHERE locator = ?');
  // ponytail: held in memory until a commit succeeds; a restart while the disk is still full loses them. Bounded: past
  // the key cap every further delivery joins one gap without agent or session, counted per attempt and never reconciled.
  const gaps = new Map<string, Gap>(); // by delivery_id
  const snapshots = lastSnapshots();
  const note = (e: Envelope) => {
    if (gaps.has(e.delivery_id)) return; // a retried rejection is still one missing delivery
    if (gaps.size < MAX_GAP_KEYS) {
      gaps.set(e.delivery_id, { agent: e.agent, session: e.session_id, from: e.received_ts, to: e.received_ts, count: 1, first: e.delivery_id });
      return;
    }
    const g = gaps.get(OVERFLOW_KEY);
    // its locator never names a delivery, so accepting that delivery later does not drop the whole bucket
    if (!g) gaps.set(OVERFLOW_KEY, { agent: null, session: null, from: e.received_ts, to: e.received_ts, count: 1, first: `overflow:${e.delivery_id}` });
    else { g.from = Math.min(g.from, e.received_ts); g.to = Math.max(g.to, e.received_ts); g.count++; }
  };

  const recovered = () => {
    if (!gaps.size) return;
    const at = now();
    try {
      o.db.exec('BEGIN IMMEDIATE');
      for (const g of gaps.values()) putGap.run(g.agent, g.session, g.from, g.to, g.count, `disk-full:${g.first}`, at);
      o.db.exec('COMMIT');
      gaps.clear();
    } catch {
      if (o.db.isTransaction) o.db.exec('ROLLBACK'); // still full: kept for the next successful commit
    }
  };

  /** P3-T15: quota readings, the context observation and the reported session cost of a re-validated tee record. */
  const usageOf = (record: Record<string, unknown>, locator: string) => {
    const quota = claudeReadings(record);
    const context = statuslineContext(record, locator);
    const cost = statuslineCost(record);
    return { ...(quota.length ? { quota } : {}), ...(context ? { context } : {}), ...(cost !== null ? { reportedCost: cost } : {}) };
  };

  /** P3-T14: a tee snapshot (never spooled, so no delivery row and no dedup; never status evidence). */
  const statusline = (e: Envelope): IntakeResult => {
    const s = statuslineRecord(e);
    if (!s || !profile.get(e.profile_key, e.agent)) return { status: 'accepted', code: 'ignored' };
    const raw = JSON.stringify(s.record);
    if (!snapshots.differs(e.profile_key, s.session, raw)) return { status: 'accepted', code: 'unchanged' };
    const at = now(); // the service clock, never the sender's (review L7); no source time: statusLine stdin has none (S13)
    try {
      o.writer.commitLive({ profileId: e.profile_key, agent: e.agent, sessions: [{ nativeSessionId: s.session }],
        events: [{ nativeSessionId: s.session, source: 'statusline', confidence: 'confirmed', nativeId: e.delivery_id, kind: 'statusline',
          sourceSeq: at, receivedTs: at, raw, ...usageOf(s.record, e.delivery_id) }] });
    } catch (err) {
      return { status: 'rejected', code: isDiskFull(err) ? 'disk-full' : 'store' };
    }
    snapshots.kept(e.profile_key, s.session, raw);
    return { status: 'accepted', code: 'ok' };
  };

  const deliver = async (e: Envelope): Promise<IntakeResult> => {
    if (isStatusline(e)) return statusline(e);
    if (stored.get(e.delivery_id)) { // stored, so never missing: a commit that landed but reported disk full (G3b-2)
      if (!gaps.delete(e.delivery_id)) try { dropGap.run(`disk-full:${e.delivery_id}`); } catch { /* the gap row stays */ }
      return { status: 'accepted', code: 'duplicate' };
    }
    o.publish?.(e, false);
    const unattributed = !profile.get(e.profile_key, e.agent) ? 'unknown-profile' : e.session_id === null ? 'no-session' : null;
    const batch: Batch = {
      profileId: e.profile_key, agent: e.agent, sessions: [], events: [],
      delivery: { deliveryId: e.delivery_id, agent: e.agent, profileKey: e.profile_key, nativeSessionId: e.session_id, event: e.event,
        receivedTs: e.received_ts, committedTs: now(), unattributed },
    };
    if (!unattributed) {
      const sid = e.session_id!;
      batch.sessions.push({ nativeSessionId: sid, lastActivity: e.received_ts, ...(e.cwd !== null ? { cwd: e.cwd } : {}) });
      batch.events.push({ nativeSessionId: sid, source: 'hook', confidence: 'confirmed', nativeId: e.delivery_id, kind: 'hook',
        sourceSeq: e.received_ts, sourceTs: e.received_ts, receivedTs: batch.delivery!.committedTs, raw: JSON.stringify(e) });
    }
    try {
      o.writer.commitLive(batch);
    } catch (err) {
      if (!isDiskFull(err)) return { status: 'rejected', code: 'store' };
      note(e);
      return { status: 'rejected', code: 'disk-full' };
    }
    gaps.delete(e.delivery_id);
    recovered();
    // ponytail: outside the delivery's transaction; a failed delete leaves this delivery counted missing
    try { dropGap.run(`disk-full:${e.delivery_id}`); } catch { /* the gap row stays */ }
    o.publish?.(e, true);
    return { status: 'accepted', code: 'ok' };
  };

  return { deliver, recovered };
}

export interface HooksOptions extends IntakeOptions {
  dataDir: string;
  log?: Logger;
  /** P3-T13b: live projection of report deliveries (durable false before the commit, true after it). */
  publishReport?: (e: Envelope, durable: boolean) => void;
  /** P3-T13b2: true for an agent outside the bundled catalog (its registration may create its own profile). */
  customAgent?: (agent: string) => boolean;
}
export interface Hooks { intake: Intake; socket: SocketServer | null; replay: Promise<ReplayResult>; close(): Promise<void> }

/** Service start (and each (re)listen): listen first, so hooks fired meanwhile are acked instead of spooling behind the
 *  replay, then replay the spool in the background (its cleanup waits a grace). A socket that cannot listen is logged;
 *  the replay still runs. */
export async function startHooks(o: HooksOptions): Promise<Hooks> {
  const intake = createIntake(o);
  let reports: SocketOptions['reports'];
  try { // a chunk dir that is not ours disables report intake only; hooks still run
    reports = { registry: openRegistry(o.dataDir), intake: createReportIntake({ db: o.db, writer: o.writer, dataDir: o.dataDir,
      ...(o.now ? { now: o.now } : {}), ...(o.publishReport ? { publish: o.publishReport } : {}), ...(o.customAgent ? { customAgent: o.customAgent } : {}) }) };
  } catch (e) {
    o.log?.log('report_intake_failed', { error: errorCode(e) });
  }
  let socket: SocketServer | null = null;
  try {
    socket = await startSocketServer({ dataDir: o.dataDir, onEnvelope: intake.deliver, ...(o.log ? { log: o.log } : {}), ...(reports ? { reports } : {}) });
  } catch (e) {
    o.log?.log('hook_socket_failed', { error: e instanceof SocketError ? e.code : errorCode(e) });
  }
  let stopped = false; // set synchronously by close(): boot closes the store right after
  const deliverReport = reports && ((id: string, frame: Record<string, unknown>, receivedTs: number): Promise<IntakeResult> => {
    const reg = reports.registry.current(id); // identity from the registry, never the record (P3-T13c)
    return reg ? reports.intake.deliver(reg, frame, receivedTs) : Promise.resolve({ status: 'rejected', code: 'auth' });
  });
  const replay = replaySpool({ dataDir: o.dataDir, db: o.db, deliver: intake.deliver, stopped: () => stopped, ...(o.now ? { now: o.now } : {}),
    ...(deliverReport ? { deliverReport } : {}) }).then((r) => {
    o.log?.log('spool_replay', { delivered: r.delivered, torn: r.torn, skipped: r.skipped, deferred: r.deferred, dropped: r.dropped, complete: r.complete ? 1 : 0 });
    return r;
  });
  replay.catch((e: unknown) => o.log?.log('spool_replay_failed', { error: errorCode(e) }));
  return { intake, socket, replay, close: async () => { stopped = true; await socket?.close(); } };
}
