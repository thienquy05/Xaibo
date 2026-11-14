// XAIBO-PROD-321 (P3-T16e; Gate 3 M1/M2 misses, P3-T16d): live work keeps flowing while a large backfill runs, and
// the settled transition lands at the settle deadline, not at the next status tick.
// (1) A backfill yields the event loop after each committed batch, commits each full batch at once (no coalescing
//     timer) and keeps batches small (25 rows, 128 KiB), so a socket ack or a watch callback never waits for a whole
//     read chunk of commits (measured in-process: a 5 ms timer ran up to ~700 ms late).
// (2) Every adapter's watcher runs before any adapter backfills: an append to a Codex rollout during the Claude
//     backfill is ingested before that backfill ends.
// (3) Boot calls onTick at a watched session's settle deadline (stop time + settle interval).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../src/service/adapters/claude/index.ts';
import { boot } from '../../src/service/boot.ts';
import { loadCatalog, type Catalog } from '../../src/service/catalog/validate.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer, type Batch } from '../../src/service/store/writer.ts';
import { claudeProfile, count, until } from '../helpers/claude-profile.ts';

const SID = '00000000-0000-4000-8000-0000000f1640';
const CODEX_FIX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'codex', '0.160.0', 'simple-turn');
// Known locations limited to the temp home, so no agent installed on this machine is ever probed.
const catalog: Catalog = { ...loadCatalog(), agents: loadCatalog().agents.map((a) => ({ ...a, detection: { ...a.detection, locations: ['~/.local/bin'] } })) };

const userLine = (sid: string, n: number, pad = 0) => `${JSON.stringify({ parentUuid: null, type: 'user', isSidechain: false,
  uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/xaibo-fixture/liveness',
  sessionId: sid, version: '2.1.319', message: { role: 'user', content: `synthetic ${n}${'x'.repeat(pad)}` } })}\n`;

/** A large transcript older than the active window, so it is backfilled (not tailed live). */
function bigTranscript(projectDir: string, sid: string, lines: number, pad = 0) {
  mkdirSync(projectDir, { recursive: true });
  const f = join(projectDir, `${sid}.jsonl`);
  writeFileSync(f, Array.from({ length: lines }, (_, i) => userLine(sid, i, pad)).join(''));
  const old = new Date(Date.now() - 3600_000);
  utimesSync(f, old, old);
  return f;
}

class Recording extends Writer {
  readonly batches: { rows: number; bytes: number; content: number }[] = [];
  override enqueue(batch: Batch, live: boolean): Promise<void> {
    if (batch.file) this.batches.push({ rows: batch.events.length, bytes: batch.events.reduce((n, e) => n + (e.raw?.length ?? 0) + (e.content?.length ?? 0), 0),
      content: batch.events.reduce((n, e) => n + (e.content?.length ?? 0), 0) });
    return super.enqueue(batch, live);
  }
}

