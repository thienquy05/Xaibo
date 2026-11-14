// XAIBO-PROD-316 (P3-T13c; PRD §5.10): the xaibo-report helper (forwarder report mode) shares the forwarder's delivery-ID
// and spool logic. It reads one report event from stdin and the registration token from a private file, checks the token
// against the stored hash before anything leaves, assigns a delivery_id only when the event has none, sends with the
// registration hello, and on a transient failure spools the frame (never the token) for the service's replay. Permanent
// failures exit 2 with one code-only stderr line and leave nothing behind; stdout stays empty. Socket cases skip only on
// the Claude sandbox's EPERM for bind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { startSocketServer } from '../../src/service/receivers/socket.ts';
import { replaySpool } from '../../src/service/receivers/spool-replay.ts';
import { addRegistration, openRegistry, removeRegistration } from '../../src/service/receivers/registrations.ts';
import { createReportIntake } from '../../src/service/receivers/report.ts';
import { createEngine } from '../../src/service/status/engine.ts';
import { count } from '../helpers/claude-profile.ts';
import { envelope, hookStore } from '../helpers/hook-store.ts';

const REPO = join(import.meta.dirname, '..', '..');
const FWD = join(REPO, 'src', 'forwarder', 'forwarder.ts');
const SESSION = '00000000-0000-4000-8000-00000b150100';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const probe = await (async () => {
  const { dir } = await hookStore();
  return new Promise<string>((resolve) => {
    const s = net.createServer().once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error')).listen(join(dir, 'p.sock'), () => s.close(() => resolve('ok')));
  });
})();
if (probe !== 'ok' && probe !== 'EPERM') throw new Error(`unexpected socket probe failure: ${probe}`);
const skip = probe === 'EPERM' ? 'Unix socket bind is denied here (Claude sandbox); runs in the unsandboxed suite' : false;

let seq = 0;
const event = (o: Record<string, unknown> = {}) => ({ v: 1, delivery_id: `h-${++seq}`, session_id: SESSION, producer_id: 'fixture-producer', producer_seq: seq,
  event: 'turn.start', source_ts: '2026-01-01T00:00:00.000Z', payload: {}, ...o });

/** Store with profile p1 (claude), a registration bound to it, its token in a private file, and the report intake. */
async function setup() {
  const h = await hookStore();
  const { registration, token } = addRegistration(h.dir, { agent: 'claude', profileKey: 'p1' });
  const tokenFile = join(h.dir, 'producer.token');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const registry = openRegistry(h.dir);
  const reports = createReportIntake({ db: h.db, writer: h.writer, dataDir: h.dir });
  const deliverReport = (id: string, frame: unknown) => {
    const reg = registry.current(id);
    return reg ? reports.deliver(reg, frame) : Promise.resolve({ status: 'rejected' as const, code: 'auth' });
  };
  return { ...h, reg: registration, token, tokenFile, registry, reports, deliverReport };
}

/** Runs a command without blocking this event loop (an in-process server must be able to ack). */
function run(cmd: string, args: string[], input: string | Buffer, env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: { PATH: process.env.PATH ?? '', ELECTRON_RUN_AS_NODE: '1', ...env } });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
    c.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    c.on('error', reject);
    c.on('close', (status) => resolve({ status, stdout, stderr }));
    c.stdin.on('error', () => {});
    c.stdin.end(input);
  });
}
const report = (dir: string, args: string[], input: string | Buffer) => run(process.execPath, [FWD, 'report', ...args], input, { XAIBO_DATA_DIR: dir });
const spooled = (dir: string) => existsSync(join(dir, 'spool'))
  ? readdirSync(join(dir, 'spool')).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(dir, 'spool', f), 'utf8').split('\n').filter(Boolean))
  : [];

