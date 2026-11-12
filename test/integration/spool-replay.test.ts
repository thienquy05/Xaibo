// XAIBO-PROD-304 (P3-T04, EC-11 replay side, EC-12 gap): spooled deliveries replay oldest first through intake, each
// stored once; a file is removed only after every record committed (a late append keeps it for the next replay); torn
// records are counted as a gap; overflow.log and overflow.saturated become exact gap rows once, then are removed. Only
// a private spool/ of our own and regular single-link files are read; nothing is followed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Envelope } from '../../src/shared/hook-protocol.ts';
import { startHooks } from '../../src/service/receivers/intake.ts';
import { replaySpool } from '../../src/service/receivers/spool-replay.ts';
import { count } from '../helpers/claude-profile.ts';
import { envelope, hookStore, SESSION, T0 } from '../helpers/hook-store.ts';

const FWD = join(import.meta.dirname, '..', '..', 'src', 'forwarder', 'forwarder.ts');
const spoolOf = (dir: string) => { const s = join(dir, 'spool'); mkdirSync(s, { recursive: true, mode: 0o700 }); return s; };
const line = (e: Envelope) => `\n${JSON.stringify(e)}\n`;
const jsonl = (dir: string) => (existsSync(join(dir, 'spool')) ? readdirSync(join(dir, 'spool')).filter((f) => f.endsWith('.jsonl')) : []);
const gaps = (db: import('node:sqlite').DatabaseSync) => db.prepare('SELECT reason, agent, native_session_id AS session, from_ts AS "from", to_ts AS "to", count FROM hook_gaps ORDER BY reason, agent, session')
  .all().map((r) => ({ ...(r as object) }));

test('EC-11: service down, 20 hooks fired, then replay: each stored once, spool empty; a second replay adds nothing', async () => {
  const h = await hookStore();
  for (let i = 0; i < 20; i++) {
    const r = spawnSync(process.execPath, [FWD, 'hook', 'claude', 'p1'], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SESSION, n: i }), env: { PATH: process.env.PATH ?? '', XAIBO_DATA_DIR: h.dir, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10_000, // Node under test:electron too
    });
    assert.equal(r.status, 0);
  }
  const first = await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver });
  assert.equal(first.delivered, 20);
  assert.equal(first.complete, true);
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery'), 20);
  assert.equal(count(h.db, "SELECT count(*) FROM events WHERE source = 'hook'"), 20);
  assert.deepEqual(jsonl(h.dir), []);
  const again = await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver });
  assert.equal(again.delivered, 0);
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery'), 20);
});

test('replay is oldest first across files by received_ts', async () => {
  const h = await hookStore();
  const s = spoolOf(h.dir);
  const [a, b, c] = [envelope({ received_ts: T0 + 3 }), envelope({ received_ts: T0 + 1 }), envelope({ received_ts: T0 + 2 })];
  writeFileSync(join(s, '2026-01-02.jsonl'), line(a) + line(b), { mode: 0o600 });
  writeFileSync(join(s, '2026-01-01.jsonl'), line(c), { mode: 0o600 });
  const order: number[] = [];
  await replaySpool({ dataDir: h.dir, db: h.db, deliver: (e) => { order.push(e.received_ts); return h.intake.deliver(e); } });
  assert.deepEqual(order, [T0 + 1, T0 + 2, T0 + 3]);
});

test('a torn record is skipped and counted as a gap; the valid records are stored and the file removed', async () => {
  const h = await hookStore();
  const s = spoolOf(h.dir);
  writeFileSync(join(s, '2026-01-01.jsonl'), `${line(envelope())}\n{"v":1,"delivery_id":"0000${line(envelope())}\n{"v":2}\n`, { mode: 0o600 });
  const r = await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver });
  assert.equal(r.delivered, 2);
  assert.equal(r.torn, 2);
  assert.deepEqual(jsonl(h.dir), []);
  assert.deepEqual(gaps(h.db), [{ reason: 'spool-torn', agent: null, session: null, from: null, to: null, count: 2 }]);
});

