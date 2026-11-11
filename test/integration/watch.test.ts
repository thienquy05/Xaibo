// XAIBO-PROD-108 (P1-T10), EC-19: with watch events suppressed, the reconciliation scan finds appends within
// interval + 1 s, never reads unchanged files, and a wake reconciles immediately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { claudeProfile, count, until } from '../helpers/claude-profile.ts';

const silentWatch = () => ({ close() {}, on() { return this; } });
const line = (sid: string, n: number) => JSON.stringify({ type: 'user', uuid: `00000000-0000-4000-8000-00000000770${n}`, sessionId: sid,
  timestamp: '2026-01-01T00:02:00.000Z', message: { role: 'user', content: 'x' } }) + '\n';
const SID = '00000000-0000-4000-8000-000000001000';

test('EC-19: missed watch events are recovered by the scan within interval + 1 s, unchanged files unread', async () => {
  const p = await claudeProfile(['usage-basic', 'identifiers']);
  const interval = 300;
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: interval, watch: silentWatch });
  await a.start();
  const base = count(p.db, 'SELECT count(*) FROM events');
  const unchanged = join(p.root, 'projects', '-tmp-xaibo-fixture-identifiers', '00000000-0000-4000-8000-000000002000.jsonl');
  const readsBefore = a.reads(unchanged);
  appendFileSync(join(p.root, 'projects', '-tmp-xaibo-fixture-usage-basic', `${SID}.jsonl`), line(SID, 1));
  const took = await until(() => count(p.db, 'SELECT count(*) FROM events') === base + 1, interval + 1000);
  await new Promise((r) => setTimeout(r, interval * 2)); // two more scans
  a.stop();
  assert.ok(took < interval + 1000, `${took} ms`);
  assert.equal(a.reads(unchanged), readsBefore, 'unchanged file was read during scans');
});

test('EC-19: a wake reconciles immediately', async () => {
  const p = await claudeProfile(['usage-basic']);
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000, watch: silentWatch });
  await a.start();
  const base = count(p.db, 'SELECT count(*) FROM events');
  appendFileSync(join(p.root, 'projects', '-tmp-xaibo-fixture-usage-basic', `${SID}.jsonl`), line(SID, 2));
  await a.wake();
  const took = await until(() => count(p.db, 'SELECT count(*) FROM events') === base + 1, 1000);
  a.stop();
  assert.ok(took < 500, `${took} ms`);
});

test('a live file watch delivers an append without waiting for the scan', async () => {
  const p = await claudeProfile(['usage-basic']);
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000, activeMs: Number.MAX_SAFE_INTEGER });
  await a.start();
  const base = count(p.db, 'SELECT count(*) FROM events');
  appendFileSync(join(p.root, 'projects', '-tmp-xaibo-fixture-usage-basic', `${SID}.jsonl`), line(SID, 3));
  await until(() => count(p.db, 'SELECT count(*) FROM events') === base + 1, 2000);
  a.stop();
});
