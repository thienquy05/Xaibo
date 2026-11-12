// XAIBO-PROD-314 (P3-T13b; PRD §5.10, SEC2, FR-08; EC-82; Q3-9; security review 872): report v1 transport. A locally
// approved registration (dev-cli register, typed confirmation, token hash only) binds agent and profile; a producer
// authenticates with its registration token on the private socket and its frames can never name another identity.
// Delivery dedup is (registration, delivery_id); content.upsert chunks assemble on disk and an item is complete only when
// every chunk is durable, exactly once across a restart; rejected frames are explicit coverage. Socket cases skip only on
// the Claude sandbox's EPERM for bind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecoder, encodeFrame, type Envelope } from '../../src/shared/hook-protocol.ts';
import { createScheduler, startSocketServer } from '../../src/service/receivers/socket.ts';
import { addRegistration, openRegistry, removeRegistration, type Registration } from '../../src/service/receivers/registrations.ts';
import { createReportIntake, type ReportIntakeOptions } from '../../src/service/receivers/report.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer } from '../../src/service/store/writer.ts';
import { count } from '../helpers/claude-profile.ts';
import { hookStore } from '../helpers/hook-store.ts';

const REPO = join(import.meta.dirname, '..', '..');
const CLI = join(REPO, 'src', 'service', 'config', 'dev-cli.ts');
const SESSION = '00000000-0000-4000-8000-00000b140100';
const probe = await (async () => {
  const { dir } = await hookStore();
  return new Promise<string>((resolve) => {
    const s = net.createServer().once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error')).listen(join(dir, 'p.sock'), () => s.close(() => resolve('ok')));
  });
})();
if (probe !== 'ok' && probe !== 'EPERM') throw new Error(`unexpected socket probe failure: ${probe}`);
const skip = probe === 'EPERM' ? 'Unix socket bind is denied here (Claude sandbox); runs in the unsandboxed suite' : false;

let seq = 0;
function report(o: Record<string, unknown> = {}, payload: Record<string, unknown> = {}): Record<string, unknown> {
  seq++;
  return { v: 1, delivery_id: `d-${seq}`, session_id: SESSION, producer_id: 'fixture-producer', producer_seq: seq, event: 'turn.start',
    source_ts: '2026-01-01T00:00:00.000Z', payload, ...o };
}
const chunk = (item: string, index: number, final: boolean, content: string, o: Record<string, unknown> = {}) =>
  report({ event: 'content.upsert', item_id: item, ...o }, { revision: 1, role: 'assistant', kind: 'message', content, chunk_index: index, final });

/** A store with profile p1 (claude), one registration bound to it, and the report intake. */
async function reportStore(o: Omit<ReportIntakeOptions, 'db' | 'writer' | 'dataDir'> = {}) {
  const h = await hookStore();
  const { registration, token } = addRegistration(h.dir, { agent: 'claude', profileKey: 'p1' });
  const reports = createReportIntake({ db: h.db, writer: h.writer, dataDir: h.dir, ...o });
  return { ...h, reg: registration, token, reports, registry: openRegistry(h.dir) };
}

