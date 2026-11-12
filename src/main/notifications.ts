// OS notification content (P3-T11; US-2, FR-10, D-11, EC-59). A pure function of agent display name, approved project
// label and wait state: nothing else can reach the text, so prompts, titles, paths and tool content never do. No content
// opt-in exists. Until an approved label exists (the Phase 5 overlay), the placeholder "Project" is shown.
import type { NotifyState } from '../shared/ipc.ts';

const STATE: Record<NotifyState, string> = { 'waiting-for-permission': 'Waiting for permission', 'needs-input': 'Needs input' };

export const notificationText = (agent: string, label: string | null, state: NotifyState): string =>
  `${agent} · ${label ?? 'Project'} · ${STATE[state]}`;