test('service down: the event is spooled with a generated delivery_id and without the token; replay stores it once', async () => {
  const h = await setup();
  const { delivery_id: _drop, ...noId } = event();
  const r = await report(h.dir, [h.reg.id, h.tokenFile], JSON.stringify(noId));
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  const lines = spooled(h.dir);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes(h.token), 'the token is never spooled');
  const rec = JSON.parse(lines[0]!) as { v: number; kind: string; registration: string; received_ts: number; frame: Record<string, unknown> };
  assert.deepEqual([rec.v, rec.kind, rec.registration], [1, 'report', h.reg.id]);
  assert.match(String(rec.frame['delivery_id']), UUID, 'a missing delivery_id is assigned before the spool');
  const first = await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, deliverReport: h.deliverReport, graceMs: 0 });
  assert.equal(first.delivered, 1);
  assert.equal(count(h.db, 'SELECT count(*) FROM report_delivery WHERE delivery_id = ?', String(rec.frame['delivery_id'])), 1);
  assert.equal(count(h.db, "SELECT count(*) FROM events WHERE source = 'report'"), 1);
  assert.deepEqual(spooled(h.dir), [], 'replayed files removed');
});

test('a given delivery_id is preserved through the spool, so a retry and its replay collapse', async () => {
  const h = await setup();
  const e = event();
  for (let i = 0; i < 2; i++) assert.equal((await report(h.dir, [h.reg.id, h.tokenFile], JSON.stringify(e))).status, 0);
  const lines = spooled(h.dir).map((l) => JSON.parse(l) as { frame: { delivery_id: string } });
  assert.deepEqual(lines.map((l) => l.frame.delivery_id), [e.delivery_id, e.delivery_id]);
  await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, deliverReport: h.deliverReport, graceMs: 0 });
  assert.equal(count(h.db, 'SELECT count(*) FROM report_delivery'), 1);
});

