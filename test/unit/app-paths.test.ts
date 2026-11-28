// XAIBO-PROD-102 (P1-T04): data-dir resolution and private modes, with injected env (no Electron).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDataDir, prepareDataDir, resolveDataDir, trustedEnv } from '../../src/main/app-paths.ts';

const appData = '/tmp/xaibo-fixture/appdata';

test('XAIBO_DATA_DIR wins in every mode', () => {
  const env = { XAIBO_DATA_DIR: '/tmp/xaibo-fixture/data' };
  assert.equal(resolveDataDir({ env, packaged: true, appData }), '/tmp/xaibo-fixture/data');
  assert.equal(resolveDataDir({ env, packaged: false, appData }), '/tmp/xaibo-fixture/data');
});

test('packaged uses Xaibo, unpackaged uses Xaibo-dev (separate locks and data)', () => {
  assert.equal(resolveDataDir({ env: {}, packaged: true, appData }), join(appData, 'Xaibo'));
  assert.equal(resolveDataDir({ env: {}, packaged: false, appData }), join(appData, 'Xaibo-dev'));
});

test('a relative or empty XAIBO_DATA_DIR is refused', () => {
  assert.throws(() => resolveDataDir({ env: { XAIBO_DATA_DIR: 'data' }, packaged: true, appData }), /absolute/);
  assert.throws(() => resolveDataDir({ env: { XAIBO_DATA_DIR: '' }, packaged: true, appData }), /absolute/);
});

test('prepareDataDir creates 0700, tightens an existing dir, and sets umask 077', () => {
  const root = mkdtempSync(join(tmpdir(), 'xpaths-'));
  const fresh = join(root, 'a', 'b');
  prepareDataDir(fresh);
  assert.equal(statSync(fresh).mode & 0o777, 0o700);

  const loose = join(root, 'loose');
  mkdirSync(loose, { mode: 0o755 });
  chmodSync(loose, 0o755);
  prepareDataDir(loose);
  assert.equal(statSync(loose).mode & 0o777, 0o700);

  const file = join(loose, 'f');
  writeFileSync(file, 'x'); // default mode 0666, masked by the umask
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('initDataDir never throws: a bad override returns null with one stderr line, a good one is prepared', () => {
  const lines: string[] = [];
  assert.equal(initDataDir({ env: { XAIBO_DATA_DIR: 'rel' }, packaged: true, appData }, (s) => lines.push(s)), null);
  assert.deepEqual(lines, ['xaibo: XAIBO_DATA_DIR must be an absolute path\n']);

  const dir = join(mkdtempSync(join(tmpdir(), 'xpaths-')), 'data');
  assert.equal(initDataDir({ env: { XAIBO_DATA_DIR: dir }, packaged: true, appData }, (s) => lines.push(s)), dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(lines.length, 1);
});

test('H4: a filesystem error prints a fixed code, never the failing path', () => {
  const root = mkdtempSync(join(tmpdir(), 'xpaths-'));
  writeFileSync(join(root, 'file'), '');
  const dir = join(root, 'file', 'data'); // under a regular file: ENOTDIR
  const lines: string[] = [];
  assert.equal(initDataDir({ env: { XAIBO_DATA_DIR: dir }, packaged: true, appData }, (s) => lines.push(s)), null);
  assert.deepEqual(lines, ['xaibo: cannot prepare the data directory (ENOTDIR)\n']);
});


// XAIBO-PROD-611 (Gate 6 second review item 5): stale or leaked test variables never steer a packaged build. Hygiene, not a
// boundary: whoever controls the launch environment can also set the marker.
test('XAIBO-PROD-611: packaged without XAIBO_E2E=1 drops every XAIBO_* variable, NODE_OPTIONS and ELECTRON_RUN_AS_NODE', () => {
  const env = { XAIBO_DATA_DIR: '/tmp/xaibo-fixture/data', XAIBO_TEST_ALLOWED_ROOT: '/tmp/xaibo-fixture/r', XAIBO_NOTIFY_STUB: '1', XAIBO_LATER: '1',
    NODE_OPTIONS: '--require /tmp/xaibo-fixture/x.js', ELECTRON_RUN_AS_NODE: '1', HOME: '/tmp/xaibo-fixture/h', PATH: '/usr/bin:/bin' };
  assert.deepEqual(trustedEnv(env, true), { HOME: '/tmp/xaibo-fixture/h', PATH: '/usr/bin:/bin' });
  assert.deepEqual(trustedEnv(env, false), env, 'an unpackaged dev build keeps everything');
  const marked = { ...env, XAIBO_E2E: '1' };
  assert.deepEqual(trustedEnv(marked, true), marked, 'the packaged E2E, perf and gate-audit runs set the marker');
  assert.equal(trustedEnv({ XAIBO_E2E: '0', XAIBO_DATA_DIR: '/tmp/xaibo-fixture/d' }, true).XAIBO_DATA_DIR, undefined, 'only "1" is the marker');
  assert.equal(resolveDataDir({ env: trustedEnv(env, true), packaged: true, appData }), join(appData, 'Xaibo'), 'a stale override never moves the packaged data dir');
});

test('XAIBO-PROD-611: src/main reads XAIBO_* variables only through trustedEnv (app-paths.ts)', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
  // review: any process.env use (a destructure, a whole copy, a computed key), except the single trustedEnv(process.env call
  const direct = files(join('src', 'main')).filter((f) => !f.endsWith('app-paths.ts'))
    .flatMap((f) => (readFileSync(f, 'utf8').match(/process\.env|\{\s*env\s*\}\s*=\s*process/g) ?? []).map(() => f));
  assert.deepEqual(direct, [join('src', 'main', 'index.ts')], 'one use: trustedEnv(process.env, app.isPackaged)');
  assert.match(readFileSync(join('src', 'main', 'index.ts'), 'utf8'), /trustedEnv\(process\.env, app\.isPackaged\)/);
});
