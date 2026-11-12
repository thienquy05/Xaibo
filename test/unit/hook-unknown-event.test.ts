// XAIBO-PROD-304 (P3-T04, EC-52): unknown hook events and new payload fields are stored generically (events
// source=hook, kind=hook, the envelope raw) and never crash intake. Deliveries that cannot be attributed (unknown
// profile, no session id) are recorded as such, never guessed. Hook paths are never dereferenced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { count } from '../helpers/claude-profile.ts';
import { envelope, hookStore, SESSION } from '../helpers/hook-store.ts';

test('EC-52: an unknown event with new nested fields is stored raw; the session is created', async () => {
  const h = await hookStore();
  const payload = { hook_event_name: 'BrandNewEvent', session_id: SESSION, future: { nested: [1, 'two', { three: null }] }, emoji: 'x\u{1F600}y' };
  const e = envelope({ event: 'BrandNewEvent', payload });
  assert.deepEqual(await h.intake.deliver(e), { status: 'accepted', code: 'ok' });
  const row = h.db.prepare("SELECT e.source, e.kind, e.confidence, e.native_id, e.raw, e.content, s.native_session_id AS sid FROM events e JOIN sessions s ON s.id = e.session_id").get() as Record<string, string | null>;
  assert.equal(row.source, 'hook');
  assert.equal(row.kind, 'hook');
  assert.equal(row.confidence, 'confirmed');
  assert.equal(row.native_id, e.delivery_id);
  assert.equal(row.sid, SESSION);
  assert.equal(row.content, null, 'hook payloads are not indexed');
  const raw = JSON.parse(row.raw!);
  assert.equal(raw.event, 'BrandNewEvent');
  assert.deepEqual(raw.payload, payload);
  assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery WHERE delivery_id = ? AND unattributed IS NULL', e.delivery_id), 1);
});

test('EC-52: truncated and malformed deliveries without a session are kept as unattributed, not guessed', async () => {
  const h = await hookStore();
  for (const flag of [{ truncated: true }, { malformed: true }] as const) {
    const e = envelope({ event: 'unknown', session_id: null, payload: null, ...flag });
    assert.equal((await h.intake.deliver(e)).status, 'accepted');
    assert.equal(count(h.db, "SELECT count(*) FROM hook_delivery WHERE delivery_id = ? AND unattributed = 'no-session'", e.delivery_id), 1);
  }
  assert.equal(count(h.db, 'SELECT count(*) FROM sessions'), 0);
  assert.equal(count(h.db, 'SELECT count(*) FROM events'), 0);
});

test('an unknown profile key, or a known key of another agent, is recorded as unattributed; no session or profile is created', async () => {
  const h = await hookStore();
  for (const e of [envelope({ profile_key: 'nope' }), envelope({ agent: 'codex' })]) {
    assert.equal((await h.intake.deliver(e)).status, 'accepted');
    const d = h.db.prepare('SELECT unattributed, native_session_id, event FROM hook_delivery WHERE delivery_id = ?').get(e.delivery_id) as Record<string, string>;
    assert.deepEqual({ ...d }, { unattributed: 'unknown-profile', native_session_id: SESSION, event: 'Stop' });
  }
  assert.equal(count(h.db, 'SELECT count(*) FROM sessions'), 0);
  assert.equal(count(h.db, 'SELECT count(*) FROM profiles'), 1);
});

test('the hook cwd is stored as given and never dereferenced (no realpath, no cwd_key)', async () => {
  const h = await hookStore();
  mkdirSync(join(h.dir, 'real'));
  symlinkSync(join(h.dir, 'real'), join(h.dir, 'link'));
  await h.intake.deliver(envelope({ cwd: join(h.dir, 'link') }));
  const s = h.db.prepare('SELECT cwd, cwd_key FROM sessions').get() as Record<string, string | null>;
  assert.deepEqual({ ...s }, { cwd: join(h.dir, 'link'), cwd_key: null });
  assert.equal(count(h.db, 'SELECT count(*) FROM cwd_history'), 0);
});