test('EC-82: a 5 MiB item in 21 chunks, stopped after chunk 9, retried from the start: complete exactly once', async () => {
  const h = await reportStore();
  const text = Array.from({ length: 5 << 20 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
  const size = Math.ceil(text.length / 21);
  const frames = Array.from({ length: 21 }, (_, i) => chunk('big', i, i === 20, text.slice(i * size, (i + 1) * size)));
  for (const f of frames) assert.ok(Buffer.byteLength(JSON.stringify(f)) <= 256 << 10, 'every frame within 256 KiB');
  for (const f of frames.slice(0, 10)) assert.equal((await h.reports.deliver(h.reg, f)).status, 'accepted');
  assert.equal(count(h.db, "SELECT count(*) FROM report_content WHERE state = 'pending'"), 1, 'labelled pending (incomplete) meanwhile');
  h.db.close(); // the service stops: nothing in memory survives

  const store = await openStore({ file: join(h.dir, 'xaibo.db'), backupDir: join(h.dir, 'backups') });
  const reports = createReportIntake({ db: store.db, writer: new Writer(store.db), dataDir: h.dir });
  const codes = [];
  for (const f of frames) codes.push((await reports.deliver(h.reg, f)).code);
  assert.deepEqual(codes, [...Array(10).fill('duplicate'), ...Array(11).fill('ok')]);
  const rows = store.db.prepare('SELECT state, chunks, bytes, content FROM report_content').all() as { state: string; chunks: number; bytes: number; content: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, 'complete');
  assert.equal(rows[0]!.chunks, 21);
  assert.equal(rows[0]!.bytes, 5 << 20);
  assert.equal(rows[0]!.content, text);
  assert.equal(count(store.db, 'SELECT count(*) FROM report_delivery'), 21);
  assert.deepEqual(readdirSync(join(h.dir, 'content-chunks', h.reg.id)), [], 'assembled chunks removed');
  assert.equal((await reports.deliver(h.reg, frames[3]!)).code, 'duplicate');
  assert.equal((await reports.deliver(h.reg, chunk('big', 3, false, 'late copy under a new delivery id'))).code, 'ok');
  assert.equal(count(store.db, "SELECT count(*) FROM report_content WHERE state = 'complete'"), 1, 'a late chunk of a complete item changes nothing');
  assert.deepEqual(readdirSync(join(h.dir, 'content-chunks', h.reg.id)), []);
});

test('review M4: chunks left behind by an item already settled in the store are freed at start', async () => {
  const h = await reportStore();
  assert.equal((await h.reports.deliver(h.reg, chunk('left', 0, false, 'kept by a crash'))).code, 'ok');
  h.db.prepare("UPDATE report_content SET state = 'complete'").run(); // as if the crash came after the commit, before removal
  createReportIntake({ db: h.db, writer: h.writer, dataDir: h.dir });
  assert.deepEqual(readdirSync(join(h.dir, 'content-chunks', h.reg.id)), []);
});

test('identity: a frame naming another agent, profile or registration is rejected and recorded, never stored', async () => {
  const h = await reportStore();
  for (const extra of [{ agent: 'codex' }, { profile_key: 'other' }, { registration: '00000000-0000-4000-8000-000000000000' }]) {
    assert.deepEqual(await h.reports.deliver(h.reg, report(extra)), { status: 'rejected', code: 'invalid-field' });
  }
  assert.equal(count(h.db, 'SELECT count(*) FROM report_delivery'), 0);
  assert.equal(count(h.db, 'SELECT count(*) FROM events'), 0);
  assert.equal(count(h.db, "SELECT count FROM report_rejects WHERE registration_id = ? AND code = 'invalid-field'", h.reg.id), 3);
});

test('rejected frames are explicit coverage: malformed, unsupported version, ill-formed text', async () => {
  const h = await reportStore();
  assert.deepEqual(await h.reports.deliver(h.reg, ['not', 'an', 'object']), { status: 'rejected', code: 'malformed' });
  assert.deepEqual(await h.reports.deliver(h.reg, report({ v: 2 })), { status: 'rejected', code: 'unsupported-version' });
  assert.deepEqual(await h.reports.deliver(h.reg, report({ session_id: 'bad\ud800id' })), { status: 'rejected', code: 'invalid-session_id' });
  assert.deepEqual(await h.reports.deliver(h.reg, chunk('i', 0, true, 'split \ud83d')), { status: 'rejected', code: 'invalid-content' });
  h.reports.rejected(h.reg, 'oversize');
  const rows = h.db.prepare('SELECT code, count FROM report_rejects ORDER BY code').all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { code: 'invalid-content', count: 1 }, { code: 'invalid-session_id', count: 1 }, { code: 'malformed', count: 1 },
    { code: 'oversize', count: 1 }, { code: 'unsupported-version', count: 1 },
  ]);
  assert.deepEqual(await h.reports.deliver(h.reg, report()), { status: 'accepted', code: 'ok' }, 'later valid frames still accepted');
});

