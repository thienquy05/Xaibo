// Status presentation (design §3.1–§3.2; P4-T01): the 21 lifecycle × confidence labels with their lifecycle and
// evidence icons and semantic tone. Pure; the service decides state, this only names it.
import type { LiveStatus } from '../../shared/ipc.ts';
import type { IconId } from './icons.ts';

export type Tone = 'muted' | 'accent' | 'success' | 'warning' | 'danger';
export interface ReasonPresentation { label: string; icon: IconId; tone: Tone }
export interface StatusPresentation {
  /** Visible and accessible status text, e.g. "Busy · confirmed". */
  label: string; icon: IconId; confidenceIcon: IconId; tone: Tone;
  reasons: ReasonPresentation[];
  /** Evidence detail when the label alone could mislead (heuristic wait, missing evidence). */
  detail: string | null;
}

const LIFE: Record<LiveStatus['lifecycle'], { name: string; icon: IconId; tone: Tone }> = {
  idle: { name: 'Idle', icon: 'idle', tone: 'muted' },
  busy: { name: 'Busy', icon: 'busy', tone: 'accent' },
  'waiting-for-permission': { name: 'Waiting for permission', icon: 'permission', tone: 'warning' },
  'needs-input': { name: 'Needs input', icon: 'input', tone: 'warning' },
  error: { name: 'Error', icon: 'error', tone: 'danger' },
  ended: { name: 'Ended', icon: 'ended', tone: 'muted' },
  unknown: { name: 'Unknown', icon: 'unknown', tone: 'muted' },
};
const EVIDENCE: Record<LiveStatus['confidence'], IconId> = { confirmed: 'evidence-solid', inferred: 'evidence-open', heuristic: 'evidence-dashed' };
const REASON: Record<string, ReasonPresentation> = {
  'Finishing…': { label: 'Finishing…', icon: 'settle', tone: 'muted' },
  'Background work': { label: 'Background work', icon: 'branch', tone: 'accent' },
};

export function statusPresentation(
  lifecycle: LiveStatus['lifecycle'] | null, confidence: LiveStatus['confidence'] | null, reasons: readonly string[] = [],
): StatusPresentation {
  const shown = reasons.flatMap((r) => (REASON[r] ? [REASON[r]] : [])); // "Probably waiting" is part of the label
  if (lifecycle === null || confidence === null) { // §3.1: missing evidence is Unknown, never Idle
    return { label: 'Unknown · heuristic', icon: 'unknown', confidenceIcon: 'evidence-dashed', tone: 'muted', reasons: shown, detail: 'No eligible state evidence' };
  }
  const l = LIFE[lifecycle];
  const wait = confidence === 'heuristic' && (lifecycle === 'waiting-for-permission' || lifecycle === 'needs-input');
  return {
    label: wait ? 'Probably waiting · heuristic' : `${l.name} · ${confidence}`,
    icon: l.icon, confidenceIcon: EVIDENCE[confidence], tone: l.tone, reasons: shown,
    detail: wait ? `Underlying state: ${l.name} (heuristic, no observed prompt)` : null,
  };
}
