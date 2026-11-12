// XAIBO-PROD-310 (P3-T10; US-1, US-4, FR-09, EC-12, EC-25, EC-44, EC-49): list rows carry the status engine's live
// status, the latest context percentage and the session ~$ estimate; native file records reach the engine only inside
// the live window; coverage banners name hook-only gaps, a full disk, Claude hooks blocked by policy and Codex hooks
// awaiting trust (only where Xaibo hooks are installed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployShim } from '../../src/service/adapters/claude/setup.ts';
import { installCodexHooks } from '../../src/service/adapters/codex/setup.ts';
import { listSessions, sessionsByKey } from '../../src/service/api.ts';
import { recordEntry } from '../../src/service/config/transaction.ts';
import { coverageBanners } from '../../src/service/status/coverage.ts';
import { fileObservations, LIVE_WINDOW_MS } from '../../src/service/status/feed.ts';
import { boot } from '../../src/service/boot.ts';
import { loadCatalog } from '../../src/service/catalog/validate.ts';
import { openStore } from '../../src/service/store/db.ts';
import type { Batch } from '../../src/service/store/writer.ts';
import { MAX_BANNERS, parsePortMessage, type LiveStatus } from '../../src/shared/ipc.ts';

const REPO = join(import.meta.dirname, '..', '..');
const SID = '00000000-0000-4000-8000-0000000f1001';
const OTHER = '00000000-0000-4000-8000-0000000f1002';
const NOW = Date.parse('2026-01-02T00:00:00.000Z');

async function store() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'xlr-')));
  const dataDir = join(base, 'data');
  mkdirSync(dataDir);
  const { db } = await openStore({ file: join(dataDir, 'xaibo.db'), backupDir: join(dataDir, 'backups') });
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', '/tmp/xaibo-fixture/root', 'default')").run();
  const ins = db.prepare("INSERT INTO sessions (agent, profile_id, native_session_id, cwd, last_activity) VALUES ('claude', 'p1', ?, '/tmp/xaibo-fixture/a', ?)");
  const id = Number(ins.run(SID, 2).lastInsertRowid);
  ins.run(OTHER, 1);
  return { base, dataDir, db, id };
}

const LIVE: LiveStatus = { lifecycle: 'busy', confidence: 'confirmed', health: 'connected', reason: 'Finishing…', outcome: null, findings: ['R2'] };
const live = (agent: string, sid: string) => (agent === 'claude' && sid === SID ? LIVE : null);

test('rows carry live status by native session id; a session the engine does not know has none', async () => {
  const { db } = await store();
  const rows = listSessions(db, null, 50, [], [], live).rows;
  assert.deepEqual(rows.map((r) => r.live), [LIVE, null]);
  assert.deepEqual(sessionsByKey(db, [{ agent: 'claude', profileId: 'p1', nativeSessionId: SID }], [], [], live).map((r) => r.live), [LIVE]);
  assert.equal(listSessions(db, null, 50).rows[0]!.live, null, 'no engine: no live status');
});

test('context: the latest generation\'s percentage; cost: unavailable without estimates', async () => {
  const { db, id } = await store();
  const put = db.prepare(`INSERT INTO context_snapshots (session_id, schema_version, source, generation, percentage, window_basis, observed_at)
    VALUES (?, 1, 'transcript', ?, ?, ?, 1)`);
  put.run(id, 1, 30, 'reported');
  put.run(id, 2, 55.5, 'reported');
  const [row, other] = listSessions(db, null, 50).rows;
  assert.equal(row!.contextPct, 55.5);
  assert.equal(other!.contextPct, null);
  assert.deepEqual([row!.costUsd, row!.costCoverage], [null, 'unavailable']);
});

