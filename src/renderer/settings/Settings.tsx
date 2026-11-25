// XAIBO-PROD-525 (P5-T16; design §6.6, §5.1 dialog transactions, §5.4, FR-52, Q-5.8): the Settings area. Only its Usage
// history section exists so far (the other §6.6 sections arrive with P5-T18): Clear usage history behind a modal
// confirmation (initial focus on Cancel). While the clear runs the dialog says Applying changes… and cannot be dismissed;
// a failure or an unknown outcome stays in the dialog with Close. Cancel, Close and success return focus to the Clear
// usage history button; success is announced next to it (the health band keeps the only status role). A read-only store
// disables the button and says why.
// XAIBO-PROD-528 (P5-T18 part 2; design §6.6, §5.1; look D-P5-09): Session retention, Trash and Storage come before Usage
// history. Retention errors show on blur or Save (never on first focus), are tied to the field through aria-describedby
// with a matching aria-invalid, and are never clamped; a failed Save focuses the invalid field. Storage is passive service
// data (one measurement per 60 s at most in the service) and never shows a disk capacity.
import { useEffect, useId, useReducer, useRef, useState } from 'react';
import type { ClearUsageResult, PriceCheck, PriceOp, PriceView, RetentionSetting, RevealResult, SaveRetentionResult, StartupReply, StartupRequest, StorageReport } from '../../shared/ipc.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { APPLYING, RESULT_UNAVAILABLE } from '../model.ts';
import { asOfText, checkText, fallbackRows, reloadText, revealText, sourceText } from './prices-view.ts';
import { canSave, startupText } from './startup-view.ts';
import { initialRetention, lastRunText, measureStorage, retentionReducer, saveText, storageView, storageWhen, toSend, type Draft, type RetentionState, type StorageRow } from './retention-view.ts';

export interface SettingsApi {
  clearUsage(): Promise<ClearUsageResult>;
  retention(): Promise<{ setting: RetentionSetting | null; lastRunAt: number | null }>;
  setRetention(value: RetentionSetting): Promise<SaveRetentionResult>;
  storage(refresh: boolean): Promise<{ report: StorageReport | null; failed: boolean }>;
  /** XAIBO-PROD-568 (P6-T11): Local prices; reveal asks main to select the override file in Finder. */
  prices(op: PriceOp): Promise<{ view: PriceView | null; check: PriceCheck | null }>;
  reveal(): Promise<RevealResult>;
  /** XAIBO-PROD-569: Start at login through main; null = no answer or a malformed one. */
  startup(request: StartupRequest): Promise<StartupReply | null>;
}
type Phase = 'applying' | ClearUsageResult | 'unavailable' | null;

export function clearStatusText(p: Phase): string {
  switch (p) {
    case null: return '';
    case 'applying': return APPLYING;
    case 'cleared': return 'Usage history cleared. Usage observed from now on will appear.';
    case 'read-only': return 'Usage history was not cleared: the store is read-only.';
    case 'failed': return 'Usage history was not cleared. Nothing was changed.';
    case 'unavailable': return RESULT_UNAVAILABLE;
  }
}

/** Review M4: where a result is shown. Success closes the dialog and is announced next to the button; any other result
 *  stays in the dialog while it is open, or goes next to the button when the dialog was already closed (Chromium closes
 *  a dialog on a second Escape without a cancel event, even while applying). */
export function routeResult(r: Exclude<Phase, 'applying' | null>, dialogOpen: boolean): { close: boolean; dialog: Phase; section: Phase } {
  if (r === 'cleared') return { close: dialogOpen, dialog: null, section: 'cleared' };
  return dialogOpen ? { close: false, dialog: r, section: null } : { close: false, dialog: null, section: r };
}

