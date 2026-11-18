// XAIBO-PROD-517 (P5-T09/T10; FR-12, US-6, Q-5.5, EC-22, EC-42): the session retention policy. Never purge an active
// (busy, waiting for permission, needs input), recent (< 24 h), Keep or in-Trash session; the purge date is N x 24 h of
// elapsed time after the last activity; the setting is 1-3650 days or Never, default 45.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { clockJumped, DAY, eligible, isActive, parseRetention, purgeAt, RETENTION_DEFAULT, retentionOf, setRetention } from '../../../src/service/retention/policy.ts';
import { retentionScheduler } from '../../../src/service/retention/job.ts';
import { blocks, refuses, type Marker, type SuppressionReason } from '../../../src/service/history/suppression.ts';
import { trashExpired, trashPurgeAt } from '../../../src/service/history/trash.ts';
import type { LiveStatus } from '../../../src/shared/ipc.ts';

const NOW = Date.UTC(2026, 10, 18, 12);
const old = { lastActivity: NOW - 46 * DAY, keep: false, trashed: false, active: false };
const R45 = { days: 45 };

test('setting: integer days 1-3650 or never; anything else is refused (Q-5.5)', () => {
  assert.equal(RETENTION_DEFAULT, 45);
  assert.deepEqual(parseRetention('never'), 'never');
  for (const d of [1, 45, 3650]) assert.deepEqual(parseRetention(d), { days: d });
  for (const bad of [0, 3651, 1.5, -1, NaN, Infinity, '45', null, undefined, {}, 'Never']) assert.equal(parseRetention(bad), null, String(bad));
});

test('setting: stored in kv, default 45 only when unset; an unreadable stored value is no setting (null), never 45', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  assert.deepEqual(retentionOf(db), { days: 45 });
  assert.equal(setRetention(db, 'never'), true);
  assert.deepEqual(retentionOf(db), 'never');
  assert.equal(setRetention(db, 30), true);
  assert.deepEqual(retentionOf(db), { days: 30 });
  assert.equal(setRetention(db, 0), false);
  assert.deepEqual(retentionOf(db), { days: 30 }, 'unchanged');
  // review M1: a garbled or future-format value must not purge history the owner chose to keep
  for (const stored of ['garbage', '0045', '45abc', '3651', 'NEVER', '']) {
    db.prepare("UPDATE kv SET value = ? WHERE key = 'retention.sessions'").run(stored);
    assert.equal(retentionOf(db), null, stored);
  }
});

test('review H3: a wall clock that ran more than 1 h ahead of the monotonic clock is a jump', () => {
  assert.equal(clockJumped({ wall: 0, mono: 0 }, { wall: DAY, mono: DAY }), false);
  assert.equal(clockJumped({ wall: 0, mono: 0 }, { wall: DAY + 3600_000 + 1, mono: DAY }), true);
  assert.equal(clockJumped({ wall: 0, mono: 0 }, { wall: DAY - 7 * DAY, mono: DAY }), false, 'backward: the elapsed checks never purge then');
});

test('purge date: last activity + N x 24 h of elapsed time; none for Never or unknown activity (US-6, EC-42)', () => {
  assert.equal(purgeAt(NOW, R45), NOW + 45 * DAY);
  assert.equal(purgeAt(NOW, 'never'), null);
  assert.equal(purgeAt(null, R45), null);
});

test('EC-22: active, recent, Keep and Trash are never eligible; exactly N x 24 h elapsed is', () => {
  assert.equal(eligible(old, R45, NOW), true);
  for (const k of ['keep', 'trashed', 'active'] as const) assert.equal(eligible({ ...old, [k]: true }, R45, NOW), false, k);
  assert.equal(eligible({ ...old, lastActivity: null }, R45, NOW), false, 'unknown age');
  assert.equal(eligible({ ...old, lastActivity: NOW - 45 * DAY }, R45, NOW), true, 'exactly 45 x 24 h');
  assert.equal(eligible({ ...old, lastActivity: NOW - 45 * DAY + 1 }, R45, NOW), false, 'one ms short');
  assert.equal(eligible(old, 'never', NOW), false);
  assert.equal(eligible({ ...old, lastActivity: NOW - 23 * 3600_000 }, { days: 1 }, NOW), false, 'activity under 24 h');
  assert.equal(eligible({ ...old, lastActivity: NOW + DAY }, R45, NOW), false, 'activity in the future (clock set back)');
});

