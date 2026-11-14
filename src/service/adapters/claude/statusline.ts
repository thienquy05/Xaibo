// Claude statusLine snapshots from the tee (P3-T14; FR-45, S-31; design review 1074 L1, M3). A delivery counts only for
// agent claude, event `statusline` and cwd null (what the tee sends; a hook-path envelope always carries its payload's
// cwd and stays a hook event). The payload is never trusted: the tee's FR-45 allowlist runs again here and only its
// result is stored. A session's snapshot is stored only when it differs from the last one stored for that session,
// so a redraw every few seconds adds nothing. Normalization into usage and context snapshots is P3-T15.
import { captureRecord } from '../../../forwarder/statusline-tee.ts';
import type { Envelope } from '../../../shared/hook-protocol.ts';

export const isStatusline = (e: Envelope) => e.agent === 'claude' && e.event === 'statusline' && e.cwd === null;

/** The re-validated record and its session, or null when nothing can be stored. */
export function statuslineRecord(e: Envelope): { session: string; record: Record<string, unknown> } | null {
  const record = captureRecord(e.payload);
  const session = record?.['session_id'];
  return record && typeof session === 'string' && session === e.session_id ? { session, record } : null;
}

const MAX_SESSIONS = 1000;
/** Store-on-change per (profile, session): `kept` only after a successful commit. ponytail: held in memory (a restart
 *  stores the next snapshot again) and cleared at 1,000 sessions; a last-snapshot column if T15 needs it across restarts. */
export function lastSnapshots() {
  const last = new Map<string, string>();
  const key = (profile: string, session: string) => JSON.stringify([profile, session]);
  return {
    differs: (profile: string, session: string, raw: string) => last.get(key(profile, session)) !== raw,
    kept: (profile: string, session: string, raw: string) => {
      if (!last.has(key(profile, session)) && last.size >= MAX_SESSIONS) last.clear();
      last.set(key(profile, session), raw);
    },
  };
}