export function Settings({ api, readOnly }: { api: SettingsApi; readOnly: boolean }) {
  const [phase, setPhase] = useState<Phase>(null); // the dialog's transaction
  const [section, setSection] = useState<Phase>(null); // the announcement next to the button
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { dialog.current?.close(); setPhase(null); trigger.current?.focus(); };
  const applying = useRef(false); // a request is in flight (read by the close event, which may outrun a render)
  const show = (r: Exclude<Phase, 'applying' | null>) => {
    applying.current = false;
    const to = routeResult(r, dialog.current?.open === true);
    if (to.close) close();
    setPhase(to.dialog);
    setSection(to.section);
  };
  const confirm = () => {
    applying.current = true;
    setPhase('applying');
    setSection(null);
    api.clearUsage().then(show, () => show('unavailable'));
  };
  const open = () => { setSection(null); setPhase(null); dialog.current?.showModal(); };
  // a close we did not ask for while applying: the button takes focus and the section carries the transaction
  const closed = () => { if (applying.current) { setPhase(null); setSection('applying'); trigger.current?.focus(); } };
  // ponytail: Clear usage history can be confirmed again after an unknown outcome; a second clear is the same request
  // (it also clears what was observed in between, which the confirmation says). Reconcile first if that ever matters.
  return (
    <div className="x-settings">
      <h1 id="settings-heading" tabIndex={-1}>Settings</h1>
      <RetentionSection api={api} readOnly={readOnly} />
      <section className="x-settings-section" aria-labelledby="trash-heading">
        <div>
          <h2 id="trash-heading">Trash</h2>
          <p className="x-hint">Sessions in Trash are emptied 30 days after they were moved there. Keep and Never above do not change this.</p>
        </div>
        <div className="x-settings-controls"><p>Auto-empty after <strong>30 days</strong></p></div>
      </section>
      <StorageSection api={api} />
      <PricesSection api={api} />
      <section className="x-settings-section" aria-labelledby="usage-history-heading">
        <div>
          <h2 id="usage-history-heading">Usage history</h2>
          <p id="usage-history-hint">
            Removes the frozen monthly totals and excludes all usage already observed from future totals. Usage observed afterwards
            still counts. This is not a session purge or a quota reset.
          </p>
        </div>
        <div className="x-settings-controls">
          <button ref={trigger} type="button" className="x-btn x-btn-secondary" disabled={readOnly} aria-describedby="usage-history-hint"
            aria-disabled={section === 'applying' || undefined} onClick={() => { if (section !== 'applying') open(); }}>
            Clear usage history
          </button>
          {readOnly ? <p>Unavailable while the store is read-only.</p> : null}
          <span aria-live="polite">{clearStatusText(section)}</span>
        </div>
      </section>
      <ConfirmDialog dialog={dialog} name="clear-usage" title="Clear usage history?" phase={phase} text={clearStatusText(phase)} confirm="Clear usage history"
        body={'The monthly totals are removed and every usage record already observed is left out of them from now on. Usage observed'
          + ' afterwards appears as usual. Sessions, account usage snapshots and quotas are not deleted.'}
        onConfirm={confirm} onDismiss={close} onClosed={closed} />
      <StartupSection api={api} />
    </div>
  );
}