test('(1) backfill: batches of at most 25 rows / 128 KiB, committed without the coalescing timer, the loop runs between them', async () => {
  const p = await claudeProfile([]);
  bigTranscript(join(p.root, 'projects', '-tmp-xaibo-fixture-liveness'), SID, 400);
  const writer = new Recording(p.db, { setTimer: () => undefined }); // a batch waiting for the timer would never commit
  const a = new ClaudeAdapter({ db: p.db, writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  let turns = 0;
  let on = true;
  const spin = () => { if (!on) return; turns++; setImmediate(spin); };
  setImmediate(spin);
  await Promise.race([a.start(), new Promise((_, rej) => setTimeout(() => rej(new Error('backfill waited for the coalescing timer')), 10_000))]);
  on = false;
  a.stop();
  assert.equal(count(p.db, 'SELECT count(*) FROM events'), 400);
  const intermediate = writer.batches.slice(0, -1); // the last batch carries the final checkpoint
  assert.ok(intermediate.length >= 15, `batches: ${writer.batches.length}`);
  for (const b of intermediate) assert.ok(b.rows <= 25 && b.bytes <= 128 * 1024 + 4096, `batch ${JSON.stringify(b)} over the bounds`);
  assert.ok(turns >= intermediate.length, `event-loop turns ${turns} < batches ${intermediate.length}`);
});

/** Oversized lines (above maxLineBytes) stream through the chunked path; their rows arrive per read chunk. */
export async function oversizedBatches(o: { chunkBytes?: number; bytesPerBatch?: number } = {}) {
  const p = await claudeProfile([]);
  bigTranscript(join(p.root, 'projects', '-tmp-xaibo-fixture-liveness'), SID, 6, 600_000); // 6 lines of ~600 KB
  const writer = new Recording(p.db);
  const a = new ClaudeAdapter({ db: p.db, writer, profileId: 'p1', root: p.root, intervalMs: 60_000, maxLineBytes: 64 * 1024, ...o });
  await a.start();
  a.stop();
  return writer.batches.slice(0, -1);
}

// The commit cost of an oversized line is its FTS content; its raw text is a few large rows (rawBytes) copied as is.
test('(1) backfill: an oversized-record batch indexes at most the byte bound plus one read chunk of content', async () => {
  const batches = await oversizedBatches();
  assert.ok(batches.length > 0);
  for (const b of batches) assert.ok(b.content <= 128 * 1024 + 128 * 1024, `batch ${JSON.stringify(b)} indexes over 256 KiB of content`);
});

test('(2) every watcher starts before any backfill: a Codex append during the Claude backfill is ingested first', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'xlive-')));
  const home = join(tmp, 'home');
  bigTranscript(join(home, '.claude', 'projects', '-tmp-xaibo-fixture-liveness'), SID, 12_000);
  const dated = join(home, '.codex', 'sessions', '2026', '01', '01');
  mkdirSync(dated, { recursive: true });
  cpSync(CODEX_FIX, dated, { recursive: true, filter: (f) => !f.endsWith('expected.json') });
  const rollout = join(dated, readdirSync(dated).find((f) => f.endsWith('.jsonl'))!);
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "2.1.319 (Claude Code)"\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const svc = await boot({ dataDir: join(tmp, 'data'), home, catalog, intervalMs: 60_000 });
  let done = false;
  void svc.done.then(() => { done = true; });
  try {
    const db = svc.store.db;
    const codexEvents = () => count(db, "SELECT count(*) FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.agent = 'codex'");
    await until(() => count(db, "SELECT count(*) FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.agent = 'claude'") > 0, 30_000);
    const before = codexEvents();
    appendFileSync(rollout, `${readFileSync(rollout, 'utf8').trim().split('\n').at(-1)}\n`);
    await until(() => codexEvents() > before || done, 60_000);
    assert.equal(done, false, 'the Codex append waited for the Claude backfill to end');
    await svc.done;
  } finally { svc.stop(); }
});

/** A store with Finishing… sessions (turn.start, then turn.end at `stopAt`), and a status clock frozen at `frozen` until
 *  `go()`, then advancing with real time: boot can take as long as it needs (Codex review L2). */
async function settling(stops: Record<string, number>, frozen: number) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'xsettle-')));
  const dataDir = join(base, 'data');
  mkdirSync(dataDir);
  mkdirSync(join(base, 'home'));
  const pre = await openStore({ file: join(dataDir, 'xaibo.db'), backupDir: join(dataDir, 'backups') });
  const put = pre.db.prepare("INSERT INTO status_evidence (agent, native_session_id, dedup, ts, rank, seq, confidence, ev) VALUES ('claude', ?, ?, ?, 0, ?, 'confirmed', ?)");
  for (const [sid, stopAt] of Object.entries(stops)) {
    put.run(sid, `${sid}:1`, stopAt - 1000, 1, JSON.stringify([{ k: 'turn.start', typed: true }]));
    put.run(sid, `${sid}:2`, stopAt, 2, JSON.stringify([{ k: 'turn.end' }]));
  }
  pre.db.close();
  let started: number | null = null;
  const ticks: { keys: string[]; at: number }[] = [];
  const now = () => (started === null ? frozen : frozen + (performance.now() - started));
  const svc = await boot({ dataDir, home: join(base, 'home'), catalog: { ...loadCatalog(), agents: [] }, now, onTick: (keys) => ticks.push({ keys, at: now() }) });
  return { svc, ticks, now, go: () => { started = performance.now(); } };
}
const SID2 = '00000000-0000-4000-8000-0000000f1641';

test('(3) boot calls onTick at a watched session\'s settle deadline', async () => {
  const stopAt = 1_000_000;
  const s = await settling({ [SID]: stopAt }, stopAt + 3800); // settle (4 s) due 200 ms after go()
  try {
    s.go();
    assert.equal(s.svc.status('claude', SID, 'p1')?.reason, 'Finishing…'); // the row read watches it
    await until(() => s.ticks.length > 0, 2_000);
    assert.deepEqual(s.ticks[0]!.keys, [`claude\0p1\0${SID}`]);
    assert.ok(s.ticks[0]!.at >= stopAt + 4000, 'not before the deadline');
    assert.ok(s.ticks[0]!.at - (stopAt + 4000) < 200, `late by ${Math.round(s.ticks[0]!.at - (stopAt + 4000))} ms`);
    assert.equal(s.svc.status('claude', SID, 'p1')?.lifecycle, 'idle');
  } finally { s.svc.stop(); }
});

