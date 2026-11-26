// XAIBO-PROD-593 (P6-T08 slice D; EC-79, design §6.5.2 "Add agent", D-P6-19): the Add agent wizard region in Agent Map's detail
// pane over the add-agent.ts model. Steps: (1) Rescan and candidates (one per agent, detected first), (2) prerequisites and
// coverage (state, version, reasons and the compatibility labels; installation, sign-in and connection are named separately and
// nothing is installed), (3) the profile, (4) the configuration preview through the existing Connect diff dialog, (5) Test
// receipt through the existing passive receipt model, (6) the result from fresh evidence, with Open integration. Next/Back/
// Cancel stay in the region; a step change focuses its heading; Rescan waits while an apply or a receipt test runs (slice C
// review L2). Grants for imported agents arrive with P6-T08a. Every service string goes through visible().
// ponytail: candidates come from the first Agents list pages (at most 4 x 10 rows: a handful of agents); page further if needed.
import { useEffect, useReducer, useRef, useState } from 'react';
import { INTEGRATION_PAGE_MAX, type IntegrationDetail, type IntegrationKey, type IntegrationRow, type RescanResult } from '../../shared/ipc.ts';
import { visible } from '../text.ts';
import { candidates, canNext, detailKey, openWizard, previewOpen, receiptEvent, setUp, stepKey, STEP_TITLE, wizardStep, type Candidate } from './add-agent.ts';
import { contentText, reasonsText, receiptText, STATE, stateText } from './integrations-state.ts';
import { panelActions } from './integration-dialog.ts';
import { IntegrationDiffDialog, type Done, type WriteApi } from './IntegrationDiffDialog.tsx';
import type { DetailFetch } from './IntegrationPanel.tsx';
import type { PageFetch } from './AgentsList.tsx';
import { pollTest, startTest, testText, TEST_POLL_MS, TEST_TIMEOUT_MS, type ReceiptTest } from './integration-panel.ts';

export interface AddAgentApi extends WriteApi { integrationPage: PageFetch; integrationDetail: DetailFetch; rescan(): Promise<RescanResult> }
const SCAN: Record<string, string> = {
  starting: 'Agents are still being detected; try again shortly.', 'read-only': 'Rescan is unavailable on a read-only store.',
  'rate-limited': 'Rescanned moments ago; try again shortly.', unavailable: 'Rescan is unavailable.', failed: 'Rescan failed; the previous results are shown.',
};

