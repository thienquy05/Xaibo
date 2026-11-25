// XAIBO-PROD-584 (P6-T10a unit 3; design .handoff/p6-t10a-design.md section 2, review R8, D-P6-17): the sign-in fieldset model,
// shared by the Agent Map integration panel and Settings. The owner either uses agent evidence or declares a method (explicit
// Unknown is a declaration; clear returns to evidence); Save, Clear declaration and Declare account change send one command each,
// with the revision the view was loaded at, and nothing when nothing changes. A stale reply installs the latest view and keeps
// the draft until the owner reviews it; a failed or lost reply keeps the draft and asks for a reread (the revision check makes a
// repeat harmless, so nothing is retried automatically). A profile switch drops the draft and any old reply. No times, paths
// or sources are ever sent; rendering is SignInFieldset.tsx.
import type { SignInMethod, SignInReplyCode, SignInView } from '../../shared/ipc.ts';
import { formatTime } from '../model.ts';

export const METHOD_TEXT: Record<SignInMethod, string> = {
  subscription: 'Subscription', 'api-key': 'API key', 'cloud-provider': 'Cloud provider', gateway: 'Gateway', mixed: 'Mixed', unknown: 'Unknown',
};
export type Mode = 'evidence' | 'declaration';
export interface Draft { mode: Mode; method: SignInMethod }
/** The three mutations (review L8: written out; a read is not a command). */
type Command = { op: 'set'; method: SignInMethod; expectedRevision: number } | { op: 'clear' | 'account-change'; expectedRevision: number };
type Op = Command['op'];

/** A sign-in request body: the read or one mutation (client.signIn, the fieldset's api). */
export type SignInCommand = { op: 'read' } | Command;

export const draftOf = (v: SignInView): Draft => (v.declaration ? { mode: 'declaration', method: v.declaration.method } : { mode: 'evidence', method: v.method });

/** The command an action sends now, or null when it would change nothing. */
export function commandOf(v: SignInView, d: Draft, action: 'save' | 'clear' | 'account-change'): Command | null {
  const expectedRevision = v.revision;
  if (action === 'account-change') return { op: 'account-change', expectedRevision };
  if (action === 'clear' || d.mode === 'evidence') return v.declaration ? { op: 'clear', expectedRevision } : null;
  return v.declaration?.method === d.method ? null : { op: 'set', method: d.method, expectedRevision };
}

export interface SignInState {
  profileId: string | null; view: SignInView | null; load: 'idle' | 'loading' | 'ready' | 'failed';
  draft: Draft | null; dirty: boolean;
  /** A newer revision arrived under an edit (or a stale reply): the owner reviews it before another Save. */
  review: boolean;
  writable: boolean;
  seq: number; pending: { seq: number; command: Command } | null;
  text: string;
  /** Changes when the component should read the profile again (a failed or lost reply). */
  reload: number;
}
export type SignInEvent =
  | { type: 'select'; profileId: string | null }
  /** A read's reply (review L4: its code counts too). */
  | { type: 'loaded'; profileId: string; code: SignInReplyCode; view: SignInView | null }
  | { type: 'edit'; draft: Draft }
  | { type: 'save' } | { type: 'clear' } | { type: 'account' } | { type: 'review' } | { type: 'discard' }
  | { type: 'replied'; seq: number; code: SignInReplyCode; view: SignInView | null }
  | { type: 'lost'; seq: number };

export const initialSignIn: SignInState = { profileId: null, view: null, load: 'idle', draft: null, dirty: false, review: false, writable: true, seq: 0, pending: null, text: '', reload: 0 };

const same = (a: Draft, b: Draft) => a.mode === b.mode && (a.mode === 'evidence' || a.method === b.method);
/** Review M2/M3: install a view: never an older revision; a clean draft follows it (no review needed), an edited one is kept. */
const install = (s: SignInState, v: SignInView, reviewIfNewer: boolean): SignInState => {
  if (s.view && v.revision < s.view.revision) return s;
  if (!s.dirty) return { ...s, view: v, draft: draftOf(v), review: false };
  const newer = s.view !== null && v.revision !== s.view.revision;
  return { ...s, view: v, review: s.review || (reviewIfNewer && newer) };
};

