// XAIBO-PROD-110 (P1-T12): list state for the session list. First page replaces; Load more appends without duplicates;
// deltas update loaded rows and add new ones only inside the loaded window, which stays bounded (no virtualization
// before Phase 4). Order matches the service keyset: last activity descending (unknown last), then id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDelta, applyLiveDelta, applyPage, collectorStep, emptyCollector, emptyLiveSet, lastKnownLabel, bannerText, compareRows, contextText, costText, emptyList, findingBadges, formatTime, markers, PAGE,
  statusExtras } from '../../src/renderer/model.ts';
import type { LiveStatus, SessionRow } from '../../src/shared/ipc.ts';

const r = (id: number, lastActivity: number | null, extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id, agent: 'claude', entrypoint: 'cli', origin: 'CLI', interactive: true, model: 'Model unavailable', cwd: `/tmp/xaibo-fixture/${id}`, title: null, lastActivity, drift: false, compressed: false, quarantined: 0,
    live: null, contextPct: null, costUsd: null, costCoverage: 'unavailable', tokens: null, tokensComplete: true, ...extra });
const ids = (s: { rows: SessionRow[] }) => s.rows.map((x) => x.id);

test('order: newest first, ties by id, unknown activity last', () => {
  assert.deepEqual([r(3, 5), r(1, null), r(2, 9), r(4, 5)].sort(compareRows).map((x) => x.id), [2, 3, 4, 1]);
});

test('first page replaces, Load more appends without duplicates and widens the window', () => {
  let s = applyPage(emptyList, { rows: [r(9, 1)], next: null }, false);
  s = applyPage(s, { rows: [r(1, 30), r(2, 20)], next: { lastActivity: 20, id: 2 } }, false);
  assert.deepEqual(ids(s), [1, 2]);
  assert.equal(s.loaded, true);
  s = applyPage(s, { rows: [r(2, 20), r(3, 10)], next: null }, true);
  assert.deepEqual(ids(s), [1, 2, 3]);
  assert.equal(s.next, null);
  assert.equal(s.capacity, 2 * PAGE);
});

test('P4-T03: a replacing page larger than one page (a resynced window) keeps room for all its rows', () => {
  const rows = Array.from({ length: 130 }, (_, i) => r(i + 1, 1_000 - i));
  const s = applyPage(emptyList, { rows, next: { lastActivity: 870, id: 130 } }, false);
  assert.equal(s.rows.length, 130);
  assert.equal(s.capacity, 150, 'whole pages');
  assert.equal(applyDelta(s, [r(999, 2_000)]).rows.length, 131, 'a delta inside the window does not trim it back to one page');
  assert.equal(applyPage(emptyList, { rows: [r(1, 1)], next: null }, false).capacity, PAGE);
});

test('review L3: a replacing page never holds the same session twice (cursor drift between requests)', () => {
  const s = applyPage(emptyList, { rows: [r(1, 30), r(2, 20), r(1, 30)], next: null }, false);
  assert.deepEqual(s.rows.map((x) => x.id), [1, 2]);
});

test('a delta updates a loaded row and moves it up', () => {
  let s = applyPage(emptyList, { rows: [r(1, 30), r(2, 20)], next: null }, false);
  s = applyDelta(s, [r(2, 40, { drift: true })]);
  assert.deepEqual(ids(s), [2, 1]);
  assert.equal(s.rows[0]!.drift, true);
});

test('a new session is added inside the loaded window and ignored beyond it', () => {
  let s = applyPage(emptyList, { rows: [r(1, 30), r(2, 20)], next: { lastActivity: 20, id: 2 } }, false);
  s = applyDelta(s, [r(5, 25), r(6, 10)]);
  assert.deepEqual(ids(s), [1, 5, 2], 'id 6 sorts after the last loaded row and comes with Load more');
  s = applyPage(emptyList, { rows: [], next: null }, false);
  s = applyDelta(s, [r(7, 1)]);
  assert.deepEqual(ids(s), [7], 'everything is loaded, so new sessions always show');
});

test('the window stays bounded; trimmed rows come back through Load more', () => {
  let s = applyPage(emptyList, { rows: [], next: null }, false);
  s = applyDelta(s, Array.from({ length: PAGE + 5 }, (_, i) => r(i + 1, 1000 - i)));
  assert.equal(s.rows.length, PAGE);
  assert.deepEqual(s.next, { lastActivity: 1000 - (PAGE - 1), id: PAGE });
});