/** `initial` is the reducer's starting state (a test renders a shown error through it). */
export function RetentionSection({ api, readOnly, initial = initialRetention }: { api: SettingsApi; readOnly: boolean; initial?: RetentionState }) {
  const id = useId();
  // state in retention-view.ts (security review of run 159): frozen while applying, stale replies ignored, a late load
  // never overwrites the user's choice, focus after the error renders
  const [s, dispatch] = useReducer(retentionReducer, initial);
  const { loaded, draft, error, phase, announce } = s;
  const days = useRef<HTMLInputElement>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    api.retention().then((r) => { if (live) dispatch({ type: 'loaded', ...r }); }, () => { if (live) dispatch({ type: 'loadFailed' }); });
    return () => { live = false; };
  }, [api]);
  useEffect(() => { if (s.focus) (s.focus.target === 'days' ? days : first).current?.focus(); }, [s.focus]);
  const change = (d: Draft) => dispatch({ type: 'change', draft: d });
  const save = () => { if (!readOnly) dispatch({ type: 'save' }); };
  // re-review L-A: the request follows the reducer's pending Save (never a render snapshot), once per seq
  const sent = useRef(0);
  useEffect(() => {
    const p = toSend(s, sent.current);
    if (!p) return;
    sent.current = p.seq;
    api.setRetention(p.value).then((result) => dispatch({ type: 'saved', seq: p.seq, result }), () => dispatch({ type: 'saved', seq: p.seq, result: 'unavailable' }));
  }, [s.pending, api]); // s.pending is the trigger
  const daysError = error !== null && draft.choice === 'other';
  const choiceError = error !== null && draft.choice === null;
  const note = loaded === 'loading' ? 'Loading the current setting…' : loaded === 'failed' ? 'The current setting is unavailable.'
    : loaded.setting === null ? 'The stored setting is unreadable, so no session retention runs. Choose one and Save.' : null;
  const radio = (choice: Draft['choice'], label: string, ref?: typeof first) => ( // review L4: the error on each radio
    <label className="x-radio"><input ref={ref} type="radio" name={`${id}-retention`} checked={draft.choice === choice}
      aria-describedby={choiceError ? `${id}-error` : undefined} onChange={() => change({ choice, days: draft.days })} /> {label}</label>
  );
  return (
    <section className="x-settings-section" aria-labelledby="retention-heading">
      <div>
        <h2 id="retention-heading">Session retention</h2>
        <p className="x-hint" id={`${id}-hint`}>
          Xaibo permanently purges inactive session history this many days after its last activity. Live sessions and sessions
          marked Keep are never purged. Each session shows its purge date.
        </p>
      </div>
      <div className="x-settings-controls x-stack">
        {note ? <p className="x-hint">{note}</p> : null}
        <fieldset className="x-radios" disabled={phase === 'applying'} aria-describedby={choiceError ? `${id}-error ${id}-hint` : `${id}-hint`}>
          <legend>Purge inactive history after</legend>
          {radio('default', '45 days (default)', first)}
          {radio('never', 'Never')}
          {radio('other', 'Other')}
          <div className="x-other">
            <input ref={days} className="x-input" inputMode="numeric" autoComplete="off" aria-label="Number of days" value={draft.days}
              aria-describedby={daysError ? `${id}-error ${id}-days` : `${id}-days`} aria-invalid={daysError || undefined}
              onChange={(e) => change({ choice: 'other', days: e.target.value })} onBlur={() => dispatch({ type: 'blur' })} />
            <span id={`${id}-days`}>days</span>
          </div>
        </fieldset>
        <div className="x-save-row">
          <button type="button" className="x-btn x-btn-primary" disabled={readOnly} aria-disabled={phase === 'applying' || undefined}
            aria-busy={phase === 'applying' || undefined} onClick={save}>Save</button>
          <span aria-live="polite">{phase !== null ? saveText(phase) : announce}</span>
        </div>
        {/* below Save, on a reserved line (E2E-found, re-review L-B): an error shown on the field's blur at mousedown moves
            no button before the mouseup; the id exists only while there is an error to point at */}
        <p className="x-error" id={error !== null ? `${id}-error` : undefined}>{error}</p>
        {readOnly ? <p>Unavailable while the store is read-only.</p> : null}
        {typeof loaded === 'object' ? <p className="x-hint">{lastRunText(loaded.lastRunAt)}</p> : null}
      </div>
    </section>
  );
}

