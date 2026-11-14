// OS notification content (P3-T11; US-2, FR-10, D-11, EC-59). A pure function of agent display name, approved project
// label and wait state: nothing else can reach the text, so prompts, titles, paths and tool content never do. No content
// opt-in exists. Until an approved label exists (the Phase 5 overlay), the placeholder "Project" is shown.
import type { NotifyState } from '../shared/ipc.ts';
import type { Logger } from '../shared/log.ts';

const STATE: Record<NotifyState, string> = { 'waiting-for-permission': 'Waiting for permission', 'needs-input': 'Needs input' };

export const notificationText = (agent: string, label: string | null, state: NotifyState): string =>
  `${agent} · ${label ?? 'Project'} · ${STATE[state]}`;

/** The part of Electron's Notification class used here (a fake in tests). */
export interface NotifierClass {
  isSupported(): boolean;
  new (o: { title: string }): { on(event: 'failed', listener: () => void): unknown; show(): void };
}

/** Shows the title. A notification that cannot be shown is logged with a code, never the title (P3-T11a): Electron 42+
 *  uses UNNotification on macOS, which refuses unsigned builds with a 'failed' event; ours are ad-hoc signed until
 *  public release (PRD §3). */
export function showNotification(N: NotifierClass, title: string, log: Logger['log']): void {
  if (!N.isSupported()) { log('notify_failed', { error: 'unsupported' }); return; }
  const n = new N({ title });
  n.on('failed', () => log('notify_failed', { error: 'show_failed' }));
  n.show();
}
