// XAIBO-PROD-572 (P6-T01a slice 3; S-38, FR-54; design .handoff/p6-t01a-design.md "Slice 3 wire contract", security
// review 3647): the signIn service request at the trust boundary and its strict reply, and answerSignIn behind it:
// profile resolved from the synced profiles first, revision checks, a per-profile throttle, read-only and closed stores.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePortMessage, parsePortRequest } from '../../src/shared/ipc.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { answerSignIn, changeSignIn, mutationGate } from '../../src/service/usage/sign-in-state.ts';

const PID = '00000000-0000-4000-8000-0000000c5101';
const OTHER = '00000000-0000-4000-8000-0000000c5102';
const req = (o: Record<string, unknown>) => parsePortRequest({ v: 1, type: 'signIn', id: 1, profileId: PID, ...o });

test('requests: exact keys per op, UUID profile, strict method enum, safe revision; nothing else accepted', () => {
  assert.deepEqual(req({ op: 'read' }), { v: 1, type: 'signIn', id: 1, profileId: PID, op: 'read' });
  assert.deepEqual(req({ op: 'set', method: 'unknown', expectedRevision: 0 }), { v: 1, type: 'signIn', id: 1, profileId: PID, op: 'set', method: 'unknown', expectedRevision: 0 });
  assert.deepEqual(req({ op: 'clear', expectedRevision: 3 }), { v: 1, type: 'signIn', id: 1, profileId: PID, op: 'clear', expectedRevision: 3 });
  assert.deepEqual(req({ op: 'account-change', expectedRevision: 3 }), { v: 1, type: 'signIn', id: 1, profileId: PID, op: 'account-change', expectedRevision: 3 });
  for (const bad of [{ op: 'read', expectedRevision: 0 }, { op: 'set', method: 'api-key' }, { op: 'set', method: 'canary-method', expectedRevision: 0 },
    { op: 'set', method: 'API-KEY', expectedRevision: 0 }, { op: 'clear', expectedRevision: 0, method: 'api-key' }, { op: 'clear', expectedRevision: -1 },
    { op: 'clear', expectedRevision: 1.5 }, { op: 'clear', expectedRevision: '1' }, { op: 'account-change', expectedRevision: 0, at: 5 },
    { op: 'set', method: 'gateway', expectedRevision: 0, source: 'codex-rollout' }, { op: 'delete', expectedRevision: 0 }, { op: 'read', profileId: 'p1' },
    { op: 'read', profileId: '/tmp/xaibo-fixture/canary' }]) {
    assert.equal(req(bad), null, JSON.stringify(bad));
  }
});

const view = { profileId: PID, revision: 2, method: 'subscription', source: 'owner', at: 1000, declaration: { method: 'subscription', at: 1000 },
  evidence: { method: 'api-key', source: 'codex-rollout', version: '0.160.0', ruleId: 'syn-rule', observedAt: 900, sourceAt: 800 },
  conflict: true, usingDeclaration: true, outputStatus: 'matched', generation: 2, boundary: { at: 1000, reason: 'method' } };
const reply = (o: Record<string, unknown>) => parsePortMessage({ v: 1, type: 'signIn', id: 1, ...o });

