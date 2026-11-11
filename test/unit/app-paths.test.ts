// XAIBO-PROD-102 (P1-T04): data-dir resolution and private modes, with injected env (no Electron).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDataDir, prepareDataDir, resolveDataDir } from '../../src/main/app-paths.ts';

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
