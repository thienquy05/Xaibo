// XAIBO-PROD-304 (P3-T04, EC-09, OQ-A1, D-18): intake publishes a delivery as pending durability, commits it in its own
// immediate transaction ahead of queued backfill, then acks. A delivery_id is stored once (live or replayed, across
// second boundaries); distinct deliveries with identical payloads stay distinct. Agent-flow hooks beside ours are never
// received or touched. Socket cases skip only on the Claude sandbox's EPERM for bind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { createDecoder, encodeFrame, parseAck, type Ack } from '../../src/shared/hook-protocol.ts';
import { replaySpool } from '../../src/service/receivers/spool-replay.ts';
import { startSocketServer } from '../../src/service/receivers/socket.ts';
import type { Batch } from '../../src/service/store/writer.ts';
import { count } from '../helpers/claude-profile.ts';
import { envelope, hookStore, installShim, run, SESSION, T0 } from '../helpers/hook-store.ts';

const REPO = join(import.meta.dirname, '..', '..');
const probe = await (async () => {
  const { dir } = await hookStore();
  return new Promise<string>((resolve) => {
    const s = net.createServer().once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error')).listen(join(dir, 'p.sock'), () => s.close(() => resolve('ok')));
  });
})();
if (probe !== 'ok' && probe !== 'EPERM') throw new Error(`unexpected socket probe failure: ${probe}`);
const skip = probe === 'EPERM' ? 'Unix socket bind is denied here (Claude sandbox); runs in the unsandboxed suite' : false;

test('order: published pending, committed, published durable, then acked', async () => {
  const seen: string[] = [];
  const h = await hookStore({ intake: { publish: (e, durable) => {
    seen.push(`${durable ? 'durable' : 'pending'}:${count(h.db, 'SELECT count(*) FROM hook_delivery WHERE delivery_id = ?', e.delivery_id)}`);
  } } });
  const r = await h.intake.deliver(envelope());
  seen.push(`ack:${r.status}`);
  assert.deepEqual(seen, ['pending:0', 'durable:1', 'ack:accepted']);
});

test('EC-09: the same delivery_id at x.999 and (x+1).001 is stored once; the replay is acked as a duplicate', async () => {
  const times = [T0 + 999, T0 + 1001];
  const h = await hookStore({ intake: { now: () => times.shift()! } });
  const e = envelope({ received_ts: T0 + 999 });
  assert.deepEqual(await h.intake.deliver(e), { status: 'accepted', code: 'ok' });
  assert.deepEqual(await h.intake.deliver({ ...e }), { status: 'accepted', code: 'duplicate' });
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery'), 1);
  assert.equal(count(h.db, "SELECT count(*) FROM events WHERE source = 'hook'"), 1);
  assert.equal(count(h.db, 'SELECT committed_ts FROM hook_delivery'), T0 + 999);
});

test('EC-09: two distinct deliveries with identical payloads in the same ms stay distinct', async () => {
  const h = await hookStore({ intake: { now: () => T0 } });
  await h.intake.deliver(envelope());
  await h.intake.deliver(envelope());
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery'), 2);
  assert.equal(count(h.db, "SELECT count(*) FROM events WHERE source = 'hook'"), 2);
  assert.equal(count(h.db, 'SELECT count(*) FROM sessions'), 1);
});

test('OQ-A1: a live delivery commits at once, ahead of queued backfill', async () => {
  const h = await hookStore({ writer: { setTimer: () => {} } }); // the backfill timer never fires by itself
  const backfill: Batch = {
    profileId: 'p1', agent: 'claude', fileSession: 'backfill-s',
    file: { path: join(REPO, 'nonexistent.jsonl'), kind: 'transcript', dev: 1, ino: 1, size: 10, mtime: T0, offset: 10, headHash: 'h', status: 'ok' },
    sessions: [{ nativeSessionId: 'backfill-s' }],
    events: [{ nativeSessionId: 'backfill-s', source: 'transcript', confidence: 'confirmed', nativeId: 'n1', kind: 'message', sourceSeq: 0, receivedTs: T0 }],
  };
  const queued = h.writer.enqueue(backfill, false);
  await h.intake.deliver(envelope());
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery'), 1);
  assert.equal(count(h.db, "SELECT count(*) FROM sessions WHERE native_session_id = 'backfill-s'"), 0, 'backfill still queued');
  h.writer.flush();
  await queued;
  assert.equal(count(h.db, "SELECT count(*) FROM sessions WHERE native_session_id = 'backfill-s'"), 1);
});

async function exchange(sock: string, token: string, frames: object[]): Promise<Ack[]> {
  const c = net.connect(sock);
  const push = createDecoder();
  const acks: Ack[] = [];
  await new Promise<void>((resolve, reject) => {
    c.on('error', reject);
    c.on('connect', () => c.write(Buffer.concat([encodeFrame({ v: 1, token }), ...frames.map((f) => encodeFrame(f as Record<string, unknown>))])));
    c.on('data', (b: Buffer) => { for (const f of push(b)) acks.push(parseAck(f)!); if (acks.length === frames.length) { c.destroy(); resolve(); } });
  });
  return acks;
}

test('through the real socket: the ack arrives only after the commit', { skip }, async () => {
  const h = await hookStore();
  let committedAtAck = -1;
  const server = await startSocketServer({ dataDir: h.dir, onEnvelope: async (e) => {
    const r = await h.intake.deliver(e);
    committedAtAck = count(h.db, 'SELECT count(*) FROM hook_delivery WHERE delivery_id = ?', e.delivery_id);
    return r;
  } });
  try {
    const e = envelope();
    const [ack] = await exchange(server.path, readFileSync(server.tokenFile, 'utf8'), [e]);
    assert.deepEqual(ack, { v: 1, delivery_id: e.delivery_id, status: 'accepted', code: 'ok' });
    assert.equal(committedAtAck, 1);
  } finally { await server.close(); }
});

test('EC-09: an agent-flow hook beside ours: only Xaibo frames arrive; its own channel and bytes are untouched', { skip }, async () => {
  const h = await hookStore();
  const shim = installShim(h.dir);
  const flowLog = join(h.dir, 'flow.log');
  const flow = join(h.dir, 'flow-hook.sh');
  writeFileSync(flow, `#!/bin/sh\ncat >> ${JSON.stringify(flowLog)}\n`);
  chmodSync(flow, 0o755);
  const settings = { hooks: { Stop: [
    { hooks: [{ type: 'command', command: `${flow} stop` }] },
    { hooks: [{ type: 'command', command: `'${shim.hook}' hook claude p1`, async: true }] },
  ] } };
  const received: string[] = [];
  const server = await startSocketServer({ dataDir: h.dir, onEnvelope: (e) => { received.push(e.agent); return h.intake.deliver(e); } });
  try {
    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: SESSION, cwd: '/tmp/xaibo-fixture/alpha' });
    for (const g of settings.hooks.Stop) for (const hk of g.hooks) { // dispatched as the agent would: through a shell, payload on stdin
      const r = await run('/bin/sh', ['-c', hk.command], payload);
      assert.equal(r.status, 0);
      assert.equal(r.out, 0);
    }
    await replaySpool({ dataDir: h.dir, db: h.db, deliver: h.intake.deliver }); // a slow dev-runtime ack may have spooled it
    assert.equal(readFileSync(flowLog, 'utf8'), payload, 'agent-flow got its payload, byte for byte');
    assert.ok(received.every((a) => a === 'claude') && received.length <= 1);
    assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery'), 1, 'one Xaibo delivery, stored once');
  } finally { await server.close(); }
});
