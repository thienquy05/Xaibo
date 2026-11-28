// XAIBO-PROD-619 (P7-T05; EC-20, EC-01): resume concurrency. Live elsewhere: a known owner (Controlled here), a live process
// (liveness.ts: pid, start time and executable match) or recent hook activity, read from the status engine as an active
// lifecycle with connected health (no separate recency window). Not live: only an ended lifecycle with no live process. All
// else is uncertain: silence does not prove the session is safe to resume, so live and uncertain both warn (design §6.8). A
// stale pid never ends a session. The warning dialog comes with the UI slice after the owner's mock review.
import type { Health, Lifecycle } from './engine.ts';
import type { Ownership } from './ownership.ts';

export type ResumeLiveness = 'live' | 'uncertain' | 'not-live';
const ACTIVE = new Set<Lifecycle>(['busy', 'waiting-for-permission', 'needs-input']);

export function resumeLiveness(e: { status: { lifecycle: Lifecycle; health: Health } | null; ownership?: Ownership }): ResumeLiveness {
  if (e.ownership === 'controlled-here') return 'live';
  if (e.status && e.status.health === 'connected' && ACTIVE.has(e.status.lifecycle)) return 'live';
  return e.status?.lifecycle === 'ended' ? 'not-live' : 'uncertain';
}