test('dedup is (registration, delivery_id): a retry collapses, another registration with the same id stays distinct', async () => {
  const h = await reportStore();
  const other = addRegistration(h.dir, { agent: 'claude', profileKey: 'p1' }).registration;
  const f = report();
  assert.equal((await h.reports.deliver(h.reg, f)).code, 'ok');
  assert.equal((await h.reports.deliver(h.reg, { ...f })).code, 'duplicate');
  assert.equal((await h.reports.deliver(other, { ...f })).code, 'ok');
  assert.equal(count(h.db, 'SELECT count(*) FROM report_delivery'), 2);
  assert.equal(count(h.db, "SELECT count(*) FROM events WHERE source = 'report'"), 2);
  assert.equal(count(h.db, 'SELECT count(*) FROM sessions'), 1);
});

test('attribution: only a synced profile of the registration agent gets a session; an unknown event kind is kept', async () => {
  const h = await reportStore();
  const stray = addRegistration(h.dir, { agent: 'codex', profileKey: 'p1' }).registration; // p1 is a claude profile
  assert.equal((await h.reports.deliver(stray, report())).code, 'ok');
  assert.equal(count(h.db, "SELECT count(*) FROM report_delivery WHERE unattributed = 'unknown-profile'"), 1);
  assert.equal(count(h.db, 'SELECT count(*) FROM sessions'), 0);
  assert.equal((await h.reports.deliver(h.reg, report({ event: 'custom.thing' }))).code, 'ok');
  assert.equal(count(h.db, "SELECT count(*) FROM report_delivery WHERE event = 'custom.thing' AND unattributed IS NULL"), 1);
});

test('T13b2: a registered custom agent gets its own profile and an attributed session on its first delivery', async () => {
  const seen: { e: Envelope; durable: boolean }[] = [];
  const h = await reportStore({ customAgent: (a) => a === 'acme-agent', publish: (e, durable) => seen.push({ e, durable }) });
  const acme = addRegistration(h.dir, { agent: 'acme-agent', profileKey: 'acme-1' }).registration;
  assert.equal((await h.reports.deliver(acme, report({ session_id: 'acme-s1' }))).code, 'ok');
  assert.deepEqual({ ...h.db.prepare("SELECT agent, root, origin FROM profiles WHERE id = 'acme-1'").get() },
    { agent: 'acme-agent', root: `registration:${acme.id}`, origin: 'registration' });
  assert.equal(count(h.db, "SELECT count(*) FROM sessions WHERE agent = 'acme-agent' AND profile_id = 'acme-1' AND native_session_id = 'acme-s1'"), 1);
  assert.equal(count(h.db, 'SELECT count(*) FROM report_delivery WHERE unattributed IS NULL'), 1);
  assert.deepEqual(seen.map((s) => s.durable), [false, true], 'its durable delivery reaches the engine');
  const again = addRegistration(h.dir, { agent: 'acme-agent', profileKey: 'acme-1' }).registration;
  assert.equal((await h.reports.deliver(again, report({ session_id: 'acme-s1' }))).code, 'ok');
  assert.equal(count(h.db, "SELECT count(*) FROM profiles WHERE agent = 'acme-agent'"), 1, 'a second registration reuses the profile');
  assert.equal(count(h.db, "SELECT count(*) FROM sessions WHERE agent = 'acme-agent'"), 1);
  removeRegistration(h.dir, acme.id);
  assert.equal(count(h.db, "SELECT count(*) FROM profiles WHERE agent = 'acme-agent'"), 1, 'revoking keeps the history');
});

test('T13b2: catalog agents never get a profile from a registration; another agent\'s profile id is never borrowed', async () => {
  const seen: boolean[] = [];
  const h = await reportStore({ customAgent: (a) => a !== 'claude' && a !== 'codex', publish: (_e, durable) => seen.push(durable) });
  const codex = addRegistration(h.dir, { agent: 'codex', profileKey: 'codex-unsynced' }).registration;
  const squatter = addRegistration(h.dir, { agent: 'acme-agent', profileKey: 'p1' }).registration; // p1 is claude's
  assert.equal((await h.reports.deliver(codex, report())).code, 'ok');
  assert.equal((await h.reports.deliver(squatter, report())).code, 'ok');
  assert.equal(count(h.db, 'SELECT count(*) FROM profiles'), 1, 'only the synced claude profile');
  assert.deepEqual({ ...h.db.prepare("SELECT agent, origin FROM profiles WHERE id = 'p1'").get() }, { agent: 'claude', origin: 'default' });
  assert.equal(count(h.db, 'SELECT count(*) FROM sessions'), 0);
  assert.equal(count(h.db, "SELECT count(*) FROM report_delivery WHERE unattributed = 'unknown-profile'"), 2);
  assert.deepEqual(seen, [false, false], 'unattributed deliveries never reach the engine');
});