test('(3) a newly watched session with an earlier deadline moves the timer earlier; the later one still fires', async () => {
  const s = await settling({ [SID]: 1_000_000 + 600, [SID2]: 1_000_000 }, 1_000_000 + 3800); // due 800 ms, then 200 ms
  try {
    s.go();
    s.svc.status('claude', SID, 'p1');
    s.svc.status('claude', SID2, 'p1');
    await until(() => s.ticks.length >= 2, 3_000);
    assert.deepEqual(s.ticks.map((t) => t.keys), [[`claude\0p1\0${SID2}`], [`claude\0p1\0${SID}`]]);
  } finally { s.svc.stop(); }
});

test('(3) stop() with a pending settle timer: no onTick afterwards', async () => {
  const s = await settling({ [SID]: 1_000_000 }, 1_000_000 + 3800);
  s.go();
  s.svc.status('claude', SID, 'p1');
  s.svc.stop();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(s.ticks.length, 0);
});

// Codex review M1 (a measured limit, not a hard bound): a line below the 8 MiB parse cap is parsed and committed as one
// record, so one huge line still holds the loop for its commit (measured: 1 MiB ~7 ms, 3 MiB ~24 ms, 6 MiB ~43 ms). Lowering
// the cap would move 1-8 MiB lines to the oversized path, which keeps only small fields (usage and tool rows lost); a
// writer worker thread is the upgrade if real stores show such lines during live work. A hook arriving during that commit
// may spool and is replayed. Under the parallel suite the same line held it ~142 ms, so this guard is load-tolerant: it
// catches an order-of-magnitude regression, not the exact figure.
test('(1) default options: one 6 MiB record holds the event loop for one bounded commit (< 400 ms even under suite load)', async () => {
  const p = await claudeProfile([]);
  const dir = join(p.root, 'projects', '-tmp-xaibo-fixture-liveness');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${SID}.jsonl`);
  const rec = (n: number, text: string) => `${JSON.stringify({ parentUuid: null, type: 'assistant', uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/xaibo-fixture/liveness', sessionId: SID, version: '2.1.319',
    message: { model: 'claude-opus-5-5', id: `msg_${n}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } })}\n`;
  writeFileSync(f, rec(1, 'small') + rec(2, 'w '.repeat(3 * 1024 * 1024)) + rec(3, 'small'));
  const old = new Date(Date.now() - 3600_000);
  utimesSync(f, old, old);
  const lates: number[] = [];
  let expect = performance.now() + 5;
  const tick = setInterval(() => { const n = performance.now(); lates.push(n - expect); expect = n + 5; }, 5);
  const a = new ClaudeAdapter({ db: p.db, writer: p.writer, profileId: 'p1', root: p.root, intervalMs: 60_000 });
  try { await a.start(); } finally { a.stop(); clearInterval(tick); }
  assert.equal(count(p.db, 'SELECT count(*) FROM events'), 3);
  assert.ok(Math.max(0, ...lates) < 400, `a 5 ms timer ran ${Math.round(Math.max(0, ...lates))} ms late`);
});

// review M1: watching a session only moves the settle timer earlier; it never rescans every watched session, so watching
// n sessions costs O(n), not O(n²) status reads (5,000 sessions: ~1.8 s with a rescan per watch, ~5 ms without).
test('(3) watching many settling sessions stays linear (no rescan per watch)', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'xsettle-')));
  const dataDir = join(base, 'data');
  mkdirSync(dataDir);
  mkdirSync(join(base, 'home'));
  const stopAt = Date.now();
  const pre = await openStore({ file: join(dataDir, 'xaibo.db'), backupDir: join(dataDir, 'backups') });
  const put = pre.db.prepare("INSERT INTO status_evidence (agent, native_session_id, dedup, ts, rank, seq, confidence, ev) VALUES ('claude', ?, ?, ?, 0, ?, 'confirmed', ?)");
  const sids = Array.from({ length: 5000 }, (_, i) => `00000000-0000-4000-8000-${String(900000 + i).padStart(12, '0')}`);
  pre.db.exec('BEGIN');
  for (const sid of sids) {
    put.run(sid, `${sid}:1`, stopAt - 1000, 1, JSON.stringify([{ k: 'turn.start', typed: true }]));
    put.run(sid, `${sid}:2`, stopAt, 2, JSON.stringify([{ k: 'turn.end' }]));
  }
  pre.db.exec('COMMIT');
  pre.db.close();
  const svc = await boot({ dataDir, home: join(base, 'home'), catalog: { ...loadCatalog(), agents: [] }, onTick: () => undefined });
  try {
    const t0 = performance.now();
    for (const sid of sids) svc.status('claude', sid, 'p1');
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `watching 5,000 sessions took ${Math.round(ms)} ms`);
  } finally { svc.stop(); }
});
