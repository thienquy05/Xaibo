// XAIBO-PROD-585 (P6-T10a unit 4a; design §6.5.2 "Sign-in fieldset", §5.1, .handoff/p6-t10a-design.md sections 2-3, D-P6-17):
// the sign-in method fieldset, shared by the Agent Map integration panel and (unit 4b) Settings, over the model in
// sign-in-view.ts. The owner uses agent evidence or declares a method; Save declaration, Clear declaration and Declare account
// change each send one revision-checked command (toSend: once per seq); the service's answer is what shows. Reads on mount,
// after a failed, lost or unavailable reply, and when the service comes back; writes need a successful read and a live
// service. A button that disappears hands focus to Save declaration; a refused or unconfirmed write focuses the status line.
// No credential or account input exists.
import { useEffect, useReducer, useRef } from 'react';
import { SIGN_IN_METHODS, type SignInMethod, type SignInReplyCode, type SignInView } from '../../shared/ipc.ts';
import { visible } from '../text.ts';
import { initialSignIn, METHOD_TEXT, provenanceLines, signInReducer, toSend, type SignInCommand } from './sign-in-view.ts';

export type SignInApi = (profileId: string, command: SignInCommand) => Promise<{ code: SignInReplyCode; view: SignInView | null }>;

export function SignInFieldset({ profileId, api, live }: { profileId: string; api: SignInApi; live: boolean }) {
  const [s, dispatch] = useReducer(signInReducer, initialSignIn);
  const sent = useRef(0), save = useRef<HTMLButtonElement>(null), status = useRef<HTMLParagraphElement>(null);
  const focusAfter = useRef<'save' | 'status' | null>(null);
  const read = (pid: string) => api(pid, { op: 'read' }).then((r) => dispatch({ type: 'loaded', profileId: pid, code: r.code, view: r.view }),
    () => dispatch({ type: 'loaded', profileId: pid, code: 'unavailable', view: null }));
  useEffect(() => { dispatch({ type: 'select', profileId }); void read(profileId); }, [profileId]);
  useEffect(() => { if (s.reload) void read(profileId); }, [s.reload]);
  const wasLive = useRef(live);
  useEffect(() => { // unit 4a review L4: the service is back: read again (a read lost with the old connection left "unavailable")
    if (live && !wasLive.current && !s.pending) void read(profileId);
    wasLive.current = live;
  }, [live]);
  useEffect(() => {
    const p = toSend(s, sent.current);
    if (!p || !s.profileId) return;
    sent.current = p.seq;
    api(s.profileId, p.command).then((r) => { focusAfter.current = r.code === 'ok' ? focusAfter.current : 'status'; dispatch({ type: 'replied', seq: p.seq, code: r.code, view: r.view }); },
      () => { focusAfter.current = 'status'; dispatch({ type: 'lost', seq: p.seq }); });
  }, [s.pending]);
  useEffect(() => { // unit 4a review M3: never leave focus on a button that just went away
    const want = focusAfter.current;
    if (!want || s.pending) return;
    focusAfter.current = null;
    if (want === 'status') status.current?.focus();
    else if (!document.activeElement || document.activeElement === document.body) save.current?.focus();
  }, [s.pending, s.dirty, s.review, s.load, s.view]);
  const busy = s.pending !== null || !live || !s.writable || s.load !== 'ready'; // review M2: a write needs a successful read
  const write = (type: 'save' | 'clear' | 'account') => { if (busy) return; focusAfter.current = 'save'; dispatch({ type }); };
  const local = (type: 'review' | 'discard') => { focusAfter.current = 'save'; dispatch({ type }); }; // review L6: offline too
  const name = `sign-in-mode-${profileId}`, hint = `sign-in-account-${profileId}`, why = `sign-in-method-${profileId}`, d = s.draft, v = s.view;
  const frozen = s.pending !== null; // review L5: nothing changes under a pending write
  return (
    <fieldset className="x-radios">
      <legend>Sign-in method</legend>
      {v ? <ul className="x-integration-list">{provenanceLines(v).map((l, i) => <li key={i}>{visible(l)}</li>)}</ul>
        : s.load === 'failed' ? null : <p className="x-hint">Loading sign-in method…</p>}
      {v && d ? (
        <>
          <label className="x-radio"><input type="radio" name={name} checked={d.mode === 'evidence'} disabled={frozen} onChange={() => dispatch({ type: 'edit', draft: { ...d, mode: 'evidence' } })} />Use agent evidence</label>
          <label className="x-radio"><input type="radio" name={name} checked={d.mode === 'declaration'} disabled={frozen} onChange={() => dispatch({ type: 'edit', draft: { ...d, mode: 'declaration' } })} />Owner declaration</label>
          <label className="x-field">Declared method
            <select value={d.method} disabled={frozen || d.mode === 'evidence'} aria-describedby={d.mode === 'evidence' ? why : undefined}
              onChange={(e) => dispatch({ type: 'edit', draft: { mode: 'declaration', method: e.target.value as SignInMethod } })}>
              {SIGN_IN_METHODS.map((m) => <option key={m} value={m}>{METHOD_TEXT[m]}</option>)}
            </select>
          </label>
          {d.mode === 'evidence' ? <p id={why} className="x-hint">Choose Owner declaration to pick a method.</p> : null}
          <div className="x-integration-actions">
            <button ref={save} type="button" className="x-btn x-btn-primary" aria-disabled={busy || undefined} onClick={() => write('save')}>Save declaration</button>
            {s.dirty ? <button type="button" className="x-btn x-btn-quiet" aria-disabled={frozen || undefined} onClick={() => { if (!frozen) local('discard'); }}>Discard edit</button> : null}
            {v.declaration ? <button type="button" className="x-btn x-btn-secondary" aria-disabled={busy || undefined} onClick={() => write('clear')}>Clear declaration</button> : null}
            {s.review ? <button type="button" className="x-btn x-btn-secondary" onClick={() => local('review')}>Review latest declaration</button> : null}
          </div>
          <div className="x-receipt-test">
            <button type="button" className="x-btn x-btn-secondary" aria-describedby={hint} aria-disabled={busy || undefined} onClick={() => write('account')}>Declare account change</button>
            <p id={hint} className="x-hint">Starts a new usage epoch for this profile. This does not sign the agent in or verify an account.</p>
          </div>
          {!live ? <p className="x-hint">Changes are off until the service is back.</p> : null}
        </>
      ) : null}
      {s.load === 'failed' ? <p><button type="button" className="x-btn x-btn-quiet" onClick={() => { focusAfter.current = 'save'; void read(profileId); }}>Retry</button></p> : null}
      <p ref={status} tabIndex={-1} className="x-hint" aria-live="polite">{visible(s.text)}</p>
    </fieldset>
  );
}