test('T13b2 review: a registration profile stops attributing once its agent is in the catalog', async () => {
  const h = await reportStore({ customAgent: (a) => a === 'acme-agent' });
  const acme = addRegistration(h.dir, { agent: 'acme-agent', profileKey: 'acme-1' }).registration;
  assert.equal((await h.reports.deliver(acme, report({ session_id: 'acme-s1' }))).code, 'ok');
  const later = createReportIntake({ db: h.db, writer: h.writer, dataDir: h.dir, customAgent: () => false }); // a newer catalog lists acme-agent
  assert.equal((await later.deliver(acme, report({ session_id: 'acme-s2' }))).code, 'ok');
  assert.equal(count(h.db, "SELECT count(*) FROM sessions WHERE native_session_id = 'acme-s2'"), 0);
  assert.equal(count(h.db, "SELECT count(*) FROM report_delivery WHERE unattributed = 'unknown-profile'"), 1);
});

test('T13b2: without a catalog to tell custom agents apart, no profile is created', async () => {
  const h = await reportStore();
  const acme = addRegistration(h.dir, { agent: 'acme-agent', profileKey: 'acme-1' }).registration;
  assert.equal((await h.reports.deliver(acme, report())).code, 'ok');
  assert.equal(count(h.db, "SELECT count(*) FROM profiles WHERE agent = 'acme-agent'"), 0);
});

test('content stays private: never in events.raw or the published envelope; identity comes from the registration', async () => {
  const seen: { e: Envelope; durable: boolean }[] = [];
  const h = await reportStore({ publish: (e, durable) => seen.push({ e, durable }) });
  const canary = `CANARY-${process.pid}-content`;
  assert.equal((await h.reports.deliver(h.reg, chunk('c', 0, true, canary))).code, 'ok');
  assert.equal(count(h.db, "SELECT count(*) FROM report_content WHERE state = 'complete' AND content = ?", canary), 1);
  for (const r of h.db.prepare('SELECT raw FROM events').all() as { raw: string }[]) assert.ok(!r.raw.includes(canary));
  assert.deepEqual(seen.map((s) => s.durable), [false, true]);
  for (const { e } of seen) {
    assert.ok(!JSON.stringify(e).includes(canary));
    assert.equal(e.agent, 'claude');
    assert.equal(e.profile_key, 'p1');
    assert.equal(e.session_id, SESSION);
    assert.ok(e.delivery_id.startsWith(`${h.reg.id}:`));
  }
});

test('Q3-9: an item past the assembly quota is labelled incomplete and acked so the producer stops retrying', async () => {
  const h = await reportStore({ chunks: { perRegistration: 4096, global: 1 << 20 } });
  assert.equal((await h.reports.deliver(h.reg, chunk('q', 0, false, 'x'.repeat(3000)))).code, 'ok');
  assert.deepEqual(await h.reports.deliver(h.reg, chunk('q', 1, false, 'y'.repeat(3000))), { status: 'accepted', code: 'incomplete' });
  assert.deepEqual(await h.reports.deliver(h.reg, chunk('q', 2, true, 'z')), { status: 'accepted', code: 'incomplete' });
  assert.equal(count(h.db, "SELECT count(*) FROM report_content WHERE state = 'incomplete' AND content IS NULL"), 1);
  assert.deepEqual(readdirSync(join(h.dir, 'content-chunks', h.reg.id)), []);
});