test('a rejected delivery stops the replay and keeps every file; the next replay completes without duplicates', async () => {
  const h = await hookStore();
  const s = spoolOf(h.dir);
  writeFileSync(join(s, '2026-01-01.jsonl'), [1, 2, 3].map((i) => line(envelope({ received_ts: T0 + i }))).join(''), { mode: 0o600 });
  let n = 0;
  const r = await replaySpool({ dataDir: h.dir, db: h.db, deliver: async (e) => (++n === 2 ? { status: 'rejected', code: 'disk-full' } : h.intake.deliver(e)) });
  assert.equal(r.complete, false);
  assert.equal(jsonl(h.dir).length, 1, 'kept (under its replay name)');
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery'), 1);
  const again = await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver });
  assert.equal(again.complete, true);
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery'), 3);
  assert.deepEqual(jsonl(h.dir), []);
});

test('a record appended to a file while it replays keeps the file; the next replay stores it', async () => {
  const h = await hookStore();
  const s = spoolOf(h.dir);
  writeFileSync(join(s, '2026-01-01.jsonl'), line(envelope()), { mode: 0o600 });
  const late = envelope({ received_ts: T0 + 9 });
  let appended = false;
  await replaySpool({ dataDir: h.dir, db: h.db, deliver: (e) => {
    if (!appended) { appended = true; appendFileSync(join(s, jsonl(h.dir)[0]!), line(late)); } // a forwarder that opened the old name
    return h.intake.deliver(e);
  } });
  assert.equal(jsonl(h.dir).length, 1);
  await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver });
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery WHERE delivery_id = ?', late.delivery_id), 1);
  assert.deepEqual(jsonl(h.dir), []);
});

test('untrusted entries are never read or followed: a symlinked spool/, a symlinked or hard-linked file', async () => {
  const h = await hookStore();
  const elsewhere = join(h.dir, 'elsewhere');
  mkdirSync(elsewhere, { mode: 0o700 });
  const target = join(elsewhere, '2026-01-01.jsonl');
  const body = line(envelope());
  writeFileSync(target, body, { mode: 0o600 });
  symlinkSync(elsewhere, join(h.dir, 'spool'));
  const viaDir = await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver });
  assert.equal(viaDir.delivered, 0);

  const h2 = await hookStore();
  const s = spoolOf(h2.dir);
  symlinkSync(target, join(s, '2026-01-02.jsonl'));
  linkSync(target, join(s, '2026-01-03.jsonl'));
  const r = await replaySpool({ dataDir: h2.dir, db: h2.db, deliver: h2.intake.deliver });
  assert.equal(r.delivered, 0);
  assert.equal(r.skipped, 2);
  assert.equal(readFileSync(target, 'utf8'), body, 'the link target is untouched');
  assert.equal(count(h2.db, 'SELECT count(*) FROM hook_delivery'), 0);
});

