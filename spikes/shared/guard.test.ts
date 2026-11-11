import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, truncateSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeSnapshot, compareSnapshots, formatResult, parseDumpKeychain, unmatchedServices, type GuardCtx, type KeychainItem } from './guard.ts';

const AGENT = { svce: 'Claude Code-credentials', acct: 'synthetic-user', mdat: '20261101000000Z' };
const OTHER = { svce: 'Synthetic Unrelated App', acct: 'synthetic-user', mdat: '20261101000000Z' };

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'guard-test-'));
  const override = join(home, 'alt-claude');
  const files: Record<string, string> = {
    '.claude/settings.json': '{"a":1}',
    '.claude/plugins/installed_plugins.json': '{}',
    '.claude/plugins/cache/p/plugin.json': '{}',
    '.claude.json': JSON.stringify({ numStartups: 1, mcpServers: {} }),
    '.codex/config.toml': 'x = 1\n',
    '.codex/auth.json': '{"token":"synthetic"}',
    '.gemini/settings.json': '{}',
    'alt-claude/settings.json': '{"b":2}',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(home, rel, '..'), { recursive: true });
    writeFileSync(join(home, rel), body);
  }
  let keychain: KeychainItem[] = [AGENT, OTHER];
  const ctx: GuardCtx = { home, env: { CLAUDE_CONFIG_DIR: override }, keychain: () => keychain };
  const base = takeSnapshot(ctx);
  return {
    home, ctx, base,
    setKeychain: (k: KeychainItem[]) => { keychain = k; },
    check: (opts = {}) => compareSnapshots(base, takeSnapshot(ctx), opts),
    done: () => rmSync(home, { recursive: true, force: true }),
  };
}

function expectCounts(r: ReturnType<typeof compareSnapshots>, want: Partial<Record<'config' | 'credential' | 'keychain' | 'unmatched' | 'expectedNew', number>>, exit: number) {
  const zero = { config: 0, credential: 0, keychain: 0, unmatched: 0, expectedNew: 0 };
  assert.deepEqual(r.counts, { ...zero, ...want });
  assert.equal(r.exit, exit);
}

test('no change gives MATCH and exit 0', () => {
  const f = fixture();
  const r = f.check();
  expectCounts(r, {}, 0);
  assert.deepEqual(formatResult(r), ['MATCH']);
  f.done();
});

test('config modified, deleted, under override root, plugin tree changed', () => {
  for (const mutate of [
    (h: string) => writeFileSync(join(h, '.claude/settings.json'), '{"a":2}'),
    (h: string) => rmSync(join(h, '.codex/config.toml')),
    (h: string) => writeFileSync(join(h, 'alt-claude/settings.json'), '{"b":3}'),
    (h: string) => writeFileSync(join(h, '.claude/plugins/cache/p/new.json'), '{}'),
    (h: string) => writeFileSync(join(h, '.claude.json'), JSON.stringify({ numStartups: 1, mcpServers: { s: {} } })),
    (h: string) => writeFileSync(join(h, '.claude.json'), JSON.stringify({ numStartups: 1, mcpServers: {}, newKey: 1 })),
  ]) {
    const f = fixture();
    mutate(f.home);
    expectCounts(f.check(), { config: 1 }, 1);
    f.done();
  }
});

test('~/.claude.json value churn outside mcpServers is ignored', () => {
  const f = fixture();
  writeFileSync(join(f.home, '.claude.json'), JSON.stringify({ numStartups: 99, mcpServers: {} }));
  expectCounts(f.check(), {}, 0);
  f.done();
});

test('credential truncated or replaced with same size', () => {
  const f = fixture();
  truncateSync(join(f.home, '.codex/auth.json'), 3);
  expectCounts(f.check(), { credential: 1 }, 1);
  f.done();
  const g = fixture();
  const p = join(g.home, '.codex/auth.json');
  writeFileSync(`${p}.new`, '{"token":"synthetiX"}');
  renameSync(`${p}.new`, p);
  expectCounts(g.check(), { credential: 1 }, 1);
  g.done();
});

test('agent keychain item removed, added under new name, second account', () => {
  for (const k of [
    [OTHER],
    [AGENT, OTHER, { svce: 'Codex Synthetic Auth', acct: 'synthetic-user', mdat: '1' }],
    [AGENT, OTHER, { ...AGENT, acct: 'second-account' }],
    [{ ...AGENT, mdat: '20261102000000Z' }, OTHER],
  ]) {
    const f = fixture();
    f.setKeychain(k);
    expectCounts(f.check(), { keychain: 1 }, 1);
    f.done();
  }
});

test('unrelated keychain item added, modified, removed pauses; non-agent marking silences it', () => {
  for (const k of [
    [AGENT, OTHER, { svce: 'Another Synthetic App', acct: 'u', mdat: '1' }],
    [AGENT, { ...OTHER, mdat: '20261102000000Z' }],
    [AGENT],
  ]) {
    const f = fixture();
    f.setKeychain(k);
    const cur = takeSnapshot(f.ctx);
    const r = compareSnapshots(f.base, cur);
    expectCounts(r, { unmatched: 1 }, 1);
    assert.deepEqual(formatResult(r), ['unmatched-change 1']);
    const nonAgent = new Set(unmatchedServices(f.base, cur));
    expectCounts(compareSnapshots(f.base, cur, { nonAgent }), {}, 0);
    f.done();
  }
});