test('permanent failures exit 2 with one code-only line and leave nothing behind', async () => {
  const h = await setup();
  const loose = join(h.dir, 'loose.token');
  writeFileSync(loose, h.token, { mode: 0o644 });
  const wrong = join(h.dir, 'wrong.token');
  writeFileSync(wrong, `${h.token}x`, { mode: 0o600 });
  const cases: [string[], string | Buffer, string][] = [
    [[h.reg.id, wrong], JSON.stringify(event()), 'auth'],
    [['00000000-0000-4000-8000-00000000dead', h.tokenFile], JSON.stringify(event()), 'auth'],
    [[h.reg.id, loose], JSON.stringify(event()), 'token'],
    [[h.reg.id, join(h.dir, 'missing.token')], JSON.stringify(event()), 'token'],
    [[h.reg.id, h.tokenFile], '{not json', 'malformed'],
    [[h.reg.id, h.tokenFile], '[1,2]', 'malformed'],
    [[h.reg.id, h.tokenFile], Buffer.alloc((256 << 10) + 1, 0x20), 'oversize'],
    [['not-a-uuid', h.tokenFile], JSON.stringify(event()), 'usage'],
    [[h.reg.id], JSON.stringify(event()), 'usage'],
  ];
  for (const [args, input, code] of cases) {
    const r = await report(h.dir, args, input);
    assert.equal(r.status, 2, `${code}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `xaibo-report: ${code}\n`);
    assert.ok(!r.stderr.includes(h.token));
  }
  assert.deepEqual(spooled(h.dir), []);
});

test('review 872c: a token file with a trailing newline works; a bad caller delivery_id exits 2', async () => {
  const h = await setup();
  writeFileSync(h.tokenFile, `${h.token}\n`, { mode: 0o600 });
  assert.equal((await report(h.dir, [h.reg.id, h.tokenFile], JSON.stringify(event()))).status, 0);
  for (const id of ['', 'x'.repeat(129), 7, 'bad\ud800id']) {
    const r = await report(h.dir, [h.reg.id, h.tokenFile], JSON.stringify(event({ delivery_id: id })));
    assert.deepEqual([r.status, r.stderr], [2, 'xaibo-report: invalid-delivery_id\n'], JSON.stringify(id));
  }
  assert.equal(spooled(h.dir).length, 1);
});

test('review M2: a spool that cannot take the event exits 2 (spool), never a false 0', async () => {
  const h = await setup();
  mkdirSync(join(h.dir, 'spool'), { mode: 0o755 });
  chmodSync(join(h.dir, 'spool'), 0o500); // ours but not writable: the append fails
  try {
    const r = await report(h.dir, [h.reg.id, h.tokenFile], JSON.stringify(event()));
    assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', 'xaibo-report: spool\n']);
  } finally { chmodSync(join(h.dir, 'spool'), 0o700); }
});

test('review L4: replay stops on a rejection it does not know to be permanent, keeping the record', async () => {
  const h = await setup();
  assert.equal((await report(h.dir, [h.reg.id, h.tokenFile], JSON.stringify(event()))).status, 0);
  const busy = await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, deliverReport: async () => ({ status: 'rejected', code: 'busy' }), graceMs: 0 });
  assert.deepEqual([busy.complete, busy.dropped], [false, 0]);
  assert.equal(spooled(h.dir).length, 1, 'kept for the next replay');
  const ok = await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, deliverReport: h.deliverReport, graceMs: 0 });
  assert.equal(ok.delivered, 1);
});

test('never blocks: a producer that never closes stdin ends within the deadline, nothing left behind', async () => {
  const h = await setup();
  const t0 = Date.now();
  const r = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const c = spawn(process.execPath, [FWD, 'report', h.reg.id, h.tokenFile], { env: { PATH: process.env.PATH ?? '', ELECTRON_RUN_AS_NODE: '1', XAIBO_DATA_DIR: h.dir } });
    let stderr = '';
    c.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    c.stdin.on('error', () => {});
    c.stdin.write('{"v":1,');
    c.on('close', (status) => resolve({ status, stderr }));
  });
  assert.ok(Date.now() - t0 < 4000, `ended in ${Date.now() - t0} ms`);
  assert.deepEqual([r.status, r.stderr], [2, 'xaibo-report: stdin\n']);
  assert.deepEqual(spooled(h.dir), []);
});

test('replay: report records with a bad registration id or a non-object frame are skipped as torn, never delivered', async () => {
  const h = await setup();
  mkdirSync(join(h.dir, 'spool'), { recursive: true, mode: 0o700 });
  const bad = [
    { v: 1, kind: 'report', registration: '../etc', received_ts: 1, frame: event() },
    { v: 1, kind: 'report', registration: h.reg.id, received_ts: 1, frame: [event()] },
    { v: 1, kind: 'report', registration: h.reg.id, received_ts: 1, frame: event(), agent: 'codex' },
  ];
  writeFileSync(join(h.dir, 'spool', '2099-01-02.jsonl'), bad.map((b) => `\n${JSON.stringify(b)}\n`).join(''), { mode: 0o600 });
  const r = await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, deliverReport: h.deliverReport, graceMs: 0 });
  assert.equal(r.torn, 3);
  assert.equal(count(h.db, 'SELECT count(*) FROM report_delivery'), 0);
});

test('never blocks: a socket that never acks spools the exact frame within the deadline', { skip }, async () => {
  const h = await setup();
  mkdirSync(join(h.dir, 'run'), { mode: 0o700 });
  const server = net.createServer(() => { /* accepts, never answers */ }).listen(join(h.dir, 'run', 'xaibo.sock'));
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const e = event();
    const t0 = Date.now();
    const r = await report(h.dir, [h.reg.id, h.tokenFile], JSON.stringify(e));
    assert.ok(Date.now() - t0 < 4000);
    assert.equal(r.status, 0);
    const lines = spooled(h.dir).map((l) => JSON.parse(l) as { frame: unknown });
    assert.deepEqual(lines.map((l) => l.frame), [e], 'the frame as sent, id included');
  } finally { server.close(); }
});

test('replay: a spooled report of a revoked registration is skipped and never blocks later records', async () => {
  const h = await setup();
  assert.equal((await report(h.dir, [h.reg.id, h.tokenFile], JSON.stringify(event()))).status, 0);
  removeRegistration(h.dir, h.reg.id);
  mkdirSync(join(h.dir, 'spool'), { recursive: true, mode: 0o700 });
  const later = envelope({ received_ts: Date.now() + 1000 }); // a hook delivery spooled after it
  writeFileSync(join(h.dir, 'spool', '2099-01-01.jsonl'), `\n${JSON.stringify(later)}\n`, { mode: 0o600 });
  const r = await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, deliverReport: h.deliverReport, graceMs: 0 });
  assert.equal(r.complete, true);
  assert.equal(r.dropped, 1);
  assert.equal(count(h.db, 'SELECT count(*) FROM report_delivery'), 0);
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery WHERE delivery_id = ?', later.delivery_id), 1);
  assert.deepEqual(spooled(h.dir), []);
});

test('the xaibo-report shim runs only our own non-writable forwarder and keeps exit codes', async () => {
  const h = await setup();
  const bin = join(h.dir, 'integrations', 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const shim = join(bin, 'xaibo-report');
  copyFileSync(join(REPO, 'src', 'forwarder', 'xaibo-report'), shim);
  chmodSync(shim, 0o755);
  const fwd = join(bin, 'xaibo-forwarder');
  writeFileSync(fwd, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FWD)} "$@"\n`, { mode: 0o755 });
  const ok = await run(shim, [h.reg.id, h.tokenFile], JSON.stringify(event()), {});
  assert.deepEqual([ok.status, ok.stdout, ok.stderr], [0, '', '']);
  assert.equal(spooled(h.dir).length, 1, 'the data dir comes from the shim location; no service, so spooled');
  const bad = await run(shim, [h.reg.id, h.tokenFile], '{not json', {});
  assert.deepEqual([bad.status, bad.stderr], [2, 'xaibo-report: malformed\n'], 'exit code and stderr pass through');
  chmodSync(fwd, 0o775);
  const refused = await run(shim, [h.reg.id, h.tokenFile], JSON.stringify(event()), {});
  assert.deepEqual([refused.status, refused.stderr], [2, 'xaibo-report: forwarder\n']);
  assert.equal(spooled(h.dir).length, 1, 'a group-writable forwarder never runs');
});

test('service up: accepted end to end (exit 0, stored once, not spooled); an invalid report exits 2', { skip }, async () => {
  const h = await setup();
  const server = await startSocketServer({ dataDir: h.dir, onEnvelope: h.intake.deliver, reports: { registry: h.registry, intake: h.reports } });
  try {
    const e = event();
    const r = await report(h.dir, [h.reg.id, h.tokenFile], JSON.stringify(e));
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
    assert.equal(count(h.db, 'SELECT count(*) FROM report_delivery WHERE delivery_id = ?', e.delivery_id), 1);
    assert.equal((await report(h.dir, [h.reg.id, h.tokenFile], JSON.stringify(e))).status, 0, 'a duplicate is accepted');
    const bad = await report(h.dir, [h.reg.id, h.tokenFile], JSON.stringify(event({ v: 2 })));
    assert.deepEqual([bad.status, bad.stderr], [2, 'xaibo-report: unsupported-version\n']);
    assert.deepEqual(spooled(h.dir), []);
  } finally { await server.close(); }
});

test('G3c-3: a spooled report keeps the helper received_ts through replay, so an old permission request never notifies', async () => {
  const h = await setup();
  const waits: string[] = [];
  const engine = createEngine({ db: h.db, now: Date.now, settleMs: 4000, log: () => {}, onWait: (...a) => waits.push(a.join('/')) });
  const reports = createReportIntake({ db: h.db, writer: h.writer, dataDir: h.dir,
    publish: (e, durable) => { if (durable) engine.ingest({ source: 'report', envelope: e }); } });
  const deliverReport = (id: string, frame: unknown, receivedTs?: number) => {
    const reg = h.registry.current(id);
    return reg ? reports.deliver(reg, frame, receivedTs) : Promise.resolve({ status: 'rejected' as const, code: 'auth' });
  };
  const old = Date.now() - 3600_000; // spooled an hour ago, during an outage
  const rec = (ts: number, o: Record<string, unknown>) => JSON.stringify({ v: 1, kind: 'report', registration: h.reg.id, received_ts: ts, frame: event(o) });
  mkdirSync(join(h.dir, 'spool'), { recursive: true, mode: 0o700 });
  writeFileSync(join(h.dir, 'spool', '2026-01-01.jsonl'), `${rec(old, { event: 'session.start' })}\n${rec(old + 1, { event: 'permission.request', request_id: 'q1' })}\n`, { mode: 0o600 });
  const r = await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver, deliverReport, graceMs: 0 });
  assert.deepEqual([r.complete, r.delivered], [true, 2]);
  assert.equal(count(h.db, 'SELECT count(*) FROM report_delivery WHERE received_ts = ?', old + 1), 1, 'the helper received_ts is kept');
  assert.deepEqual(waits, [], 'a stale replayed request does not notify');
});
