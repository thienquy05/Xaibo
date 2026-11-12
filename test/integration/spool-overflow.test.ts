// P3-T03 (EC-12): at the 50 MiB spool cap nothing is appended; a short overflow line names the gap (agent, session,
// event; never cwd or content); the overflow log has its own 1 MiB cap and then only a saturated flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FWD = join(import.meta.dirname, '..', '..', 'src', 'forwarder', 'forwarder.ts');
const PAYLOAD = { session_id: '00000000-0000-4000-8000-0000000f0201', cwd: '/tmp/xaibo-fixture/secret-path', hook_event_name: 'Stop', prompt: 'payload-canary' };
const run = (dir: string, payload: object = PAYLOAD) => spawnSync(process.execPath, [FWD, 'hook', 'claude', 'p1'], { input: JSON.stringify(payload), env: { PATH: process.env.PATH ?? '', XAIBO_DATA_DIR: dir }, timeout: 10_000 });

function fullSpool() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'xo-')));
  const spool = join(dir, 'spool');
  mkdirSync(spool, { mode: 0o700 });
  const old = join(spool, '2026-01-01.jsonl');
  writeFileSync(old, '', { mode: 0o600 });
  truncateSync(old, 50 * 1024 * 1024); // sparse: counts toward the cap without using disk
  return { dir, spool };
}

test('EC-12: at the cap nothing is appended; one overflow line <=128 bytes without cwd or content; exit 0 silent', () => {
  const { dir, spool } = fullSpool();
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.length + r.stderr.length, 0);
  assert.deepEqual(readdirSync(spool).filter((f) => f.endsWith('.jsonl')), ['2026-01-01.jsonl'], 'no new spool file');
  assert.equal(statSync(join(spool, '2026-01-01.jsonl')).size, 50 * 1024 * 1024);
  const log = readFileSync(join(spool, 'overflow.log'), 'utf8').split('\n').filter(Boolean);
  assert.equal(log.length, 1);
  assert.ok(Buffer.byteLength(log[0]!) <= 128, log[0]);
  const line = JSON.parse(log[0]!);
  assert.equal(line.agent, 'claude');
  assert.equal(line.event, 'Stop');
  assert.equal(line.session_id, PAYLOAD.session_id);
  assert.ok(!log[0]!.includes('secret-path') && !log[0]!.includes('payload-canary'));
});

test('EC-12: an overflow line stays within 128 bytes (newline included) for multibyte and escaped event names', () => {
  for (const event of ['\u754c'.repeat(32), '\u0000'.repeat(32), '\u754c'.repeat(128)]) {
    const { dir, spool } = fullSpool();
    assert.equal(run(dir, { ...PAYLOAD, hook_event_name: event }).status, 0);
    const text = readFileSync(join(spool, 'overflow.log'));
    assert.ok(text.length <= 128, `${text.length} bytes`);
    assert.equal(JSON.parse(text.toString('utf8')).agent, 'claude');
  }
});

test('EC-12: just below the overflow cap a line that would cross it is not written; the saturated flag is', () => {
  const { dir, spool } = fullSpool();
  writeFileSync(join(spool, 'overflow.log'), '', { mode: 0o600 });
  truncateSync(join(spool, 'overflow.log'), 1024 * 1024 - 1);
  assert.equal(run(dir).status, 0);
  assert.equal(statSync(join(spool, 'overflow.log')).size, 1024 * 1024 - 1);
  assert.ok(existsSync(join(spool, 'overflow.saturated')));
});

test('EC-12: the overflow log stops at 1 MiB and leaves a saturated flag', () => {
  const { dir, spool } = fullSpool();
  writeFileSync(join(spool, 'overflow.log'), '', { mode: 0o600 });
  truncateSync(join(spool, 'overflow.log'), 1024 * 1024);
  for (let i = 0; i < 2; i++) assert.equal(run(dir).status, 0);
  assert.equal(statSync(join(spool, 'overflow.log')).size, 1024 * 1024);
  assert.ok(existsSync(join(spool, 'overflow.saturated')));
});

test('a spool dir with too many entries counts as full (bounded cost)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'xo-')));
  const spool = join(dir, 'spool');
  mkdirSync(spool, { mode: 0o700 });
  for (let i = 0; i < 1001; i++) writeFileSync(join(spool, `junk-${i}`), '');
  assert.equal(run(dir).status, 0);
  assert.equal(readdirSync(spool).filter((f) => f.endsWith('.jsonl')).length, 0);
  assert.ok(existsSync(join(spool, 'overflow.log')));
});
