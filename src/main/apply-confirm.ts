// XAIBO-PROD-600 (P6-T12 slice 2; D-P6-21; plan and security review .handoff/p6-t12-slice2-plan.md): main's native confirmation
// of a real-class apply (Connect, Disconnect or Full Uninstall, cleanup) on the owner's real agent profiles. The renderer asks
// with a kind and a preview id only; main asks the service for the offer, checks it against the ask and shows a native
// warning dialog (Cancel first and default; every value quoted with the grants escaping, never cut: an offer over the budget
// is refused); only the apply button sends applyConfirm, with the offer's binding, not within 750 ms of the dialog opening,
// and only while that flow is still the current one. One flow at a time. A restart or a lost reply after the confirm answers
// unknown (the apply may have run: reread). No Electron import.
import { IPC_VERSION, type ApplyAsk, type ApplyKind, type ApplyLabel, type ApplyOffer, type ApplyOutcome, type ServiceCommand, type ServiceEvent } from '../shared/ipc.ts';
import { q, type GrantDialog } from './grants.ts';

export const EDITS = "Xaibo will change this agent's own configuration files.";
const CLEANUP = "Xaibo removes only its own records and backups; the agent's files are not changed.";
const OFFER_MS = 10_000;
const CONFIRM_MS = 60_000; // under the operation lock; the settings routes run no CLI
const DETAIL_MAX = 6_000;
const CLICK_MS = 750; // as grants: a click this soon after the dialog opened counts as Cancel
const LABEL: Record<ApplyLabel, string> = {
  agent: 'Agent', profile: 'Profile ID', folder: 'Profile folder', scope: 'Scope', file: 'File', change: 'Change', value: 'Sets', retention: 'Retention',
  tee: 'Statusline tee', helper: 'Hook command', entries: 'Entries', 'real-entries': 'Entries on real profiles', records: 'Records removed',
  backups: 'Backups removed', manual: 'Left for you to remove',
};
const TEXT: Record<ApplyKind, { title: string; question: string; button: string }> = {
  connect: { title: 'Connect a real profile', question: 'Apply these configuration changes to a real agent profile?', button: 'Apply' },
  removal: { title: 'Disconnect a real profile', question: "Revert Xaibo's changes in a real agent profile?", button: 'Disconnect' },
  cleanup: { title: 'Clean up records', question: "Remove Xaibo's records of changes that were already removed outside Xaibo?", button: 'Clean up' },
};

/** The native confirmation for an offer; null when its escaped detail is over the budget (refused, never cut). */
export function applyDialog(o: ApplyOffer): GrantDialog | null {
  const t = TEXT[o.kind], last = o.kind === 'cleanup' ? CLEANUP : EDITS;
  const detail = [...o.items.map(([l, v]) => `${LABEL[l]}: ${q(v)}`), '', last].join('\n');
  if (detail.length > DETAIL_MAX) return null;
  return { type: 'warning', title: t.title, message: `${t.question}\n\n${last}`, detail, buttons: ['Cancel', t.button], defaultId: 0, cancelId: 0, noLink: true };
}

export interface ApplyDeps {
  /** The native message box; true only for the apply button. */
  confirm(d: GrantDialog): Promise<boolean>;
  send(c: ServiceCommand): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  /** A monotonic clock (ms). */
  now(): number;
}
type ApplyEvent = Extract<ServiceEvent, { type: 'apply' }>;
interface Wait { id: number; phase: 'offer' | 'confirm'; timer: unknown; resolve(r: ApplyEvent['result'] | null): void }
interface Flow { done: boolean; wait: Wait | null; finish(o: ApplyOutcome): void }
const refused = (code: Extract<ApplyOutcome, { status: 'refused' }>['code']): ApplyOutcome => ({ status: 'refused', code });

export function applyFlow(d: ApplyDeps) {
  let current: Flow | null = null;
  let nextId = 0; // never reset, so a reply meant for an earlier flow or service can never match
  const release = (f: Flow, r: ApplyEvent['result'] | null) => {
    const w = f.wait;
    if (!w) return;
    f.wait = null;
    d.clearTimer(w.timer);
    w.resolve(r);
  };
  const request = (f: Flow, phase: Wait['phase'], cmd: (id: number) => ServiceCommand) => new Promise<ApplyEvent['result'] | null>((resolve) => {
    const id = ++nextId;
    f.wait = { id, phase, resolve, timer: d.setTimer(() => release(f, null), phase === 'offer' ? OFFER_MS : CONFIRM_MS) };
    d.send(cmd(id));
  });
  const run = async (f: Flow, a: ApplyAsk): Promise<ApplyOutcome> => {
    const r = await request(f, 'offer', (id) => ({ v: IPC_VERSION, type: 'applyOffer', id, ask: a }));
    if (r === null) return refused('unavailable');
    if (r.status === 'refused') return r;
    if (r.status !== 'offer') return refused('failed');
    const o = r.offer;
    if (o.kind !== a.kind || o.previewId !== a.previewId) return refused('failed');
    const dialog = applyDialog(o);
    if (!dialog) return refused('oversize');
    const opened = d.now();
    const yes = await d.confirm(dialog);
    if (f.done || current !== f) return refused('unavailable'); // settled while the dialog was open: send nothing
    if (!yes || d.now() - opened < CLICK_MS) return { status: 'cancelled' };
    const c = await request(f, 'confirm', (cid) => ({ v: IPC_VERSION, type: 'applyConfirm', id: cid, ask: a, binding: o.binding }));
    if (c === null) return refused(f.done ? 'unavailable' : 'unknown');
    if (c.status === 'done' && c.kind !== a.kind) return refused('failed'); // code review 2: the reply of the kind asked
    return c.status === 'done' || c.status === 'refused' ? c : refused('failed');
  };
  return {
    /** One flow at a time, taken before any await; settles exactly once. */
    ask(a: ApplyAsk): Promise<ApplyOutcome> {
      if (current) return Promise.resolve(refused('busy'));
      return new Promise<ApplyOutcome>((resolve) => {
        const f: Flow = { done: false, wait: null, finish: (o) => {
          if (f.done) return;
          f.done = true;
          if (current === f) current = null;
          release(f, null);
          resolve(o);
        } };
        current = f;
        run(f, a).then(f.finish, () => f.finish(refused('failed')));
      });
    },
    /** An apply event from the service: only the pending request's id, and only a result its phase expects. */
    receive(ev: ApplyEvent): void {
      const w = current?.wait;
      if (!current || !w || ev.id !== w.id) return;
      const s = ev.result.status;
      if (s === 'refused' || (w.phase === 'offer' ? s === 'offer' : s === 'done')) release(current, ev.result);
    },
    /** The service (re)started: unavailable, or unknown once the confirm was sent (the apply may have run). */
    reset(): void { current?.finish(refused(current.wait?.phase === 'confirm' ? 'unknown' : 'unavailable')); },
  };
}
