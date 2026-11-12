// P3-T02: hook wire protocol v1 (EC-32 parsing half; §7.3). Frames: 4-byte big-endian length + UTF-8 JSON, ≤1 MiB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDecoder, encodeFrame, FrameError, MAX_FRAME, parseAck, parseEnvelope, parseHello, PROTOCOL_VERSION,
} from '../../src/shared/hook-protocol.ts';

const ENV = {
  v: 1, delivery_id: '00000000-0000-4000-8000-0000000d0001', agent: 'claude', profile_key: 'p1', event: 'Stop',
  session_id: '00000000-0000-4000-8000-0000000d0002', cwd: '/tmp/xaibo-fixture/alpha', received_ts: 1767225600000,
  payload: { hook_event_name: 'Stop' },
};

test('encode/decode round trip; several frames in one chunk', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  const push = createDecoder();
  const both = Buffer.concat([encodeFrame(ENV), encodeFrame({ v: 1, token: 't' })]);
  assert.deepEqual(push(both), [ENV, { v: 1, token: 't' }]);
  assert.deepEqual(push(Buffer.alloc(0)), []);
});

test('a frame split across chunks decodes exactly once', () => {
  const push = createDecoder();
  const f = encodeFrame(ENV);
  const out = [...f].flatMap((b) => push(Buffer.from([b])));
  assert.deepEqual(out, [ENV]);
});

test('an oversize header is rejected before any body is buffered; encode refuses oversize too', () => {
  const push = createDecoder();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME + 1);
  assert.throws(() => push(header), (e) => e instanceof FrameError && e.code === 'oversize');
  assert.throws(() => encodeFrame({ s: 'x'.repeat(MAX_FRAME) }), (e) => e instanceof FrameError && e.code === 'oversize');
  const exact = createDecoder();
  const h = Buffer.alloc(4);
  h.writeUInt32BE(MAX_FRAME);
  assert.deepEqual(exact(h), [], 'exactly 1 MiB is allowed');
});

test('a body that is not JSON is a frame error, without echoing content', () => {
  const body = Buffer.from('not json: private-ish');
  const h = Buffer.alloc(4);
  h.writeUInt32BE(body.length);
  assert.throws(() => createDecoder()(Buffer.concat([h, body])), (e) => e instanceof FrameError && e.code === 'json' && !e.message.includes('private'));
});

test('hello, envelope and ack validation; unknown v rejected', () => {
  assert.deepEqual(parseHello({ v: 1, token: 'abc' }), { v: 1, token: 'abc' });
  for (const bad of [{ v: 2, token: 'abc' }, { v: 1 }, { v: 1, token: '' }, null, [], 'x']) assert.equal(parseHello(bad), null);
  assert.deepEqual(parseEnvelope(ENV), { ok: true, envelope: ENV });
  assert.deepEqual(parseEnvelope({ ...ENV, truncated: true, malformed: true, payload: null }).ok, true);
  assert.deepEqual(parseEnvelope({ ...ENV, v: 2 }), { ok: false, code: 'version' });
  const shapes: Array<Record<string, unknown>> = [
    { delivery_id: 'not-a-uuid' }, { agent: 'Claude Code' }, { agent: 'a'.repeat(33) }, { profile_key: 'x'.repeat(129) },
    { event: '' }, { session_id: 5 }, { cwd: 'x'.repeat(4097) }, { received_ts: 'now' }, { truncated: 'yes' }, { extra: 1 },
  ];
  for (const s of shapes) assert.deepEqual(parseEnvelope({ ...ENV, ...s }), { ok: false, code: 'shape' }, JSON.stringify(s).slice(0, 40));
  const noPayload: Record<string, unknown> = { ...ENV };
  delete noPayload['payload'];
  assert.deepEqual(parseEnvelope(noPayload), { ok: false, code: 'shape' });
  assert.deepEqual(parseAck({ v: 1, delivery_id: ENV.delivery_id, status: 'accepted', code: 'ok' }), { v: 1, delivery_id: ENV.delivery_id, status: 'accepted', code: 'ok' });
  assert.equal(parseAck({ v: 1, delivery_id: null, status: 'maybe', code: 'ok' }), null);
});
