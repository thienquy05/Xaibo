// File records for the status engine (P3-T10). Hook deliveries reach the engine from intake publish; native file
// records from each committed file batch. Only records with a source time inside the live window are fed, so a backfill
// of old history neither loads the engine's in-memory evidence nor its status_evidence rows; a record without a source
// time is never fed (its receive time is the backfill's, which made an old session look live in the P3-T10 check).
import type { Observation } from './engine.ts';
import type { Batch } from '../store/writer.ts';

/** ponytail: a fixed 24 h live window; a session idle longer shows "No live status" until its next record. Make it a
 *  setting if long-paused sessions need their last state shown. */
export const LIVE_WINDOW_MS = 24 * 3600_000;

export function fileObservations(b: Batch, now: number): Observation[] {
  if (!b.file) return [];
  const file = b.file.path;
  return b.events.flatMap((e): Observation[] => {
    if (typeof e.raw !== 'string' || e.sourceTs === undefined || now - e.sourceTs > LIVE_WINDOW_MS) return [];
    return [{ source: 'file', agent: b.agent, profile: b.profileId, sessionId: e.nativeSessionId, file, offset: e.byteOffset ?? e.sourceSeq, line: e.raw, receivedTs: e.receivedTs }];
  });
}
