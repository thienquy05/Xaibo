// XAIBO-PROD-624 (P7-T04 slice E; design §6.7, mock approved 2026-11-27): the renderer's launch model. Main builds and checks
// every command (P7-T02/T03); the renderer only asks (options, preview, launch) through the preload bridge and shows main's
// parsed replies: anything unparsed or a missing bridge is "unavailable". The cwd defaults only from folders sessions were
// evidenced in (never guessed from a title or content) and stays editable.
import { OWNERSHIP_TEXT } from '../../service/status/ownership.ts';
import { parseLaunchOptionsReply, parseLaunchPreviewReply, parseLaunchReply, type LaunchOptionsReply, type LaunchPreviewReply, type LaunchRefusal, type LaunchReply, type SessionRow } from '../../shared/ipc.ts';

export interface LaunchApi {
  options(): Promise<LaunchOptionsReply>;
  preview(ask: { agent: string; profileId: string; cwd: string }): Promise<LaunchPreviewReply>;
  launch(previewId: string): Promise<LaunchReply>;
}
const UNAVAILABLE = { status: 'refused', code: 'unavailable' } as const;
export function launchApi(invoke: ((request: unknown) => Promise<unknown>) | undefined): LaunchApi {
  const ask = <T>(request: unknown, parse: (x: unknown) => T | null): Promise<T> =>
    invoke ? invoke(request).then((r) => parse(r) ?? (UNAVAILABLE as T), () => UNAVAILABLE as T) : Promise.resolve(UNAVAILABLE as T);
  return {
    options: () => ask({ op: 'options' }, parseLaunchOptionsReply),
    preview: (a) => ask({ op: 'preview', agent: a.agent, profileId: a.profileId, cwd: a.cwd }, parseLaunchPreviewReply),
    launch: (previewId) => ask({ op: 'launch', previewId }, parseLaunchReply),
  };
}

export const REFUSAL_TEXT: Record<LaunchRefusal, string> = {
  invalid: 'Xaibo could not read this launch request.',
  unavailable: 'Launch is unavailable right now. Try again in a moment.',
  busy: 'Another launch just ran. Wait a moment, then try again.',
  disabled: 'This agent cannot be launched from Xaibo.',
  'not-detected': 'This agent was not detected.',
  profile: 'Launch from this profile is not supported yet.',
  executable: "The agent's executable could not be checked.",
  interpreter: 'The executable is a shell or interpreter, which Xaibo never launches.',
  name: "The executable's name is not one this agent uses.",
  cwd: 'Choose an existing folder.',
  id: 'The session ID could not be prepared.',
  placeholder: 'The launch template is not supported.',
  text: 'The launch contains text Xaibo cannot pass safely.',
  env: 'The environment grant is not valid.',
  expired: 'The preview expired. Check the command again.',
  changed: 'The agent changed since the preview. Check the command again.',
  grant: 'The launch grant no longer matches the agent. Launch again to renew it.',
};
export const FAILED_TEXT = { write: 'Xaibo could not write the launch script.', open: 'Terminal did not open the launch script.' } as const;
export const PENDING_OWNERSHIP = OWNERSHIP_TEXT.unavailable;
export const CANCELLED_TEXT = 'Launch grant not given. Nothing was started.';

const CHOICES_MAX = 12;
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
/** Evidenced session folders: the chosen agent's first, then the rest; most recent first; distinct; absolute only. */
export function cwdChoices(rows: readonly SessionRow[], agent: string | null): { label: string; cwd: string }[] {
  const order = [...rows].filter((r) => typeof r.cwd === 'string' && r.cwd.startsWith('/'))
    .sort((a, b) => Number(b.agent === agent) - Number(a.agent === agent) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  const cwds = [...new Set(order.map((r) => r.cwd as string))].slice(0, CHOICES_MAX);
  const names = cwds.map(base);
  return cwds.map((cwd, i) => ({ cwd, label: names.indexOf(names[i]!) !== names.lastIndexOf(names[i]!) ? `${names[i]} (${cwd})` : names[i]! }));
}

const BASE = ['PATH', 'HOME', 'LANG', 'TERM', 'USER', 'SHELL', 'TMPDIR'];
/** The preview's environment line: the fixed set, plus a profile variable read in Terminal when one is passed through. */
export function envHint(env: readonly string[]): string {
  const extra = env.filter((k) => !BASE.includes(k));
  return `Environment: ${env.join(', ')} (${extra.length ? `${extra.join(', ')} as set in Terminal's environment` : 'no granted keys'})`;
}
/** A coarse elapsed label for list rows (an accessible name that changes once a minute, not every second). */
export function minutes(ms: number): string { const m = Math.floor(Math.max(0, ms) / 60_000); return m < 1 ? 'under 1 min' : `${m} min`; }
/** m:ss, or h:mm:ss from an hour. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
