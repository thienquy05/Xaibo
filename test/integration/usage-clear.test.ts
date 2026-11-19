// XAIBO-PROD-525 (P5-T16; FR-52, Q-5.8, EC-105): Clear usage history removes the frozen monthly totals and durably marks
// every contribution observed up to the confirmation as cleared: it is excluded from the live calculation and from every
// later settlement (retention, purge, Trash expiry), across a restart, while usage observed afterwards counts. The other
// deletion paths never change the totals (Trash/restore, purge, Keep across retention runs), a price edit after freezing
// leaves frozen rows and their price revision as they were, and the monthly tables hold opaque keys only.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { applyOverlay } from '../../src/service/history/overlay.ts';
import { purgeSession } from '../../src/service/history/purge.ts';
import { runRetention } from '../../src/service/retention/job.ts';
import { DAY } from '../../src/service/retention/policy.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { monthStatus } from '../../src/service/usage/availability.ts';
import { clearUsageHistory } from '../../src/service/usage/clear.ts';
import { priceUsage } from '../../src/service/usage/cost.ts';
import { liveMonthly } from '../../src/service/usage/monthly.ts';
import { loadPrices } from '../../src/service/usage/prices.ts';
import { settle } from '../../src/service/usage/settle.ts';
import { parsePortMessage, parsePortRequest } from '../../src/shared/ipc.ts';
import { hookStore } from '../helpers/hook-store.ts';
import { dump, removeSessions, request, sample, scope, SECRET, session, turn } from '../helpers/monthly.ts';

const OCT = Date.UTC(2026, 9, 12, 12), NOV = Date.UTC(2026, 10, 10, 12), DEC = Date.UTC(2026, 11, 2, 12), NOW = Date.UTC(2026, 11, 20, 12);
const EMPTY = { usage: [], sessions: [], quota: [] };
const FROZEN = ['monthly_usage', 'monthly_sessions', 'monthly_quota_peaks'];

