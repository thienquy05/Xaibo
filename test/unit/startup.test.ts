// XAIBO-PROD-569 (P6-T10 unit 1; design §6.6 Startup, plan P6-T10, OQ-P1-16; review R9): Start at login. Off by default;
// Save sets the OS login item and reads it back (a mismatch is a failure, never a claimed success); E2E uses a file stub, never
// the machine's login items. Both IPC directions are parsed with exact keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerStartup, stubLoginItems, type LoginItems } from '../../src/main/startup.ts';
import { parseStartupReply, parseStartupRequest } from '../../src/shared/ipc.ts';
import { canSave, startupText } from '../../src/renderer/settings/startup-view.ts';

const fake = (initial = false, o: { drop?: boolean; throws?: boolean } = {}) => {
  let on = initial;
  const items: LoginItems & { sets: boolean[] } = { sets: [], get: () => on, set: (v) => { items.sets.push(v); if (o.throws) throw new Error('platform'); if (!o.drop) on = v; } };
  return items;
};

test('requests: read, or save with a boolean; nothing else', () => {
  assert.deepEqual(parseStartupRequest({ op: 'read' }), { op: 'read' });
  assert.deepEqual(parseStartupRequest({ op: 'save', enabled: true }), { op: 'save', enabled: true });
  for (const bad of [{ op: 'save' }, { op: 'save', enabled: 'yes' }, { op: 'read', extra: 1 }, { op: 'delete' }, null, 'read'])
    assert.equal(parseStartupRequest(bad), null, JSON.stringify(bad));
});

test('replies: ready with a boolean, or failed with a fixed code and a boolean or null', () => {
  assert.deepEqual(parseStartupReply({ status: 'ready', enabled: false }), { status: 'ready', enabled: false });
  assert.deepEqual(parseStartupReply({ status: 'failed', code: 'platform', enabled: null }), { status: 'failed', code: 'platform', enabled: null });
  for (const bad of [{ status: 'ready' }, { status: 'failed', code: 'boom', enabled: null }, { status: 'ready', enabled: true, x: 1 }, undefined])
    assert.equal(parseStartupReply(bad), null, JSON.stringify(bad));
});

test('read reports the OS value; Save sets it, reads it back, and calls a mismatch or a throw a failure', () => {
  const off = fake();
  assert.deepEqual(answerStartup({ op: 'read' }, off), { status: 'ready', enabled: false });
  assert.deepEqual(off.sets, [], 'reading never registers anything');
  assert.deepEqual(answerStartup({ op: 'save', enabled: true }, off), { status: 'ready', enabled: true });
  assert.deepEqual(off.sets, [true]);
  assert.deepEqual(answerStartup({ op: 'save', enabled: true }, fake(false, { drop: true })), { status: 'failed', code: 'platform', enabled: false }, 'the OS kept it off');
  assert.deepEqual(answerStartup({ op: 'save', enabled: false }, fake(true, { throws: true })), { status: 'failed', code: 'platform', enabled: true });
  assert.deepEqual(answerStartup(null, off), { status: 'failed', code: 'invalid', enabled: null }, 'an invalid request does nothing');
});

test('the E2E stub keeps the value in its own file, off when absent or unreadable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xstartup-'));
  const file = join(dir, 'login-item-stub.json');
  const s = stubLoginItems(file);
  assert.equal(s.get(), false);
  s.set(true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { openAtLogin: true });
  assert.equal(stubLoginItems(file).get(), true);
  writeFileSync(file, '{ broken');
  assert.equal(stubLoginItems(file).get(), false);
});

test('code review 1: Save waits for the current value; an unknown value needs an explicit choice first', () => {
  assert.equal(canSave('loading', false), false);
  assert.equal(canSave('loading', true), false);
  assert.equal(canSave(null, false), false, 'never silently turns off a login item it could not read');
  assert.equal(canSave(null, true), true);
  assert.equal(canSave(false, false), true);
  assert.equal(canSave(true, false), true);
});

test('Settings texts: saved on, saved off, the OS refused, unavailable', () => {
  assert.equal(startupText({ status: 'ready', enabled: true }), 'Saved. Xaibo starts at login.');
  assert.equal(startupText({ status: 'ready', enabled: false }), 'Saved. Xaibo does not start at login.');
  assert.equal(startupText({ status: 'failed', code: 'platform', enabled: false }), 'macOS did not apply the change. Start at login is off.');
  assert.equal(startupText({ status: 'failed', code: 'platform', enabled: null }), 'macOS did not apply the change.');
  assert.equal(startupText(null), 'The result is unavailable. Check the setting before trying again.');
});