test('EC-12: overflow.log becomes one gap per {agent, session, time range}, once; saturated adds an open-count gap', async () => {
  const now = T0 + 100_000;
  const h = await hookStore();
  const s = spoolOf(h.dir);
  const log = [
    { ts: T0 + 10, agent: 'claude', session_id: 's1', event: 'Stop' },
    { ts: T0 + 20, agent: 'claude', session_id: 's1', event: 'PreToolUse' },
    { ts: T0 + 30, agent: 'codex', session_id: null, event: 'Stop' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\nnot json\n';
  writeFileSync(join(s, 'overflow.log'), log, { mode: 0o600 });
  writeFileSync(join(s, 'overflow.saturated'), '', { mode: 0o600 });
  await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, now: () => now });
  const expected = [
    { reason: 'spool-overflow', agent: null, session: null, from: null, to: null, count: 1 },
    { reason: 'spool-overflow', agent: 'claude', session: 's1', from: T0 + 10, to: T0 + 20, count: 2 },
    { reason: 'spool-overflow', agent: 'codex', session: null, from: T0 + 30, to: T0 + 30, count: 1 },
  ];
  const got = gaps(h.db);
  assert.deepEqual(got.filter((g) => (g as { reason: string }).reason === 'spool-overflow'), expected);
  const sat = got.filter((g) => (g as { reason: string }).reason === 'spool-saturated') as { to: number; count: number | null }[];
  assert.equal(sat.length, 1);
  assert.equal(sat[0]!.to, now);
  assert.equal(sat[0]!.count, null, 'the number lost after saturation is unknown');
  assert.deepEqual(readdirSync(s), []);
  // a crash after the commit but before the removal leaves the taken log under its own name: it is not counted twice
  const taken = join(s, 'overflow.taken-00000000-0000-4000-8000-000000000001.log');
  writeFileSync(taken, log, { mode: 0o600 });
  await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, now: () => now, graceMs: 0 });
  const after = gaps(h.db).length;
  writeFileSync(taken, log, { mode: 0o600 });
  await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, now: () => now, graceMs: 0 });
  assert.equal(gaps(h.db).length, after);
  assert.deepEqual(readdirSync(s), []);
});

// Interim Codex review of P3-T04 (findings 1-4).
const total = (db: import('node:sqlite').DatabaseSync, reason: string) => count(db, 'SELECT coalesce(sum(count), 0) FROM hook_gaps WHERE reason = ?', reason);

test('R1: a forwarder that opened the old name and writes after the last delivery loses nothing (grace before removal)', async () => {
  const h = await hookStore();
  const s = spoolOf(h.dir);
  const file = join(s, '2026-01-01.jsonl');
  writeFileSync(file, line(envelope()), { mode: 0o600 });
  const fd = openSync(file, 'a'); // validated and opened before the rename
  const late = envelope({ received_ts: T0 + 9 });
  const overflow = join(s, 'overflow.log');
  writeFileSync(overflow, `${JSON.stringify({ ts: T0, agent: 'claude', session_id: 's1', event: 'Stop' })}\n`, { mode: 0o600 });
  const ofd = openSync(overflow, 'a');
  try {
    await replaySpool({ dataDir: h.dir, db: h.db, graceMs: 300, deliver: async (e) => {
      const r = await h.intake.deliver(e);
      setTimeout(() => { // after the last delivery, inside the forwarder's window
        writeSync(fd, line(late));
        writeSync(ofd, `${JSON.stringify({ ts: T0 + 5, agent: 'claude', session_id: 's1', event: 'Stop' })}\n`);
      }, 50);
      return r;
    } });
  } finally { closeSync(fd); closeSync(ofd); }
  await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, graceMs: 0 });
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery WHERE delivery_id = ?', late.delivery_id), 1);
  assert.deepEqual({ ...(h.db.prepare("SELECT from_ts AS f, to_ts AS t, count AS n FROM hook_gaps WHERE reason = 'spool-overflow'").get() as object) },
    { f: T0, t: T0 + 5, n: 2 });
  assert.deepEqual(readdirSync(s), []);
});

test('R2: torn records are counted per file, so a crash between removals never counts a file twice', async () => {
  const h = await hookStore();
  const s = spoolOf(h.dir);
  writeFileSync(join(s, '2026-01-01.jsonl'), `${line(envelope())}{"torn\n`, { mode: 0o600 });
  writeFileSync(join(s, '2026-01-02.jsonl'), `${line(envelope())}{"torn\n`, { mode: 0o600 });
  const seen = new Map<string, string>();
  await replaySpool({ dataDir: h.dir, db: h.db, graceMs: 0, deliver: (e) => {
    for (const f of jsonl(h.dir)) seen.set(f, readFileSync(join(s, f), 'utf8'));
    return h.intake.deliver(e);
  } });
  assert.equal(total(h.db, 'spool-torn'), 2);
  const [name, body] = [...seen][1]!; // as if the crash came after the first removal
  writeFileSync(join(s, name), body, { mode: 0o600 });
  await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, graceMs: 0 });
  assert.equal(total(h.db, 'spool-torn'), 2);
  assert.deepEqual(jsonl(h.dir), []);
});