// review H1: the monotonic clock stops while the machine sleeps, so the scheduler re-baselines on wake; a jump skips one
// run and retries after the short delay, never a whole day
function fakeScheduler() {
  const t = { wall: 0, mono: 0 };
  let pending: { fn: () => void; ms: number } | null = null;
  const runs: number[] = [], skips: number[] = [];
  const s = retentionScheduler({ delayMs: 600_000, run: () => runs.push(t.wall), wall: () => t.wall, mono: () => t.mono,
    setTimer: (fn, ms) => { pending = { fn, ms }; return 1; }, clearTimer: () => { pending = null; }, log: () => skips.push(t.wall) });
  const fire = (awake: number, slept = 0) => { t.mono += awake; t.wall += awake + slept; const p = pending!; pending = null; p.fn(); };
  return { t, s, runs, skips, fire, next: () => pending?.ms };
}

test('scheduler: first run after the delay, then daily', () => {
  const f = fakeScheduler();
  f.s.start();
  assert.equal(f.next(), 600_000);
  f.fire(600_000);
  assert.equal(f.runs.length, 1);
  assert.equal(f.next(), DAY);
  f.fire(DAY);
  assert.equal(f.runs.length, 2);
  f.s.stop();
  assert.equal(f.next(), undefined);
});

test('scheduler: a night of sleep reported by wake() is no clock jump; a jump while awake skips once and retries soon', () => {
  const f = fakeScheduler();
  f.s.start();
  f.fire(600_000);
  f.t.mono += 1000; f.t.wall += 1000 + 8 * 3600_000; f.s.wake(); // slept 8 h; the service was told
  f.fire(DAY - 1000);
  assert.equal(f.runs.length, 2, 'ran after the sleep');
  f.fire(DAY, 3 * 3600_000); // the wall clock ran 3 h ahead while awake
  assert.deepEqual([f.runs.length, f.skips.length, f.next()], [2, 1, 600_000]);
  f.fire(600_000);
  assert.equal(f.runs.length, 3, 'the retry runs');
});

test('EC-22: busy, waiting for permission and needs input are active; the rest are not', () => {
  for (const l of ['busy', 'waiting-for-permission', 'needs-input'] as const) assert.equal(isActive(l), true, l);
  for (const l of ['idle', 'error', 'ended', 'unknown'] as const) assert.equal(isActive(l), false, l);
  assert.equal(isActive(null), false, 'no live status');
});

// P5-T10 (EC-22): a fake lifecycle table through the job's two checks (isActive feeds eligible). Only idle, error, ended
// or unknown sessions without Keep, last active N x 24 h ago, are purged.
test('EC-22: fake lifecycle table, only the old, idle-like, unkept rows are eligible', () => {
  const rows: [LiveStatus['lifecycle'] | null, number, boolean, boolean][] = [
    // lifecycle, age, keep, expected
    ['busy', 60 * DAY, false, false], ['waiting-for-permission', 60 * DAY, false, false], ['needs-input', 60 * DAY, false, false],
    ['idle', 60 * DAY, false, true], ['error', 60 * DAY, false, true], ['ended', 60 * DAY, false, true], ['unknown', 60 * DAY, false, true],
    [null, 60 * DAY, false, true], ['idle', 60 * DAY, true, false], ['ended', 23 * 3600_000, false, false], ['ended', 44 * DAY, false, false]];
  for (const [l, age, keep, want] of rows)
    assert.equal(eligible({ lastActivity: NOW - age, keep, trashed: false, active: isActive(l) }, R45, NOW), want, `${l} ${age / DAY}d keep=${keep}`);
  // 24 h floor holds even when the setting is 1 day
  assert.equal(eligible({ ...old, lastActivity: NOW - DAY + 1 }, { days: 1 }, NOW), false);
  assert.equal(eligible({ ...old, lastActivity: NOW - DAY }, { days: 1 }, NOW), true);
});