test('replies: strict view, null view for failures, bounds re-imposed (review L5)', () => {
  assert.deepEqual(reply({ code: 'ok', view }), { v: 1, type: 'signIn', id: 1, code: 'ok', view });
  assert.deepEqual(reply({ code: 'stale', view }), { v: 1, type: 'signIn', id: 1, code: 'stale', view });
  for (const code of ['profile-not-found', 'read-only', 'unavailable', 'failed']) {
    assert.deepEqual(reply({ code, view: null }), { v: 1, type: 'signIn', id: 1, code, view: null });
    assert.equal(reply({ code, view }), null, code + ' never carries a view');
  }
  const bad = [
    { ...view, evidence: { ...view.evidence, orderAt: 1 } }, { ...view, evidence: { ...view.evidence, version: '/tmp/xaibo-fixture/v' } },
    { ...view, evidence: { ...view.evidence, ruleId: 'r'.repeat(65) } }, { ...view, evidence: { ...view.evidence, source: 'env' } },
    { ...view, method: 'guess' }, { ...view, at: 1.5 }, { ...view, outputStatus: 'unsupported-version' }, { ...view, boundary: { at: 1, reason: 'other' } },
    { ...view, extra: 1 }, { ...view, profileId: 'p1' }, { ...view, source: 'keychain' },
  ];
  for (const v of bad) assert.equal(reply({ code: 'ok', view: v }), null, JSON.stringify(v).slice(0, 120));
  assert.equal(reply({ code: 'guess', view: null }), null);
});

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }); // code review M
async function setup() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'xsip-')));
  dirs.push(d);
  const s = await openStore({ file: join(d, 'xaibo.db'), backupDir: join(d, 'b') });
  s.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES (?, 'codex', '/tmp/xaibo-fixture/c', 'manual')").run(PID);
  s.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES (?, 'codex', '/tmp/xaibo-fixture/gone', 'manual')").run(OTHER); // in the store, gone from disk
  const writer = new Writer(s.db);
  const deps = { db: s.db, writer, readOnly: false, profile: (id: string) => id === PID, allow: mutationGate() };
  return { s, writer, deps };
}
const R = (o: Record<string, unknown>) => req(o) as Extract<NonNullable<ReturnType<typeof parsePortRequest>>, { type: 'signIn' }>;

test('read: synced profiles only (review M2); an unknown or stale-on-disk profile is profile-not-found with no view, never stale', async () => {
  const { deps } = await setup();
  assert.deepEqual(answerSignIn({ ...deps, profile: () => null }, R({ op: 'read' }), 1000), { code: 'unavailable', view: null, changed: false });
  assert.deepEqual(answerSignIn(deps, { ...R({ op: 'read' }), profileId: OTHER }, 1000), { code: 'profile-not-found', view: null, changed: false });
  assert.deepEqual(answerSignIn(deps, { ...R({ op: 'clear', expectedRevision: 5 }), profileId: OTHER }, 1000), { code: 'profile-not-found', view: null, changed: false });
  const r = answerSignIn(deps, R({ op: 'read' }), 1000);
  assert.deepEqual(r, { code: 'ok', changed: false, view: { profileId: PID, revision: 0, method: 'unknown', source: null, at: null, declaration: null, evidence: null,
    conflict: false, usingDeclaration: false, outputStatus: 'unavailable', generation: 0, boundary: null } });
});

test('set, same again, stale, account change, clear: codes, views and the changed flag', async () => {
  const { deps } = await setup();
  const a = answerSignIn(deps, R({ op: 'set', method: 'api-key', expectedRevision: 0 }), 1000);
  assert.deepEqual([a.code, a.changed, a.view?.method, a.view?.source, a.view?.at, a.view?.usingDeclaration, a.view?.generation, a.view?.boundary],
    ['ok', true, 'api-key', 'owner', 1000, true, 1, { at: 1000, reason: 'method' }]);
  const same = answerSignIn(deps, R({ op: 'set', method: 'api-key', expectedRevision: 1 }), 2000);
  assert.deepEqual([same.code, same.changed, same.view?.at], ['ok', false, 1000]);
  const stale = answerSignIn(deps, R({ op: 'account-change', expectedRevision: 0 }), 3000);
  assert.deepEqual([stale.code, stale.changed, stale.view?.revision], ['stale', false, 1]);
  const acct = answerSignIn(deps, R({ op: 'account-change', expectedRevision: 1 }), 4000);
  assert.deepEqual([acct.code, acct.changed, acct.view?.generation, acct.view?.boundary], ['ok', true, 2, { at: 4000, reason: 'declared-account' }]);
  const clear = answerSignIn(deps, R({ op: 'clear', expectedRevision: 2 }), 5000);
  assert.deepEqual([clear.code, clear.view?.method, clear.view?.source, clear.view?.usingDeclaration], ['ok', 'unknown', null, false]);
  for (const r of [a, same, stale, acct, clear]) assert.notEqual(parsePortMessage({ v: 1, type: 'signIn', id: 1, code: r.code, view: r.view }), null, 'the service view passes the renderer parser');
});

