import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReceiver, frame } from './receiver.ts';

const short = () => mkdtempSync(join(tmpdir(), 'rx-')); // Unix socket paths must stay under 104 bytes

function send(sock: string, bytes: Buffer, endAfter = true): Promise<{ ack: boolean; closed: boolean }> {
  return new Promise((res) => {
    const c = connect(sock);
    let ack = false;
    c.on('data', () => { ack = true; });
    c.on('close', () => res({ ack, closed: true }));
    c.on('error', () => {});
    c.write(bytes, () => { if (endAfter) c.end(); });
    setTimeout(() => { c.destroy(); res({ ack, closed: false }); }, 1500);
  });
}

const delivery = (token: string, over: Record<string, unknown> = {}) => ({
  v: 1, delivery_id: randomUUID(), agent: 'claude', event: 'Stop', session_id: 'synthetic', cwd: '/tmp/xaibo-fixture/p',
  received_ts: 0, payload: {}, token, t_entry: '1', t_send: '2', ...over,
});

test('private socket and token; valid frame acked; rejection matrix without a crash', async () => {
  const dir = short();
  const rx = await startReceiver({ dataDir: dir, ackPoint: 'volatile' });
  try {
    assert.equal(statSync(join(dir, 'run')).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'run', 'token')).mode & 0o777, 0o600);
    const token = readFileSync(join(dir, 'run', 'token'), 'utf8');
    assert.equal((await send(rx.socketPath, frame(delivery(token)))).ack, true);
    assert.equal((await send(rx.socketPath, frame(delivery('wrong-token')))).ack, false);
    assert.equal((await send(rx.socketPath, frame(delivery(token, { v: 2 })))).ack, false);
    const big = Buffer.alloc(4); big.writeUInt32BE(2 * 1024 * 1024);
    assert.equal((await send(rx.socketPath, Buffer.concat([big, Buffer.alloc(1024)]))).ack, false);
    const trunc = Buffer.alloc(4); trunc.writeUInt32BE(100);
    assert.equal((await send(rx.socketPath, Buffer.concat([trunc, Buffer.from('{"v":1')]))).ack, false);
    assert.equal((await send(rx.socketPath, Buffer.from([0, 0, 0, 5, 1, 2, 3, 4, 5]))).ack, false); // not JSON
    assert.equal((await send(rx.socketPath, frame(delivery(token)))).ack, true, 'receiver still serving after rejections');
    assert.equal(rx.stats.delivered, 2);
    assert.deepEqual(Object.keys(rx.stats.rejected).sort(), ['bad-json', 'bad-token', 'bad-version', 'too-large', 'truncated'].sort());
  } finally { await rx.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('startup replays the spool deduplicated by delivery_id; commit ack point persists', async () => {
  const dir = short();
  mkdirSync(join(dir, 'spool'), { recursive: true });
  const ids = Array.from({ length: 900 }, () => randomUUID());
  const lines = [...ids, ...ids.slice(0, 100)].map((id) => JSON.stringify(delivery('t', { delivery_id: id })));
  writeFileSync(join(dir, 'spool', 'a.jsonl'), `${lines.slice(0, 500).join('\n')}\n`);
  writeFileSync(join(dir, 'spool', 'b.jsonl'), `${lines.slice(500).join('\n')}\n`);
  mkdirSync(join(dir, 'run'), { recursive: true });
  writeFileSync(join(dir, 'run', 'spool-bytes'), String(50 * 1024 * 1024)); // counter at the cap from earlier outages
  const rx = await startReceiver({ dataDir: dir, ackPoint: 'commit' });
  try {
    assert.equal(rx.stats.replayed, 900);
    assert.equal(readFileSync(join(dir, 'run', 'spool-bytes'), 'utf8'), '0', 'replay resets the spool byte counter');
    const token = readFileSync(join(dir, 'run', 'token'), 'utf8');
    assert.equal((await send(rx.socketPath, frame(delivery(token, { delivery_id: ids[0] })))).ack, true, 'duplicate still acked');
    assert.equal(rx.stats.duplicates, 101);
    assert.equal(rx.persisted(), 900);
  } finally { await rx.close(); rmSync(dir, { recursive: true, force: true }); }
});
