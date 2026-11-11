// XAIBO-PROD-101 (P1-T03): content-free logger with hashed ids, 0600 files and bounded rotation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, hashId, loadInstallSecret } from '../../src/shared/log.ts';
import { canaries } from '../helpers/canary.ts';

const temp = () => join(mkdtempSync(join(tmpdir(), 'xlog-')), 'logs');
const secret = Buffer.alloc(32, 7);
const read = (dir: string) => readFileSync(join(dir, 'xaibo.log'), 'utf8');

test('writes allowlisted fields only; content strings never reach the file', () => {
  const dir = temp();
  const log = createLogger({ dir, secret, now: () => 0 });
  const c = canaries();
  log.log('ingest_batch', { rows: 12, bytes: 4096, durationMs: 7.5, ok: true, prompt: 'hello world from the user', cwd: c.home });
  log.log('parse_error', { error: 'E_JSON', line: 3 });
  log.log('parse_error', { error: 'contains spaces and content' });
  log.log('parse_error', { error: c['secret-github'] });
  const text = read(dir);
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { t: '1970-01-01T00:00:00.000Z', event: 'ingest_batch', rows: 12, bytes: 4096, durationMs: 7.5, ok: true });
  assert.deepEqual(lines[1], { t: '1970-01-01T00:00:00.000Z', event: 'parse_error', error: 'E_JSON', line: 3 });
  assert.equal(lines[2].error, undefined);
  assert.equal(lines[3].error, undefined);
  for (const v of ['hello world', c.home, c['secret-github']]) assert.ok(!text.includes(v), v);
});

test('ids are HMAC-hashed with the install secret', () => {
  const dir = temp();
  const id = '00000000-0000-4000-8000-0000000000aa';
  createLogger({ dir, secret }).log('session_seen', { sessionId: id });
  const expected = createHmac('sha256', secret).update(id).digest('hex').slice(0, 16);
  assert.equal(hashId(secret, id), expected);
  const text = read(dir);
  assert.ok(!text.includes(id));
  assert.equal(JSON.parse(text).sessionId, expected);
});

test('an event name that is not code-shaped is replaced', () => {
  const dir = temp();
  createLogger({ dir, secret }).log('user typed: hello', {});
  assert.equal(JSON.parse(read(dir)).event, 'invalid_event');
});

test('log dir is 0700 and files are 0600', () => {
  const dir = temp();
  createLogger({ dir, secret }).log('start', {});
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'xaibo.log')).mode & 0o777, 0o600);
});

test('rotation keeps a bounded number of bounded files', () => {
  const dir = temp();
  const log = createLogger({ dir, secret, maxBytes: 300, maxFiles: 3 });
  for (let i = 0; i < 100; i++) log.log('tick', { i });
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ['xaibo.log', 'xaibo.log.1', 'xaibo.log.2']);
  for (const f of files) {
    assert.ok(statSync(join(dir, f)).size <= 300, f);
    assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600);
  }
  assert.match(read(dir), /"i":99/);
});

test('install secret: 32 random bytes, 0600, stable across calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xsecret-'));
  const a = loadInstallSecret(dir);
  const b = loadInstallSecret(dir);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
  assert.equal(statSync(join(dir, 'install-secret')).mode & 0o777, 0o600);
});

test('canary: logs', () => {
  const dir = temp();
  const log = createLogger({ dir, secret, now: () => 0 });
  const c = canaries();
  for (const [k, v] of Object.entries(c)) log.log('canary_probe', { error: v, sessionId: v, note: v, [k.replace(/\W/g, '')]: v, count: 1 });
  const text = read(dir);
  for (const v of Object.values(c)) for (const f of [v, JSON.stringify(v).slice(1, -1)]) assert.ok(!text.includes(f), 'a canary reached the log');
  assert.equal(text.trim().split('\n').length, Object.keys(c).length);
});