test('--expect-new-keychain precedence', () => {
  const NEW = { svce: 'Claude Code-credentials-temp', acct: 'synthetic-user', mdat: '1' };
  const f = fixture();
  f.setKeychain([AGENT, OTHER, NEW]);
  let r = f.check({ expectNew: NEW.svce });
  expectCounts(r, { expectedNew: 1 }, 0);
  assert.deepEqual(formatResult(r), ['MATCH', 'expected-new 1']);
  f.setKeychain([{ ...AGENT, mdat: '2' }, OTHER, NEW]);
  r = f.check({ expectNew: NEW.svce });
  expectCounts(r, { keychain: 1, expectedNew: 1 }, 1);
  assert.equal(formatResult(r)[0], 'DIFF: config 0 / credential 0 / keychain 1');
  f.setKeychain([AGENT, { ...OTHER, mdat: '2' }, NEW]);
  expectCounts(f.check({ expectNew: NEW.svce }), { unmatched: 1, expectedNew: 1 }, 1);
  f.done();
});

test('output never contains file or item names', () => {
  const f = fixture();
  writeFileSync(join(f.home, '.claude/settings.json'), '{"a":9}');
  truncateSync(join(f.home, '.codex/auth.json'), 1);
  f.setKeychain([OTHER, { svce: 'Another Synthetic App', acct: 'u', mdat: '1' }]);
  const out = formatResult(f.check()).join('\n');
  for (const s of ['settings', 'auth', '.claude', '.codex', f.home, AGENT.svce, OTHER.svce, 'Another', 'synthetic-user']) {
    assert.ok(!out.includes(s), `leaked ${s}`);
  }
  f.done();
});

test('parseDumpKeychain keeps generic-password attributes only', () => {
  const text = [
    'keychain: "login.keychain-db"', 'version: 512', 'class: "genp"', 'attributes:',
    '    0x00000007 <blob>="Claude Code-credentials"', '    "acct"<blob>="synthetic-user"',
    '    "mdat"<timedate>=0x3230323631313031  "20261101000000Z\\000"', '    "svce"<blob>="Claude Code-credentials"',
    'keychain: "login.keychain-db"', 'class: "inet"', 'attributes:', '    "srvr"<blob>="example.com"', '    "acct"<blob>="x"',
    'keychain: "login.keychain-db"', 'class: "genp"', 'attributes:',
    '    "acct"<blob>=<NULL>', '    "mdat"<timedate>=0x32  "20261102000000Z\\000"', '    "svce"<blob>=0x414243  "ABC"',
  ].join('\n');
  assert.deepEqual(parseDumpKeychain(text), [
    { svce: 'Claude Code-credentials', acct: 'synthetic-user', mdat: '20261101000000Z\\000' },
    { svce: 'ABC', acct: '', mdat: '20261102000000Z\\000' },
  ]);
});

test('plugin churn: content updates and version bumps inside the tree are ignored; names are not', () => {
  const setup = () => {
    const f = fixture();
    mkdirSync(join(f.home, '.claude/plugins/cache/mkt/plug/1.0.0'), { recursive: true });
    writeFileSync(join(f.home, '.claude/plugins/cache/mkt/plug/1.0.0/plugin.json'), '{"v":1}');
    writeFileSync(join(f.home, '.claude/plugins/known_marketplaces.json'), '{"mkt":{"lastUpdated":"a"}}');
    return { ...f, base: takeSnapshot(f.ctx), cmp: () => compareSnapshots(takeSnapshot(f.ctx), takeSnapshot(f.ctx)) };
  };
  let f = setup();
  const before = takeSnapshot(f.ctx);
  writeFileSync(join(f.home, '.claude/plugins/cache/mkt/plug/1.0.0/plugin.json'), '{"v":2,"more":true}');
  mkdirSync(join(f.home, '.claude/plugins/cache/mkt/plug/1.0.1'));
  writeFileSync(join(f.home, '.claude/plugins/known_marketplaces.json'), '{"mkt":{"lastUpdated":"b"}}');
  expectCounts(compareSnapshots(before, takeSnapshot(f.ctx)), {}, 0);
  f.done();
  f = setup();
  const b2 = takeSnapshot(f.ctx);
  mkdirSync(join(f.home, '.claude/plugins/cache/mkt/newplug'));
  expectCounts(compareSnapshots(b2, takeSnapshot(f.ctx)), { config: 1 }, 1);
  f.done();
  f = setup();
  const b3 = takeSnapshot(f.ctx);
  writeFileSync(join(f.home, '.claude/plugins/known_marketplaces.json'), '{"mkt":{},"other":{}}');
  expectCounts(compareSnapshots(b3, takeSnapshot(f.ctx)), { config: 1 }, 1);
  f.done();
});
