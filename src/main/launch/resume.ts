// XAIBO-PROD-619 (P7-T05; OQ-P7-3): the MVP lock, Xaibo-side only. A second Xaibo launch or resume of the same session is
// blocked while one is pending (begin..end), or while a session Xaibo launched has live evidence; a session started elsewhere
// is warned about (EC-20), never locked: external clients cannot be locked. ponytail: in memory, so a restart forgets pending
// launches; the provisional row's own state carries it across restarts if that ever matters.
import type { ResumeLiveness } from '../../service/status/resume-liveness.ts';

export function resumeGuard() {
  const pending = new Set<string>();
  return {
    begin(key: string, o: { liveness: ResumeLiveness; launchedHere: boolean }): 'ok' | 'locked' {
      if (pending.has(key) || (o.launchedHere && o.liveness === 'live')) return 'locked';
      pending.add(key);
      return 'ok';
    },
    /** The launch bound, failed or its provisional row was removed. */
    end(key: string) { pending.delete(key); },
  };
}
