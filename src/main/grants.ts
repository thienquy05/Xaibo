// XAIBO-PROD-597 (P6-T08a slice B; D-P6-20, SEC5; security review H1-H4, M6-M9, L13): main's grant confirmation. The renderer
// asks with ids only; main picks a probe's executable (resolving its real path), asks the service for the offer, checks it
// against the request and shows a native warning dialog (Cancel first and default) with the not-a-sandbox sentence in the
// message and at the end of the detail; only the grant button sends grantConfirm, with the offer's binding, and only while
// that flow is still the current one (a restart or a lost reply settles it; the open dialog cannot be dismissed). One flow at
// a time. Untrusted strings are JSON-quoted with every control, format, separator, private-use, unassigned and odd space
// character shown as a code point, never truncated: an offer over the size budget is refused. No Electron import.
import { IPC_VERSION, type GrantAsk, type GrantOffer, type GrantOutcome, type GrantRequest, type ServiceCommand, type ServiceEvent } from '../shared/ipc.ts';

export const SANDBOX = 'The granted program runs with your access. This grant is not a sandbox.';
const OFFER_MS = 10_000;
const CONFIRM_MS = 30_000; // the service refreshes detection before it replies
const DETAIL_MAX = 6_000;
const CLICK_MS = 750; // code review L: a grant click this soon after the dialog opened counts as Cancel (clickjacking)
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u{a0}\u{1680}\u{2000}-\u{200a}\u{202f}\u{205f}\u{3000}\u{115f}\u{1160}\u{3164}\u{ffa0}\u{2800}]/gu;
export const q = (s: string) => JSON.stringify(s).replace(UNSAFE, (c) => '\\u{' + c.codePointAt(0)!.toString(16).toUpperCase() + '}');

export interface GrantDialog { type: 'warning'; title: string; message: string; detail: string; buttons: [string, string]; defaultId: 0; cancelId: 0; noLink: true }
const TEXT = {
  root: { title: 'Approve profile root', question: "Allow Xaibo to use this imported agent's profile folder?", button: 'Approve root' },
  probe: { title: 'Grant executable probe', question: 'Allow Xaibo to run this executable for version detection?', button: 'Grant probe' },
  setup: { title: 'Grant setup writes', question: "Allow this imported agent's declared configuration changes?", button: 'Grant setup' },
} as const;

/** The native confirmation for an offer; null when its escaped detail is over the budget (refused, never cut). */
export function grantDialog(o: GrantOffer): GrantDialog | null {
  const t = TEXT[o.action];
  const body = o.action === 'root' ? [`Root ID: ${o.id ?? ''}`, `Folder: ${q(o.path)}`, '', 'Approves this folder only. Executable probing and setup writes need separate grants.']
    : o.action === 'probe' ? [`Binary ID: ${o.id ?? ''}`, `Executable: ${q(o.path)}`, `In approved folder: ${q(o.root)}`, `Command: [${(o.argv ?? []).map(q).join(',')}]`, '',
      'Allows bounded version probes during detection and rescans. Grants no setup writes or launch permission.']
    : [`File: ${q(o.path)}`, 'Changes:', ...(o.ops ?? []).map((x) => `  ${q(x.pointer)} = ${q(x.value)}`), '',
      'Allows only these declared changes. Connect still shows its configuration diff and needs Apply. Nothing changes now.'];
  const detail = [`Entry: ${q(o.name)}`, `Agent ID: ${o.agent}`, ...body, '', SANDBOX].join('\n');
  if (detail.length > DETAIL_MAX) return null;
  return { type: 'warning', title: t.title, message: `${t.question}\n\n${SANDBOX}`, detail, buttons: ['Cancel', t.button], defaultId: 0, cancelId: 0, noLink: true };
}

