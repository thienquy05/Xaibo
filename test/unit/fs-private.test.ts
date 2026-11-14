// XAIBO-PROD-329 (D-P3-23): the shared private-directory and atomic-write helpers that replace the copies in
// config/transaction, adapters/generic/chunks, receivers/socket and receivers/registrations. Temp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, privateDir } from '../../src/service/fs-private.ts';

const base = () => realpathSync(mkdtempSync(join(tmpdir(), 'xfsp-')));
const mode = (p: string) => statSync(p).mode & 0o777;
const refused = () => { throw new Error('refused'); };

test('privateDir: creates 0700, accepts an existing one and tightens group/other bits', () => {
  const b = base();
  const d = join(b, 'run');
  privateDir(d, refused);
  assert.equal(mode(d), 0o700);
  chmodSync(d, 0o755);
  privateDir(d, refused);
  assert.equal(mode(d), 0o700);
});

test('privateDir: a symlink or a non-directory goes to onFail; a non-EEXIST mkdir error is rethrown', () => {
  const b = base();
  mkdirSync(join(b, 'real'), { mode: 0o700 });
  symlinkSync(join(b, 'real'), join(b, 'link'));
  writeFileSync(join(b, 'file'), '');
  assert.throws(() => privateDir(join(b, 'link'), refused), /refused/);
  assert.throws(() => privateDir(join(b, 'file'), refused), /refused/);
  assert.throws(() => privateDir(join(b, 'missing', 'child'), refused), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
  assert.throws(() => privateDir(join(b, 'file')), /not a private directory/, 'default onFail throws');
});

test('atomicWrite: exact mode under a permissive umask, replaces the target, no temp file left', () => {
  const b = base();
  const f = join(b, 'token');
  const old = process.umask(0);
  try {
    atomicWrite(f, 'one', 0o600);
    assert.equal(mode(f), 0o600);
    atomicWrite(f, Buffer.from('two'), 0o640);
  } finally { process.umask(old); }
  assert.equal(readFileSync(f, 'utf8'), 'two');
  assert.equal(mode(f), 0o640);
  assert.deepEqual(readdirSync(b), ['token']);
});

test('atomicWrite: a throw before the rename keeps the target and removes the temp file', () => {
  const b = base();
  const f = join(b, 'regs.json');
  atomicWrite(f, 'kept', 0o600);
  assert.throws(() => atomicWrite(f, 'lost', 0o600, () => { throw new Error('stop'); }), /stop/);
  assert.equal(readFileSync(f, 'utf8'), 'kept');
  assert.deepEqual(readdirSync(b), ['regs.json']);
});
