// XAIBO-PROD-598 (P6-T08a slice C; D-P6-20, SEC5): the grants fieldset, shared by the Add agent wizard (Profile and grants)
// and the integration panel, for imported agents only (the caller renders it when the detail's grants are not null), with or
// without a profile. Over grants-view.ts: one row per declared item with its state; Approve root, Grant probe and Grant setup
// ask main (ids only), which shows its native confirmation; Revoke sends ids over the port. One action at a time; the outcome
// is announced, the detail is read again (onChanged), then focus returns to the same row's first control (its replacement),
// or the status line. Grants wait with an adjacent reason while no folder is allowed or approved, or the service is gone.
import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import type { GrantAsk, GrantOutcome, GrantState, RevokeResult, RevokeTarget } from '../../shared/ipc.ts';
import { visible } from '../text.ts';
import { grantRows, grantsNote, outcomeText, revokeText } from './grants-view.ts';

export interface GrantApi { grant(a: GrantAsk): Promise<GrantOutcome>; revoke(agent: string, t: RevokeTarget): Promise<RevokeResult> }

export function GrantsFieldset({ agent, grants, live, api, onChanged }: {
  agent: string; grants: GrantState | 'unavailable'; live: boolean; api: GrantApi;
  /** Reads the detail (and what depends on it) again; resolves once that read settled. */
  onChanged: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLFieldSetElement>(null), status = useRef<HTMLParagraphElement>(null), focusRow = useRef<string | null>(null);
  const id = useId();
  // after an action: the row's first control (its replacement once a reread swaps it), else the status line; kept while focus
  // stays on that row, so a later reread (the panel moving to a newly listed profile) still lands on the new control
  useEffect(() => {
    const k = focusRow.current;
    if (!k || pending) return;
    const active = document.activeElement;
    if (active && active !== document.body && !box.current?.contains(active)) { focusRow.current = null; return; } // moved on
    const to = box.current?.querySelector<HTMLButtonElement>(`[data-grant-row="${CSS.escape(k)}"] button`) ?? status.current;
    if (to && active !== to) to.focus();
  }, [pending, grants]);
  const away = (e: FocusEvent) => { if (focusRow.current && e.target !== status.current && !(e.target as Element).closest(`[data-grant-row="${CSS.escape(focusRow.current)}"]`)) focusRow.current = null; };
  const run = (key: string, act: () => Promise<string>) => {
    if (pending || !live) return;
    setPending(true);
    setNote(null);
    void act().then((said) => { setNote(said); return onChanged(); }).catch(() => undefined).finally(() => { focusRow.current = key; setPending(false); });
  };
  const off = pending || !live;
  const all = grants === 'unavailable' ? null : grantsNote(grants);
  return (
    <fieldset ref={box} className="x-radios" aria-busy={pending || undefined} onFocus={away}>
      <legend>Grants</legend>
      {grants === 'unavailable' ? <p className="x-hint">Grant state is unavailable.</p> : (
        <>
          {all ? <p id={`${id}-all`} className="x-hint">{all}</p> : null}
          <ul className="x-integration-list">
            {grantRows(agent, grants).map((r) => {
              const why = r.grant?.disabled && r.grant.disabled !== all ? `${id}-${r.key}` : undefined;
              const g = r.grant, t = r.revoke;
              return (
                <li key={r.key} data-grant-row={r.key}>
                  {visible(r.label)}: {r.state}
                  {g || t ? (
                    <div className="x-integration-actions">
                      {g ? <button type="button" className="x-btn x-btn-secondary" aria-disabled={off || g.disabled !== null || undefined} aria-describedby={why ?? (g.disabled ? `${id}-all` : undefined)}
                        onClick={() => { if (!g.disabled) run(r.key, () => api.grant(g.ask).then((o) => outcomeText(g.ask.action, o))); }}>{g.label}</button> : null}
                      {t ? <button type="button" className="x-btn x-btn-quiet" aria-disabled={off || undefined}
                        onClick={() => run(r.key, () => api.revoke(agent, t).then(revokeText, () => 'No reply came; the state below was read again.'))}>Revoke</button> : null}
                    </div>
                  ) : null}
                  {why ? <p id={why} className="x-hint">{g!.disabled}</p> : null}
                </li>
              );
            })}
          </ul>
          {!live ? <p className="x-hint">Grant changes are off until the service is back.</p> : null}
        </>
      )}
      <p ref={status} tabIndex={-1} className="x-hint" aria-live="polite">{note ?? ''}</p>
    </fieldset>
  );
}
