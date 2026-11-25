// XAIBO-PROD-578 (P6-T10 unit 4b; design §6.5.2, .handoff/p6-t10-design.md section 3, review R1/R8): the selected
// integration panel in Agent Map's detail pane, over unit 4a's integrationDetail. Heading, Back to map, a native Profile
// select scoped to the agent (a change discards the old profile's test), facts, the profile's configuration in words, Codex
// trust steps while awaiting trust, Test receipt (reads only; integration-panel.ts) and the status-only tee and notify lines.
// XAIBO-PROD-579 (unit 5): Connection actions (Connect, Disconnect, Full Uninstall, Clean up; only where they apply and the
// service is live), each through the diff dialog (IntegrationDiffDialog.tsx); after an apply the evidence is read again before
// another action and the Agents list refreshes. Tee stays status only until unit 6. Every service string goes through visible().
import { useEffect, useRef, useState } from 'react';
import type { DETAIL_REFUSALS, IntegrationDetail, IntegrationDetailResult, IntegrationKey } from '../../shared/ipc.ts';
import { formatTime } from '../model.ts';
import { Icon } from '../status/StatusBadge.tsx';
import { visible } from '../text.ts';
import { contentText, reasonsText, receiptText, STATE, stateText } from './integrations-state.ts';
import { panelActions, type ActionKind, type DialogAction } from './integration-dialog.ts';
import { IntegrationDiffDialog, type Done, type WriteApi } from './IntegrationDiffDialog.tsx';
import { entryText, notifyText, pollTest, startTest, teeText, testable, testText, TEST_POLL_MS, TEST_TIMEOUT_MS, type ReceiptTest } from './integration-panel.ts';

export type DetailFetch = (key: IntegrationKey) => Promise<IntegrationDetailResult>;
const REFUSED: Record<(typeof DETAIL_REFUSALS)[number], string> = {
  starting: 'Agents are still being detected', unavailable: 'Agent evidence is unavailable', 'not-found': 'This agent or profile is no longer listed', failed: "Couldn't load this integration",
};
const ACTION: Record<ActionKind, string> = { connect: 'Connect', disconnect: 'Disconnect', uninstall: 'Full Uninstall', cleanup: 'Clean up' };