export interface GrantDeps {
  /** The native open dialog; null when cancelled. */
  pickExecutable(): Promise<string | null>;
  /** The picked file's real path (throws when it cannot be resolved). */
  realpath(p: string): string;
  /** The native message box; true only for the grant button. */
  confirm(d: GrantDialog): Promise<boolean>;
  send(c: ServiceCommand): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
  /** A monotonic clock (ms). */
  now(): number;
}
type GrantEvent = Extract<ServiceEvent, { type: 'grant' }>;
interface Wait { id: number; phase: 'offer' | 'confirm'; timer: unknown; resolve(r: GrantEvent['result'] | null): void }
interface Flow { done: boolean; wait: Wait | null; finish(o: GrantOutcome): void }
const refused = (code: Extract<GrantOutcome, { status: 'refused' }>['code']): GrantOutcome => ({ status: 'refused', code });

export function grantFlow(d: GrantDeps) {
  let current: Flow | null = null;
  let nextId = 0; // never reset, so a reply meant for an earlier flow or service can never match
  const release = (f: Flow, r: GrantEvent['result'] | null) => {
    const w = f.wait;
    if (!w) return;
    f.wait = null;
    d.clearTimer(w.timer);
    w.resolve(r);
  };
  /** Sends one command and waits for its event; null when no reply came in time or the flow was settled. */
  const request = (f: Flow, phase: Wait['phase'], cmd: (id: number) => ServiceCommand) => new Promise<GrantEvent['result'] | null>((resolve) => {
    const id = ++nextId;
    f.wait = { id, phase, resolve, timer: d.setTimer(() => release(f, null), phase === 'offer' ? OFFER_MS : CONFIRM_MS) };
    d.send(cmd(id));
  });
  const run = async (f: Flow, a: GrantAsk): Promise<GrantOutcome> => {
    // ponytail (code review nit): a probe's picker opens before the service has checked the agent, binary and root, so a
    // pick can end in not-found or root-not-approved; add a pre-offer if that confuses owners.
    let req: GrantRequest;
    if (a.action === 'probe') {
      const picked = await d.pickExecutable();
      if (!picked) return { status: 'cancelled' };
      let file: string;
      try { file = d.realpath(picked); } catch { return refused('executable-invalid'); }
      req = { ...a, file };
    } else req = a;
    if (f.done) return refused('unavailable');
    const r = await request(f, 'offer', (id) => ({ v: IPC_VERSION, type: 'grantOffer', id, request: req }));
    if (r === null) return refused('unavailable');
    if (r.status === 'refused') return refused(r.code);
    if (r.status !== 'offer') return refused('failed');
    const o = r.offer, id = a.action === 'root' ? a.root : a.action === 'probe' ? a.binary : null;
    if (o.action !== a.action || o.agent !== a.agent || o.id !== id || (req.action === 'probe' && o.path !== req.file)) return refused('failed');
    const dialog = grantDialog(o);
    if (!dialog) return refused('oversize');
    const opened = d.now();
    const yes = await d.confirm(dialog);
    if (f.done || current !== f) return refused('unavailable'); // review H1: settled while the dialog was open: send nothing
    if (!yes || d.now() - opened < CLICK_MS) return { status: 'cancelled' };
    const c = await request(f, 'confirm', (cid) => ({ v: IPC_VERSION, type: 'grantConfirm', id: cid, request: req, binding: o.binding }));
    if (c === null) return refused(f.done ? 'unavailable' : 'unknown');
    return c.status === 'granted' ? { status: 'granted' } : c.status === 'refused' ? refused(c.code) : refused('failed');
  };
  return {
    /** One flow at a time, taken before any await (review H2); settles exactly once. */
    ask(a: GrantAsk): Promise<GrantOutcome> {
      if (current) return Promise.resolve(refused('busy'));
      return new Promise<GrantOutcome>((resolve) => {
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
    /** A grant event from the service: only the pending request's id, and only a result its phase expects (review M6). */
    receive(ev: GrantEvent): void {
      const w = current?.wait;
      if (!current || !w || ev.id !== w.id) return;
      const s = ev.result.status;
      if (s === 'refused' || (w.phase === 'offer' ? s === 'offer' : s === 'granted')) release(current, ev.result);
    },
    /** The service (re)started: a pending flow answers unavailable, or unknown once its confirm was sent (code review M: the
     *  grant may be on disk); its late replies are ignored. */
    reset(): void { current?.finish(refused(current.wait?.phase === 'confirm' ? 'unknown' : 'unavailable')); },
  };
}
