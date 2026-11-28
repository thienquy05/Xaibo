// XAIBO-PROD-622 (P7-T04 slice C, EC-85; design §6.7): provisional launch rows in the service. Main registers a row after a
// launch (started or failed); the renderer may remove it; evidence binds it: Claude by the pre-allocated session id; an agent
// without one only by a session absent at registration, same agent, profile and cwd, within 60 s, and only when exactly one
// row waits for that agent, profile and cwd. A bound row leaves the list and reports its session once. No timeout ends a row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionalRows, BIND_MS, type StoredSession } from '../../../src/service/launch/provisional.ts';
import { parsePortMessage, parsePortRequest, parseServiceCommand, parseServiceEvent } from '../../../src/shared/ipc.ts';
import { launchInfo } from '../../../src/service/launch/info.ts';
import { loadCatalog } from '../../../src/service/catalog/validate.ts';

const ID = '00000000-0000-4000-8000-0000000c0001';
const base = { agent: 'claude', profileId: 'p1', cwd: '/synthetic/proj', startedAt: 1_000, state: 'starting' as const, reason: null };

function setup(existing: string[] | null = [], over: Record<string, Partial<StoredSession> | null> = {}, freshFails = false) {
  let now = 1_000;
  const pushes: unknown[] = [];
  const stored: Record<string, StoredSession | null> = {
    ['claude\0p1\0' + ID]: { id: 41, startedAt: 1_000, cwdKey: '/synthetic/proj', lastActivity: 1_100 },
    'codex\0p2\0n-new': { id: 42, startedAt: 1_500, cwdKey: '/synthetic/proj', lastActivity: 1_500 },
    'codex\0p2\0n-old': { id: 40, startedAt: 500, cwdKey: '/synthetic/proj', lastActivity: 500 },
    'codex\0p2\0n-early': { id: 44, startedAt: 1_000 - 2_001, cwdKey: '/synthetic/proj', lastActivity: 1_000 - 2_001 }, // before the launch, past the skew
    'codex\0p2\0n-elsewhere': { id: 43, startedAt: 1_500, cwdKey: '/synthetic/other', lastActivity: 1_500 },
    'codex\0p2\0n-hook': { id: 45, startedAt: null, cwdKey: '/synthetic/proj', lastActivity: null },
    'codex\0p2\0n-later': { id: 46, startedAt: 1_000 + BIND_MS, cwdKey: '/synthetic/proj', lastActivity: 1_000 + BIND_MS },
  };
  for (const [k, v] of Object.entries(over)) stored[k] = v === null ? null : { ...stored[k]!, ...v };
  const reg = provisionalRows({
    now: () => now,
    existing: () => (existing === null ? null : new Set(existing)),
    stored: (agent, profileId, sid) => stored[`${agent}\0${profileId}\0${sid}`] ?? null,
    fresh: (agent, profileId, cwdKey, from, to) => (freshFails ? null : Object.entries(stored).filter(([k, v]) => k.startsWith(`${agent}\0${profileId}\0`) && v
      && v.cwdKey === cwdKey && v.startedAt !== null && v.startedAt >= from && v.startedAt < to).map(([k]) => k.split('\0')[2]!)),
    changed: (m) => pushes.push(m),
  });
  return { reg, pushes, at: (t: number) => { now = t; } };
}

test('Claude: binds by the pre-allocated id only; the bound row leaves and reports its session once', () => {
  const { reg, pushes } = setup();
  reg.register({ ...base, key: 'k1', nativeId: ID });
  assert.deepEqual(reg.list().map((r) => r.key), ['k1']);
  assert.deepEqual(pushes.at(-1), { rows: [{ ...base, key: 'k1', nativeId: ID }], bound: [] });
  reg.offer('claude', 'p1', '00000000-0000-4000-8000-0000000c0002');
  reg.offer('claude', 'p9', ID);
  assert.equal(reg.list().length, 1, 'another id or profile never binds');
  reg.offer('claude', 'p1', ID);
  assert.deepEqual(reg.list(), []);
  assert.deepEqual(pushes.at(-1), { rows: [], bound: [{ key: 'k1', session: 41 }] });
  const n = pushes.length;
  reg.offer('claude', 'p1', ID);
  assert.equal(pushes.length, n, 'reported once');
});