test('Q3-9 round-robin: one registration backlog cannot starve another; queue caps refuse', async () => {
  const order: string[] = [];
  const s = createScheduler();
  const job = (k: string) => async () => { order.push(k); await new Promise((r) => setImmediate(r)); return { status: 'accepted' as const, code: 'ok' }; };
  const all = [...['a1', 'a2', 'a3', 'a4', 'a5'].map((k) => s.submit('A', 10, job(k))), s.submit('B', 10, job('b1'))];
  await Promise.all(all);
  assert.ok(order.indexOf('b1') <= 2, `B waited behind A's backlog: ${order.join(',')}`);
  const capped = createScheduler({ frames: 2, bytes: 100, total: 150 });
  const hold = () => new Promise<{ status: 'accepted'; code: string }>(() => {});
  assert.ok(capped.submit('A', 10, hold));
  assert.ok(capped.submit('A', 10, hold));
  assert.equal(capped.submit('A', 10, hold), null, 'per-registration frame cap');
  assert.equal(capped.submit('B', 101, hold), null, 'per-registration byte cap');
  assert.ok(capped.submit('B', 100, hold));
  assert.equal(capped.submit('C', 50, hold), null, 'global byte cap');
});

// ---- Through the real socket --------------------------------------------------------------------------------------

interface Wire { v: 1; delivery_id: string | null; status: string; code: string }
/** Opens a connection, sends the hello and frames, then collects acks until `want` arrive or the server closes. */
function talk(sock: string, hello: object, frames: object[], want = frames.length): Promise<{ acks: Wire[]; c: net.Socket }> {
  const c = net.connect(sock);
  const push = createDecoder();
  const acks: Wire[] = [];
  return new Promise((resolve, reject) => {
    const done = () => { c.removeAllListeners('data'); resolve({ acks, c }); };
    c.on('error', reject);
    c.on('connect', () => c.write(Buffer.concat([encodeFrame(hello as Record<string, unknown>), ...frames.map((f) => encodeFrame(f as Record<string, unknown>))])));
    c.on('data', (b: Buffer) => { for (const f of push(b)) acks.push(f as Wire); if (acks.length >= want) done(); });
    c.on('close', done);
  });
}
const send = (c: net.Socket, f: object, want = 1): Promise<Wire[]> => new Promise((resolve) => {
  const push = createDecoder();
  const acks: Wire[] = [];
  const on = (b: Buffer) => { for (const x of push(b)) acks.push(x as Wire); if (acks.length >= want) { c.off('data', on); resolve(acks); } };
  c.on('data', on);
  c.once('close', () => resolve(acks));
  c.write(encodeFrame(f as Record<string, unknown>));
});

async function served(h: Awaited<ReturnType<typeof reportStore>>) {
  return startSocketServer({ dataDir: h.dir, onEnvelope: h.intake.deliver, reports: { registry: h.registry, intake: h.reports } });
}

test('socket: a registration hello binds the connection; acks echo the report delivery_id; a bad frame keeps it open', { skip }, async () => {
  const h = await reportStore();
  const server = await served(h);
  try {
    const good = report();
    const bad = report({ v: 2 });
    const { acks, c } = await talk(server.path, { v: 1, registration: h.reg.id, token: h.token }, [good, bad]);
    assert.deepEqual(acks, [
      { v: 1, delivery_id: good['delivery_id'], status: 'accepted', code: 'ok' },
      { v: 1, delivery_id: bad['delivery_id'], status: 'rejected', code: 'unsupported-version' },
    ]);
    const next = report();
    assert.deepEqual(await send(c, next), [{ v: 1, delivery_id: next['delivery_id'], status: 'accepted', code: 'ok' }]);
    c.destroy();
    assert.equal(count(h.db, 'SELECT count(*) FROM report_delivery'), 2);
  } finally { await server.close(); }
});

