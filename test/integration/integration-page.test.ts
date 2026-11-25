// XAIBO-PROD-574 (P6-T10 unit 2a; FR-06; design .handoff/p6-t10-design.md sections 1-2, review R2/R3/R7/R10): the last
// lifecycle receipt from the stored deliveries, the receipt index, the integrationPage request/reply contract and the
// service page (rows per agent/profile from detection, reconcile, trust, policy and receipts; stable paging).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, schemaSnapshot } from '../../src/service/store/db.ts';
import { loadCatalog } from '../../src/service/catalog/validate.ts';
import { parsePortMessage, parsePortRequest } from '../../src/shared/ipc.ts';
import { answerIntegrationPage, lastReceipt, type PageDeps } from '../../src/service/integrations/state.ts';

const C1 = '00000000-0000-4000-8000-0000000c7401', C2 = '00000000-0000-4000-8000-0000000c7402', X1 = '00000000-0000-4000-8000-0000000c7403';
const S = '00000000-0000-4000-8000-0000000c74f1';
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
async function store() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'xip-')));
  dirs.push(d);
  return (await openStore({ file: join(d, 'xaibo.db'), backupDir: join(d, 'b') })).db;
}
let n = 0;
const hook = (db: Awaited<ReturnType<typeof store>>, o: { agent?: string; profile?: string; session?: string | null; event?: string; at: number; unattributed?: string | null }) =>
  db.prepare('INSERT INTO hook_delivery (delivery_id, agent, profile_key, native_session_id, event, received_ts, committed_ts, unattributed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('d' + (n++), o.agent ?? 'claude', o.profile ?? C1, o.session === undefined ? S : o.session, o.event ?? 'Stop', o.at, o.at, o.unattributed ?? null);

test('028: receipt indexes exist and schema.sql matches', async () => {
  const db = await store();
  const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%receipt%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(idx, ['hook_delivery_receipt', 'report_delivery_receipt']);
  assert.equal(schemaSnapshot(db), readFileSync(new URL('../../src/service/store/schema.sql', import.meta.url), 'utf8'));
});

test('a receipt is the newest attributed lifecycle delivery with a session after install; nothing else counts', async () => {
  const db = await store();
  hook(db, { at: 1_000, event: 'SessionStart' }); // before install
  hook(db, { at: 5_000, event: 'Stop' });
  hook(db, { at: 6_000, event: 'statusline' }); // usage only
  hook(db, { at: 7_000, session: null }); // no session
  hook(db, { at: 8_000, unattributed: 'unknown-profile' });
  hook(db, { at: 9_000, profile: C2 }); // another profile
  hook(db, { at: 9_500, agent: 'codex' }); // another agent
  assert.deepEqual(lastReceipt(db, 'claude', C1, 2_000), { source: 'hook', event: 'Stop', receivedAt: 5_000 });
  assert.equal(lastReceipt(db, 'claude', C1, 5_000), null, 'strictly after install');
  assert.equal(lastReceipt(db, 'claude', C1, null), null, 'nothing installed: no receipt');
});

const R = (o: Record<string, unknown>) => parsePortRequest({ v: 1, type: 'integrationPage', id: 1, ...o });
test('requests: cursor, direction and limit 1..10 only', () => {
  assert.deepEqual(R({ cursor: null, direction: 'next', limit: 10 }), { v: 1, type: 'integrationPage', id: 1, cursor: null, direction: 'next', limit: 10 });
  assert.deepEqual(R({ cursor: { agent: 'codex', profileId: C1 }, direction: 'previous', limit: 1 }), { v: 1, type: 'integrationPage', id: 1, cursor: { agent: 'codex', profileId: C1 }, direction: 'previous', limit: 1 });
  assert.ok(R({ cursor: { agent: 'agy', profileId: null }, direction: 'next', limit: 3 }));
  for (const bad of [{ cursor: null, direction: 'next', limit: 0 }, { cursor: null, direction: 'next', limit: 11 }, { cursor: null, direction: 'up', limit: 3 },
    { cursor: { agent: 'Bad Agent', profileId: null }, direction: 'next', limit: 3 }, { cursor: { agent: 'claude', profileId: 'p1' }, direction: 'next', limit: 3 },
    { cursor: { agent: 'claude', profileId: null, root: '/tmp/x' }, direction: 'next', limit: 3 }, { cursor: null, direction: 'next', limit: 3, path: '/tmp/x' }]) {
    assert.equal(R(bad), null, JSON.stringify(bad));
  }
});

const row = { key: { agent: 'claude', profileId: C1 }, name: 'Claude Code', profileLabel: 'Default profile', version: '2.1.332', state: 'connected', reasons: [],
  lifecycleGaps: [], receipt: { source: 'hook', event: 'Stop', receivedAt: 5000 }, content: { mode: 'native-transcript', assurance: 'verified', evidence: 'S9', gaps: [] } };
const M = (result: unknown) => parsePortMessage({ v: 1, type: 'integrationPage', id: 1, result });
test('replies: bounded rows, fixed state and reason codes, refusals with a fixed code', () => {
  const ok = { status: 'ready', observedAt: 9000, value: { rows: [row], previous: null, next: { agent: 'claude', profileId: C1 } } };
  assert.deepEqual(M(ok), { v: 1, type: 'integrationPage', id: 1, result: ok });
  assert.deepEqual(M({ status: 'refused', code: 'starting' }), { v: 1, type: 'integrationPage', id: 1, result: { status: 'refused', code: 'starting' } });
  for (const v of [{ ...row, state: 'guess' }, { ...row, reasons: ['free text'] }, { ...row, receipt: { ...row.receipt, payload: 'x' } },
    { ...row, content: { ...row.content, mode: 'full' } }, { ...row, lifecycleGaps: ['other'] }, { ...row, key: { agent: 'claude', profileId: '/tmp/x' } }, { ...row, extra: 1 }]) {
    assert.equal(M({ status: 'ready', observedAt: 9000, value: { rows: [v], previous: null, next: null } }), null, JSON.stringify(v).slice(0, 100));
  }
  assert.equal(M({ status: 'ready', observedAt: 9000, value: { rows: Array(11).fill(row), previous: null, next: null } }), null, 'at most 10 rows');
  assert.equal(M({ status: 'refused', code: 'boom: /tmp/x' }), null);
});

async function deps(o: Partial<PageDeps> = {}): Promise<PageDeps> {
  const db = await store();
  const catalog = loadCatalog();
  return {
    db, catalog, home: '/tmp/xaibo-fixture/home', now: 10_000,
    detections: [{ agent: 'claude', state: 'detected', path: '/x/claude', version: '2.1.332', id: { dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 }, manual: false },
      { agent: 'codex', state: 'detected', path: '/x/codex', version: '0.160.0', id: { dev: 1, ino: 2, size: 1, mtimeMs: 1, ctimeMs: 1 }, manual: false },
      { agent: 'agy', state: 'not-detected' }],
    profiles: [{ id: C1, agent: 'claude', root: '/tmp/xaibo-fixture/home/.claude', origin: 'default' }, { id: C2, agent: 'codex', root: '/tmp/xaibo-fixture/home/.codex', origin: 'default' },
      { id: X1, agent: 'codex', root: '/tmp/xaibo-fixture/other/.codex', origin: 'manual' }],
    reconcile: () => ({ status: 'ready', entries: [{ entry: C1, route: 'claude-plugin', profileId: C1, state: 'connected', cleanup: [], manual: [] },
      { entry: C2, route: 'codex-hooks', profileId: C2, state: 'connected', cleanup: [], manual: [] }] }),
    installedAt: (p) => (p.id === X1 ? null : 1_000),
    trust: (p) => (p.id === C2 ? 'awaiting-trust' : null),
    policy: () => null,
    ...o,
  };
}
test('hook policy is Claude only; an unreadable policy is unreadable, not blocked (code review H, M2)', async () => {
  const d = await deps({ policy: (p) => (p.agent === 'claude' ? 'blocked' : null), trust: () => 'connected' });
  hook(d.db, { at: 5_000 });
  hook(d.db, { at: 5_000, agent: 'codex', profile: C2, event: 'Stop' });
  const r = ask(d, null, 'next', 10);
  const by = (pid: string) => (r.status === 'ready' ? r.value.rows.find((x) => x.key.profileId === pid) : undefined);
  assert.deepEqual([by(C1)?.state, by(C1)?.reasons], ['setup-required', ['hooks-blocked']]);
  assert.equal(by(C2)?.state, 'connected', 'a Claude policy never blocks Codex');
  const u = ask(await deps({ policy: () => 'unknown' }), null, 'next', 10);
  assert.deepEqual(u.status === 'ready' ? u.value.rows.find((x) => x.key.profileId === C1)?.reasons : null, ['unreadable']);
});

test('a gap recorded without an agent limits every agent (code review M3); a report delivery can be the receipt', async () => {
  const d = await deps();
  hook(d.db, { at: 5_000 });
  d.db.prepare("INSERT INTO hook_gaps (reason, agent, locator, recorded_at) VALUES ('spool-overflow', NULL, 'g1', ?)").run(d.now - 1000);
  const r = ask(d, null, 'next', 10);
  const c1 = r.status === 'ready' ? r.value.rows.find((x) => x.key.profileId === C1) : undefined;
  assert.deepEqual([c1?.state, c1?.reasons, c1?.lifecycleGaps], ['partial-coverage', ['hook-gap'], ['spool-overflow']]);
  d.db.prepare(`INSERT INTO report_delivery (registration_id, delivery_id, agent, profile_key, native_session_id, event, producer_id, producer_seq, received_ts, committed_ts)
    VALUES ('r', 'd1', 'agy', ?, ?, 'Stop', 'p', 1, 7000, 7000)`).run(C1, S);
  assert.deepEqual(lastReceipt(d.db, 'agy', C1, 1_000, ['Stop']), { source: 'report', event: 'Stop', receivedAt: 7_000 });
  assert.equal(lastReceipt(d.db, 'agy', C1, 1_000, ['SessionStart']), null, 'an event outside the lifecycle set never counts');
});

const ask = (d: PageDeps, cursor: unknown, direction: string, limit: number) => answerIntegrationPage(d, R({ cursor, direction, limit }) as never);

test('the page: one row per agent/profile, states from the evidence, stable order, paging both ways', async () => {
  const d = await deps();
  hook(d.db, { at: 5_000 });
  const all = ask(d, null, 'next', 10);
  assert.equal(all.status, 'ready');
  const rows = all.status === 'ready' ? all.value.rows : [];
  assert.deepEqual(rows.map((r) => [r.key.agent, r.key.profileId, r.state, r.reasons]), [
    ['agy', null, 'not-detected', ['no-executable']],
    ['claude', C1, 'connected', []],
    ['codex', C2, 'awaiting-trust', ['no-receipt']],
    ['codex', X1, 'detected', ['not-connected']],
  ]);
  assert.deepEqual(rows[1]!.receipt, { source: 'hook', event: 'Stop', receivedAt: 5_000 });
  assert.deepEqual(rows[1]!.content, { mode: 'native-transcript', assurance: 'verified', evidence: 'S9', gaps: [] });
  assert.equal(rows[1]!.profileLabel, 'Default profile');
  assert.notEqual(M(all), null, 'the service reply passes the renderer parser');
  const p1 = ask(d, null, 'next', 2);
  const p2 = ask(d, p1.status === 'ready' ? p1.value.next : null, 'next', 2);
  assert.deepEqual(p2.status === 'ready' ? p2.value.rows.map((r) => r.key.profileId) : [], [C2, X1]);
  const back = ask(d, p2.status === 'ready' ? p2.value.previous : null, 'previous', 2);
  assert.deepEqual(back.status === 'ready' ? back.value.rows.map((r) => r.key.agent) : [], ['agy', 'claude']);
  assert.equal(p2.status === 'ready' ? p2.value.next : 'x', null, 'no next after the last row');
});

test('evidence that cannot be read is Setup required; before profile sync the page is starting', async () => {
  const blocked = await deps({ reconcile: () => ({ status: 'blocked', code: 'busy' }) });
  const r = ask(blocked, null, 'next', 10);
  assert.deepEqual(r.status === 'ready' ? r.value.rows.find((x) => x.key.profileId === C1)?.reasons : null, ['evidence-unavailable']);
  assert.deepEqual(r.status === 'ready' ? r.value.rows.find((x) => x.key.profileId === X1)?.reasons : null, ['not-connected'], 'a busy reconcile never masks a profile with nothing installed (code review M4)');
  const noManifest = ask(await deps({ reconcile: () => ({ status: 'blocked', code: 'manifest' }) }), null, 'next', 10);
  assert.deepEqual(noManifest.status === 'ready' ? noManifest.value.rows.find((x) => x.key.profileId === X1)?.reasons : null, ['evidence-unavailable'], 'an unreadable manifest is unknown for every profile');
  assert.deepEqual(ask(await deps({ catalog: null }), null, 'next', 10), { status: 'refused', code: 'unavailable' }, 'no catalog: unavailable, never an empty list');
  assert.deepEqual(ask(await deps({ profiles: null }), null, 'next', 10), { status: 'refused', code: 'starting' });
  assert.deepEqual(ask(await deps(), { agent: 'claude', profileId: '00000000-0000-4000-8000-0000000c74ff' }, 'next', 10), { status: 'refused', code: 'stale-cursor' });
});