test('without an id: one new same-cwd start within 60 s binds; old, early, elsewhere, hook-only, late and ambiguous never do', () => {
  const codex = { ...base, agent: 'codex', profileId: 'p2', nativeId: null };
  const a = setup(['n-old']);
  a.reg.register({ ...codex, key: 'c1' });
  for (const sid of ['n-old', 'n-early', 'n-elsewhere', 'n-hook', 'n-unknown']) a.reg.offer('codex', 'p2', sid);
  assert.equal(a.reg.list().length, 1, 'present at registration, started before the launch, another cwd, no stored start, not stored');
  a.reg.offer('codex', 'p2', 'n-new');
  assert.deepEqual(a.pushes.at(-1), { rows: [], bound: [{ key: 'c1', session: 42 }] });

  const late = setup();
  late.reg.register({ ...codex, key: 'c2' });
  late.at(1_000 + BIND_MS + 1);
  late.reg.offer('codex', 'p2', 'n-new');
  assert.equal(late.reg.list().length, 1, 'past 60 s: stays Starting…, never Ended');
  late.reg.register({ ...codex, key: 'c5', startedAt: 1_000 + BIND_MS });
  late.reg.offer('codex', 'p2', 'n-later');
  assert.deepEqual(late.pushes.at(-1), { rows: [{ ...codex, key: 'c2' }], bound: [{ key: 'c5', session: 46 }] }, '622 review: a stale row never blocks a new launch');

  const two = setup();
  two.reg.register({ ...codex, key: 'c3' });
  two.reg.register({ ...codex, key: 'c4', startedAt: 1_010 });
  two.at(1_020);
  two.reg.offer('codex', 'p2', 'n-new');
  assert.equal(two.reg.list().length, 2, 'two waiting launches for one cwd: ambiguous, neither binds');

  const blind = setup(null);
  blind.reg.register({ ...codex, key: 'c6' });
  blind.reg.offer('codex', 'p2', 'n-new');
  assert.equal(blind.reg.list().length, 1, 'no snapshot (store unreadable at registration): binds only by id, so never');

  const gone = setup([], { ['claude\0p1\0' + ID]: null });
  gone.reg.register({ ...base, key: 'k9', nativeId: ID });
  gone.reg.offer('claude', 'p1', ID);
  assert.equal(gone.reg.list().length, 1, 'no stored session id: the row stays');
});

test('failed rows never bind; remove drops a row; register replaces nothing and is bounded', () => {
  const { reg, pushes } = setup();
  reg.register({ ...base, key: 'f0', nativeId: ID, state: 'failed', reason: 'open' });
  assert.deepEqual(reg.list(), [], 'security review L4: a failed update for a row already gone adds nothing');
  reg.register({ ...base, key: 'f1', nativeId: ID });
  reg.register({ ...base, key: 'f1', nativeId: ID, state: 'failed', reason: 'open' });
  reg.offer('claude', 'p1', ID);
  assert.equal(reg.list().length, 1, 'a failed launch is not bound');
  reg.register({ ...base, key: 'f1', nativeId: null });
  assert.equal(reg.list()[0]!.state, 'failed', 'a key is registered once');
  reg.remove('f1');
  reg.remove('nope');
  assert.deepEqual(reg.list(), []);
  assert.deepEqual(pushes.at(-1), { rows: [], bound: [] });
  for (let i = 0; i < 40; i++) reg.register({ ...base, key: `m${i}`, nativeId: null });
  assert.equal(reg.list().length, 32, 'bounded: the oldest rows go first');
  assert.equal(reg.list()[0]!.key, 'm8');
});

test('provisional command, remove request and push parse with exact keys', () => {
  const row = { ...base, key: '00000000-0000-4000-8000-0000000c00aa', nativeId: ID };
  assert.deepEqual(parseServiceCommand({ v: 1, type: 'provisional', row }), { v: 1, type: 'provisional', row });
  for (const bad of [{ ...row, nativeId: 'not-a-uuid' }, { ...row, key: 'not a uuid' }, { ...row, cwd: 'relative' }, { ...row, state: 'ended' }, { ...row, agent: 'Bad' }, { ...row, extra: 1 }, { ...row, startedAt: -1 }])
    assert.equal(parseServiceCommand({ v: 1, type: 'provisional', row: bad }), null, JSON.stringify(bad));
  assert.deepEqual(parsePortRequest({ v: 1, type: 'removeProvisional', key: row.key }), { v: 1, type: 'removeProvisional', key: row.key });
  assert.equal(parsePortRequest({ v: 1, type: 'removeProvisional', key: 'x' }), null);
  const push = { v: 1, type: 'provisional', rows: [row], bound: [{ key: row.key, session: 41 }] };
  assert.deepEqual(parsePortMessage(push), push);
  assert.equal(parsePortMessage({ ...push, bound: [{ key: row.key, session: -1 }] }), null);
});