test('socket: bad token, unknown registration and mixed hellos are one auth code; nothing reaches intake', { skip }, async () => {
  const h = await reportStore();
  const server = await served(h);
  const install = readFileSync(server.tokenFile, 'utf8');
  try {
    for (const hello of [
      { v: 1, registration: h.reg.id, token: 'wrong' },
      { v: 1, registration: '00000000-0000-4000-8000-00000000dead', token: h.token },
      { v: 1, registration: h.reg.id, token: install }, // never falls back to the install token
      { v: 1, registration: h.reg.id, token: h.token, extra: 1 },
      { v: 1, token: h.token }, // a registration token is not the install token
    ]) {
      const { acks } = await talk(server.path, hello, [report()]);
      assert.deepEqual(acks, [{ v: 1, delivery_id: null, status: 'rejected', code: 'auth' }], JSON.stringify(Object.keys(hello)));
    }
    assert.equal(count(h.db, 'SELECT count(*) FROM report_delivery'), 0);
  } finally { await server.close(); }
});

test('socket: a report frame over 256 KiB is refused and counted for that registration', { skip }, async () => {
  const h = await reportStore();
  const server = await served(h);
  try {
    const { acks } = await talk(server.path, { v: 1, registration: h.reg.id, token: h.token }, [chunk('o', 0, true, 'x'.repeat(300 << 10))]);
    assert.deepEqual(acks, [{ v: 1, delivery_id: null, status: 'rejected', code: 'oversize' }]);
    assert.equal(count(h.db, "SELECT count FROM report_rejects WHERE registration_id = ? AND code = 'oversize'", h.reg.id), 1);
  } finally { await server.close(); }
});

test('socket: revoking a registration cuts its open connection; at most 8 connections per registration', { skip }, async () => {
  const h = await reportStore();
  const server = await served(h);
  const hello = { v: 1, registration: h.reg.id, token: h.token };
  try {
    const open = await Promise.all(Array.from({ length: 8 }, () => talk(server.path, hello, [report()])));
    for (const o of open) assert.equal(o.acks[0]!.code, 'ok');
    const { acks: ninth } = await talk(server.path, hello, [report()]);
    assert.deepEqual(ninth, [{ v: 1, delivery_id: null, status: 'rejected', code: 'busy' }]);
    assert.ok(removeRegistration(h.dir, h.reg.id));
    assert.deepEqual(await send(open[0]!.c, report()), [{ v: 1, delivery_id: null, status: 'rejected', code: 'auth' }]);
    for (const o of open) o.c.destroy();
  } finally { await server.close(); }
});

// ---- dev-cli register / revoke ------------------------------------------------------------------------------------

function cli(args: string[], dataDir: string) {
  // ELECTRON_RUN_AS_NODE: under test:electron the exec path is Electron, which must run the CLI as Node
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), XAIBO_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: '1' }, input: '' });
}

test('dev-cli register: typed confirmation (or --yes for a temp data dir), token printed once, only its hash stored', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'xr-')));
  const refused = cli(['register', '--agent', 'claude', '--profile-key', 'p1'], dir);
  assert.equal(refused.status, 1);
  assert.ok(!existsSync(join(dir, 'registrations.json')), 'nothing written without confirmation');
  const r = cli(['register', '--agent', 'claude', '--profile-key', 'p1', '--yes'], dir);
  assert.equal(r.status, 0, r.stderr);
  const id = /^registered (\S+)/m.exec(r.stdout)?.[1];
  const token = /^token: (\S+)$/m.exec(r.stdout)?.[1];
  assert.ok(id && token);
  const file = join(dir, 'registrations.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, 'utf8').includes(token!), 'the token itself is never stored');
  const reg = openRegistry(dir).verify(id!, token!) as Registration;
  assert.deepEqual([reg.agent, reg.profile_key], ['claude', 'p1']);
  assert.equal(openRegistry(dir).verify(id!, `${token}x`), null);
  assert.equal(cli(['register', '--agent', 'Bad Agent', '--profile-key', 'p1', '--yes'], dir).status, 1);
  const revoked = cli(['revoke', '--id', id!, '--yes'], dir);
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.equal(openRegistry(dir).verify(id!, token!), null);
});

test('dev-cli register: --yes is refused for a data dir outside the temp dir', () => {
  const dir = join(REPO, '.cache', 'not-temp-data');
  const r = cli(['register', '--agent', 'claude', '--profile-key', 'p1', '--yes'], dir);
  assert.equal(r.status, 1);
  assert.ok(!existsSync(join(dir, 'registrations.json')));
});
