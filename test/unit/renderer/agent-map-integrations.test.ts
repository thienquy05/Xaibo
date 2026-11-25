// XAIBO-PROD-575 (P6-T10 unit 2b; FR-06, D-PD-02; design §6.5, .handoff/p6-t10-design.md section 3, review R10): the
// Agent Map Agents mode model in agent-map/integrations-state.ts: stable row keys, bounded paging over integrationPage (10
// rows a page, three resident pages, Load previous after eviction) reusing the tree's paging helpers, replies and
// refusals, the FR-06 state words and glyphs, reasons, separate Lifecycle receipt and Content coverage texts, Last known
// wording and short row names. Synthetic rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTEGRATION_FACTS, INTEGRATION_REFUSALS, INTEGRATION_STATES, type IntegrationRow } from '../../../src/shared/ipc.ts';
import { emptyLevel, RESIDENT } from '../../../src/renderer/agent-map/tree.ts';
import { AGENTS_PAGE, agentItems, agentKey, agentLabel, contentText, FACT, MODES, pageReply, pageRequest, reasonsText, receiptText, REFUSAL_TEXT, STATE, stateText,
  type AgentLevel } from '../../../src/renderer/agent-map/integrations-state.ts';
import { formatTime } from '../../../src/renderer/model.ts';

const P = (n: number) => `00000000-0000-4000-8000-0000000c75${String(n).padStart(2, '0')}`;
const row = (n: number, o: Partial<IntegrationRow> = {}): IntegrationRow => ({ key: { agent: 'codex', profileId: P(n) }, name: 'Codex', profileLabel: `Profile ${n}`, version: '0.160.0',
  state: 'detected', reasons: ['not-connected'], lifecycleGaps: [], receipt: null, content: { mode: 'native-transcript', assurance: 'verified', evidence: 'S9', gaps: [] }, ...o });
const page = (from: number, n: number, more: boolean) => ({ status: 'ready' as const, observedAt: 9_000 + from, value: { rows: Array.from({ length: n }, (_, i) => row(from + i)),
  previous: from > 0 ? row(from).key : null, next: more ? row(from + n - 1).key : null } });

test('modes: Repositories first, then Agents', () => {
  assert.deepEqual(MODES.map((m) => [m.mode, m.label]), [['repositories', 'Repositories'], ['agents', 'Agents']]);
});

test('row keys are stable per agent and profile; a profile-less row has its own key', () => {
  assert.equal(agentKey({ agent: 'codex', profileId: P(1) }), agentKey(row(1).key));
  assert.notEqual(agentKey({ agent: 'codex', profileId: P(1) }), agentKey({ agent: 'codex', profileId: P(2) }));
  assert.notEqual(agentKey({ agent: 'agy', profileId: null }), agentKey({ agent: 'agy', profileId: P(1) }));
  assert.notEqual(agentKey({ agent: 'codex', profileId: null }), agentKey({ agent: 'claude', profileId: null }));
});

test('paging: 10 a page, forward cursors only, three resident pages, Load previous refetches a dropped page from its own cursor', () => {
  assert.equal(AGENTS_PAGE, 10);
  let l: AgentLevel = emptyLevel();
  assert.deepEqual(pageRequest(l, 'first'), { cursor: null, direction: 'next', limit: 10 });
  l = pageReply(l, 'first', null, page(0, 10, true)).level;
  for (let p = 1; p <= 3; p++) {
    const req = pageRequest(l, 'more');
    assert.deepEqual(req.cursor, row(p * 10 - 1).key);
    l = pageReply(l, 'more', req.cursor, page(p * 10, 10, true)).level;
  }
  assert.equal(l.pages.length, RESIDENT, 'at most three resident pages');
  assert.deepEqual(agentItems(l).map((r) => r.key.profileId), Array.from({ length: 30 }, (_, i) => P(i + 10)));
  const back = pageRequest(l, 'prev');
  assert.deepEqual(back, { cursor: null, direction: 'next', limit: 10 }, 'the first page again, from the start');
  l = pageReply(l, 'prev', back.cursor, page(0, 10, true)).level;
  assert.deepEqual(agentItems(l).map((r) => r.key.profileId)[0], P(0));
  assert.equal(l.pages.length, RESIDENT);
  assert.deepEqual(l.before, []);
});

test('replies: a page announces its count and evidence time; an overlapping refetch never duplicates a row', () => {
  const r = pageReply(emptyLevel(), 'first', null, page(0, 3, false));
  assert.deepEqual([r.observedAt, r.reload, r.note], [9_000, false, '3 agents loaded']);
  assert.equal(pageReply(emptyLevel(), 'first', null, page(0, 1, false)).note, '1 agent loaded');
  assert.equal(pageReply(emptyLevel(), 'first', null, page(0, 0, false)).note, 'No agents');
  const l = pageReply(r.level, 'more', row(2).key, { status: 'ready', observedAt: 1, value: { rows: [row(2), row(3)], previous: null, next: null } }).level;
  assert.deepEqual(agentItems(l).map((x) => x.key.profileId), [P(0), P(1), P(2), P(3)]);
});