test('file records reach the engine only inside the live window, with their file offset; hook batches never', () => {
  const ev = (o: Partial<Batch['events'][number]>) => ({ nativeSessionId: SID, source: 'transcript', confidence: 'inferred', nativeId: 'n', kind: 'k', sourceSeq: 1,
    receivedTs: NOW, raw: '{"type":"user"}', ...o });
  const b: Batch = {
    profileId: 'p1', agent: 'claude', sessions: [],
    file: { path: '/tmp/xaibo-fixture/t.jsonl', kind: 'transcript', dev: 1, ino: 1, size: 1, mtime: NOW, offset: 1, headHash: 'h', status: 'ok' },
    events: [ev({ byteOffset: 10, sourceTs: NOW - 1000 }), ev({ byteOffset: 20, sourceTs: NOW - LIVE_WINDOW_MS - 1 }), ev({ byteOffset: 30, raw: undefined as unknown as string }),
      ev({ byteOffset: 40 })],
  };
  const obs = fileObservations(b, NOW);
  // visual check: a backfilled record without a source time was fed as "now" and gave an old session a live status
  assert.deepEqual(obs.map((o) => o.source === 'file' && o.offset), [10], 'old, raw-less and timeless records skipped');
  assert.deepEqual(obs[0], { source: 'file', agent: 'claude', sessionId: SID, file: '/tmp/xaibo-fixture/t.jsonl', offset: 10, line: '{"type":"user"}', receivedTs: NOW });
  assert.deepEqual(fileObservations({ ...b, file: undefined as never }, NOW), [], 'hook batches are fed by intake publish');
  assert.equal(LIVE_WINDOW_MS, 24 * 3600_000);
});

test('banners: hook-only gaps of the last 24 h grouped by reason and agent; disk full while full', async () => {
  const { db, dataDir } = await store();
  const gap = db.prepare('INSERT INTO hook_gaps (reason, agent, native_session_id, from_ts, to_ts, count, locator, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  gap.run('spool-overflow', 'claude', SID, 100, 200, 2, 'a', NOW - 1000);
  gap.run('spool-overflow', 'claude', OTHER, 50, 300, 3, 'b', NOW - 2000);
  gap.run('spool-saturated', null, null, 400, null, null, 'c', NOW - 3000);
  gap.run('disk-full', 'claude', SID, 1, 2, 9, 'd', NOW - 25 * 3600_000);
  const o = { db, dataDir, profiles: [], now: NOW, managedDir: join(dataDir, 'no-managed') };
  assert.deepEqual(coverageBanners({ ...o, diskFull: false }), [
    { kind: 'hook-gap', reason: 'spool-overflow', agent: 'claude', count: 5, from: 50, to: 300 },
    { kind: 'hook-gap', reason: 'spool-saturated', agent: null, count: null, from: 400, to: null },
  ]);
  assert.deepEqual(coverageBanners({ ...o, diskFull: true }).at(0), { kind: 'disk-full' });
});

test('banners: Claude hooks blocked by policy and Codex awaiting trust, only where Xaibo hooks are installed', async () => {
  const { base, db, dataDir } = await store();
  const configDir = join(base, 'claude', '.claude');
  const codexHome = join(base, 'codex', '.codex');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ disableAllHooks: true }));
  copyFileSync(join(REPO, 'test', 'fixtures', 'synthetic', 'config', 'codex-hooks', 'foreign.json'), join(codexHome, 'hooks.json'));
  db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('c1', 'claude', ?, 'default'), ('x1', 'codex', ?, 'default')").run(configDir, codexHome);
  const profiles = [{ id: 'c1', agent: 'claude', root: configDir }, { id: 'x1', agent: 'codex', root: codexHome }];
  const o = { db, dataDir, profiles, diskFull: false, now: NOW, managedDir: join(base, 'managed') };
  assert.deepEqual(coverageBanners(o), [], 'nothing installed: no hook banners');

  recordEntry(dataDir, { id: 'e1', target: join(configDir, 'settings.json'), route: 'claude-settings-fallback', state: 'applied', existed: true, preHash: null,
    postHash: 'x', owned: [], created: [], backup: null, at: new Date(NOW).toISOString() });
  const forwarder = join(base, 'forwarder');
  writeFileSync(forwarder, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  deployShim(dataDir, { hook: join(REPO, 'src', 'forwarder', 'xaibo-hook'), forwarder });
  installCodexHooks({ dataDir, codexHome, profileKey: 'x1', bounds: { root: join(base, 'codex'), denied: [] } });

  const banners = coverageBanners(o);
  assert.deepEqual(banners[0], { kind: 'hooks-blocked', agent: 'claude', state: 'blocked' });
  assert.equal(banners[1]!.kind, 'awaiting-trust');
  assert.ok(banners[1]!.kind === 'awaiting-trust' && banners[1]!.agent === 'codex' && banners[1]!.steps.length > 0);
  assert.equal(banners.length, 2);
});