test('coverage markers are text plus glyph; time is local and readable', () => {
  assert.deepEqual(markers(r(1, 1)), []);
  assert.deepEqual(markers(r(1, 1, { drift: true, compressed: true, quarantined: 2 })).map((m) => m.text),
    ['Format drift', 'Compressed, not imported', '2 quarantined lines']);
  assert.ok(markers(r(1, 1, { quarantined: 1 }))[0]!.glyph.length > 0);
  assert.equal(markers(r(1, 1, { quarantined: 1 }))[0]!.text, '1 quarantined line');
  assert.equal(formatTime(new Date(2026, 0, 2, 3, 4, 5).getTime()), '2026-01-02 03:04');
  assert.equal(formatTime(null), 'Unknown');
});

// P3-T10 (XAIBO-PROD-310, Q3-5): placeholder live status text. Every state is text plus glyph, never colour alone;
// heuristic and inferred confidence are spelled out; findings name the rule and the PRD §6.4 warning.
const L = (o: Partial<LiveStatus> = {}): LiveStatus =>
  ({ lifecycle: 'busy', confidence: 'confirmed', health: 'connected', reason: null, outcome: null, findings: [], since: null, ...o });

test('status extras (P4-T01): health and last-turn outcome as words beside the status badge (design §3.2)', () => {
  assert.deepEqual(statusExtras(L()), []);
  assert.deepEqual(statusExtras(L({ health: 'stale' })), ['Stale']);
  assert.deepEqual(statusExtras(L({ health: 'detached', outcome: 'interrupted' })), ['Health: Detached', 'Last turn interrupted']);
});

test('finding badges: rule id plus the §6.4 warning name', () => {
  assert.deepEqual(findingBadges(null), []);
  assert.deepEqual(findingBadges(L({ findings: ['R1', 'R2', 'R3', 'R4', 'R5'] })).map((b) => b.text),
    ['R1 Possibly inactive', 'R2 Repeated tool', 'R3 Repeated error', 'R4 Possible loop', 'R5 Long-running tool']);
});

test('context and cost: minimal text, unavailable stays labelled, estimates marked ~', () => {
  assert.equal(contextText(null), 'Context unavailable');
  assert.equal(contextText(42.4), '42% context');
  assert.equal(contextText(0), '0% context');
  assert.equal(costText(null, 'unavailable'), '~$ unavailable');
  assert.equal(costText(1.234, 'full'), '~$1.23');
  assert.equal(costText(0.5, 'partial'), '~$0.50 known subtotal');
  assert.equal(costText(0.5, 'uncertain'), '~$0.50 known subtotal');
  assert.equal(costText(0.004, 'full'), '~$<0.01', 'a non-zero estimate never reads as $0.00');
  assert.equal(costText(0, 'full'), '~$0.00');
});

test('coverage banners: gap counts, agent names and time ranges as text', () => {
  const names = (id: string) => (id === 'claude' ? 'Claude Code' : id);
  const at = new Date(2026, 0, 2, 3, 4).getTime();
  assert.equal(bannerText({ kind: 'hook-gap', reason: 'spool-overflow', agent: 'claude', count: 3, from: at, to: at }, names),
    'Hook events missing (spool overflow): 3 from Claude Code, 2026-01-02 03:04 to 2026-01-02 03:04');
  assert.equal(bannerText({ kind: 'hook-gap', reason: 'spool-saturated', agent: null, count: null, from: null, to: null }, names),
    'Hook events missing (spool overflow, count unknown): an unknown number from an unknown agent');
  assert.equal(bannerText({ kind: 'hook-gap', reason: 'disk-full', agent: 'codex', count: 1, from: at, to: at }, names),
    'Hook events missing (disk full): 1 from codex, 2026-01-02 03:04 to 2026-01-02 03:04');
  assert.equal(bannerText({ kind: 'disk-full' }, names), 'Disk full: collection paused');
  assert.equal(bannerText({ kind: 'hooks-blocked', agent: 'claude', state: 'blocked' }, names), 'Claude Code: hooks blocked by policy (files only)');
  assert.equal(bannerText({ kind: 'hooks-blocked', agent: 'claude', state: 'unknown' }, names), 'Claude Code: hook policy unknown (files only)');
  assert.equal(bannerText({ kind: 'awaiting-trust', agent: 'codex', steps: ['a'] }, names), 'codex: hooks installed, awaiting trust');
});