test('refusals: a stale cursor reloads from the first page; others fail the level with a fixed sentence', () => {
  const l = pageReply(emptyLevel(), 'first', null, page(0, 10, true)).level;
  const stale = pageReply({ ...l, loading: 'more' }, 'more', row(9).key, { status: 'refused', code: 'stale-cursor' });
  assert.equal(stale.reload, true);
  assert.equal(stale.level.loading, null);
  for (const code of INTEGRATION_REFUSALS) assert.ok(REFUSAL_TEXT[code].length > 0, code);
  const failed = pageReply({ ...l, loading: 'more' }, 'more', row(9).key, { status: 'refused', code: 'starting' });
  assert.deepEqual([failed.level.failed, failed.reload, failed.note, failed.refused], ['more', false, REFUSAL_TEXT.starting, 'starting']);
  assert.equal(stale.refused, null, 'a reload is not a refusal to show');
  // security review L2: a first page has no cursor to go stale: a failure, never a request loop
  const first = pageReply({ ...emptyLevel(), loading: 'first' }, 'first', null, { status: 'refused', code: 'stale-cursor' });
  assert.deepEqual([first.reload, first.level.failed, first.refused], [false, 'first', 'stale-cursor']);
  assert.equal(agentItems(failed.level).length, 10, 'what is shown stays');
});

test('FR-06 states: every state has its design glyph, tone and word; Last known is said, never an unqualified Connected', () => {
  assert.deepEqual(Object.keys(STATE).sort(), [...INTEGRATION_STATES].sort());
  assert.deepEqual(STATE.detected, { text: 'Detected', icon: 'file', tone: 'muted' });
  assert.deepEqual(STATE['setup-required'], { text: 'Setup required', icon: 'settings', tone: 'warn' });
  assert.deepEqual(STATE['awaiting-trust'], { text: 'Awaiting trust', icon: 'permission', tone: 'warn' });
  assert.deepEqual(STATE.connected, { text: 'Connected', icon: 'link', tone: 'ok' });
  assert.deepEqual(STATE['partial-coverage'], { text: 'Partial coverage', icon: 'finding', tone: 'warn' });
  assert.deepEqual(STATE['unsupported-version'], { text: 'Unsupported version', icon: 'unknown', tone: 'warn' });
  assert.deepEqual(STATE['not-detected'], { text: 'Not detected', icon: 'unknown', tone: 'muted' });
  assert.equal(stateText(row(1, { state: 'connected', reasons: [] }), false), 'Connected');
  assert.equal(stateText(row(1, { state: 'connected', reasons: [] }), true), 'Last known: Connected');
});

test('reasons: every fact code and gap has words; none is a bare code', () => {
  for (const f of INTEGRATION_FACTS) assert.ok(FACT[f] && FACT[f] !== f, f);
  assert.equal(reasonsText(row(1, { state: 'connected', reasons: [] })), null);
  assert.equal(reasonsText(row(1, { state: 'setup-required', reasons: ['drifted', 'pending-recovery'] })), `${FACT.drifted}; ${FACT['pending-recovery']}`);
  assert.equal(reasonsText(row(1, { state: 'partial-coverage', reasons: ['hook-gap'], lifecycleGaps: ['spool-overflow', 'disk-full'] })), `${FACT['hook-gap']} (spool overflow, disk full)`);
});

test('Lifecycle receipt and Content coverage are separate texts from evidence only', () => {
  assert.equal(receiptText(row(1)), 'Lifecycle receipt: none observed');
  assert.equal(receiptText(row(1, { receipt: { source: 'hook', event: 'Stop', receivedAt: 5_000 } })), `Lifecycle receipt: Stop hook, ${formatTime(5_000)}`);
  assert.equal(receiptText(row(1, { receipt: { source: 'report', event: 'session.end', receivedAt: 5_000 } })), `Lifecycle receipt: session.end report, ${formatTime(5_000)}`);
  assert.equal(contentText(row(1).content), 'Content coverage: native transcript, verified (S9)');
  assert.equal(contentText({ mode: 'unavailable', assurance: 'unavailable', evidence: null, gaps: [] }), 'Content coverage: unavailable');
  assert.equal(contentText({ mode: 'report-state-only', assurance: 'declared', evidence: null, gaps: ['no-text'] }), 'Content coverage: report, state only, declared; gaps: no-text');
});

test('a row name is short and names agent, profile and state', () => {
  assert.equal(agentLabel(row(1, { state: 'awaiting-trust', reasons: ['no-receipt'] })), 'Codex · Profile 1 · Awaiting trust');
  assert.equal(agentLabel(row(1, { key: { agent: 'agy', profileId: null }, name: 'Antigravity CLI', profileLabel: null, state: 'not-detected' })), 'Antigravity CLI · No profile · Not detected');
  const long = agentLabel(row(1, { profileLabel: `/tmp/xaibo-fixture/${'x'.repeat(600)}/profiles/codex-01` }));
  assert.ok(long.length < 200);
  assert.match(long, /…x+\/profiles\/codex-01 · Detected$/, 'a long profile path keeps its distinguishing end');
  // reviews (security L1, correctness M2): a service string in the accessible name is escaped too
  const rlo = String.fromCodePoint(0x202e), spoof = agentLabel(row(1, { profileLabel: `/tmp/a${rlo}exe.txt${String.fromCodePoint(10)}b` }));
  assert.ok(!spoof.includes(rlo) && !spoof.includes(String.fromCodePoint(10)), spoof);
});
