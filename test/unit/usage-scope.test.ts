// XAIBO-PROD-319 (P3-T15, EC-92, PRD §5.11): usage scopes. Claude (no account identifier on the statusLine) is one
// "Account scope unverified" scope per session; Codex shares a scope across sessions only through the same salted
// account marker; profiles never merge. The marker is a domain-separated HMAC-SHA256 under a per-install secret salt
// (review M2): never the raw id, never its plain hash. The salt file must be a private 32-byte regular file; a bad one
// gives no epoch and is never silently replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountMarker, loadScopeSalt, scopeKey } from '../../src/service/usage/snapshots.ts';

const SALT_A = Buffer.alloc(32, 1);
const SALT_B = Buffer.alloc(32, 2);

test('account marker: 32 hex, stable per salt, differs across salts, never the raw id or its plain SHA-256', () => {
  const id = randomUUID(); // runtime canary
  const m = accountMarker(SALT_A, id);
  assert.match(m, /^[0-9a-f]{32}$/);
  assert.equal(accountMarker(SALT_A, id), m);
  assert.notEqual(accountMarker(SALT_B, id), m);
  assert.ok(!m.includes(id.replace(/-/g, '').slice(0, 8)));
  assert.ok(!createHash('sha256').update(id).digest('hex').startsWith(m));
});

test('EC-92 scopes: Claude per session and unverified; Codex shared by marker; never across profiles', () => {
  const c1 = scopeKey({ profileId: 'p1', agent: 'claude', epoch: null, nativeSessionId: 's1' });
  const c2 = scopeKey({ profileId: 'p1', agent: 'claude', epoch: null, nativeSessionId: 's2' });
  assert.equal(c1.verified, false);
  assert.notEqual(c1.key, c2.key, 'two Claude sessions with identical readings stay two scopes');
  const x1 = scopeKey({ profileId: 'p1', agent: 'codex', epoch: 'e1', nativeSessionId: 's1' });
  const x2 = scopeKey({ profileId: 'p1', agent: 'codex', epoch: 'e1', nativeSessionId: 's2' });
  const other = scopeKey({ profileId: 'p2', agent: 'codex', epoch: 'e1', nativeSessionId: 's1' });
  assert.equal(x1.key, x2.key);
  assert.equal(x1.verified, true);
  assert.notEqual(x1.key, other.key, 'same marker in another profile: no merge');
  assert.notEqual(scopeKey({ profileId: 'p1', agent: 'codex', epoch: null, nativeSessionId: 's1' }).key, x1.key);
});

const dir = () => { const d = join(realpathSync(mkdtempSync(join(tmpdir(), 'xsalt-'))), 'data'); mkdirSync(d, { mode: 0o700 }); return d; };

test('salt: created once (0600, 32 bytes) and read back unchanged', () => {
  const d = dir();
  const a = loadScopeSalt(d);
  assert.equal(a?.length, 32);
  assert.equal(statSync(join(d, 'usage-scope.salt')).mode & 0o777, 0o600);
  assert.deepEqual(loadScopeSalt(d), a);
});

test('review M2: a bad salt file gives no epoch and is never replaced', () => {
  const codes: string[] = [];
  const log = { log: (code: string) => void codes.push(code) };
  const short = dir();
  writeFileSync(join(short, 'usage-scope.salt'), Buffer.alloc(16), { mode: 0o600 });
  assert.equal(loadScopeSalt(short, log), null);
  assert.equal(readFileSync(join(short, 'usage-scope.salt')).length, 16, 'not regenerated');
  const open = dir();
  writeFileSync(join(open, 'usage-scope.salt'), Buffer.alloc(32), { mode: 0o600 });
  chmodSync(join(open, 'usage-scope.salt'), 0o644);
  assert.equal(loadScopeSalt(open, log), null);
  const link = dir();
  writeFileSync(join(link, 'real'), Buffer.alloc(32), { mode: 0o600 });
  symlinkSync(join(link, 'real'), join(link, 'usage-scope.salt'));
  assert.equal(loadScopeSalt(link, log), null);
  assert.deepEqual(codes, ['usage_salt_invalid', 'usage_salt_invalid', 'usage_salt_invalid']);
});