test('R3: two separate overflow logs with identical lines both count', async () => {
  const h = await hookStore();
  const s = spoolOf(h.dir);
  const body = `${JSON.stringify({ ts: T0, agent: 'claude', session_id: 's1', event: 'Stop' })}\n`;
  writeFileSync(join(s, 'overflow.taken-00000000-0000-4000-8000-00000000000a.log'), body, { mode: 0o600 });
  writeFileSync(join(s, 'overflow.taken-00000000-0000-4000-8000-00000000000b.log'), body, { mode: 0o600 });
  await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, graceMs: 0 });
  assert.equal(total(h.db, 'spool-overflow'), 2);
});

test('R4: replay memory is bounded in aggregate: files past the bound wait for the next replay, nothing is lost', async () => {
  const h = await hookStore();
  const s = spoolOf(h.dir);
  const bodies = [1, 2, 3].map((d) => [0, 1].map(() => line(envelope({ received_ts: T0 + d }))).join(''));
  bodies.forEach((b, i) => writeFileSync(join(s, `2026-01-0${i + 1}.jsonl`), b, { mode: 0o600 }));
  const maxBytes = Buffer.byteLength(bodies[0]!) + 1;
  const first = await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, graceMs: 0, maxBytes });
  assert.equal(first.delivered, 2);
  assert.equal(first.deferred, 2);
  assert.equal(jsonl(h.dir).length, 2);
  for (let i = 0; i < 2; i++) await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, graceMs: 0, maxBytes });
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery'), 6);
  assert.deepEqual(jsonl(h.dir), []);
});

test('R1b: a file already under its replay name (retry after a failed replay) also waits the grace before removal', async () => {
  const h = await hookStore();
  const s = spoolOf(h.dir);
  const file = join(s, '2026-01-01.replay-00000000-0000-4000-8000-0000000000aa.jsonl');
  writeFileSync(file, line(envelope()), { mode: 0o600 });
  const fd = openSync(file, 'a'); // a forwarder that opened the plain name just before the earlier rename
  const late = envelope({ received_ts: T0 + 9 });
  try {
    await replaySpool({ dataDir: h.dir, db: h.db, graceMs: 300, deliver: async (e) => {
      const r = await h.intake.deliver(e);
      setTimeout(() => writeSync(fd, line(late)), 50);
      return r;
    } });
  } finally { closeSync(fd); }
  await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, graceMs: 0 });
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery WHERE delivery_id = ?', late.delivery_id), 1);
  assert.deepEqual(jsonl(h.dir), []);
});

test('R5: service stop during the background replay: no delivery or gap write after close, files kept, no failure', async () => {
  const h = await hookStore();
  const s = spoolOf(h.dir);
  writeFileSync(join(s, '2026-01-01.jsonl'), [1, 2, 3].map((i) => line(envelope({ received_ts: T0 + i }))).join('') + '{"torn\n', { mode: 0o600 });
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer }); // the socket may not listen here; the replay runs anyway
  const closing = svc.close();
  h.db.close(); // as boot.stop() does right after
  const r = await svc.replay;
  await closing;
  assert.equal(r.complete, false);
  assert.ok(r.delivered < 3);
  assert.equal(jsonl(h.dir).length, 1, 'kept for the next start');
});

test('R6: service stop during the cleanup grace keeps the files', async () => {
  const h = await hookStore();
  const s = spoolOf(h.dir);
  writeFileSync(join(s, '2026-01-01.jsonl'), line(envelope()), { mode: 0o600 });
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer });
  await new Promise((r) => setTimeout(r, 100)); // delivered; the 1 s grace is running
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery'), 1);
  await svc.close();
  await svc.replay;
  assert.equal(jsonl(h.dir).length, 1, 'nothing removed after stop');
});
