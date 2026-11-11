// XAIBO-PROD-111 (P1-T13; EC-33, EC-35, M9): the diagnostics bundle, crash/error records and test artifacts carry no
// canary of any class; files are 0600; the log tail is bounded. Canaries are generated at run time (never committed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBundle, readLogTail, writeBundle } from '../../src/main/diagnostics.ts';
import { errorCode, installCrashPolicy } from '../../src/shared/crash.ts';
import { createLogger } from '../../src/shared/log.ts';
import { sanitizeTree, saveArtifact } from '../e2e/artifacts.ts';
import { canaries } from '../helpers/canary.ts';

const forms = (c: Record<string, string>) => Object.values(c).flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]);
const hits = (text: string, c: Record<string, string>) => forms(c).filter((f) => text.includes(f));
const temp = (p: string) => mkdtempSync(join(tmpdir(), p));

test('canary: diagnostics', () => {
  const c = canaries();
  const all = Object.values(c).join(' ');
  const json = buildBundle({
    app: { version: `0.0.0 ${c.email}`, electron: '45.2.3', node: c['secret-aws'] },
    os: { platform: 'darwin', release: c.home, arch: 'arm64' },
    health: { v: 1, type: 'health', state: 'running', attempt: 0, readOnly: null },
    counters: { requestsBlocked: 2, ipcDropped: 0 },
    logTail: [`{"event":"x","note":"${all}"}`, all],
  });
  assert.deepEqual(hits(json, c), []);
  const parsed = JSON.parse(json) as { app: { electron: string }; counters: Record<string, number>; logTail: string[] };
  assert.equal(parsed.app.electron, '45.2.3');
  assert.deepEqual(parsed.counters, { requestsBlocked: 2, ipcDropped: 0 });
  assert.equal(parsed.logTail.length, 2);
  const file = join(temp('xdiag-'), 'bundle.json');
  writeBundle(file, json);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, 'utf8'), json);
});

test('readLogTail: last lines of the app and service logs, bounded in lines and bytes', () => {
  const dir = join(temp('xtail-'), 'logs');
  mkdirSync(join(dir, 'service'), { recursive: true });
  writeFileSync(join(dir, 'xaibo.log'), Array.from({ length: 500 }, (_, i) => `{"event":"main_${i}"}`).join('\n') + '\n');
  writeFileSync(join(dir, 'service', 'xaibo.log'), '{"event":"svc_1"}\n');
  const tail = readLogTail(dir, { lines: 50, bytes: 64 * 1024 });
  assert.equal(tail.length, 51);
  assert.equal(tail[0], '{"event":"main_450"}');
  assert.equal(tail.at(-1), '{"event":"svc_1"}');
  assert.ok(readLogTail(dir, { lines: 1000, bytes: 1024 }).join('\n').length <= 2048);
  assert.deepEqual(readLogTail(join(dir, 'missing'), { lines: 10, bytes: 1024 }), []);
});

test('canary: error-records', () => {
  const c = canaries();
  const dir = join(temp('xcrash-'), 'logs');
  const proc = new EventEmitter();
  let exits = 0;
  installCrashPolicy(proc, createLogger({ dir, secret: Buffer.alloc(32, 1) }), { exitOnUncaught: () => { exits++; } });
  for (const v of Object.values(c)) {
    proc.emit('uncaughtException', Object.assign(new Error(`failed on ${v}`), { code: v }));
    proc.emit('unhandledRejection', v);
  }
  proc.emit('uncaughtException', Object.assign(new Error('x'), { code: 'ENOENT' }));
  const text = readFileSync(join(dir, 'xaibo.log'), 'utf8');
  assert.deepEqual(hits(text, c), []);
  const lines = text.trim().split('\n').map((l) => JSON.parse(l) as { event: string; error?: string });
  assert.equal(lines.filter((l) => l.event === 'uncaught_exception').length, Object.keys(c).length + 1);
  assert.equal(lines.filter((l) => l.event === 'unhandled_rejection').length, Object.keys(c).length);
  assert.equal(lines.at(-1)!.error, 'ENOENT');
  assert.equal(exits, Object.keys(c).length + 1, 'uncaught exceptions exit; rejections do not');
  assert.equal(errorCode(new TypeError('x')), 'TypeError');
  assert.equal(errorCode('text'), 'unknown');
});

test('canary: test-artifacts', () => {
  const c = canaries();
  const dir = temp('xart-');
  const file = saveArtifact(dir, 'page.txt', Object.values(c).join('\n'));
  assert.deepEqual(hits(readFileSync(file, 'utf8'), c), []);
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'nested', 'error-context.md'), `snapshot: ${Object.values(c).join(' ')}`);
  writeFileSync(join(dir, 'nested', 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  sanitizeTree(dir);
  for (const f of readdirSync(dir, { recursive: true }).map(String)) {
    if (f.endsWith('.md') || f.endsWith('.txt')) assert.deepEqual(hits(readFileSync(join(dir, f), 'utf8'), c), [], f);
  }
  assert.deepEqual([...readFileSync(join(dir, 'nested', 'image.png'))], [0x89, 0x50, 0x4e, 0x47], 'binary files untouched');
});
