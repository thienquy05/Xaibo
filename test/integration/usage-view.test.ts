// XAIBO-PROD-405 (P4-T04b1; design §6.1 Usage scopes / Observed history, PRD §5.11, FR-46, Q-4.4): the usage reply
// carries the newest stored measurement per scope and stream as raw fields (the renderer derives stale/reset-passed at
// render time), an explicit passive-unavailable row per agy profile and a no-observation row per Claude/Codex profile
// without scopes; history pages return one scope+stream's observations in a time window, in order, by keyset cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerUsage, answerUsageHistory, HISTORY_MAX } from '../../src/service/api.ts';
import { parsePortMessage } from '../../src/shared/ipc.ts';
import { openStore } from '../../src/service/store/db.ts';

const HOME = '/tmp/xaibo-fixture/home';
const T = Date.parse('2026-01-02T00:00:00.000Z');
const MIN = 60_000;

async function store() {
  const dir = mkdtempSync(join(tmpdir(), 'xuv-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'b') });
  const prof = db.prepare('INSERT INTO profiles (id, agent, root, origin) VALUES (?, ?, ?, ?)');
  prof.run('p1', 'claude', `${HOME}/.claude`, 'default');
  prof.run('p2', 'claude', `${HOME}/work/.claude-alt`, 'manual');
  prof.run('c1', 'codex', `${HOME}/.codex`, 'default');
  prof.run('c2', 'codex', '/tmp/xaibo-fixture/elsewhere', 'env');
  prof.run('a1', 'agy', `${HOME}/.gemini`, 'default');
  const scope = db.prepare('INSERT INTO usage_scopes (scope_key, profile_id, agent, epoch, verified) VALUES (?, ?, ?, ?, ?)');
  const s1 = Number(scope.run('k1', 'p1', 'claude', null, 0).lastInsertRowid);
  const s2 = Number(scope.run('k2', 'c1', 'codex', 'epoch-marker', 1).lastInsertRowid);
  const hist = db.prepare(`INSERT INTO usage_history (schema_version, usage_scope_id, limit_id, kind, minute, used_percent, window_minutes, resets_at,
    plan, credits, as_of, first_observed_at, observed_at, measured_at, source, source_locator) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixture', 'loc')`);
  const put = (s: number, stream: string, at: number, o: { kind?: string; used?: number | null; win?: number | null; reset?: number | null; plan?: string | null; credits?: string | null; asOf?: number | null } = {}) =>
    Number(hist.run(s, stream, o.kind ?? 'sample', Math.floor(at / MIN), o.used === undefined ? 10 : o.used, o.win === undefined ? 300 : o.win, o.reset ?? null,
      o.plan ?? null, o.credits ?? null, o.asOf === undefined ? null : o.asOf, at, at, at).lastInsertRowid);
  return { db, s1, s2, put };
}

test('usage: newest measurement per scope and stream as raw fields; agy passive; no-observation rows; labels never show the home path', async () => {
  const { db, s1, s2, put } = await store();
  put(s1, 'five_hour', T, { used: 40 });
  put(s1, 'five_hour', T + 5 * MIN, { used: 101, reset: T + 60 * MIN }); // above 100 % kept
  put(s1, 'seven_day', T, { used: null, win: 10_080 }); // a null reading stays null, never 0
  put(s2, 'codex:primary', T + MIN, { used: 25, plan: 'pro', credits: JSON.stringify({ has_credits: true, balance: '12.50' }), asOf: T + MIN });
  const reply = answerUsage(db, { v: 1, type: 'usage', id: 3 }, HOME);
  assert.equal(reply.id, 3);
  const base = { verified: null, stream: null, windowMinutes: null, usedPercent: null, resetsAt: null, plan: null, credits: null, asOf: null, firstObservedAt: null, measuredAt: null };
  // XAIBO-PROD-582: identity and sign-in fields are checked in their own test below
  assert.deepEqual(reply.scopes.map(({ profileId: _p, generation: _g, boundary: _b, ...rest }) => rest), [
    { ...base, scope: null, agent: 'agy', profile: 'Default profile', unavailable: 'passive' },
    { scope: s1, agent: 'claude', profile: 'Default profile', verified: false, stream: 'five_hour', windowMinutes: 300, usedPercent: 101, resetsAt: T + 60 * MIN,
      plan: null, credits: null, asOf: null, firstObservedAt: T + 5 * MIN, measuredAt: T + 5 * MIN, unavailable: null },
    { scope: s1, agent: 'claude', profile: 'Default profile', verified: false, stream: 'seven_day', windowMinutes: 10_080, usedPercent: null, resetsAt: null,
      plan: null, credits: null, asOf: null, firstObservedAt: T, measuredAt: T, unavailable: null },
    { ...base, scope: null, agent: 'claude', profile: '~/work/.claude-alt', unavailable: 'no-observation' },
    { scope: s2, agent: 'codex', profile: 'Default profile', verified: true, stream: 'codex:primary', windowMinutes: 300, usedPercent: 25, resetsAt: null,
      plan: 'pro', credits: { hasCredits: true, unlimited: null, balance: '12.50' }, asOf: T + MIN, firstObservedAt: T + MIN, measuredAt: T + MIN, unavailable: null },
    { ...base, scope: null, agent: 'codex', profile: '/tmp/xaibo-fixture/elsewhere', unavailable: 'no-observation' },
  ]);
  assert.ok(!JSON.stringify(reply).includes(`${HOME}/`), 'home directory never sent');
});

test('usageHistory: one scope and stream, window [from, to), time order, keyset pages without gaps or duplicates, capped', async () => {
  const { db, s1, s2, put } = await store();
  const ids: number[] = [];
  for (let i = 0; i < 7; i++) ids.push(put(s1, 'five_hour', T + i * MIN, { used: i, kind: i === 3 ? 'transition' : 'sample', asOf: i === 2 ? T + i * MIN : null }));
  put(s1, 'five_hour', T - MIN); // before the window
  put(s1, 'five_hour', T + 24 * 60 * MIN); // at `to`: excluded
  put(s1, 'seven_day', T + MIN); // other stream
  put(s2, 'five_hour', T + MIN); // other scope
  const req = { v: 1 as const, type: 'usageHistory' as const, id: 1, scope: s1, stream: 'five_hour', from: T, to: T + 24 * 60 * MIN, cursor: null, limit: 3 };
  const seen: number[] = [];
  let page = answerUsageHistory(db, req);
  assert.deepEqual(page.records[2], { id: ids[2], kind: 'sample', measuredAt: T + 2 * MIN, usedPercent: 2, windowMinutes: 300, resetsAt: null, sourceTimeKnown: true });
  assert.equal(page.records[0]!.sourceTimeKnown, false);
  for (;;) {
    seen.push(...page.records.map((r) => r.id));
    if (!page.next) break;
    page = answerUsageHistory(db, { ...req, cursor: page.next });
  }
  assert.deepEqual(seen, ids);
  assert.equal(HISTORY_MAX, 100);
  for (let i = 0; i < 120; i++) put(s2, 'many', T + i * MIN); // one sample per minute (unique index)
  assert.equal(answerUsageHistory(db, { ...req, scope: s2, stream: 'many', limit: 1000 }).records.length, HISTORY_MAX);
});

test('a store that cannot answer gives empty replies', async () => {
  const { db, s1 } = await store();
  db.close();
  assert.deepEqual(answerUsage(db, { v: 1, type: 'usage', id: 2 }, HOME), { v: 1, type: 'usage', id: 2, scopes: [], profiles: [] });
  assert.deepEqual(answerUsageHistory(db, { v: 1, type: 'usageHistory', id: 4, scope: s1, stream: 'five_hour', from: 0, to: 1, cursor: null, limit: 50 }),
    { v: 1, type: 'usageHistory', id: 4, records: [], next: null });
});

// XAIBO-PROD-582 (P6-T10a unit 1; design .handoff/p6-t10a-design.md, review R4, D-P6-17): each scope names its profile, its
// sign-in generation and that generation's boundary (generation 0: none, never invented; a later change never relabels it);
// every profile is listed once with its current sign-in view, from the database only.
test('P6-T10a: scopes carry profile, generation and that generation\'s boundary; every profile listed with its sign-in view', async () => {
  const { db, s1, s2, put } = await store();
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('r1', '9code', '/tmp/xaibo-fixture/reg', 'registration'), ('r2', 'acme', '/tmp/xaibo-fixture/acme', 'registration')").run();
  put(s1, 'five_hour', T, { used: 40 });
  db.prepare("INSERT INTO sign_in_boundaries (profile_id, generation, revision, at, reason, method) VALUES ('c1', 1, 1, ?, 'method', 'api-key'), ('c1', 2, 2, ?, 'declared-account', 'subscription')").run(T, T + MIN);
  db.prepare('UPDATE usage_scopes SET sign_in_generation = 1 WHERE id = ?').run(s2); // an older epoch: the profile is on generation 2 now
  put(s2, 'codex:primary', T + MIN, { used: 25 });
  const reply = answerUsage(db, { v: 1, type: 'usage', id: 5 }, HOME);
  const pick = (s: (typeof reply.scopes)[number]) => [s.profileId, s.generation, s.boundary];
  assert.deepEqual(pick(reply.scopes.find((s) => s.scope === s1)!), ['p1', 0, null], 'generation 0: no invented provenance');
  assert.deepEqual(pick(reply.scopes.find((s) => s.scope === s2)!), ['c1', 1, { method: 'api-key', at: T, reason: 'method' }], 'its own generation, not today\'s');
  assert.deepEqual(reply.scopes.filter((s) => s.scope === null).map(pick), [['a1', null, null], ['p2', null, null], ['c2', null, null]]);
  assert.deepEqual(reply.profiles.map((p) => [p.profileId, p.agent, p.label]), [
    ['r2', 'acme', '/tmp/xaibo-fixture/acme'], ['a1', 'agy', 'Default profile'], ['p1', 'claude', 'Default profile'], ['p2', 'claude', '~/work/.claude-alt'],
    ['c1', 'codex', 'Default profile'], ['c2', 'codex', '/tmp/xaibo-fixture/elsewhere'],
  ].sort((a, b) => (a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : a[0]! < b[0]! ? -1 : 1)), 'agent then id; a custom agent included, one whose id the parser refuses (9code) left out');
  // review H1: only a UUID profile can be declared or opened; any other id (a registration profile key) carries no view
  assert.ok(reply.profiles.every((p) => p.signIn === null), 'these fixture ids are not UUIDs');
  const U = '00000000-0000-4000-8000-0000000c8211';
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES (?, 'claude', '/tmp/xaibo-fixture/u', 'manual')").run(U);
  const withU = answerUsage(db, { v: 1, type: 'usage', id: 6 }, HOME);
  const u = withU.profiles.find((p) => p.profileId === U)!;
  assert.equal(u.signIn?.profileId, U);
  assert.equal(u.signIn?.method, 'unknown', 'no declaration, no shipped rules: Unknown');
  assert.ok(parsePortMessage(withU), 'review H1: the whole reply passes the renderer parser with a registration profile in it');
  assert.ok(!JSON.stringify(reply).includes(`${HOME}/`), 'home directory never sent');
});

test('review M/L: a custom registration profile adds no row; a trailing slash in home still hides it', async () => {
  const { db } = await store();
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('r1', '9code', '/tmp/xaibo-fixture/reg', 'registration')").run();
  const scopes = answerUsage(db, { v: 1, type: 'usage', id: 1 }, `${HOME}/`).scopes;
  assert.ok(!scopes.some((s) => s.agent === '9code'), 'no usage source: no row (and its id would void the reply)');
  assert.ok(scopes.some((s) => s.profile === '~/work/.claude-alt'));
  assert.ok(!JSON.stringify(scopes).includes(`${HOME}/`));
});
