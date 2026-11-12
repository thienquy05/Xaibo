// XAIBO-PROD-205 (P2-T05, EC-07, PRD §5.5): two sessions open in the same repo (one encoded-cwd directory) with
// interleaved appends stay two sessions; every event lands in the session its record names, never routed by cwd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { claudeProfile, count, until } from '../helpers/claude-profile.ts';

const CWD = '/tmp/xaibo-fixture/shared';
const sid = (n: string) => `00000000-0000-4000-8000-0000000a${n}`;
const line = (session: string, uuid: string, sec: number) => JSON.stringify({ parentUuid: null, type: 'user', uuid, cwd: CWD, sessionId: session,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString(), entrypoint: 'cli', message: { role: 'user', content: 'x' } }) + '\n';

test('EC-07: two sessions in one cwd with interleaved appends -> two sessions, events routed by session id', async () => {
  const p = await claudeProfile([]);
  const dir = join(p.root, 'projects', '-tmp-xaibo-fixture-shared');
  mkdirSync(dir, { recursive: true });
  const [A, B] = [sid('0001'), sid('0002')];
  writeFileSync(join(dir, `${A}.jsonl`), line(A, sid('1001'), 1));
  writeFileSync(join(dir, `${B}.jsonl`), line(B, sid('2001'), 2));
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  await a.start();
  try {
    for (const [s, u, t] of [[A, '1002', 3], [B, '2002', 4], [A, '1003', 5], [B, '2003', 6]] as const) {
      appendFileSync(join(dir, `${s}.jsonl`), line(s, sid(u), t));
      await a.wake();
    }
    await until(() => count(p.db, 'SELECT count(*) FROM events') === 6, 5000);
  } finally { a.stop(); }
  assert.equal(count(p.db, 'SELECT count(*) FROM sessions'), 2);
  const routed = p.db.prepare('SELECT s.native_session_id AS s, group_concat(e.native_id) AS ids FROM events e JOIN sessions s ON s.id = e.session_id GROUP BY s.id ORDER BY s.native_session_id')
    .all().map((r) => ({ ...r }));
  assert.deepEqual(routed.map((r) => ({ s: r.s, ids: String(r.ids).split(',').sort() })), [
    { s: A, ids: [sid('1001'), sid('1002'), sid('1003')] },
    { s: B, ids: [sid('2001'), sid('2002'), sid('2003')] },
  ]);
  assert.equal(count(p.db, 'SELECT count(*) FROM cwd_history'), 2, 'one history row per session for the shared cwd');
  assert.equal(count(p.db, 'SELECT count(*) FROM turns'), 6, 'each prompt record is a turn of its own session');
});
