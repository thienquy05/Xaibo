// XAIBO-PROD-305 (P3-T05, EC-49): the effective hook policy comes from managed settings (managed-settings.json plus
// managed-settings.d/*.json, path injected) and the profile's user settings. disableAllHooks (any scope),
// allowManagedHooksOnly and strictKnownMarketplaces (managed) block the plugin route: "hooks blocked by policy",
// files-only. allowedHttpHookUrls governs HTTP hooks only, so it is noted, never blocking. An unparseable policy file is
// "unknown", never assumed open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeHookPolicy } from '../../src/service/adapters/claude/hooks.ts';

function setup(o: { managed?: object | string; dropIns?: Record<string, object | string>; user?: object | string } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'xpol-'));
  const managedDir = join(tmp, 'ClaudeCode');
  const configDir = join(tmp, 'profile', '.claude');
  mkdirSync(managedDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const put = (f: string, v: object | string) => writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v));
  if (o.managed !== undefined) put(join(managedDir, 'managed-settings.json'), o.managed);
  if (o.dropIns) {
    mkdirSync(join(managedDir, 'managed-settings.d'));
    for (const [n, v] of Object.entries(o.dropIns)) put(join(managedDir, 'managed-settings.d', n), v);
  }
  if (o.user !== undefined) put(join(configDir, 'settings.json'), o.user);
  return claudeHookPolicy({ managedDir, configDir });
}

test('no policy files, or permissive ones: hooks ok', () => {
  assert.deepEqual(setup(), { state: 'ok', reasons: [], notes: [], coverage: null });
  assert.deepEqual(setup({ managed: { disableAllHooks: false }, user: { model: 'x', disableAllHooks: false } }).state, 'ok');
});

test('EC-49: each blocking setting gives "hooks blocked by policy", files-only, with its reason', () => {
  const cases: [Parameters<typeof setup>[0], string][] = [
    [{ managed: { disableAllHooks: true } }, 'disable-all-hooks-managed'],
    [{ user: { disableAllHooks: true } }, 'disable-all-hooks-user'],
    [{ dropIns: { '10-hooks.json': { allowManagedHooksOnly: true } } }, 'managed-hooks-only'],
    [{ managed: { strictKnownMarketplaces: [] } }, 'marketplaces-restricted'],
  ];
  for (const [o, reason] of cases) {
    const p = setup(o);
    assert.equal(p.state, 'blocked', reason);
    assert.deepEqual(p.reasons, [reason]);
    assert.deepEqual(p.coverage, { label: 'hooks blocked by policy', mode: 'files-only' });
  }
});

test('allowManagedHooksOnly in user settings is not a policy (managed only); allowedHttpHookUrls is noted, not blocking', () => {
  assert.equal(setup({ user: { allowManagedHooksOnly: true } }).state, 'ok');
  const p = setup({ managed: { allowedHttpHookUrls: [] } });
  assert.equal(p.state, 'ok');
  assert.deepEqual(p.notes, ['http-hook-allowlist']);
});

test('an unparseable policy file is unknown, never assumed open; non-JSON drop-ins are ignored', () => {
  for (const o of [{ managed: '{not json' }, { user: '[1,2]' }, { dropIns: { '20-x.json': '{' } }]) {
    const p = setup(o);
    assert.equal(p.state, 'unknown');
    assert.deepEqual(p.reasons, ['policy-unreadable']);
    assert.deepEqual(p.coverage, { label: 'hook policy unknown', mode: 'files-only' });
  }
  assert.equal(setup({ dropIns: { 'README.txt': '{' } }).state, 'ok');
});

test('several blocking settings are all reported, in a fixed order', () => {
  const p = setup({ managed: { disableAllHooks: true, strictKnownMarketplaces: [] }, dropIns: { 'a.json': { allowManagedHooksOnly: true } }, user: { disableAllHooks: true } });
  assert.deepEqual(p.reasons, ['disable-all-hooks-managed', 'disable-all-hooks-user', 'managed-hooks-only', 'marketplaces-restricted']);
});

test('R3: policy that cannot be read (permission denied) is unknown, never ok', () => {
  for (const target of ['managedDir', 'dropIns'] as const) {
    const tmp = mkdtempSync(join(tmpdir(), 'xpol-'));
    const managedDir = join(tmp, 'ClaudeCode');
    const configDir = join(tmp, 'profile', '.claude');
    mkdirSync(join(managedDir, 'managed-settings.d'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(managedDir, 'managed-settings.d', '10.json'), JSON.stringify({ disableAllHooks: true }));
    const locked = target === 'managedDir' ? managedDir : join(managedDir, 'managed-settings.d');
    chmodSync(locked, 0o000);
    try {
      const p = claudeHookPolicy({ managedDir, configDir });
      assert.equal(p.state, 'unknown', target);
      assert.deepEqual(p.reasons, ['policy-unreadable']);
    } finally { chmodSync(locked, 0o700); }
  }
});
