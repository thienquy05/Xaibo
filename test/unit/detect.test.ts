// XAIBO-PROD-106 (P1-T08, EC-38): catalog validation; executables from manual path, login-shell PATH, then known
// locations; a shell-free bounded version probe; Not detected is a normal state, never an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkExecutable, detectAgent } from '../../src/service/catalog/detect.ts';
import { loadCatalog, validateCatalog, type AgentEntry } from '../../src/service/catalog/validate.ts';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'xdetect-')));
const bin = (dir: string, name: string, body: string) => {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
};
const entry = (id: string, locations: string[]): AgentEntry => ({
  id, displayName: id,
  detection: { binaries: [{ id: 'main', names: [id], versionArgs: ['--version'] }], locations },
  profileRoots: [{ id: 'user', base: 'home', relative: `.${id}` }],
});

test('the bundled catalog is valid and has the Phase 1 agents', () => {
  assert.deepEqual(loadCatalog().agents.map((a) => a.id), ['claude', 'codex']);
});

test('the schema rejects unknown fields, shell names and parent segments', () => {
  const good = loadCatalog();
  assert.deepEqual(validateCatalog(good), []);
  const clone = () => structuredClone(good) as unknown as { agents: Record<string, any>[] };
  const extra = clone(); extra.agents[0]!.launch = 'x';
  const shellName = clone(); shellName.agents[0]!.detection.binaries[0].names = ['zsh'];
  const parent = clone(); parent.agents[0]!.detection.locations = ['~/../etc'];
  for (const bad of [extra, shellName, parent, { schemaVersion: 2, agents: [] }]) assert.notDeepEqual(validateCatalog(bad), []);
});

test('EC-38: absent from PATH and known locations → Not detected, no throw', async () => {
  const d = await detectAgent(entry('ghost', ['~/nowhere', '/tmp/xaibo-fixture/none']), { env: { PATH: join(home, 'empty') }, home });
  assert.deepEqual(d, { agent: 'ghost', state: 'not-detected' });
});

test('EC-38: found only at a known location (not on the login PATH) → Detected with version', async () => {
  const f = bin(join(home, 'known'), 'kloc', 'echo "kloc 2.1.319 (fixture)"');
  const d = await detectAgent(entry('kloc', ['~/known']), { env: { PATH: '/usr/bin:/bin' }, home });
  assert.deepEqual(d, { agent: 'kloc', state: 'detected', path: f, version: '2.1.319' });
});

test('login-shell PATH wins over known locations; the version args are passed as given', async () => {
  const onPath = bin(join(home, 'pathbin'), 'order', '[ "$1" = --version ] && echo "0.160.0"');
  bin(join(home, 'known2'), 'order', 'echo "9.9.9"');
  const d = await detectAgent(entry('order', ['~/known2']), { env: { PATH: `${join(home, 'pathbin')}:/usr/bin` }, home });
  assert.deepEqual(d, { agent: 'order', state: 'detected', path: onPath, version: '0.160.0' });
});

test('a valid manual path is used first and resolved to its realpath', async () => {
  const real = bin(join(home, 'manual'), 'mtool', 'echo "1.2.3"');
  const link = join(home, 'mtool-link');
  symlinkSync(real, link);
  bin(join(home, 'pathbin2'), 'mtool', 'echo "4.5.6"');
  const d = await detectAgent(entry('mtool', []), { env: { PATH: join(home, 'pathbin2') }, home, manualPath: link });
  assert.deepEqual(d, { agent: 'mtool', state: 'detected', path: real, version: '1.2.3' });
});

test('checkExecutable accepts only regular executable files', async () => {
  const ok = bin(join(home, 'chk'), 'yes', 'true');
  const plain = join(home, 'chk', 'plain');
  writeFileSync(plain, 'x');
  assert.equal(await checkExecutable(ok), ok);
  for (const p of [plain, join(home, 'chk'), join(home, 'chk', 'missing'), 'relative/path']) assert.equal(await checkExecutable(p), null, p);
});

test('a version probe that times out or fails → Not detected', async () => {
  bin(join(home, 'slow'), 'slow', 'sleep 5');
  bin(join(home, 'bad'), 'bad', 'exit 2');
  const t0 = Date.now();
  assert.equal((await detectAgent(entry('slow', ['~/slow']), { env: {}, home, timeoutMs: 300 })).state, 'not-detected');
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal((await detectAgent(entry('bad', ['~/bad']), { env: {}, home })).state, 'not-detected');
});
