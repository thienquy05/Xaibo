// XAIBO-PROD-431 (P4-T12b finding, EC-44): a service that starts while the disk is full cannot create its socket and
// listened never again, so hooks were lost until the next restart. A failed listen is retried until it listens; hooks
// the forwarder spooled meanwhile replay after the late listen; close() stops the retry. The listen is made to fail by
// a regular file where run/ must be (the socket server refuses it), then the file is removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { createDecoder, encodeFrame } from '../../src/shared/hook-protocol.ts';
import { startHooks } from '../../src/service/receivers/intake.ts';
import { addRegistration } from '../../src/service/receivers/registrations.ts';
import { count } from '../helpers/claude-profile.ts';
import { envelope, hookStore, SESSION, T0 } from '../helpers/hook-store.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms: number) {
  for (const end = Date.now() + ms; !f(); await sleep(20)) if (Date.now() > end) return false;
  return true;
}
const logger = () => { const events: string[] = []; return { events, log: { log: (e: string) => { events.push(e); } } }; };

test('a socket that cannot listen at start retries until it listens, then replays what was spooled meanwhile', async () => {
  const h = await hookStore();
  writeFileSync(join(h.dir, 'run'), ''); // run/ cannot be made: the listen fails, as a full disk makes it fail
  const l = logger();
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, log: l.log, socketRetryMs: 50 });
  try {
    await svc.replay; // the start replay found nothing
    assert.equal(svc.socket, null);
    await sleep(200); // several retries fail
    assert.deepEqual(l.events.filter((e) => e.startsWith('hook_socket')), ['hook_socket_failed'], 'one failure line per outage, not one per retry');
    mkdirSync(join(h.dir, 'spool'), { mode: 0o700 }); // the forwarder spooled a hook while nothing listened
    writeFileSync(join(h.dir, 'spool', '2026-01-01.jsonl'), `\n${JSON.stringify(envelope())}\n`, { mode: 0o600 });
    rmSync(join(h.dir, 'run')); // space is back
    assert.ok(await until(() => svc.socket !== null, 2000), 'listens again without a restart');
    assert.ok(existsSync(join(h.dir, 'run', 'xaibo.sock')));
    assert.ok(l.events.includes('hook_socket_listening'));
    assert.ok(await until(() => count(h.db, 'SELECT count(*) FROM hook_delivery') === 1, 3000), 'the spooled hook is stored after the late listen');
  } finally { await svc.close(); }
});

test('close() during the outage stops the retry: nothing listens afterwards', async () => {
  const h = await hookStore();
  writeFileSync(join(h.dir, 'run'), '');
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, socketRetryMs: 50 });
  await svc.close();
  rmSync(join(h.dir, 'run'));
  await sleep(200);
  assert.equal(svc.socket, null);
  assert.equal(existsSync(join(h.dir, 'run', 'xaibo.sock')), false);
});

// XAIBO-PROD-443 (G4b-3): report intake that could not open content-chunks at start was off until a restart: a
// registration hello was refused as a token hello, and the spool replay stopped at the first report record, holding the
// hooks spooled behind it. It is now retried on each report delivery; the spool replays once when it first works.
test('XAIBO-PROD-443: a report intake that fails at start recovers without a restart; spooled report and hook behind it are stored', async () => {
  const h = await hookStore();
  const { registration, token } = addRegistration(h.dir, { agent: 'claude', profileKey: 'p1' });
  writeFileSync(join(h.dir, 'content-chunks'), ''); // the chunk store cannot be opened (a full disk fails the same way)
  let n = 0;
  const report = () => ({ v: 1, delivery_id: `d-${++n}`, session_id: SESSION, producer_id: 'fixture-producer', producer_seq: n, event: 'turn.start',
    source_ts: '2026-01-01T00:00:00.000Z', payload: {} });
  mkdirSync(join(h.dir, 'spool'), { mode: 0o700 });
  writeFileSync(join(h.dir, 'spool', '2026-01-01.jsonl'), [JSON.stringify({ v: 1, kind: 'report', registration: registration.id, received_ts: T0, frame: report() }),
    JSON.stringify(envelope({ received_ts: T0 + 1 }))].join('\n') + '\n', { mode: 0o600 });
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, socketRetryMs: 50 });
  try {
    await svc.replay;
    assert.deepEqual([count(h.db, 'SELECT count(*) FROM report_delivery'), count(h.db, 'SELECT count(*) FROM hook_delivery')], [0, 0], 'held behind the report');
    rmSync(join(h.dir, 'content-chunks'));
    const live = report();
    const acks = await new Promise<unknown[]>((resolve, reject) => {
      const c = net.connect(svc.socket!.path);
      const push = createDecoder();
      const got: unknown[] = [];
      c.on('error', reject);
      c.on('connect', () => c.write(Buffer.concat([encodeFrame({ v: 1, registration: registration.id, token }), encodeFrame(live)])));
      c.on('data', (b: Buffer) => { got.push(...push(b)); if (got.length) { c.destroy(); resolve(got); } });
      c.on('close', () => resolve(got));
    });
    assert.deepEqual(acks, [{ v: 1, delivery_id: live.delivery_id, status: 'accepted', code: 'ok' }], 'the registration hello is verified, the frame stored');
    assert.ok(await until(() => count(h.db, 'SELECT count(*) FROM report_delivery') === 2 && count(h.db, 'SELECT count(*) FROM hook_delivery') === 1, 3000),
      'the spooled report and the hook behind it are stored without a restart');
  } finally { await svc.close(); }
});