test('621 review MEDIUM: an over-bound agent value is clamped, never failing the whole reply', () => {
  const long = '/' + 'a'.repeat(5000);
  const info = launchInfo(loadCatalog(), [{ agent: 'claude', state: 'detected', path: long, version: '1.0.0', id: { dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 }, manual: false }],
    [...Array(70)].map((_, i) => ({ id: `p${i}`, agent: 'claude', root: long, origin: 'manual' as const })), '/synthetic-home');
  const claude = info.find((a) => a.agent === 'claude')!;
  assert.equal(claude.executable, null, 'an executable path over the bound is not offered');
  assert.equal(claude.profiles.length, 64);
  assert.ok(claude.profiles.every((p) => p.label.length <= 4096));
  const odd = launchInfo(loadCatalog(), [], [{ id: 'x'.repeat(65), agent: 'claude', root: '/r', origin: 'manual' }, { id: 'ok', agent: 'claude', root: '/r', origin: 'default' }], '/synthetic-home');
  assert.deepEqual(odd.find((a) => a.agent === 'claude')!.profiles.map((p) => p.id), ['ok'], '622 security review: an over-long profile id is left out');
});

test('627: a row bound by id needs session activity from the launch on (a resume never binds on the old records)', () => {
  const { reg, pushes, at } = setup([], { ['claude\0p1\0' + ID]: { lastActivity: 500 } });
  reg.register({ ...base, key: 'r1', nativeId: ID, startedAt: 10_000 });
  at(10_500);
  reg.offer('claude', 'p1', ID);
  assert.equal(reg.list().length, 1, 'activity from before the resume: not bound');
  const later = setup([], { ['claude\0p1\0' + ID]: { lastActivity: 10_200 } });
  later.reg.register({ ...base, key: 'r2', nativeId: ID, startedAt: 10_000 });
  later.reg.offer('claude', 'p1', ID);
  assert.deepEqual(later.pushes.at(-1), { rows: [], bound: [{ key: 'r2', session: 41 }] });
  void pushes; void at;
});

test('G7-4 (OQ-P7-2): two eligible new sessions for one waiting launch: neither binds, in either arrival order; an unreadable store binds nothing', () => {
  const codex = { ...base, agent: 'codex', profileId: 'p2', nativeId: null };
  const second = { 'codex\0p2\0n-new2': { id: 47, startedAt: 1_600, cwdKey: '/synthetic/proj', lastActivity: 1_600 } };
  for (const order of [['n-new', 'n-new2'], ['n-new2', 'n-new']]) {
    const a = setup(['n-old'], second);
    a.reg.register({ ...codex, key: 'c1' });
    a.at(1_700);
    for (const sid of order) a.reg.offer('codex', 'p2', sid);
    assert.equal(a.reg.list().length, 1, order.join(' then '));
  }
  const f = setup(['n-old'], {}, true);
  f.reg.register({ ...codex, key: 'c1' });
  f.reg.offer('codex', 'p2', 'n-new');
  assert.equal(f.reg.list().length, 1, 'no candidate list: fail closed');
});

test('G7-1/G7-3: a starting row locks its session (pending); re-registering its key updates it (failed unlocks); removal unlocks', () => {
  const { reg, pushes } = setup();
  reg.register({ ...base, key: 'k1', nativeId: ID });
  assert.deepEqual([reg.pending('claude', 'p1', ID), reg.pending('claude', 'p2', ID), reg.pending('codex', 'p1', ID)], [true, false, false]);
  reg.register({ ...base, key: 'k1', nativeId: ID, state: 'failed', reason: 'open' });
  assert.deepEqual(reg.list(), [{ ...base, key: 'k1', nativeId: ID, state: 'failed', reason: 'open' }]);
  assert.deepEqual(pushes.at(-1), { rows: [{ ...base, key: 'k1', nativeId: ID, state: 'failed', reason: 'open' }], bound: [] });
  assert.equal(reg.pending('claude', 'p1', ID), false, 'a failed row does not lock');
  reg.register({ ...base, key: 'k2', nativeId: ID });
  reg.remove('k2');
  assert.equal(reg.pending('claude', 'p1', ID), false);
});

test('G7-3: main removes a row and the service acknowledges a registration (strict parse)', () => {
  assert.deepEqual(parseServiceCommand({ v: 1, type: 'removeProvisional', key: ID }), { v: 1, type: 'removeProvisional', key: ID });
  assert.deepEqual(parseServiceEvent({ v: 1, type: 'provisionalAck', key: ID }), { v: 1, type: 'provisionalAck', key: ID });
  for (const bad of [{ v: 1, type: 'removeProvisional', key: 'x' }, { v: 1, type: 'removeProvisional', key: ID, extra: 1 }]) assert.equal(parseServiceCommand(bad), null);
  assert.equal(parseServiceEvent({ v: 1, type: 'provisionalAck', key: 'x' }), null);
});
