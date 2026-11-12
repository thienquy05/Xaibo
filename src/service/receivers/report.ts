// Report v1 intake (P3-T13b; PRD §5.10, SEC2, FR-08; EC-82; security review 872). Order per frame: validate (a rejected
// frame is acked rejected with its fixed code and counted per registration and code), dedup on (registration,
// delivery_id), publish as pending durability, write a content chunk durably, commit the delivery (and the item's state
// or full text) in one immediate transaction, remove an assembled item's chunks, publish as durable, then ack. Identity is
// the registration's, never the payload's; a session is attached only for a synced profile of the registration's agent,
// otherwise the delivery row records it as unattributed. Content goes only to report_content: events.raw and the
// published envelope carry the event with its content emptied. Payload paths are stored as given, never dereferenced.
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Envelope } from '../../shared/hook-protocol.ts';
import { parseReport } from '../../shared/report/schema.ts';
import { openChunks, type ChunkKey, type ChunkLimits } from '../adapters/generic/chunks.ts';
import { isDiskFull, type Batch, type ReportDelivery, type Writer } from '../store/writer.ts';
import type { Registration } from './registrations.ts';
import type { IntakeResult } from './socket.ts';

export interface ReportIntakeOptions {
  db: DatabaseSync;
  writer: Writer;
  dataDir: string;
  now?: () => number;
  /** Live projection: durable false before the commit, true after it. */
  publish?: (e: Envelope, durable: boolean) => void;
  chunks?: ChunkLimits;
}
export interface ReportIntake {
  deliver(reg: Registration, frame: unknown): Promise<IntakeResult>;
  /** Counts a frame refused before intake (framing, size) as coverage for its registration. */
  rejected(reg: Registration, code: string): void;
}

export function createReportIntake(o: ReportIntakeOptions): ReportIntake {
  const now = o.now ?? Date.now;
  const chunks = openChunks(path.join(o.dataDir, 'content-chunks'), o.chunks);
  const profile = o.db.prepare('SELECT 1 FROM profiles WHERE id = ? AND agent = ?');
  const stored = o.db.prepare('SELECT 1 FROM report_delivery WHERE registration_id = ? AND delivery_id = ?');
  const itemState = o.db.prepare('SELECT state FROM report_content WHERE registration_id = ? AND native_session_id = ? AND item_id = ? AND revision = ?');
  const putReject = o.db.prepare(`INSERT INTO report_rejects (registration_id, code, count, first_ts, last_ts) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT DO UPDATE SET count = count + 1, last_ts = excluded.last_ts`);
  const settledIn = (k: ChunkKey) => {
    const st = (itemState.get(k.registration, k.session, k.item, k.revision) as { state: string } | undefined)?.state;
    return st === 'complete' || st === 'incomplete' ? st : undefined;
  };
  // Removal after the commit is best effort: a crash or a failed removal leaves chunks that are freed here (review M4/M5).
  const free = (k: ChunkKey) => { try { chunks.remove(k); } catch { /* freed at the next start */ } };
  for (const k of chunks.items()) if (settledIn(k)) free(k);

  const rejected = (reg: Registration, code: string) => {
    const at = now();
    try { putReject.run(reg.id, code, at, at); } catch { /* a full store: the ack still says rejected */ }
  };

  const deliver = async (reg: Registration, frame: unknown): Promise<IntakeResult> => {
    const r = parseReport(frame);
    if (!r.ok) { rejected(reg, r.code); return { status: 'rejected', code: r.code }; }
    const x = r.event;
    if (stored.get(reg.id, x.delivery_id)) return { status: 'accepted', code: 'duplicate' };
    const at = now();
    const p = x.payload;
    const isContent = x.event === 'content.upsert';
    const lean = isContent ? { ...x, payload: { ...p, content: '' } } : x;
    const e: Envelope = {
      v: 1, delivery_id: `${reg.id}:${x.delivery_id}`, agent: reg.agent, profile_key: reg.profile_key, event: x.event, session_id: x.session_id,
      cwd: x.cwd ?? null, received_ts: at, payload: lean as unknown as Record<string, unknown>,
    };
    o.publish?.(e, false);

    let key: ChunkKey | null = null;
    let content: ReportDelivery['content'];
    let settled: string | undefined;
    if (isContent) {
      key = { registration: reg.id, session: x.session_id, item: x.item_id!, revision: p['revision'] as number };
      settled = settledIn(key);
      if (settled) free(key); // a late chunk of a settled item: never reassembled
      else {
        let c;
        try { c = chunks.put(key, p['chunk_index'] as number, p['final'] as boolean, p['content'] as string); } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOSPC') return { status: 'rejected', code: 'disk-full' };
          if (err instanceof RangeError) { rejected(reg, 'invalid-content'); return { status: 'rejected', code: 'invalid-content' }; }
          return { status: 'rejected', code: 'store' };
        }
        content = { itemId: key.item, revision: key.revision, role: p['role'] as string, kind: p['kind'] as string, state: c.state, chunks: c.chunks,
          bytes: c.bytes, text: c.state === 'complete' ? c.content : null };
      }
    }

    const attributed = !!profile.get(reg.profile_key, reg.agent);
    const batch: Batch = {
      profileId: reg.profile_key, agent: reg.agent, sessions: [], events: [],
      report: { registrationId: reg.id, deliveryId: x.delivery_id, agent: reg.agent, profileKey: reg.profile_key, nativeSessionId: x.session_id,
        event: x.event, producerId: x.producer_id, producerSeq: x.producer_seq, receivedTs: at, committedTs: at,
        unattributed: attributed ? null : 'unknown-profile', ...(content ? { content } : {}) },
    };
    if (attributed) {
      batch.sessions.push({ nativeSessionId: x.session_id, lastActivity: at, ...(x.cwd ? { cwd: x.cwd } : {}) });
      batch.events.push({ nativeSessionId: x.session_id, source: 'report', confidence: 'confirmed', nativeId: e.delivery_id, kind: 'report',
        sourceSeq: x.producer_seq, sourceTs: at, receivedTs: at, raw: JSON.stringify(lean) });
    }
    try {
      o.writer.commitLive(batch);
    } catch (err) {
      return { status: 'rejected', code: isDiskFull(err) ? 'disk-full' : 'store' }; // the chunk stays on disk for the retry
    }
    if (key && content && content.state !== 'pending') free(key);
    o.publish?.(e, true);
    return { status: 'accepted', code: (content?.state ?? settled) === 'incomplete' ? 'incomplete' : 'ok' };
  };

  return { deliver, rejected };
}
