// Session kinds and resume argv (P2-T04, EC-05, EC-50, OQ-P2-08). The catalog maps an agent's entry point (Claude
// `entrypoint`; Codex `session_meta.source`, stored as entrypoint, + `originator`) to a badge, an interactive flag and
// resume args verified in S6/S7 (agy: D-P2-02). Pure: nothing here starts a process; execution is Phase 7, which
// prepends the detected binary and appends the prompt.
import type { SessionKind } from './catalog/validate.ts';

export interface KindInput { agent: string; entrypoint: string | null; originator: string | null }
export type Resume = { argv: string[]; promptRequired: boolean } | { disabled: true; reason: string };

// Every agent's native session id is a UUID (S9, T00); anything else could become a flag or a path.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The first kind of the session's agent whose every match field equals the session's value (exact strings). */
export function sessionKind(kinds: SessionKind[], s: KindInput): SessionKind | undefined {
  return kinds.find((k) => k.agent === s.agent
    && (k.match.entrypoint === undefined || k.match.entrypoint === s.entrypoint)
    && (k.match.originator === undefined || k.match.originator === s.originator));
}

export function resumeArgv(kinds: SessionKind[], s: KindInput & { nativeSessionId: string; nativeAvailable?: boolean }): Resume {
  if (s.nativeAvailable === false) return { disabled: true, reason: 'Native session deleted; resume unavailable' }; // EC-81
  const kind = sessionKind(kinds, s);
  if (!kind) return { disabled: true, reason: 'Entry point not verified; resume disabled' };
  if (!kind.resume) return { disabled: true, reason: kind.resumeDisabled ?? 'Resume not verified' };
  if (!UUID.test(s.nativeSessionId)) return { disabled: true, reason: 'Session id is not a UUID; resume disabled' };
  return { argv: kind.resume.args.map((a) => a.replaceAll('{id}', s.nativeSessionId)), promptRequired: kind.resume.promptRequired ?? false };
}
