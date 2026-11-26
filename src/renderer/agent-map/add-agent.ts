// XAIBO-PROD-592 (P6-T08 slice C; design §6.5.2 "Add agent", D-P6-19): the Add agent wizard model, pure. Six steps in design
// order; Next only when the step is satisfied (an agent, a profile, an applied preview, a receipt); a scan reply for an older
// request is ignored; another agent or profile clears what follows it; Back revisits without undoing (an applied preview stays
// applied, so it is never applied twice); a rescan returns to the candidates and clears the profile. Config work, previews and
// receipts stay with the existing Connect dialog and Test receipt (slice D wires them); nothing here holds a preview or grant.
// Code review H1/M1: another agent or profile moves a later step back to where that choice is made, and bumps a generation
// that an applied or receipt reply must carry, so a late reply for an earlier selection is ignored.
import type { IntegrationRow, RescanResult } from '../../shared/ipc.ts';
import type { ReceiptTest } from './integration-panel.ts';
import { panelActions } from './integration-dialog.ts';
import type { IntegrationDetail } from '../../shared/ipc.ts';

export const STEPS = ['candidates', 'prerequisites', 'profile', 'preview', 'receipt', 'result'] as const;
export type Step = (typeof STEPS)[number];
export const STEP_TITLE: Record<Step, string> = {
  candidates: 'Rescan and candidates', prerequisites: 'Prerequisites and coverage', profile: 'Profile and grants',
  preview: 'Configuration preview', receipt: 'Receipt test', result: 'Result',
};
export interface Wizard {
  step: Step; seq: number; gen: number; scan: 'scanning' | 'ready' | { refused: string; retryAfterMs?: number };
  agent: string | null; profileId: string | null; applied: boolean; receipt: boolean;
}
export type WizardEvent =
  | { type: 'rescan' } | { type: 'scanned'; seq: number; result: RescanResult }
  | { type: 'agent'; agent: string } | { type: 'profile'; profileId: string }
  | { type: 'applied'; gen: number } | { type: 'receipt'; gen: number } | { type: 'next' } | { type: 'back' };

/** XAIBO-PROD-593 (slice D): step 1's candidates, one per agent (detection belongs to the agent, whatever the profile), detected
 *  first, then not detected, each in service order. */
export interface Candidate { agent: string; name: string; version: string | null; detected: boolean }
export function candidates(rows: readonly IntegrationRow[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const r of rows) if (!seen.has(r.key.agent)) seen.set(r.key.agent, { agent: r.key.agent, name: r.name, version: r.version, detected: r.state !== 'not-detected' });
  const all = [...seen.values()];
  return [...all.filter((c) => c.detected), ...all.filter((c) => !c.detected)];
}

/** E2E finding: before a profile is chosen the detail is read through the agent's first listed profile (a profile-less key exists
 *  only for an agent with no profile); a chosen profile always wins. */
export const detailKey = (rows: readonly IntegrationRow[], agent: string, profileId: string | null): { agent: string; profileId: string | null } =>
  (profileId ? { agent, profileId } : rows.find((r) => r.key.agent === agent)?.key ?? { agent, profileId: null });

/** E2E finding: a passed Test receipt on the receipt step is the receipt for the current selection (read in an effect, never
 *  dispatched from inside a state updater). */
/** E2E finding: per-step state belongs to one step of one selection (the generation moves with agent, profile and rescan). */
/** E2E finding: the Connect dialog may open only on the preview step for the chosen profile before anything is applied. */
export const previewOpen = (w: Wizard) => w.step === 'preview' && w.profileId !== null && !w.applied;
/** Review M3: set up = Xaibo's entries on the profile and no Connect left to offer (a partial apply is not). */
export const setUp = (d: IntegrationDetail) => d.row.key.profileId !== null && d.entries.length > 0 && !panelActions(d).includes('connect');
export const stepKey = (w: Wizard) => `${w.gen}|${w.step}`;
export const receiptEvent = (t: ReceiptTest, w: Wizard): WizardEvent | null =>
  (t.phase === 'received' && w.step === 'receipt' && w.applied && !w.receipt ? { type: 'receipt', gen: w.gen } : null);

export const openWizard = (): Wizard => ({ step: 'candidates', seq: 1, gen: 1, scan: 'scanning', agent: null, profileId: null, applied: false, receipt: false });

export function canNext(w: Wizard): boolean {
  switch (w.step) {
    case 'candidates': return w.agent !== null; // review L1: the previous evidence stays usable while a rescan runs
    case 'prerequisites': return true;
    case 'profile': return w.profileId !== null;
    case 'preview': return w.applied;
    case 'receipt': return w.receipt;
    case 'result': return false;
  }
}

export function wizardStep(w: Wizard, e: WizardEvent): Wizard {
  const at = STEPS.indexOf(w.step);
  switch (e.type) {
    case 'rescan': return { ...w, step: 'candidates', seq: w.seq + 1, gen: w.gen + 1, scan: 'scanning', profileId: null, applied: false, receipt: false };
    case 'scanned':
      if (e.seq !== w.seq) return w;
      return { ...w, scan: e.result.status === 'ready' ? 'ready' : { refused: e.result.code, ...(e.result.retryAfterMs !== undefined ? { retryAfterMs: e.result.retryAfterMs } : {}) } };
    case 'agent': return e.agent === w.agent ? w : { ...w, step: STEPS[Math.min(at, 1)]!, gen: w.gen + 1, agent: e.agent, profileId: null, applied: false, receipt: false };
    case 'profile': return e.profileId === w.profileId ? w : { ...w, step: STEPS[Math.min(at, 2)]!, gen: w.gen + 1, profileId: e.profileId, applied: false, receipt: false };
    case 'applied': return e.gen === w.gen && w.step === 'preview' && !w.applied ? { ...w, applied: true } : w;
    case 'receipt': return e.gen === w.gen && w.step === 'receipt' && w.applied && !w.receipt ? { ...w, receipt: true } : w;
    case 'next': return canNext(w) ? { ...w, step: STEPS[at + 1]! } : w;
    case 'back': return at > 0 ? { ...w, step: STEPS[at - 1]! } : w;
  }
}
