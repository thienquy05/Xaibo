// XAIBO-PROD-626 (P7-T05, P7-T09; FR-13, FR-20, FR-21, EC-20, EC-67, EC-81): one stored session's resume target for main. The
// resume template is the catalog's (sessionKind, S6/S7) and only an interactive one: native availability first (EC-81), a UUID
// native id, no prompt-required print mode or headless token (FR-20: never a headless fallback), whole-token placeholders only
// (the launch layer accepts nothing else). Fork only where the bundled catalog carries a tested template (OQ-P7-5). The VS Code
// handoff only for Claude with a verified vscode compatibility row for the detected release (P6-T08 data; S7), else why not.
// Liveness: busy/waiting with connected health is live, ended is not, anything else (silence included) is uncertain (EC-20).
// Pure: the service passes the stored session, its status and the detected version.
import { HEADLESS, uuid, type LiveTemplate, type ResumeTarget } from '../../shared/ipc.ts';
import type { Catalog } from '../catalog/validate.ts';
import { sessionKind } from '../resume.ts';
import { resumeLiveness } from '../status/resume-liveness.ts';

export interface StoredForResume {
  agent: string; profileId: string; nativeSessionId: string; cwd: string | null; entrypoint: string | null; originator: string | null; nativeAvailable: boolean;
  live: Parameters<typeof resumeLiveness>[0]['status'];
  /** G7-1 (OQ-P7-3): a Xaibo resume of this session is still starting (its provisional row has not bound, failed or been removed). */
  pending?: boolean;
}
const whole = (args: readonly string[]) => args.every((t) => t === '{id}' || !t.includes('{'));
const off = (disabled: string): LiveTemplate => ({ disabled });

export function resumeTarget(catalog: Catalog, s: StoredForResume, version: string | null): ResumeTarget {
  const kind = sessionKind(catalog.sessionKinds, s);
  let resume: LiveTemplate, fork: LiveTemplate;
  if (!s.nativeAvailable) resume = fork = off('Native session deleted; resume unavailable');
  else if (!uuid(s.nativeSessionId)) resume = fork = off('Session id is not a lowercase UUID; resume disabled'); // as the launch layer accepts
  else {
    resume = s.pending ? off('A resume from Xaibo is still starting; wait for it or remove its Starting… row')
      : !kind ? off('Entry point not verified; resume disabled')
      : !kind.resume ? off(kind.resumeDisabled ?? 'Resume not verified')
      : kind.resume.promptRequired || kind.resume.args.some((t) => HEADLESS.test(t)) ? off('Print mode (-p) needs a prompt; not offered as an interactive resume')
      : !whole(kind.resume.args) ? off('Resume template not supported')
      : { args: [...kind.resume.args] };
    fork = kind?.fork && whole(kind.fork.args) ? { args: [...kind.fork.args] } : off('Fork not verified for this agent');
  }
  const row = version ? catalog.agents.find((a) => a.id === s.agent)?.compatibility?.find((r) => r.surface === 'vscode' && r.version === version) : undefined;
  const vscode = s.agent !== 'claude' ? 'Open in VS Code is available for Claude Code sessions only'
    : row?.visible === 'verified' ? null : `VS Code history visibility: unverified for ${version ?? 'an unknown version'}`;
  return { agent: s.agent, profileId: s.profileId, nativeId: s.nativeSessionId, cwd: s.cwd, resume, fork, vscode,
    liveness: resumeLiveness({ status: s.live, ownership: 'observed-externally' }) };
}