function StorageTable({ caption, rows }: { caption: string; rows: StorageRow[] }) {
  return (
    <table>
      <caption>{caption}</caption>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">{r.label}</th>
            <td className="x-bar-cell">{r.share === null ? null : (
              <span className="x-meter" aria-hidden="true"><span className="x-meter-used" style={{ width: `${Math.min(100, r.share)}%` }} /></span>)}</td>
            <td className={r.share === null && r.text === 'Unavailable' ? 'x-un' : undefined}>{r.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StorageSection({ api }: { api: SettingsApi }) {
  const [state, setState] = useState<{ report: StorageReport | null; failed: boolean } | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const load = () => {
    setBusy(true);
    void measureStorage(api).then((r) => { if (live.current) { setState(r); setBusy(false); } });
  };
  useEffect(() => { live.current = true; load(); return () => { live.current = false; }; }, [api]);
  const v = storageView(state === 'loading' ? null : state.report);
  return (
    <section className="x-settings-section" aria-labelledby="storage-heading">
      <div>
        <h2 id="storage-heading">Storage</h2>
        <p className="x-hint">
          Space Xaibo's own data uses on this Mac. Account usage is kept for 45 days regardless of Keep or Never; monthly totals do
          not expire.
        </p>
      </div>
      <div className="x-settings-controls x-stack">
        <div className="x-storage">
          <div>
            <p className="x-hint">Storage used</p>
            <p className="x-storage-total">{state === 'loading' ? 'Loading…' : v.total}</p>
            <p className="x-hint x-storage-when">
              <span>{state === 'loading' ? '' : storageWhen(state)}</span>
              <button type="button" className="x-btn x-btn-quiet" aria-disabled={busy || undefined} aria-busy={busy || undefined}
                onClick={() => { if (!busy) load(); }}>Refresh</button>
              <span aria-live="polite">{busy && state !== 'loading' ? 'Measuring…' : ''}</span>
            </p>
          </div>
          {v.disk.length ? <StorageTable caption="On disk" rows={v.disk} /> : null}
          {v.inside ? <StorageTable caption="Inside the database" rows={v.inside} />
            : state !== 'loading' && v.disk.length ? <p className="x-hint">Inside the database: Unavailable</p> : null}
        </div>
      </div>
    </section>
  );
}

/** XAIBO-PROD-568 (P6-T11; design §6.6 Local prices / Owner-set fallback, §529, A6): the current table and its revision,
 *  Reveal override file -> Validate -> Reload. Validate switches nothing; an error from a Reload is announced once (alert),
 *  an error already present on load is shown without one. Focus stays on the invoking button; a running action is
 *  aria-disabled. No editor and no network: the owner edits the private file. */
export function PricesSection({ api }: { api: SettingsApi }) {
  const [view, setView] = useState<PriceView | null | 'loading' | 'failed'>('loading');
  const [busy, setBusy] = useState<PriceOp | 'reveal' | null>(null);
  const [note, setNote] = useState('');
  const [reloads, setReloads] = useState(0); // > 0: the error shown came from a Reload
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    api.prices('get').then((r) => { if (live.current) setView(r.view); }, () => { if (live.current) setView('failed'); });
    return () => { live.current = false; };
  }, [api]);
  const run = (op: PriceOp | 'reveal') => {
    if (busy) return;
    setBusy(op);
    setNote('');
    const done = (text: string) => { if (live.current) { setBusy(null); setNote(text); } };
    if (op === 'reveal') { api.reveal().then((r) => done(revealText(r)), () => done(revealText('failed'))); return; }
    api.prices(op).then((r) => {
      if (!live.current) return;
      setView(r.view);
      if (op === 'reload') setReloads((n) => n + 1);
      // a Reload error is the alert below, not also this polite line
      done(!r.view ? RESULT_UNAVAILABLE : op === 'validate' ? (r.check ? checkText(r.check) : RESULT_UNAVAILABLE) : r.view.error ? '' : reloadText(r.view));
    }, () => done(RESULT_UNAVAILABLE));
  };
  const v = typeof view === 'object' ? view : null;
  const rows = v ? fallbackRows(v) : [];
  const action = (op: PriceOp | 'reveal', label: string) => (
    <button type="button" className="x-btn x-btn-secondary" aria-disabled={busy !== null || undefined} aria-busy={busy === op || undefined}
      onClick={() => run(op)}>{label}</button>
  );
  return (
    <section className="x-settings-section" aria-labelledby="prices-heading">
      <div>
        <h2 id="prices-heading">Local prices</h2>
        <p className="x-hint">
          Estimated costs use this price table. To change a rate, edit the private override file, then Validate and Reload. Xaibo
          never fetches prices; an old date is not a market check, and existing estimates keep the prices they were made with.
        </p>
      </div>
      <div className="x-settings-controls x-stack">
        {view === 'loading' ? <p>Loading prices…</p> : view === 'failed' || view === null ? <p>Prices are unavailable.</p> : (
          <>
            <p>{asOfText(view)}</p>
            <p className="x-hint">Source: {sourceText(view)}</p>
          </>
        )}
        {v?.error ? <p key={reloads} className="x-error" role={reloads > 0 ? 'alert' : undefined}>{reloadText(v)}</p> : null}
        <div className="x-save-row">
          {action('reveal', 'Reveal override file')}
          {action('validate', 'Validate')}
          {action('reload', 'Reload')}
          <span aria-live="polite">{busy === 'validate' ? 'Validating…' : note}</span>
        </div>
        {v ? (
          <div className="x-storage">
            {rows.length ? (
              <table>
                <caption>Owner-set fallback</caption>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <th scope="row">{r.models}<br /><span className="x-hint">{r.scope}</span></th>
                      <td>{r.rates.map((x) => <span key={x.label} className="x-rate">{x.label}: {x.text}</span>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="x-hint">No owner-set fallback rates.</p>}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** XAIBO-PROD-569 (P6-T10 unit 1; design §6.6 Startup): Start at login, off by default. The checkbox is a draft until Save;
 *  the result line says what macOS has afterwards (Save keeps focus). */
export function StartupSection({ api }: { api: SettingsApi }) {
  const [loaded, setLoaded] = useState<boolean | null | 'loading'>('loading');
  const [draft, setDraft] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    api.startup({ op: 'read' }).then((r) => {
      if (!live.current) return;
      const on = r?.status === 'ready' ? r.enabled : null;
      setLoaded(on);
      setDraft(on === true);
    }, () => { if (live.current) setLoaded(null); });
    return () => { live.current = false; };
  }, [api]);
  const blocked = busy || !canSave(loaded, touched);
  const save = () => {
    if (blocked) return;
    setBusy(true);
    setNote('');
    const done = (r: StartupReply | null) => {
      if (!live.current) return;
      setBusy(false);
      setNote(startupText(r));
      if (r && r.enabled !== null) { setLoaded(r.enabled); setDraft(r.enabled); }
    };
    api.startup({ op: 'save', enabled: draft }).then(done, () => done(null));
  };
  return (
    <section className="x-settings-section" aria-labelledby="startup-heading">
      <div>
        <h2 id="startup-heading">Startup</h2>
        <p className="x-hint" id="startup-hint">Off by default. Closing the window keeps collection running; Quit stops it.</p>
      </div>
      <div className="x-settings-controls x-stack">
        {loaded === 'loading' ? <p>Loading the current setting…</p> : loaded === null ? <p>The current setting is unavailable.</p> : null}
        <label className="x-radio"><input type="checkbox" checked={draft} aria-describedby="startup-hint" disabled={loaded === 'loading'}
          onChange={(e) => { setTouched(true); setDraft(e.target.checked); }} /> Start Xaibo at login</label>
        <div className="x-save-row">
          <button type="button" className="x-btn x-btn-primary" aria-disabled={blocked || undefined} aria-busy={busy || undefined} onClick={save}>Save</button>
          <span aria-live="polite">{busy ? 'Saving…' : note}</span>
        </div>
      </div>
    </section>
  );
}