export function AddAgent({ api, lastKnown, onCancel, onDone, onChanged }: {
  api: AddAgentApi; lastKnown: string | null; onCancel: () => void; onDone: (key: IntegrationKey) => void; onChanged: () => void;
}) {
  const [w, send] = useReducer(wizardStep, undefined, openWizard);
  const [rows, setRows] = useState<IntegrationRow[] | 'failed' | null>(null);
  // per-step state is stamped with its step key; another step's state reads as absent (E2E finding: an effect that reset it
  // after the step painted could undo a press made in between)
  const [detailS, setDetail] = useState<{ key: string; value: IntegrationDetail; observedAt: number } | { key: string; failed: true } | null>(null);
  const [dialog, setDialog] = useState<{ action: { kind: 'connect'; profileId: string }; n: number } | null>(null);
  const [testS, setTestS] = useState<{ key: string; t: ReceiptTest } | null>(null);
  const [busy, setBusy] = useState(false); // an apply is in flight
  const heading = useRef<HTMLHeadingElement>(null);
  const polling = useRef(false); // review M1: one receipt poll at a time
  const rowsSeq = useRef(0);
  const live = lastKnown === null;

  const loadRows = async () => {
    const mine = ++rowsSeq.current; // review L8: the latest list read wins
    const out: IntegrationRow[] = [];
    let cursor: IntegrationKey | null = null;
    try {
      for (let i = 0; i < 4; i++) {
        const r = await api.integrationPage(cursor, INTEGRATION_PAGE_MAX);
        if (r.status !== 'ready') throw new Error(r.code);
        out.push(...r.value.rows);
        cursor = r.value.next;
        if (!cursor) break;
      }
      if (mine === rowsSeq.current) setRows(out);
    } catch { if (mine === rowsSeq.current) setRows((x) => (Array.isArray(x) ? x : 'failed')); } // keep the previous evidence on a failed refresh
  };
  const rescan = () => {
    const seq = w.seq + 1;
    send({ type: 'rescan' });
    void api.rescan().then((result) => send({ type: 'scanned', seq, result }), () => send({ type: 'scanned', seq, result: { status: 'refused', code: 'failed' } })).then(() => loadRows());
  };
  useEffect(() => { rescan(); }, []); // rescan on open (FR-01)
  useEffect(() => { heading.current?.focus(); }, [w.step]); // design §6.5.2: a step change focuses its heading
  const key: IntegrationKey | null = w.agent ? detailKey(Array.isArray(rows) ? rows : [], w.agent, w.profileId) : null;
  const sk = stepKey(w), keyStr = key ? `${key.agent}|${key.profileId ?? ''}` : '';
  const skRef = useRef(sk);
  skRef.current = sk;
  /** Review M1/L7: a reply for another step is dropped; a failed poll keeps what is shown (only a first read or Retry fails). */
  const loadDetail = (poll = false): Promise<{ value: IntegrationDetail; observedAt: number } | null> => {
    if (!key) return Promise.resolve(null);
    const k = key, at = sk;
    const failed = () => { if (!poll && at === skRef.current) setDetail({ key: at, failed: true }); return null; };
    return api.integrationDetail(k).then((r) => {
      if (at !== skRef.current) return null;
      if (r.status !== 'ready') return failed();
      const v = { value: r.value, observedAt: r.observedAt };
      setDetail({ key: at, ...v });
      return v;
    }, failed);
  };
  useEffect(() => { void loadDetail(); }, [sk, keyStr]);
  const cur = detailS && detailS.key === sk ? detailS : null;
  const detail = cur ? ('failed' in cur ? 'failed' as const : cur) : null;
  const d = detail && detail !== 'failed' ? detail.value : null;
  const test: ReceiptTest = testS && testS.key === sk ? testS.t : { phase: 'idle' };
  const setTest = (f: ReceiptTest | ((t: ReceiptTest) => ReceiptTest)) => {
    const at = sk;
    setTestS((s) => { const was = s && s.key === at ? s.t : { phase: 'idle' } as ReceiptTest; return { key: at, t: typeof f === 'function' ? f(was) : f }; });
  };
  // step 4: a profile Xaibo already set up counts as applied (nothing to apply twice)
  useEffect(() => { if (w.step === 'preview' && d && setUp(d)) send({ type: 'applied', gen: w.gen }); }, [w.step, d, w.gen]);
  useEffect(() => { // step 5: Test receipt, every 2 s, never past its timeout
    if (test.phase !== 'waiting') return;
    const poll = setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      void loadDetail(true).then((r) => { if (r) setTest((t) => pollTest(t, r.value, r.observedAt)); }).finally(() => { polling.current = false; });
    }, TEST_POLL_MS);
    const stop = setTimeout(() => setTest((t) => (t.phase === 'waiting' ? { phase: 'timeout' } : t)), TEST_TIMEOUT_MS + TEST_POLL_MS);
    return () => { clearInterval(poll); clearTimeout(stop); };
  }, [test.phase, sk]);
  useEffect(() => { const e = receiptEvent(test, w); if (e) send(e); }, [test, w]); // a passed test is the step's receipt
  const previewBtn = useRef<HTMLButtonElement>(null);
  const done = ({ sent, focus }: Done) => {
    setDialog(null); // a finished request never reopens (E2E finding)
    // review M3: the dialog's focus target; a trigger that is gone hands focus to the step heading
    if (focus === 'heading' || (focus === 'trigger' && !previewBtn.current?.isConnected)) heading.current?.focus();
    else if (focus === 'trigger') previewBtn.current?.focus();
    if (!sent) return;
    setBusy(true);
    onChanged();
    void loadDetail().then((r) => { setBusy(false); if (r && setUp(r.value)) send({ type: 'applied', gen: w.gen }); else heading.current?.focus(); });
  };
  const retry = (what: string) => <p className="x-hint">Couldn't load {what}. <button type="button" className="x-btn x-btn-quiet" onClick={() => void loadDetail()}>Retry</button></p>;
  const cands: Candidate[] = Array.isArray(rows) ? candidates(rows) : [];
  const said = testText(test), why = d ? reasonsText(d.row) : null;
  const blocked = busy || test.phase === 'waiting';
  const scanNote = w.scan === 'scanning' ? 'Rescanning…' : w.scan === 'ready' ? null : SCAN[w.scan.refused] ?? SCAN.failed!;

  return (
    <section className="x-pane x-map-detail x-integration" aria-labelledby="add-agent-heading">
      <div className="x-pane-head">
        <h2 id="add-agent-heading">Add agent</h2>
        <button type="button" className="x-btn x-btn-quiet" onClick={onCancel}>Cancel</button>
      </div>
      <div className="x-map-detail-body" role="region" aria-labelledby="add-agent-step">
        <h3 id="add-agent-step" ref={heading} tabIndex={-1}>{STEP_TITLE[w.step]}</h3>
        {w.step === 'candidates' ? (
          <>
            <div className="x-integration-actions">
              <button type="button" className="x-btn x-btn-secondary" aria-disabled={w.scan === 'scanning' || blocked || !live || undefined}
                onClick={() => { if (w.scan !== 'scanning' && !blocked && live) rescan(); }}>Rescan agents</button>
            </div>
            <p className="x-hint" aria-live="polite">{scanNote ?? ''}</p>
            {rows === 'failed' && !cands.length ? <p className="x-hint">Agents could not be loaded. <button type="button" className="x-btn x-btn-quiet" onClick={() => void loadRows()}>Retry</button></p>
              : rows === null ? <p className="x-hint">Detecting agents…</p>
              : !cands.length ? <p className="x-hint">No agents are known. Install one with its own installer, then Rescan.</p>
              : (
                <fieldset className="x-radios">
                  <legend>Agent</legend>
                  {cands.map((c) => (
                    <label key={c.agent} className="x-radio"><input type="radio" name="add-agent-choice" checked={w.agent === c.agent} onChange={() => send({ type: 'agent', agent: c.agent })} />
                      {visible(c.name)}: {c.detected ? `detected${c.version ? `, version ${visible(c.version)}` : ''}` : 'not detected'}</label>
                  ))}
                </fieldset>
              )}
            <p className="x-hint">Importing a catalog entry is not available here yet; granting an imported agent's folder, probe or setup comes later.</p>
          </>
        ) : w.step === 'prerequisites' ? (
          d ? (
            <>
              <dl className="x-map-dl">
                <div><dt>Installation</dt><dd>{d.row.state === 'not-detected' ? 'Not detected: install it with its own installer, then Rescan. Xaibo never installs software.' : `Detected${d.row.version ? `, version ${visible(d.row.version)}` : ''}`}</dd></div>
                <div><dt>Connection</dt><dd><span className="x-agent-state" data-tone={STATE[d.row.state].tone}>{stateText(d.row, !live)}</span>{why ? ` (${why})` : ''}</dd></div>
                <div><dt>Sign-in</dt><dd>Declared per profile in the integration panel or Settings; Xaibo never checks credentials.</dd></div>
              </dl>
              <h4>Coverage by surface</h4>
              {d.compatibility.length ? <ul className="x-integration-list">{d.compatibility.map((l) => <li key={l}>{visible(l)}</li>)}</ul>
                : <p className="x-hint">No compatibility evidence is recorded for this agent.</p>}
            </>
          ) : detail === 'failed' ? retry('this agent') : <p className="x-hint">Loading…</p>
        ) : w.step === 'profile' ? (
          d ? (d.profiles.length ? (
            <fieldset className="x-radios">
              <legend>Profile</legend>
              {d.profiles.map((p) => (
                <label key={p.id} className="x-radio"><input type="radio" name="add-agent-profile" checked={w.profileId === p.id} onChange={() => send({ type: 'profile', profileId: p.id })} />{visible(p.label)}</label>
              ))}
            </fieldset>
          ) : <p className="x-hint">No profile found: start the agent once so it creates its profile folder, then Rescan.</p>)
            : detail === 'failed' ? retry('this agent') : <p className="x-hint">Loading…</p>
        ) : w.step === 'preview' ? (
          d && w.profileId ? (
            w.applied ? <p className="x-hint">Configuration is set up for this profile.</p>
              : panelActions(d).includes('connect') && live ? (
                <div className="x-integration-actions">
                  <button ref={previewBtn} type="button" className="x-btn x-btn-primary" aria-disabled={busy || undefined}
                    onClick={() => { if (!busy && w.profileId) setDialog((r) => ({ action: { kind: 'connect', profileId: w.profileId! }, n: (r?.n ?? 0) + 1 })); }}>Preview configuration change</button>
                </div>
              ) : <p className="x-hint">Xaibo cannot set this agent up here{why ? ` (${why})` : ''}.</p>
          ) : detail === 'failed' ? retry('this profile') : <p className="x-hint">Loading…</p>
        ) : w.step === 'receipt' ? (
          d ? (
            <>
              {d.trustSteps.length ? <ol className="x-integration-list">{d.trustSteps.map((s, i) => <li key={i}>{visible(s)}</li>)}</ol> : null}
              <p className="x-hint">Start the test, then use the agent once in this profile: Xaibo only reads what the agent reports.</p>
              <div className="x-integration-actions">
                <button type="button" className="x-btn x-btn-secondary" aria-disabled={test.phase === 'waiting' || w.receipt || undefined}
                  onClick={() => { if (test.phase !== 'waiting' && !w.receipt) void loadDetail().then((r) => { if (r) setTest(startTest(r.observedAt)); }); }}>Test receipt</button>
              </div>
              <p className="x-hint" aria-live="polite">{visible(said ?? '')}</p>
            </>
          ) : detail === 'failed' ? retry('this profile') : <p className="x-hint">Loading…</p>
        ) : d ? (
          <>
            <dl className="x-map-dl">
              <div><dt>State</dt><dd><span className="x-agent-state" data-tone={STATE[d.row.state].tone}>{stateText(d.row, !live)}</span>{why ? ` (${why})` : ''}</dd></div>
              <div><dt>Lifecycle receipt</dt><dd>{visible(receiptText(d.row).replace(/^Lifecycle receipt: /, ''))}</dd></div>
              <div><dt>Content coverage</dt><dd>{visible(contentText(d.row.content).replace(/^Content coverage: /, ''))}</dd></div>
            </dl>
            <div className="x-integration-actions"><button type="button" className="x-btn x-btn-primary" onClick={() => { if (key) onDone(key); }}>Open integration</button></div>
          </>
        ) : detail === 'failed' ? retry('the result') : <p className="x-hint">Loading…</p>}
        <div className="x-integration-actions x-wizard-nav">
          <button type="button" className="x-btn x-btn-secondary" aria-disabled={w.step === 'candidates' || blocked || undefined}
            onClick={() => { if (w.step !== 'candidates' && !blocked) send({ type: 'back' }); }}>Back</button>
          {w.step !== 'result' ? <button type="button" className="x-btn x-btn-primary" aria-disabled={!canNext(w) || blocked || undefined}
            onClick={() => { if (canNext(w) && !blocked) send({ type: 'next' }); }}>Next</button> : null}
        </div>
      </div>
      {d ? <IntegrationDiffDialog open={previewOpen(w) ? dialog : null} detail={d} api={api} lastKnown={lastKnown} onDone={done} /> : null}
    </section>
  );
}