export function IntegrationPanel({ fetchDetail, write, target, lastKnown, onBack, onProfile, onChanged }: {
  fetchDetail: DetailFetch; write: WriteApi; target: IntegrationKey; lastKnown: string | null; onBack: () => void; onProfile: (profileId: string) => void;
  /** An apply was sent: evidence elsewhere (the Agents list) may have changed. */
  onChanged: () => void;
}) {
  const [res, setRes] = useState<IntegrationDetailResult | 'loading' | 'error'>('loading');
  const [test, setTest] = useState<ReceiptTest>({ phase: 'idle' });
  const seq = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const keyStr = `${target.agent}|${target.profileId ?? ''}`;
  const targetRef = useRef(target);
  targetRef.current = target;
  /** The latest read wins; an older reply (another profile, an earlier poll) is dropped. Code review M3: a poll that fails or is
   *  refused keeps what is shown (and the test result in view); only a first read or a Retry shows the failure. */
  const load = (poll = false): Promise<IntegrationDetailResult | null> => {
    const t = ++seq.current;
    return fetchDetail(targetRef.current).then((r) => { if (seq.current !== t) return null; if (!poll || r.status === 'ready') setRes(r); return r; }, () => { if (seq.current === t && !poll) setRes('error'); return null; });
  };
  const polling = useRef(false); // code review L1: a slow read is never superseded by the next tick
  useEffect(() => { setRes('loading'); setTest({ phase: 'idle' }); setNote(null); void load(); }, [keyStr]); // a profile change discards the old test and note (code review L2)
  useEffect(() => { heading.current?.focus(); }, []); // opened: the panel heading (design §6.5.2); a profile change keeps focus on the select
  useEffect(() => { // Test receipt: read every 2 s; a backstop timeout when reads fail (the service is gone)
    if (test.phase !== 'waiting') return;
    const poll = setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      void load(true).then((r) => { if (r?.status === 'ready') setTest((t) => pollTest(t, r.value, r.observedAt)); }).finally(() => { polling.current = false; });
    }, TEST_POLL_MS);
    const stop = setTimeout(() => setTest((t) => (t.phase === 'waiting' ? { phase: 'timeout' } : t)), TEST_TIMEOUT_MS + TEST_POLL_MS);
    return () => { clearInterval(poll); clearTimeout(stop); };
  }, [test.phase, keyStr]);
  const start = () => { if (test.phase !== 'waiting') void load().then((r) => { if (r?.status === 'ready') setTest(startTest(r.observedAt)); }); };
  const wasLost = useRef(lastKnown !== null);
  useEffect(() => { // code review M3: the service is back: its evidence again
    if (wasLost.current && lastKnown === null) void load();
    wasLost.current = lastKnown !== null;
  }, [lastKnown]);

  const ready = typeof res === 'object' && res.status === 'ready' ? res : null, d = ready?.value ?? null;
  // the agent's profiles as last read: the select stays while another profile loads, so it keeps focus
  const profilesRef = useRef<{ id: string; label: string }[]>([]);
  if (d) profilesRef.current = d.profiles;
  const profiles = profilesRef.current;
  // XAIBO-PROD-579: the dialog keeps the detail it opened with while a reload runs; actions wait for that reload
  const detailRef = useRef<IntegrationDetail | null>(null);
  if (d) detailRef.current = d;
  const [dialogReq, setDialogReq] = useState<{ action: DialogAction; n: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const act = (k: ActionKind, el: HTMLButtonElement) => {
    const pid = d?.row.key.profileId;
    if (refreshing || !pid) return;
    trigger.current = el;
    setNote(null);
    setDialogReq((r) => ({ action: k === 'uninstall' ? { kind: 'uninstall' } : { kind: k, profileId: pid }, n: (r?.n ?? 0) + 1 }));
  };
  const done = ({ note: said, focus, sent }: Done) => {
    if (said !== null) setNote(said);
    if (focus === 'heading' || (focus === 'trigger' && !trigger.current?.isConnected)) heading.current?.focus();
    else if (focus === 'trigger') trigger.current?.focus();
    if (!sent) return;
    setRefreshing(true); // the outcome is established by fresh evidence before another action (design §5.1)
    void load().then(() => setRefreshing(false));
    onChanged();
  };
  const actions = d && lastKnown === null ? panelActions(d) : [];
  const why = d ? reasonsText(d.row) : null, tee = d ? teeText(d) : null, notify = d ? notifyText(d) : null, said = testText(test);
  return (
    <section className="x-pane x-map-detail x-integration" aria-labelledby="integration-heading">
      <div className="x-pane-head">
        <h2 id="integration-heading" ref={heading} tabIndex={-1}>Integration: {visible(d?.row.name ?? target.agent)}</h2>
        <button type="button" className="x-btn x-btn-quiet" onClick={onBack}><Icon id="back" />Back to map</button>
      </div>
      <div className="x-map-detail-body">
        {profiles.length > 1 ? (
          <label className="x-field">Profile
            <select value={target.profileId ?? ''} onChange={(e) => onProfile(e.target.value)}>
              {profiles.map((p) => <option key={p.id} value={p.id}>{visible(p.label)}</option>)}
            </select>
          </label>
        ) : d ? <p className="x-agent-sub">Profile: {d.row.profileLabel === null ? 'No profile' : visible(d.row.profileLabel)}</p> : null}
        {res === 'loading' ? <p className="x-hint">Loading integration…</p>
          : !d || !ready ? <p className="x-hint">{res === 'error' || typeof res !== 'object' || res.status !== 'refused' ? REFUSED.failed : REFUSED[res.code]}. <button type="button" className="x-btn x-btn-quiet" onClick={() => void load()}>Retry</button></p>
          : (
            <>
              <dl className="x-map-dl">
                <div><dt>Version</dt><dd>{d.row.version === null ? 'Unavailable' : visible(d.row.version)}</dd></div>
                <div><dt>State</dt><dd><span className="x-agent-state" data-tone={STATE[d.row.state].tone}><Icon id={STATE[d.row.state].icon} />{stateText(d.row, lastKnown !== null)}</span></dd></div>
                {why ? <div><dt>Why</dt><dd>{why}</dd></div> : null}
                <div><dt>Lifecycle receipt</dt><dd>{visible(receiptText(d.row).replace(/^Lifecycle receipt: /, ''))}</dd></div>
                <div><dt>Content coverage</dt><dd>{visible(contentText(d.row.content).replace(/^Content coverage: /, ''))}</dd></div>
                <div><dt>Evidence checked</dt><dd>{formatTime(ready.observedAt)}</dd></div>
              </dl>
              {d.entries.length ? <><h3>Configuration</h3><ul className="x-integration-list">{d.entries.map((e) => <li key={e.entry}>{entryText(e)}</li>)}</ul></> : null}
              {actions.length ? <div className="x-receipt-test"><h3>Connection</h3><div className="x-integration-actions">{actions.map((k) => (
                <button key={k} type="button" className={`x-btn ${k === 'connect' ? 'x-btn-primary' : k === 'cleanup' ? 'x-btn-secondary' : 'x-btn-danger'}`} aria-disabled={refreshing || undefined}
                  onClick={(e) => act(k, e.currentTarget)}>{ACTION[k]}</button>
              ))}</div><p className="x-hint" aria-live="polite">{visible(note ?? '')}</p></div> : null}
              {d.trustSteps.length ? <><h3>Hooks installed, awaiting trust</h3><ol className="x-integration-list">{d.trustSteps.map((s, i) => <li key={i}>{visible(s)}</li>)}</ol></> : null}
              {testable(d) ? (
                <div className="x-receipt-test">
                  <button type="button" className="x-btn x-btn-secondary" aria-disabled={test.phase === 'waiting' || undefined} onClick={start}>Test receipt</button>
                  <p className="x-hint" aria-live="polite">{visible(said ?? '')}</p>
                </div>
              ) : null}
              {tee ? <p className="x-hint">{tee}</p> : null}
              {notify ? <p className="x-hint">{notify}</p> : null}
            </>
          )}
      </div>
      {detailRef.current ? <IntegrationDiffDialog open={dialogReq} detail={detailRef.current} api={write} lastKnown={lastKnown} onDone={done} /> : null}
    </section>
  );
}
