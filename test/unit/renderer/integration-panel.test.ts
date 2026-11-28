// XAIBO-PROD-578 (P6-T10 unit 4b; design §6.5.2, .handoff/p6-t10-design.md section 3 "Test receipt", review R1/R8): the
// integration panel model in agent-map/integration-panel.ts: the Test receipt (a new eligible receipt received after the
// test started and after the install boundary succeeds; an old or replayed one, or one from before a reinstall, never does;
// 60 s timeout with the design's wording; nothing runs), entry and status texts, and where Back to map returns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECT_ROUTES, RECONCILE_STATES, type IntegrationDetail } from '../../../src/shared/ipc.ts';
import { agentRow, allRows, entryText, focusInvoker, notifyText, pollTest, restoreTarget, startTest, teeText, testable, testText, TEST_POLL_MS, TEST_TIMEOUT_MS, type ReceiptTest } from '../../../src/renderer/agent-map/integration-panel.ts';
import { INTEGRATION_PAGE_MAX, type IntegrationKey, type IntegrationPageResult } from '../../../src/shared/ipc.ts';
import { formatTime } from '../../../src/renderer/model.ts';

const P = '00000000-0000-4000-8000-0000000c7801', E = '00000000-0000-4000-8000-0000000c78e1';
const detail = (o: { receipt?: number | null; boundary?: number | null; agent?: string; entries?: IntegrationDetail['entries'] } = {}): IntegrationDetail => ({
  row: { key: { agent: o.agent ?? 'codex', profileId: P }, name: 'Codex', profileLabel: 'Default profile', version: '0.160.0', state: 'awaiting-trust', reasons: ['no-receipt'], lifecycleGaps: [],
    receipt: o.receipt ? { source: 'hook', event: 'Stop', receivedAt: o.receipt } : null, content: { mode: 'native-transcript', assurance: 'verified', evidence: 'S9', gaps: [] } },
  profiles: [{ id: P, label: 'Default profile' }], entries: o.entries ?? [], trustSteps: [], boundary: o.boundary === undefined ? 1_000 : o.boundary, compatibility: [], grants: null,
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

// XAIBO-PROD-598 (P6-T08a slice C, E2E finding): a folder approval can list the imported agent's first profile, so its
// profile-less key stops existing (and a folder revoke can remove that profile again); the panel moves to the agent's first
// listed row instead of showing "no longer listed".
test('allRows: the Agents list from its first pages, following next cursors; at most 4 pages; a refusal throws', async () => {
  const row = (agent: string, profileId: string | null) => ({ ...detail({ agent }).row, key: { agent, profileId } });
  const pages = [[row('a', null), row('b', P)], [row('c', null)]];
  const asked: (IntegrationKey | null)[] = [];
  const fetch = async (cursor: IntegrationKey | null, limit: number): Promise<IntegrationPageResult> => {
    asked.push(cursor);
    assert.equal(limit, INTEGRATION_PAGE_MAX);
    const i = asked.length - 1, rows = pages[i] ?? [];
    return { status: 'ready', observedAt: 1, value: { rows, previous: null, next: i < pages.length - 1 ? rows.at(-1)!.key : null } };
  };
  assert.deepEqual((await allRows(fetch)).map((r) => r.key), [{ agent: 'a', profileId: null }, { agent: 'b', profileId: P }, { agent: 'c', profileId: null }]);
  assert.deepEqual(asked, [null, { agent: 'b', profileId: P }]);
  let n = 0;
  const endless = async (): Promise<IntegrationPageResult> => ({ status: 'ready', observedAt: 1, value: { rows: [row(`x${++n}`, null)], previous: null, next: { agent: `x${n}`, profileId: null } } });
  assert.equal((await allRows(endless)).length, 4);
  await assert.rejects(allRows(async () => ({ status: 'refused', code: 'starting' })), /starting/);
});

test('agentRow: the agent\'s first listed row (its first profile, or its profile-less row); null when it is not listed', () => {
  const row = (agent: string, profileId: string | null) => ({ ...detail({ agent }).row, key: { agent, profileId } });
  assert.deepEqual(agentRow([row('a', null), row('synthagent', E), row('synthagent', P)], 'synthagent'), { agent: 'synthagent', profileId: E });
  assert.deepEqual(agentRow([row('synthagent', null)], 'synthagent'), { agent: 'synthagent', profileId: null });
  assert.equal(agentRow([row('other', P)], 'synthagent'), null);
});


// Gate 6 D1-3 (XAIBO-PROD-610, design §6.5.2): Return to Dashboard focuses the button that opened the panel once the usage
// blocks have drawn it (their data loads after the area switch), else the Usage and history heading after a bounded wait
test('XAIBO-PROD-610: focusInvoker waits for the invoker, then falls back to the heading; never past its tries', async () => {
  const focused: string[] = [];
  const el = (name: string) => ({ focus: () => { focused.push(name); } });
  let waits = 0, shown = 2;
  const wait = async () => { waits++; };
  assert.equal(await focusInvoker(() => (waits >= shown ? el('invoker') : null), () => el('heading'), wait, 5), 'invoker');
  assert.deepEqual([focused, waits], [['invoker'], 2]);
  focused.length = 0; waits = 0; shown = Infinity;
  assert.equal(await focusInvoker(() => null, () => el('heading'), wait, 5), 'heading');
  assert.deepEqual([focused, waits], [['heading'], 5]);
  assert.equal(await focusInvoker(() => null, () => null, wait, 1), null, 'nothing to focus');
});