async function store() {
  const h = await hookStore();
  h.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p2', 'codex', '/tmp/xaibo-fixture/codex', 'default')").run();
  for (const id of [1, 2]) {
    h.db.prepare("INSERT INTO price_revisions (id, schema_version, source, revision, content_hash, body, accepted_at) VALUES (?, 1, 'bundled', ?, ?, '{}', 0)").run(id, `r${id}`, `h${id}`);
  }
  return { ...h, file: join(h.dir, 'xaibo.db'), backupDir: join(h.dir, 'backups') };
}
const frozenRows = (db: DatabaseSync) => FROZEN.reduce((n, t) => n + (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n, 0);
/** A session with one turn and one priced request at `at`. */
function used(db: DatabaseSync, sid: string, at: number, o: { profile?: string; last?: number; tokens?: number } = {}) {
  const id = session(db, { sid, last: o.last ?? at, started: at, ...(o.profile ? { profile: o.profile } : {}) });
  turn(db, id, `${sid}-t`, at, 'claude-x');
  request(db, id, { identity: `${sid}:1`, ts: at, model: 'claude-x', input: o.tokens ?? 10, output: 5, cost: { usd: 0.5, coverage: 'full', rev: 1 } });
  return id;
}

test('clear: frozen totals go; every observed contribution stays excluded (live, restart, later expiry); later usage counts', async () => {
  const h = await store();
  const a = used(h.db, 'clear-a', NOV);
  const b = used(h.db, 'clear-b', OCT);
  const q = sample(h.db, scope(h.db, 'clear-scope', true), { percent: 40, at: OCT });
  h.writer.transact((db) => { // b and the quota reading are already frozen; a is live
    settle(db, { sessions: [b], quota: [q] }, SECRET, NOW);
    removeSessions(db, [b]);
    db.prepare('DELETE FROM usage_history WHERE id = ?').run(q);
  });
  assert.ok(frozenRows(h.db) > 0);
  assert.equal(liveMonthly(h.db, SECRET).usage.length, 2);

  assert.throws(() => clearUsageHistory(h.db, SECRET, NOW), /transaction/, 'runs only inside the caller\'s transaction');
  const r = h.writer.transact((db) => clearUsageHistory(db, SECRET, NOW));
  assert.ok(r.cleared > 0);
  assert.equal(frozenRows(h.db), 0, 'frozen monthly totals removed');
  assert.deepEqual(liveMonthly(h.db, SECRET), EMPTY, 'the retained session no longer counts');
  assert.equal((h.db.prepare('SELECT count(*) AS n FROM settled_contributions WHERE cleared = 0').get() as { n: number }).n, 0, 'every marker is cleared');
  h.writer.transact((db) => clearUsageHistory(db, SECRET, NOW)); // a second clear changes nothing
  assert.deepEqual(liveMonthly(h.db, SECRET), EMPTY);

  // restart: a new connection on the same file
  h.db.close();
  const { db } = await openStore({ file: h.file, backupDir: h.backupDir });
  const writer = new Writer(db);
  assert.deepEqual(liveMonthly(db, SECRET), EMPTY, 'still cleared after a restart');

  // usage observed afterwards counts: a new request in the cleared session, and a new session
  request(db, a, { identity: 'clear-a:2', ts: DEC, model: 'claude-x', input: 7, output: 3, cost: { usd: 0.25, coverage: 'full', rev: 2 } });
  const c = used(db, 'clear-c', DEC);
  const later = liveMonthly(db, SECRET);
  assert.deepEqual(later.usage.map((u) => u.month), ['2026-12']);
  assert.equal(later.usage.reduce((n, u) => n + u.requests, 0), 2);
  assert.equal(later.usage.reduce((n, u) => n + u.uncachedInput, 0), 17);
  assert.equal(later.usage[0]!.costUsd, 0.75);
  assert.equal(later.usage[0]!.turns, 1, 'only the new turn');

  // later expiry settles the retained sessions: only the later usage is frozen, nothing from before the clear
  writer.transact((t) => { settle(t, { sessions: [a, c], quota: [] }, SECRET, NOW); removeSessions(t, [a, c]); });
  assert.deepEqual(liveMonthly(db, SECRET), later);
  assert.deepEqual((db.prepare('SELECT DISTINCT month FROM monthly_usage').all() as { month: string }[]).map((x) => x.month), ['2026-12']);
});

test('Trash then restore, purge and Keep across retention runs leave the totals unchanged; after a clear none of them brings usage back', async () => {
  const h = await store();
  const x = used(h.db, 'del-trash', NOV), y = used(h.db, 'del-purge', NOV, { tokens: 20 });
  used(h.db, 'del-kept', NOW - 50 * DAY, { tokens: 30 });
  used(h.db, 'del-old', NOW - 50 * DAY, { tokens: 40 });
  h.db.prepare("INSERT INTO overlays (agent, profile_id, native_session_id, keep) VALUES ('claude', 'p1', 'del-kept', 1)").run();
  const before = liveMonthly(h.db, SECRET);
  const files = { dataDir: h.dir, backupDir: h.backupDir, secret: SECRET };
  const retention = (now: number) => runRetention(h.writer, h.db, { ...files, now, active: () => false });

  assert.equal(applyOverlay(h.db, { kind: 'trash', session: x, on: true }, { readOnly: false, now: NOW }).ok, true);
  assert.deepEqual(liveMonthly(h.db, SECRET), before, 'Trash');
  applyOverlay(h.db, { kind: 'trash', session: x, on: false }, { readOnly: false, now: NOW });
  assert.deepEqual(liveMonthly(h.db, SECRET), before, 'restore');
  assert.equal(purgeSession(h.writer, y, { ...files, now: NOW, reason: 'manual' }).purged, true);
  assert.deepEqual(liveMonthly(h.db, SECRET), before, 'purge settles first');
  assert.equal((await retention(NOW))!.sessions, 1, 'the old session is purged; the kept one is not');
  assert.deepEqual(liveMonthly(h.db, SECRET), before, 'retention');
  await retention(NOW + DAY);
  assert.deepEqual(liveMonthly(h.db, SECRET), before, 'a kept session is never counted twice');
  assert.ok(h.db.prepare("SELECT 1 FROM sessions WHERE native_session_id = 'del-kept'").get());

  h.writer.transact((db) => clearUsageHistory(db, SECRET, NOW + DAY));
  assert.deepEqual(liveMonthly(h.db, SECRET), EMPTY);
  applyOverlay(h.db, { kind: 'trash', session: x, on: true }, { readOnly: false, now: NOW + DAY });
  h.db.prepare("UPDATE overlays SET keep = 0 WHERE native_session_id = 'del-kept'").run();
  await retention(NOW + 40 * DAY); // Trash expiry and the no-longer-kept session are purged and settled
  assert.equal((h.db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n, 0);
  assert.deepEqual(liveMonthly(h.db, SECRET), EMPTY, 'cleared contributions never reappear through settlement');
  assert.equal(frozenRows(h.db), 0);
});

test('a price edit after freezing leaves frozen rows and their price revision unchanged', async () => {
  const h = await store();
  const f = used(h.db, 'price-frozen', OCT);
  h.writer.transact((db) => { settle(db, { sessions: [f], quota: [] }, SECRET, NOW); removeSessions(db, [f]); });
  const frozen = JSON.stringify(h.db.prepare('SELECT * FROM monthly_usage ORDER BY month').all());
  const g = session(h.db, { sid: 'price-live', last: NOV });
  request(h.db, g, { identity: 'price-live:1', ts: NOV, model: 'claude-opus-5-5', input: 100, output: 10 });
  const overridePath = join(h.dir, 'models.override.json');
  const first = loadPrices({ db: h.db, overridePath });
  priceUsage(h.db, first);
  writeFileSync(overridePath, JSON.stringify({ schemaVersion: 1, revision: 'owner-1', currency: 'USD', prices_as_of: '2026-11-12',
    sources: [{ id: 'owner', url: 'https://example.com/p', retrieved: '2026-11-12' }],
    models: [{ id: 'claude-x', display_name: 'Claude X', source: 'owner', prices_verified: true, rates: { input: 40, output: 200, cache_read: 2, cache_write: { '5m': 50, '1h': 80 } } }] }));
  const second = loadPrices({ db: h.db, overridePath, previous: first });
  assert.notEqual(second.revisionId, first.revisionId);
  priceUsage(h.db, second);
  assert.equal(JSON.stringify(h.db.prepare('SELECT * FROM monthly_usage ORDER BY month').all()), frozen, 'frozen rows untouched');
  const oct = liveMonthly(h.db, SECRET).usage.find((u) => u.month === '2026-10')!;
  assert.deepEqual([oct.costUsd, oct.priceRevisions], [0.5, [1]], 'frozen cost keeps the revision that priced it');
});

test('privacy: monthly tables and markers hold no home path, profile, session, title or account canary', async () => {
  const h = await store();
  const CANARIES = ['canary-home-7c1', 'profile-canary-7c1', 'session-canary-7c1', 'title-canary-7c1', 'acct-canary-7c1@example.invalid'];
  h.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('profile-canary-7c1', 'claude', '/tmp/xaibo-fixture/canary-home-7c1/.claude', 'manual')").run();
  const one = used(h.db, 'session-canary-7c1', OCT, { profile: 'profile-canary-7c1' });
  h.db.prepare("UPDATE sessions SET title = 'title-canary-7c1', cwd = '/tmp/xaibo-fixture/canary-home-7c1/work' WHERE id = ?").run(one);
  const q = sample(h.db, scope(h.db, 'acct-canary-7c1@example.invalid', true, 'p2'), { percent: 55, at: OCT });
  h.writer.transact((db) => { settle(db, { sessions: [one], quota: [q] }, SECRET, NOW); removeSessions(db, [one]); db.prepare('DELETE FROM usage_history WHERE id = ?').run(q); });
  const two = used(h.db, 'session-canary-7c1-b', NOV, { profile: 'profile-canary-7c1' });
  h.writer.transact((db) => clearUsageHistory(db, SECRET, NOW)); // cleared markers for retained records
  request(h.db, two, { identity: 'later', ts: DEC, model: 'claude-x', input: 1, output: 1 });
  h.writer.transact((db) => { settle(db, { sessions: [two], quota: [] }, SECRET, NOW); removeSessions(db, [two]); }); // frozen again
  assert.ok(frozenRows(h.db) > 0);
  const bytes = dump(h.db);
  for (const c of CANARIES) assert.ok(!bytes.includes(c), `no ${c} in the monthly tables`);
  assert.ok(!bytes.includes('/tmp/xaibo-fixture'), 'no path');
});

test('review M2: a model that resolves after the clear does not bring back the cleared session-month (live, status, settled)', async () => {
  const h = await store();
  const s = session(h.db, { sid: 'late-model', last: NOV, started: NOV });
  turn(h.db, s, 'late-model-t1', NOV, null); // model unknown when the clear runs
  h.writer.transact((db) => clearUsageHistory(db, SECRET, NOW));
  h.db.prepare("UPDATE turns SET model_id = 'claude-x' WHERE session_id = ?").run(s); // resolved later
  assert.deepEqual(liveMonthly(h.db, SECRET), EMPTY);
  assert.deepEqual(monthStatus(h.db, SECRET, NOW), [], 'no month listed');
  h.writer.transact((db) => { settle(db, { sessions: [s], quota: [] }, SECRET, NOW); removeSessions(db, [s]); });
  assert.equal(frozenRows(h.db), 0, 'nothing frozen either');
});

test('IPC: clearUsage request and reply parse strictly', () => {
  assert.deepEqual(parsePortRequest({ v: 1, type: 'clearUsage', id: 3 }), { v: 1, type: 'clearUsage', id: 3 });
  assert.equal(parsePortRequest({ v: 1, type: 'clearUsage', id: -1 }), null);
  for (const result of ['cleared', 'read-only', 'failed'] as const) {
    assert.deepEqual(parsePortMessage({ v: 1, type: 'clearUsage', id: 3, result }), { v: 1, type: 'clearUsage', id: 3, result });
  }
  assert.equal(parsePortMessage({ v: 1, type: 'clearUsage', id: 3, result: 'done' }), null);
  assert.equal(parsePortMessage({ v: 1, type: 'clearUsage', id: 3 }), null);
});