// P3-T10 security review M1: what the service sends must pass the renderer's parser, or one bad gap row hides every
// banner. Agents that are not catalog ids become unknown, implausible times become unknown, the list is capped with the
// disk-full, policy and trust banners first.
test('banners always pass the renderer parser: odd agents and times become unknown; capped, important kinds first', async () => {
  const { db, dataDir } = await store();
  const gap = db.prepare("INSERT INTO hook_gaps (reason, agent, native_session_id, from_ts, to_ts, count, locator, recorded_at) VALUES ('spool-overflow', ?, NULL, ?, ?, 1, ?, ?)");
  gap.run('0x', 1e15, -5, 'odd', NOW - 10);
  for (let i = 0; i < 70; i++) gap.run(`a${i}`, NOW - 100, NOW - 50, `g${i}`, NOW - 1000 - i);
  const banners = coverageBanners({ db, dataDir, profiles: [], diskFull: true, now: NOW });
  assert.equal(banners.length, MAX_BANNERS);
  assert.deepEqual(banners[0], { kind: 'disk-full' });
  assert.deepEqual(banners.find((b) => b.kind === 'hook-gap' && b.agent === null), { kind: 'hook-gap', reason: 'spool-overflow', agent: null, count: 1, from: null, to: null });
  assert.notEqual(parsePortMessage({ v: 1, type: 'coverage', banners }), null);
});

// review L6: a cost that is not a usable amount is unavailable, never "full" without an amount.
test('a negative stored estimate is unavailable', async () => {
  const { db, id } = await store();
  db.prepare("INSERT INTO cost_estimates (session_id, schema_version, source, covered_scope, amount_usd, basis, coverage) VALUES (?, 1, 'x', 'session', -1, 'agent_reported', NULL)").run(id);
  const row = listSessions(db, null, 50).rows.find((r) => r.id === id)!;
  assert.deepEqual([row.costUsd, row.costCoverage], [null, 'unavailable']);
});

// review M3: the engine reloads stored evidence at start, but time-only transitions (settle, heuristic wait, R1/R5) were
// watched only after new evidence; reading a busy row now watches it, so a restart mid-turn still settles.
test('after a restart a busy session is watched once its row is read, and settles with time alone', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'xlb-')));
  const dataDir = join(base, 'data');
  mkdirSync(dataDir);
  mkdirSync(join(base, 'home'));
  const pre = await openStore({ file: join(dataDir, 'xaibo.db'), backupDir: join(dataDir, 'backups') });
  const put = pre.db.prepare("INSERT INTO status_evidence (agent, native_session_id, dedup, ts, rank, seq, confidence, ev) VALUES ('claude', ?, ?, ?, 0, ?, 'confirmed', ?)");
  put.run(SID, 'd:1', NOW, 1, JSON.stringify([{ k: 'turn.start', typed: true }]));
  put.run(SID, 'd:2', NOW + 1000, 2, JSON.stringify([{ k: 'turn.end' }]));
  pre.db.close();
  let now = NOW + 2000;
  const svc = await boot({ dataDir, home: join(base, 'home'), catalog: { ...loadCatalog(), agents: [] }, now: () => now });
  try {
    assert.equal(svc.status('claude', SID, 'p1')?.reason, 'Finishing…');
    now = NOW + 6000;
    assert.deepEqual(svc.ticking(), [`claude\0p1\0${SID}`]);
    assert.equal(svc.status('claude', SID, 'p1')?.lifecycle, 'idle');
  } finally { svc.stop(); }
});