// XAIBO-PROD-407 (P4-T04c): the Dashboard live set kept current by session deltas: a row that ended or that the engine no
// longer knows leaves; a live row enters or updates in list order; the set stays capped (more = true when trimmed).
test('live set: ended or unknown rows leave; live rows enter in list order; capped with more', () => {
  const on = (id: number, at: number, lifecycle: LiveStatus['lifecycle'] = 'busy') => r(id, at, { live: L({ lifecycle }) });
  let s = { rows: [on(1, 30), on(2, 20)], more: false, loaded: true };
  s = applyLiveDelta(s, [on(3, 25), r(9, 40)]); // 9 has no live status: not a member
  assert.deepEqual(ids(s), [1, 3, 2]);
  s = applyLiveDelta(s, [on(2, 50, 'needs-input')]);
  assert.deepEqual(ids(s), [2, 1, 3], 'updated and moved up');
  s = applyLiveDelta(s, [on(1, 60, 'ended'), { ...on(3, 25), live: null }]);
  assert.deepEqual(ids(s), [2]);
  const capped = applyLiveDelta({ rows: [on(1, 10), on(2, 9)], more: false, loaded: true }, [on(3, 11)], 2);
  assert.deepEqual([ids(capped), capped.more], [[3, 1], true]);
  assert.deepEqual(emptyLiveSet, { rows: [], more: false, loaded: false });
});

// P4-T04c security review: the "Last known" qualifier. Nothing is "last known" before the collector first ran; after
// that, every non-running state carries the time it stopped running.
test('collector: starting before any run reads Collection starting; a later loss keeps its time; running clears it', () => {
  let c = collectorStep(emptyCollector, 'starting', 100);
  assert.equal(lastKnownLabel(c, 'starting'), 'Collection starting');
  c = collectorStep(c, 'running', 200);
  assert.equal(lastKnownLabel(c, 'running'), null);
  c = collectorStep(c, 'restarting', new Date(2026, 0, 2, 9, 5).getTime());
  c = collectorStep(c, 'stopped', new Date(2026, 0, 2, 9, 6).getTime());
  assert.equal(lastKnownLabel(c, 'stopped'), 'since 2026-01-02 09:05', 'first loss time kept');
  c = collectorStep(c, 'running', 300);
  assert.deepEqual([c.lostAt, lastKnownLabel(c, 'running')], [null, null]);
  assert.equal(lastKnownLabel(emptyCollector, null), 'Collection starting', 'no health yet');
});

// XAIBO-PROD-436 (P4-T14b; owner decision D-P4-09): a full disk pauses collection; the band says so (not Running) and
// live labels are qualified as last known while it lasts.
test('band: a running service that reports disk full reads Paused (disk full); otherwise the health text', async () => {
  const { bandText } = await import('../../src/renderer/model.ts');
  const h = (state: 'starting' | 'running' | 'restarting' | 'stopped', attempt = 0) => ({ v: 1 as const, type: 'health' as const, state, attempt, readOnly: null });
  const full = [{ kind: 'disk-full' as const }];
  assert.deepEqual(bandText(null, full), { state: 'starting', text: 'Starting' });
  assert.deepEqual(bandText(h('running'), []), { state: 'running', text: 'Running' });
  assert.deepEqual(bandText(h('running'), full), { state: 'paused', text: 'Paused (disk full)' });
  assert.deepEqual(bandText(h('restarting', 2), full), { state: 'restarting', text: 'Restarting (attempt 2)' }, 'a stale banner never hides a restart');
  assert.deepEqual(bandText(h('running'), [{ kind: 'hooks-blocked' as const, agent: 'claude', state: 'blocked' as const }]), { state: 'running', text: 'Running' });
});

test('collector: a pause is a loss for the Last known qualifier; running again clears it', () => {
  let c = collectorStep(collectorStep(emptyCollector, 'running', 100), 'paused', new Date(2026, 0, 2, 9, 7).getTime());
  assert.equal(lastKnownLabel(c, 'paused'), 'since 2026-01-02 09:07');
  c = collectorStep(c, 'running', 300);
  assert.equal(lastKnownLabel(c, 'running'), null);
});

test('review L: a pause before any Running health (disk already full at start) still carries its time', () => {
  const c = collectorStep(emptyCollector, 'paused', new Date(2026, 0, 2, 9, 8).getTime());
  assert.equal(lastKnownLabel(c, 'paused'), 'since 2026-01-02 09:08');
});
