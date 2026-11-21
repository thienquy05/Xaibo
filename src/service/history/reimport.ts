// XAIBO-PROD-516 (P5-T08; FR-11, EC-21, FR-52): explicit Re-import of a purged session. The marker is cleared and the
// files that held the session's records are reset, so the next scan reads them from the start; records already settled
// add nothing to the frozen monthly totals (their contribution keys are settled). The caller triggers that scan (the
// adapters' reconcile, P5-T18 wiring); records whose native copy is gone cannot come back.
import { existsSync } from 'node:fs';
import { finishPending, type FileOptions } from './purge.ts';
import { clear, type Identity } from './suppression.ts';
import type { Writer } from '../store/writer.ts';

/** none: no suppressing marker; pending: the purge still owes file work it could not finish yet (review M1);
 *  native-gone: none of the session's native files exist any more (review L2), the marker stays. */
export type ReimportResult = 'ok' | 'none' | 'pending' | 'native-gone';

/** keep: also set Keep in the transaction that clears the marker (XAIBO-PROD-527 review M1, D-P5-08). */
export function reimport(writer: Writer, who: Identity, o: FileOptions & { keep?: boolean }): ReimportResult {
  const live = () => writer.transact((db) => db.prepare('SELECT 1 FROM suppressions WHERE agent = ? AND profile_id = ? AND native_session_id = ? AND cleared_at IS NULL')
    .get(who.agent, who.profile, who.native) !== undefined);
  if (!live()) return 'none';
  if (!finishPending(writer, who, o)) return 'pending'; // a cleared marker must not let the purge's file work remove re-imported data
  return writer.transact((db) => {
    // G5Rr1-2: the file work just finished and cleared a retention marker that saw new native activity: re-imported already
    if (db.prepare('SELECT 1 FROM suppressions WHERE agent = ? AND profile_id = ? AND native_session_id = ? AND cleared_at IS NULL').get(who.agent, who.profile, who.native) === undefined) {
      if (o.keep) db.prepare('INSERT INTO overlays (agent, profile_id, native_session_id, keep) VALUES (?, ?, ?, 1) ON CONFLICT DO UPDATE SET keep = 1').run(who.agent, who.profile, who.native);
      return 'ok';
    }
    const paths = db.prepare(`SELECT f.path FROM suppressions s, json_each(coalesce(s.files, '[]')) j JOIN source_files f ON f.id = j.value
      WHERE s.agent = ? AND s.profile_id = ? AND s.native_session_id = ? AND s.cleared_at IS NULL`).all(who.agent, who.profile, who.native) as { path: string }[];
    const listed = (db.prepare("SELECT json_array_length(coalesce(files, '[]')) AS n FROM suppressions WHERE agent = ? AND profile_id = ? AND native_session_id = ?")
      .get(who.agent, who.profile, who.native) as { n: number }).n;
    if (listed > 0 && !paths.some((p) => existsSync(p.path))) return 'native-gone';
    clear(db, who, o.now);
    if (o.keep) {
      db.prepare('INSERT INTO overlays (agent, profile_id, native_session_id, keep) VALUES (?, ?, ?, 1) ON CONFLICT DO UPDATE SET keep = 1').run(who.agent, who.profile, who.native);
    }
    return 'ok';
  });
}
