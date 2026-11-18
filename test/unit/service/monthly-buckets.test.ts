// XAIBO-PROD-512 (P5-T04; FR-52, EC-104 unit part): local calendar month at event time with the offset stored, across
// month-end and DST; sessions and turns once per month bucket; sessions per model and across models; quota peak = max per
// month per scope and window, never summed or carried forward, verified and unverified scopes apart.
process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveMonthly, monthOf } from '../../../src/service/usage/monthly.ts';
import { settle } from '../../../src/service/usage/settle.ts';
import { monthlyStore, removeSessions, request, sample, scope, SECRET, session, turn, tx } from '../../helpers/monthly.ts';

const at = (iso: string) => Date.parse(iso);

test('month at event time in the owner zone, with its UTC offset: month-end and DST', () => {
  assert.deepEqual(monthOf(at('2026-10-31T23:30:00-07:00')), { month: '2026-10', offset: -420 });
  assert.deepEqual(monthOf(at('2026-11-01T06:30:00Z')), { month: '2026-10', offset: -420 }); // UTC already November
  assert.deepEqual(monthOf(at('2026-11-01T00:30:00-07:00')), { month: '2026-11', offset: -420 });
  assert.deepEqual(monthOf(at('2026-11-01T02:30:00-08:00')), { month: '2026-11', offset: -480 }); // after DST ends
  assert.deepEqual(monthOf(at('2026-03-08T03:30:00-07:00')), { month: '2026-03', offset: -420 }); // after DST starts
});

test('a session spanning months counts once in each; turns once; sessions per model and across models', async () => {
  const db = await monthlyStore();
  const s = session(db, { sid: 's1', last: at('2026-11-02T10:00:00-08:00') });
  turn(db, s, 't1', at('2026-10-31T23:30:00-07:00'), 'model-a');
  turn(db, s, 't2', at('2026-10-31T23:50:00-07:00'), 'model-b');
  turn(db, s, 't3', at('2026-11-02T10:00:00-08:00'), 'model-a');
  request(db, s, { identity: 'r1', ts: at('2026-11-02T10:00:00-08:00'), model: 'model-a', output: 1 });
  const idle = session(db, { sid: 's2', last: at('2026-11-15T12:00:00-08:00') }); // no turns or usage: its last activity
  const v = liveMonthly(db, SECRET);
  assert.deepEqual(v.sessions.map((r) => [r.month, r.sessions]), [['2026-10', 1], ['2026-11', 2]]);
  assert.deepEqual(v.usage.map((r) => [r.month, r.modelId, r.sessions, r.turns, r.requests]),
    [['2026-10', 'model-a', 1, 1, 0], ['2026-10', 'model-b', 1, 1, 0], ['2026-11', '', 1, 0, 0], ['2026-11', 'model-a', 1, 1, 1]]);
  // settled keys record the bucket month and its offset
  tx(db, () => settle(db, { sessions: [s, idle], quota: [] }, SECRET, 0));
  const keys = db.prepare('SELECT month, utc_offset AS o, count(*) AS n FROM settled_contributions GROUP BY month, utc_offset ORDER BY month, o').all();
  assert.deepEqual(keys.map((k) => ({ ...k })), [{ month: '2026-10', o: -420, n: 5 }, { month: '2026-11', o: -480, n: 6 }]);
});

test('review M1: after a time-zone change, re-imported settled records keep their settled month and add nothing', async () => {
  const db = await monthlyStore();
  const t = at('2026-10-31T23:30:00-07:00'); // October in Los Angeles, November in UTC
  const add = () => {
    const s = session(db, { sid: 'tz', last: t });
    turn(db, s, 'tz1', t, 'model-a');
    request(db, s, { identity: 'tz-r', ts: t, model: 'model-a', output: 1 });
    return s;
  };
  const s = add();
  const before = liveMonthly(db, SECRET);
  tx(db, () => { settle(db, { sessions: [s], quota: [] }, SECRET, 0); removeSessions(db, [s]); });
  process.env.TZ = 'UTC';
  try {
    const again = add();
    assert.deepEqual(liveMonthly(db, SECRET), before);
    assert.equal(tx(db, () => settle(db, { sessions: [again], quota: [] }, SECRET, 0)).added, 0);
  } finally { process.env.TZ = 'America/Los_Angeles'; }
});

test('re-review: a session with no turn or request keeps its settled month across a time-zone change too', async () => {
  const db = await monthlyStore();
  const t = at('2026-10-31T23:30:00-07:00');
  const s = session(db, { sid: 'empty', last: t });
  const before = liveMonthly(db, SECRET);
  tx(db, () => { settle(db, { sessions: [s], quota: [] }, SECRET, 0); removeSessions(db, [s]); });
  process.env.TZ = 'UTC';
  try {
    const again = session(db, { sid: 'empty', last: t });
    assert.deepEqual(liveMonthly(db, SECRET), before);
    assert.equal(tx(db, () => settle(db, { sessions: [again], quota: [] }, SECRET, 0)).added, 0);
  } finally { process.env.TZ = 'America/Los_Angeles'; }
});

test('quota peak: max measured per month per scope and window; never summed or carried forward; uncertain scopes apart', async () => {
  const db = await monthlyStore();
  const v = scope(db, 'verified', true), u = scope(db, 'uncertain', false);
  sample(db, v, { percent: 30, at: at('2026-10-10T12:00:00-07:00') });
  sample(db, v, { percent: 55, at: at('2026-10-31T23:59:00-07:00') });
  sample(db, v, { percent: 20, at: at('2026-11-01T00:01:00-07:00'), kind: 'transition' }); // a window crossing months: its own month's reading
  sample(db, v, { percent: 90, at: at('2026-10-12T12:00:00-07:00'), window: 10080 });     // weekly window, separate
  sample(db, v, { percent: null, at: at('2026-12-05T12:00:00-08:00') });                  // no measured percent: no December peak
  sample(db, u, { percent: 80, at: at('2026-10-11T12:00:00-07:00') });
  const q = liveMonthly(db, SECRET).quota;
  const row = (scopeKey: string, month: string, window: number) => q.find((r) => r.scopeKey === scopeKey && r.month === month && r.windowMinutes === window);
  const keys = [...new Set(q.map((r) => r.scopeKey))];
  assert.equal(keys.length, 2);
  const vk = q.find((r) => r.verified)!.scopeKey, uk = q.find((r) => !r.verified)!.scopeKey;
  assert.match(vk, /^[0-9a-f]{64}$/);
  assert.deepEqual([row(vk, '2026-10', 300)?.peakPercent, row(vk, '2026-10', 300)?.observations], [55, 2]);
  assert.equal(row(vk, '2026-11', 300)?.peakPercent, 20);
  assert.equal(row(vk, '2026-10', 10080)?.peakPercent, 90);
  assert.equal(row(uk, '2026-10', 300)?.peakPercent, 80);
  assert.equal(q.filter((r) => r.month === '2026-12').length, 0); // absent, not zero, not carried forward
  assert.equal(q.length, 4);
});