test('a conflict shows both values with their times', async () => {
  const { s, writer, deps } = await setup();
  const t = Date.now() - 60_000;
  writer.transact((db) => changeSignIn(db, PID, { kind: 'evidence', result: { kind: 'matched', method: 'gateway', ruleId: 'syn-rule' }, source: 'codex-rollout', version: '0.160.0', sourceAt: t }, t + 1));
  const r = answerSignIn(deps, R({ op: 'set', method: 'subscription', expectedRevision: 1 }), t + 2);
  assert.deepEqual([r.view?.conflict, r.view?.method, r.view?.declaration, r.view?.evidence, r.view?.outputStatus],
    [true, 'subscription', { method: 'subscription', at: t + 2 }, { method: 'gateway', source: 'codex-rollout', version: '0.160.0', ruleId: 'syn-rule', observedAt: t + 1, sourceAt: t }, 'matched']);
  void s;
});

test('a commit whose view read then fails still reports the change (code review): failed, no view, changed', async () => {
  const { s, deps } = await setup();
  const db = new Proxy(s.db, { get(t, k) {
    if (k === 'prepare') return (sql: string) => { if (sql.includes('ORDER BY generation DESC')) throw new Error('database is locked'); return t.prepare(sql); };
    const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
  } });
  assert.deepEqual(answerSignIn({ ...deps, db }, R({ op: 'set', method: 'gateway', expectedRevision: 0 }), 1000), { code: 'failed', view: null, changed: true });
  assert.equal((s.db.prepare('SELECT declared_method AS m FROM profile_sign_in').get() as { m: string }).m, 'gateway', 'the change was committed');
});

test('read-only and closed stores change nothing and say so (no view, no input echoed)', async () => {
  const { s, deps } = await setup();
  const ro = { ...deps, readOnly: true };
  assert.equal(answerSignIn(ro, R({ op: 'read' }), 1000).code, 'ok');
  assert.deepEqual(answerSignIn(ro, R({ op: 'set', method: 'gateway', expectedRevision: 0 }), 1000), { code: 'read-only', view: null, changed: false });
  assert.equal((s.db.prepare('SELECT count(*) AS n FROM profile_sign_in').get() as { n: number }).n, 0);
  s.db.close();
  assert.deepEqual(answerSignIn(deps, R({ op: 'set', method: 'gateway', expectedRevision: 0 }), 1000), { code: 'failed', view: null, changed: false });
  assert.deepEqual(answerSignIn(deps, R({ op: 'read' }), 1000), { code: 'failed', view: null, changed: false });
});

test('throttle: at most 10 changes per profile per minute, so a renderer cannot burn the epoch budget (review M1)', async () => {
  const gate = mutationGate();
  for (let i = 0; i < 10; i++) assert.equal(gate(PID, 1000 + i), true);
  assert.equal(gate(PID, 1020), false);
  assert.equal(gate(OTHER, 1020), true, 'per profile');
  assert.equal(gate(PID, 61_001), true, 'the window moves on');
  const { s, deps } = await setup();
  let rev = 0;
  let limited = 0;
  for (let i = 0; i < 300; i++) {
    const r = answerSignIn(deps, R({ op: 'set', method: i % 2 ? 'api-key' : 'subscription', expectedRevision: rev }), 1000 + i);
    if (r.code === 'limit') limited++; else rev = r.view!.revision;
  }
  assert.equal(limited, 290);
  assert.equal((s.db.prepare('SELECT count(*) AS n FROM sign_in_boundaries').get() as { n: number }).n, 10);
});