export function signInReducer(s: SignInState, e: SignInEvent): SignInState {
  switch (e.type) {
    case 'select': // the seq carries on, so an old profile's reply can never match a new pending command
      if (e.profileId === s.profileId && s.load !== 'idle') return s; // review L7: the same profile keeps its pending command
      return { ...initialSignIn, seq: s.seq, reload: s.reload, profileId: e.profileId, load: e.profileId === null ? 'idle' : 'loading' };
    case 'loaded': {
      if (e.profileId !== s.profileId) return s;
      if (!e.view || e.code !== 'ok') return { ...s, load: 'failed', writable: s.writable && e.code !== 'profile-not-found', text: replyText(e.code === 'ok' ? 'unavailable' : e.code, 'set') };
      if (s.view && e.view.revision < s.view.revision) return s; // review M3: an older read changes nothing
      const n = install({ ...s, load: 'ready' }, e.view, true);
      return { ...n, text: n.review && !s.review ? replyText('stale', 'set') : n.review ? s.text : '' }; // review L5
    }
    case 'edit': return s.pending || !s.view ? s : { ...s, draft: e.draft, dirty: !same(e.draft, draftOf(s.view)), text: '' }; // review M1
    case 'discard': return s.pending || !s.view ? s : { ...s, draft: draftOf(s.view), dirty: false, review: false, text: '' };
    case 'review': return { ...s, review: false, text: '' };
    case 'save': case 'clear': case 'account': {
      if (s.pending || !s.view || !s.draft || !s.writable || s.profileId === null) return s;
      if (e.type === 'account' && s.dirty) return { ...s, text: 'Save or discard the declaration edit first.' };
      if (e.type !== 'account' && s.review) return { ...s, text: 'Review the latest declaration before saving.' };
      const command = commandOf(s.view, s.draft, e.type === 'account' ? 'account-change' : e.type);
      if (!command) return { ...s, text: e.type === 'clear' ? 'No declaration to clear.' : 'No change to save.' };
      const seq = s.seq + 1;
      return { ...s, seq, pending: { seq, command }, text: 'Saving…' };
    }
    case 'replied': {
      if (!s.pending || e.seq !== s.pending.seq) return s;
      const op = s.pending.command.op, base = { ...s, pending: null, text: replyText(e.code, op) };
      switch (e.code) {
        case 'ok': return e.view ? { ...base, view: e.view, draft: draftOf(e.view), dirty: false, review: false } : { ...base, reload: s.reload + 1 };
        case 'stale': return e.view ? { ...install(base, e.view, false), text: base.text, review: base.dirty } : { ...base, reload: s.reload + 1 }; // M2: a clean draft follows
        case 'limit': return e.view ? { ...install(base, e.view, false), text: base.text } : base;
        case 'profile-not-found': return { ...base, writable: false };
        case 'failed': case 'unavailable': return { ...base, reload: s.reload + 1 }; // unit 4a review L7: its words promise a reread
        default: return base;
      }
    }
    case 'lost': return s.pending && e.seq === s.pending.seq ? { ...s, pending: null, reload: s.reload + 1, text: replyText('failed', s.pending.command.op) } : s;
  }
}

/** Review L8: the command to send now, once per seq (`sent` = the last seq sent), as retention-view's toSend. */
export const toSend = (s: SignInState, sent: number) => (s.pending && s.pending.seq !== sent ? s.pending : null);

/** Fixed words per reply code; never an echo of input or an error message. */
export function replyText(code: SignInReplyCode, op: Op): string {
  switch (code) {
    case 'ok': return op === 'account-change' ? 'Account change declared; usage epoch updated.' : op === 'clear' ? 'Declaration cleared; using agent evidence.' : 'Declaration saved.';
    case 'stale': return 'This profile changed elsewhere. Review the latest declaration before saving.';
    case 'profile-not-found': return 'This profile is no longer available. Choose another profile.';
    case 'limit': return 'Sign-in changes are currently limited. No change was applied.';
    case 'read-only': return 'Sign-in changes are unavailable while the store is read-only.';
    case 'unavailable': return 'Sign-in state is unavailable. Retry loading this profile.';
    case 'failed': return 'The result could not be confirmed. Reload this profile before trying again.';
  }
}

const SOURCE: Record<NonNullable<SignInView['evidence']>['source'], string> = {
  'claude-statusline': 'Claude status line', 'claude-transcript': 'Claude transcript', 'codex-rollout': 'Codex rollout', 'agy-transcript': 'Antigravity transcript',
};
/** What the fieldset says about the method: the effective one, the owner's declaration and the agent evidence (both when they
 *  disagree), ambiguous evidence, and the current usage epoch. */
export function provenanceLines(v: SignInView): string[] {
  const out = [`Sign-in method: ${METHOD_TEXT[v.method]}`];
  if (v.declaration) out.push(`Owner declaration: ${METHOD_TEXT[v.declaration.method]} · declared ${formatTime(v.declaration.at)}`);
  if (v.outputStatus === 'ambiguous') out.push('Agent evidence is ambiguous; it is not used.');
  else if (v.evidence) {
    const e = v.evidence, claude = e.source.startsWith('claude-');
    out.push(`Agent evidence: ${METHOD_TEXT[e.method]} · ${SOURCE[e.source]} · ${claude ? 'source time unknown; ' : ''}observed ${formatTime(e.observedAt)}`);
  } else out.push('No sign-in evidence from agent output.');
  if (v.conflict) out.push('Using owner declaration. Agent evidence disagrees.');
  if (v.generation > 0 && v.boundary) out.push(`Usage epoch ${v.generation} since ${formatTime(v.boundary.at)} (${v.boundary.reason === 'method' ? 'sign-in method change' : 'declared account change'})`);
  return out;
}