// P5-T10 (EC-22): what new native activity does to the marker the purge left. A retention purge gives way (the session is
// re-imported and the cleared marker is the "re-imported" notice); a manual purge keeps blocking until Re-import (its
// uncleared manual marker is the "suppressed, Re-import" notice). Owed file work blocks both.
test('EC-22: auto-purged session continued natively is re-imported; manual purge stays suppressed', () => {
  const m = (reason: SuppressionReason, extra: Partial<Marker> = {}): Marker => ({ reason, at: NOW, pending: null, cleared_at: null, files: '[]', ...extra });
  assert.equal(blocks(m('retention'), true), false, 'retention + new activity: re-import');
  assert.equal(blocks(m('retention'), false), true, 'retention, no new activity: stays out');
  assert.equal(blocks(m('manual'), true), true, 'manual + new activity: stays suppressed');
  assert.equal(blocks(m('manual'), false), true);
  assert.equal(blocks(m('retention', { pending: '["r1"]' }), true), true, 'owed file work blocks');
  assert.equal(blocks(m('manual', { cleared_at: NOW + 1 }), false), false, 'after Re-import');
  assert.equal(blocks(undefined, false), false, 'never purged');
  // intake: a delivery from before the purge never comes back, even for a retention marker
  assert.equal(refuses(m('retention'), NOW), true);
  assert.equal(refuses(m('retention'), NOW + 1), false);
  assert.equal(refuses(m('manual'), NOW + 1), true);
});

// P5-T10 (EC-42 regression): fixtures across America/New_York DST changes. A calendar "+N days" in the local zone is 1 h
// short across spring forward and 1 h long across fall back; retention and Trash expiry use elapsed N x 24 h either way.
test('EC-42: retention and Trash expiry use elapsed N x 24 h across DST, not local calendar days', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const calendarPlus = (t: number, days: number) => { const d = new Date(t); d.setDate(d.getDate() + days); return d.getTime(); };
    // spring forward 2026-03-08: last activity 2026-02-20 10:00 EST
    const last = Date.UTC(2026, 1, 20, 15);
    const cal = calendarPlus(last, 45);
    assert.equal(purgeAt(last, R45)! - cal, 3600_000, 'fixture crosses spring forward');
    const c = { ...old, lastActivity: last };
    assert.equal(eligible(c, R45, cal), false, 'local calendar date reached, 45 x 24 h not elapsed');
    assert.equal(eligible(c, R45, last + 45 * DAY - 1), false);
    assert.equal(eligible(c, R45, last + 45 * DAY), true);
    // fall back 2026-11-01: deleted 2026-10-15 10:00 EDT
    const trashed = Date.UTC(2026, 9, 15, 14);
    const tcal = calendarPlus(trashed, 30);
    assert.equal(tcal - trashPurgeAt(trashed), 3600_000, 'fixture crosses fall back');
    assert.equal(trashPurgeAt(trashed), trashed + 30 * DAY);
    assert.equal(trashExpired(trashed, trashed + 30 * DAY - 1), false);
    assert.equal(trashExpired(trashed, trashed + 30 * DAY), true, '30 x 24 h elapsed, before the local calendar date');
    // and retention across fall back is 1 h earlier than the calendar date
    const last2 = Date.UTC(2026, 9, 1, 14);
    assert.equal(calendarPlus(last2, 45) - purgeAt(last2, R45)!, 3600_000);
    assert.equal(eligible({ ...old, lastActivity: last2 }, R45, last2 + 45 * DAY), true);
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});
