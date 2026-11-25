// XAIBO-PROD-578 (P6-T10 unit 4b; design §6.5.2, .handoff/p6-t10-design.md section 3 "Test receipt", review R1/R8): the
// integration panel model in agent-map/integration-panel.ts: the Test receipt (a new eligible receipt received after the
// test started and after the install boundary succeeds; an old or replayed one, or one from before a reinstall, never does;
// 60 s timeout with the design's wording; nothing runs), entry and status texts, and where Back to map returns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECT_ROUTES, RECONCILE_STATES, type IntegrationDetail } from '../../../src/shared/ipc.ts';
import { entryText, notifyText, pollTest, restoreTarget, startTest, teeText, testable, testText, TEST_POLL_MS, TEST_TIMEOUT_MS, type ReceiptTest } from '../../../src/renderer/agent-map/integration-panel.ts';
import { formatTime } from '../../../src/renderer/model.ts';

const P = '00000000-0000-4000-8000-0000000c7801', E = '00000000-0000-4000-8000-0000000c78e1';
const detail = (o: { receipt?: number | null; boundary?: number | null; agent?: string; entries?: IntegrationDetail['entries'] } = {}): IntegrationDetail => ({
  row: { key: { agent: o.agent ?? 'codex', profileId: P }, name: 'Codex', profileLabel: 'Default profile', version: '0.160.0', state: 'awaiting-trust', reasons: ['no-receipt'], lifecycleGaps: [],
    receipt: o.receipt ? { source: 'hook', event: 'Stop', receivedAt: o.receipt } : null, content: { mode: 'native-transcript', assurance: 'verified', evidence: 'S9', gaps: [] } },
  profiles: [{ id: P, label: 'Default profile' }], entries: o.entries ?? [], trustSteps: [], boundary: o.boundary === undefined ? 1_000 : o.boundary,
});

test('Test receipt: polls every 2 s for up to 60 s; only a receipt after the start and the install boundary counts', () => {
  assert.deepEqual([TEST_POLL_MS, TEST_TIMEOUT_MS], [2_000, 60_000]);
  const t = startTest(5_000); // code review L3: the service's observation time at the click, nothing else
  assert.deepEqual(t, { phase: 'waiting', startedAt: 5_000, until: 65_000 });
  assert.equal(testText(t), 'Waiting for test receipt…');
  assert.equal(pollTest(t, detail({ receipt: 4_000 }), 7_000), t, 'the receipt from before the test never counts');
  assert.equal(pollTest(t, detail({ receipt: 5_000 }), 7_000), t, 'not strictly after the start');
  assert.equal(pollTest(t, detail({ receipt: 6_000, boundary: 6_500 }), 7_000), t, 'a reinstall after it moved the boundary past it');
  const ok = pollTest(t, detail({ receipt: 6_000 }), 7_000);
  assert.deepEqual(ok, { phase: 'received', receipt: { source: 'hook', event: 'Stop', receivedAt: 6_000 } });
  assert.equal(testText(ok), `Receipt observed: Stop hook, ${formatTime(6_000)}`);
  const late = pollTest(t, detail({ receipt: 4_000 }), 65_000);
  assert.deepEqual(late, { phase: 'timeout' });
  assert.equal(testText(late), 'No receipt observed. Check trust and profile, then retry.');
  assert.equal(pollTest(late, detail({ receipt: 70_000 }), 71_000), late, 'a finished test stays finished');
  assert.equal(testText({ phase: 'idle' } as ReceiptTest), null);
});

test('Test receipt is offered only where a lifecycle integration is installed (a boundary)', () => {
  assert.equal(testable(detail()), true);
  assert.equal(testable(detail({ boundary: null })), false);
});

test('entries in words for every route and reconcile state; unreadable says why', () => {
  for (const route of CONNECT_ROUTES) for (const state of RECONCILE_STATES) {
    const t = entryText({ entry: E, route, state, reason: state === 'unreadable' ? 'refused' : null });
    assert.ok(t.length > 0 && !t.includes(route) && !(state.includes('-') && t.includes(state)), t); // never a bare code
  }
  assert.equal(entryText({ entry: E, route: 'codex-hooks', state: 'drifted', reason: null }), 'Codex hooks: changed outside Xaibo');
  assert.equal(entryText({ entry: E, route: 'claude-tee', state: 'unreadable', reason: 'refused' }), 'Status-line tee: unreadable (refused)');
});

test('optional status-line tee (Claude) and notify wrapper (Codex) are status only', () => {
  const tee = (state: (typeof RECONCILE_STATES)[number]) => detail({ agent: 'claude', entries: [{ entry: E, route: 'claude-tee', state, reason: null }] });
  assert.equal(teeText(detail({ agent: 'claude' })), 'Optional status-line tee: off');
  assert.equal(teeText(tee('connected')), 'Optional status-line tee: on');
  assert.equal(teeText(tee('drifted')), 'Optional status-line tee: changed outside Xaibo');
  assert.equal(teeText(detail()), null);
  assert.equal(notifyText(detail()), 'Codex notify wrapper: unavailable (no verified setup yet)');
  assert.equal(notifyText(detail({ agent: 'claude' })), null);
});

test('Back to map returns to the originating row while it is loaded, else to the heading (null)', () => {
  assert.equal(restoreTarget(['a:x|1', 'a:x|2'], 'a:x|2'), 'a:x|2');
  assert.equal(restoreTarget(['a:x|1'], 'a:x|2'), null);
});
