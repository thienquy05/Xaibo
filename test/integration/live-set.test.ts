// XAIBO-PROD-404 (P4-T04a; design §6.1 live-set summary, D-P3-09, §5.12): session rows carry tokens (normalized input
// plus output over message-scope usage only, null without usage, never 0) and the live-set request returns tracked,
// non-ended sessions active within the 24 h feed window, in list order, capped at 100 with `more`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerLiveSet, LIVE_SET_MAX, listSessions } from '../../src/service/api.ts';
import { openStore } from '../../src/service/store/db.ts';
import type { LiveStatus } from '../../src/shared/ipc.ts';

const NOW = Date.parse('2026-01-02T00:00:00.000Z');
const H = 3_600_000;

async function store() {
  const dir = mkdtempSync(join(tmpdir(), 'xls-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'b') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  const ins = db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id, last_activity) VALUES ('claude', 'p1', ?, ?)");
  const add = (sid: string, at: number | null) => Number(ins.run(sid, at).lastInsertRowid);
  return { db, add };
}
const status = (lifecycle: LiveStatus['lifecycle']): LiveStatus =>
  ({ lifecycle, confidence: 'confirmed', health: 'connected', reason: null, outcome: null, findings: [], since: null });

test('tokens: message-scope input plus output; session-scope totals are not added; a missing component is incomplete; no usage is null', async () => {
  const { db, add } = await store();
  const a = add('sid-a', NOW);
  const b = add('sid-b', NOW - 1);
  const c = add('sid-c', NOW - 2);
  const use = db.prepare(`INSERT INTO usage (session_id, schema_version, source, identity, scope, uncached_input, cache_read, cache_write, output, completeness)
    VALUES (?, 1, 'transcript', ?, ?, ?, ?, ?, ?, '{}')`);
  use.run(a, 'm1', 'message', 100, 20, 5, 50);
  use.run(a, 'm2', 'message', 10, 0, 0, 5); // e.g. a subagent message inside the same session: counted once
  use.run(a, 's', 'session', 9999, 0, 0, 9999); // a cumulative session-scope reading must not be added on top
  use.run(b, 'm1', 'message', 100, null, 0, 50);
  const rows = listSessions(db, null, 50).rows;
  const by = new Map(rows.map((r) => [r.id, r]));
  assert.deepEqual([by.get(a)!.tokens, by.get(a)!.tokensComplete], [190, true]);
  assert.deepEqual([by.get(b)!.tokens, by.get(b)!.tokensComplete], [150, false], 'known subtotal, never imputed');
  assert.deepEqual([by.get(c)!.tokens, by.get(c)!.tokensComplete], [null, true], 'unavailable, not 0');
});

test('review M2/L3: only a Claude reported-missing cache write is a gap; all-NULL components are unavailable, not 0', async () => {
  const { db, add } = await store();
  const a = add('claude-gap', NOW);
  const b = add('codex-none', NOW - 1);
  const c = add('all-null', NOW - 2);
  const use = db.prepare(`INSERT INTO usage (session_id, schema_version, source, identity, scope, uncached_input, cache_read, cache_write, output, completeness)
    VALUES (?, 1, 'transcript', ?, 'message', ?, ?, ?, ?, ?)`);
  use.run(a, 'm1', 100, 0, null, 10, JSON.stringify({ cacheWrite: 'missing' }));
  use.run(b, 'm1', 100, 0, null, 10, JSON.stringify({ cacheWrite: 'relation-unverified' }));
  use.run(b, 'm2', 100, 0, null, 10, JSON.stringify({ cacheWrite: 'unavailable' }));
  use.run(c, 'm1', null, null, null, null, JSON.stringify({ cacheWrite: 'missing' }));
  const by = new Map(listSessions(db, null, 50).rows.map((r) => [r.id, r]));
  assert.deepEqual([by.get(a)!.tokens, by.get(a)!.tokensComplete], [110, false]);
  assert.deepEqual([by.get(b)!.tokens, by.get(b)!.tokensComplete], [220, true]);
  assert.deepEqual([by.get(c)!.tokens, by.get(c)!.tokensComplete], [null, false], 'nothing known is unavailable, never 0');
});

test('live set: non-ended sessions the engine knows, active within 24 h, in list order', async () => {
  const { db, add } = await store();
  const ids = { busy: add('busy', NOW - H), wait: add('wait', NOW), ended: add('ended', NOW), unknown: add('none', NOW), old: add('old', NOW - 25 * H), idle: add('idle', NOW - 2 * H) };
  const live = (_agent: string, sid: string): LiveStatus | null =>
    ({ busy: status('busy'), wait: status('needs-input'), ended: status('ended'), old: status('busy'), idle: status('idle') } as Record<string, LiveStatus>)[sid] ?? null;
  const reply = answerLiveSet(db, { v: 1, type: 'liveSet', id: 9 }, NOW, [], [], live);
  assert.equal(reply.id, 9);
  assert.equal(reply.more, false);
  assert.deepEqual(reply.rows.map((r) => r.id), [ids.wait, ids.busy, ids.idle]);
});

test('live set: capped with more; a store that cannot answer gives an empty set', async () => {
  const { db, add } = await store();
  for (let i = 0; i < LIVE_SET_MAX + 1; i++) add(`s${i}`, NOW - i);
  const reply = answerLiveSet(db, { v: 1, type: 'liveSet', id: 1 }, NOW, [], [], () => status('busy'));
  assert.equal(LIVE_SET_MAX, 100);
  assert.equal(reply.rows.length, LIVE_SET_MAX);
  assert.equal(reply.more, true);
  db.close();
  assert.deepEqual(answerLiveSet(db, { v: 1, type: 'liveSet', id: 2 }, NOW, [], [], () => status('busy')), { v: 1, type: 'liveSet', id: 2, rows: [], more: false });
});

test('security review HIGH: token values past 2^53 never throw; the total is unavailable instead', async () => {
  const { db, add } = await store();
  const a = add('huge', NOW);
  const use = db.prepare(`INSERT INTO usage (session_id, schema_version, source, identity, scope, uncached_input, cache_read, cache_write, output, completeness)
    VALUES (?, 1, 'transcript', ?, 'message', ?, 0, 0, 0, '{}')`);
  use.run(a, 'm1', 9e18);
  use.run(a, 'm2', 9e18);
  const rows = listSessions(db, null, 50).rows;
  assert.deepEqual([rows[0]!.tokens, rows[0]!.tokensComplete], [null, true]);
});
