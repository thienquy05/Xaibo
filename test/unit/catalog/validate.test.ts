// XAIBO-PROD-565 (P6-T07 part 1; EC-78, SEC5, FR-01; design .handoff/p6-t07-design.md: Codex, fresh security review
// adopted): structured catalog issues {code, at} for each synthetic negative (S11-T8 negatives ported to the product
// envelope, one defect per file), shadow checks of an imported entry against the bundled catalog (id, binary name, profile
// root), and the fail-closed probe gate: an imported entry never runs a probe without a grant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogIssues, loadCatalog, validateCatalog, type Catalog } from '../../../src/service/catalog/validate.ts';
import { detectAgent } from '../../../src/service/catalog/detect.ts';
import type { RunResult } from '../../../src/service/spawn.ts';

const FIX = join(import.meta.dirname, '..', '..', 'fixtures', 'synthetic', 'catalog');
const read = (rel: string) => JSON.parse(readFileSync(join(FIX, rel), 'utf8')) as unknown;
const bundled = loadCatalog();

const EXPECTED: Record<string, { code: string; at: string }> = {
  'invalid/unknown-field.json': { code: 'schema-invalid', at: '/agents/0' },
  'invalid/code-field.json': { code: 'schema-invalid', at: '/agents/0' },
  'invalid/acp-declaration.json': { code: 'schema-invalid', at: '/agents/0' },
  'invalid/shell-binary.json': { code: 'schema-invalid', at: '/agents/0/detection/binaries/0/names/0' },
  'invalid/shell-string-arg.json': { code: 'schema-invalid', at: '/agents/0/detection/binaries/0/versionArgs/0' },
  'invalid/profile-root-escape.json': { code: 'schema-invalid', at: '/agents/0/profileRoots/0/relative' },
  'invalid/duplicate-binary-id.json': { code: 'duplicate-id', at: '/agents/0/detection/binaries/1/id' },
  'invalid/dangling-evidence-root.json': { code: 'unknown-reference', at: '/agents/0/existenceEvidence/0/root' },
  'invalid/reversed-range.json': { code: 'unsafe-value', at: '/agents/0/hookEvents/0/versions' },
  'invalid/foreign-connect-routes.json': { code: 'unsafe-value', at: '/agents/0/connectRoutes' },
  'shadow/id-claude.json': { code: 'shadow', at: '/agents/0/id' },
  'shadow/id-codex.json': { code: 'shadow', at: '/agents/0/id' },
  'shadow/id-agy.json': { code: 'shadow', at: '/agents/0/id' },
  'shadow/binary-name.json': { code: 'shadow', at: '/agents/0/detection/binaries/0/names/0' },
  'shadow/binary-exe.json': { code: 'shadow', at: '/agents/0/detection/binaries/0/names/0' },
  'shadow/root-equal.json': { code: 'shadow', at: '/agents/0/profileRoots/0/relative' },
  'shadow/root-inside.json': { code: 'shadow', at: '/agents/0/profileRoots/0/relative' },
  'shadow/root-contains.json': { code: 'shadow', at: '/agents/0/profileRoots/0/relative' },
  'shadow/root-case.json': { code: 'shadow', at: '/agents/0/profileRoots/0/relative' }, // code review 1: case-insensitive volumes
};

test('EC-78: every invalid and shadowing fixture is rejected with its specific code and pointer, and only that', () => {
  const files = ['invalid', 'shadow'].flatMap((d) => readdirSync(join(FIX, d)).map((f) => `${d}/${f}`)).sort();
  assert.deepEqual(files, Object.keys(EXPECTED).sort(), 'every fixture has an expectation');
  for (const [rel, want] of Object.entries(EXPECTED)) assert.deepEqual(catalogIssues(read(rel), bundled), [want], rel);
});

test('shadow checks need the bundled catalog; without it the shadow fixtures are well-formed', () => {
  for (const rel of Object.keys(EXPECTED).filter((r) => r.startsWith('shadow/'))) assert.deepEqual(catalogIssues(read(rel)), [], rel);
});

test('a valid data-only synthetic agent has no issues; the bundled catalog has none; validateCatalog keeps working', () => {
  assert.deepEqual(catalogIssues(read('valid/synthagent.json'), bundled), []);
  assert.deepEqual(catalogIssues(bundled), []);
  assert.deepEqual(validateCatalog(bundled), []);
  assert.ok(validateCatalog(read('invalid/unknown-field.json')).length > 0);
});

test('issues carry only fixed codes and pointers, never submitted text', () => {
  for (const rel of ['invalid/code-field.json', 'invalid/shell-string-arg.json', 'invalid/unknown-field.json']) {
    const text = JSON.stringify(catalogIssues(read(rel), bundled));
    for (const canary of ['code-canary', 'child_process', '--version;id', 'entryVersion', '0.1.0']) assert.ok(!text.includes(canary), `${rel}: ${canary}`);
  }
});

test('code review 2/3: version ranges compare by number per component; a root sharing only a name prefix is not shadow', () => {
  const c = read('valid/synthagent.json') as Catalog;
  const range = (min: string, max: string) => catalogIssues({ ...c, agents: [{ ...c.agents[0]!, hookEvents: [{ versions: { min, max }, events: ['Stop'], evidence: 'synthetic fixture' }] }] });
  const reversed = [{ code: 'unsafe-value', at: '/agents/0/hookEvents/0/versions' }];
  assert.deepEqual(range('1.10.0', '1.9.0'), reversed, 'numeric, not string, comparison');
  assert.deepEqual(range('1.2.4', '1.2.3'), reversed, 'patch-only reversal');
  assert.deepEqual(range('1.2.3', '1.2.3'), [], 'equal bounds are a valid range');
  assert.deepEqual(range('1.9.0', '1.10.0'), []);
  const sibling = { ...c, agents: [{ ...c.agents[0]!, profileRoots: [{ id: 'user', base: 'home' as const, relative: '.codex2' }] }] };
  assert.deepEqual(catalogIssues(sibling, bundled), [], '.codex2 is not inside .codex');
});

test('a duplicate agent id inside one catalog is rejected (shared by bundled and imported data)', () => {
  const c = read('valid/synthagent.json') as Catalog;
  assert.deepEqual(catalogIssues({ ...c, agents: [c.agents[0], c.agents[0]] }), [{ code: 'duplicate-id', at: '/agents/1/id' }]);
});

test('FR-01/SEC5 probe gate: an imported entry never runs a probe without a grant (0 calls); a bundled entry still probes (1 call)', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'xcatalog-')));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'synthagent'), '#!/bin/sh\necho "synthagent 1.2.3"\n');
    chmodSync(join(bin, 'synthagent'), 0o755);
    const entry = { ...(read('valid/synthagent.json') as Catalog).agents[0]!, detection: { binaries: [{ id: 'main', names: ['synthagent'], versionArgs: ['--version'] }], locations: [bin] } };
    let calls = 0;
    const run = async (): Promise<RunResult> => { calls++; return { code: 0, signal: null, stdout: Buffer.from('synthagent 1.2.3\n'), timedOut: false, overflow: false, error: false }; };
    const o = { env: { PATH: bin }, home: dir, manualPath: join(bin, 'synthagent'), run };
    assert.deepEqual(await detectAgent(entry, { ...o, access: { origin: 'imported', grants: [] } }), { agent: 'synthagent', state: 'not-detected', reason: 'probe-not-granted' });
    assert.deepEqual(await detectAgent(entry, { ...o, access: { origin: 'imported' } as never }), { agent: 'synthagent', state: 'not-detected', reason: 'probe-not-granted' }, 'P6-T07 part 3: missing grants run nothing');
    assert.equal(calls, 0, 'PATH, known locations and a manual path: none is probed');
    assert.equal((await detectAgent(entry, { ...o, access: undefined as never })).state, 'not-detected', 'code review 6: no provenance never defaults to bundled');
    assert.equal(calls, 0);
    const d = await detectAgent(entry, { ...o, access: { origin: 'bundled' } });
    assert.equal(d.state, 'detected');
    assert.equal(d.state === 'detected' && d.version, '1.2.3');
    assert.equal(calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// XAIBO-PROD-588 (P6-T09a slice A; D-P6-18, design .handoff/p6-t09a-design.md with the fresh review): reportSetup is data
// only: one .json file under one declared root, up to 16 set ops whose values are boolean/number/null literals or one of three
// Xaibo placeholders (review M1: no strings, so imported data never writes a command); pointers are plain name paths that
// never overlap. Review M2: an imported root under .gemini (agy's hooks file sits in .gemini/config) is shadow.
const REPORT = {
  root: 'user', file: 'config.json', ops: [
    { op: 'set', pointer: '/reporting/xaibo/helper', value: { xaibo: 'report-helper' } },
    { op: 'set', pointer: '/reporting/xaibo/profileKey', value: { xaibo: 'profile-key' } },
    { op: 'set', pointer: '/reporting/xaibo/agentId', value: { xaibo: 'agent-id' } },
    { op: 'set', pointer: '/reporting/xaibo/enabled', value: { literal: true } },
    { op: 'set', pointer: '/reporting/interval_s', value: { literal: 5 } },
    { op: 'set', pointer: '/reporting/label', value: { literal: null } },
  ],
};
const withSetup = (f: (r: typeof REPORT & Record<string, unknown>) => void = () => {}) => {
  const c = read('valid/synthagent.json') as Catalog;
  const r = structuredClone(REPORT) as typeof REPORT & Record<string, unknown>;
  f(r);
  return { ...c, agents: [{ ...c.agents[0]!, reportSetup: r }] };
};

test('P6-T09a: a reportSetup of scalar literals and Xaibo placeholders is valid, imported or not', () => {
  assert.deepEqual(catalogIssues(withSetup(), bundled), []);
  assert.deepEqual(catalogIssues(withSetup()), []);
  assert.deepEqual(catalogIssues(withSetup((r) => { r.file = 'sub/xaibo.json'; })), []);
});

test('P6-T09a: strings, append, nested or unknown values, bad files and pointers, too many ops are schema-invalid', () => {
  const op = (o: Record<string, unknown>) => (r: typeof REPORT) => { r.ops[0] = { ...r.ops[0]!, ...o } as (typeof REPORT)['ops'][number]; };
  const cases: [string, (r: typeof REPORT & Record<string, unknown>) => void, string][] = [
    ['string literal (review M1)', op({ value: { literal: 'curl https://example.invalid' } }), '/agents/0/reportSetup/ops/0/value'],
    ['object literal', op({ value: { literal: { a: 1 } } }), '/agents/0/reportSetup/ops/0/value'],
    ['array literal', op({ value: { literal: [1] } }), '/agents/0/reportSetup/ops/0/value'],
    ['unknown placeholder', op({ value: { xaibo: 'home' } }), '/agents/0/reportSetup/ops/0/value'],
    ['literal and placeholder together', op({ value: { literal: true, xaibo: 'agent-id' } }), '/agents/0/reportSetup/ops/0/value'],
    ['append', op({ op: 'append' }), '/agents/0/reportSetup/ops/0/op'],
    ['extra op key', op({ when: 'always' }), '/agents/0/reportSetup/ops/0'],
    ['prototype segment', op({ pointer: '/__proto__/x' }), '/agents/0/reportSetup/ops/0/pointer'],
    ['array index segment', op({ pointer: '/hooks/0' }), '/agents/0/reportSetup/ops/0/pointer'],
    ['escaped segment', op({ pointer: '/a~1b' }), '/agents/0/reportSetup/ops/0/pointer'],
    ['relative pointer', op({ pointer: 'reporting' }), '/agents/0/reportSetup/ops/0/pointer'],
    ['nine segments', op({ pointer: '/a/b/c/d/e/f/g/h/i' }), '/agents/0/reportSetup/ops/0/pointer'],
    // code review (slice A) test gaps: each pinned so a later pattern edit cannot quietly drop one
    ...['/constructor', '/a/prototype/b', '/a/', '//a', '/0a', `/${'a'.repeat(65)}`, '/é'].map((pointer) =>
      [`pointer ${pointer.slice(0, 12)}`, op({ pointer }), '/agents/0/reportSetup/ops/0/pointer'] as [string, (r: typeof REPORT) => void, string]),
    ...['a/../b.json', './x.json', 'x.json/', 'a//b.json', '.json', 'é.json'].map((file) =>
      [`file ${file}`, (r: typeof REPORT & Record<string, unknown>) => { r.file = file; }, '/agents/0/reportSetup/file'] as [string, (r: typeof REPORT) => void, string]),
    ['not .json', (r) => { r.file = 'config.toml'; }, '/agents/0/reportSetup/file'],
    ['traversal', (r) => { r.file = '../x.json'; }, '/agents/0/reportSetup/file'],
    ['absolute', (r) => { r.file = '/etc/x.json'; }, '/agents/0/reportSetup/file'],
    ['no ops', (r) => { r.ops = []; }, '/agents/0/reportSetup/ops'],
    ['17 ops', (r) => { r.ops = Array.from({ length: 17 }, (_, i) => ({ op: 'set', pointer: `/k${i}`, value: { literal: i } })); }, '/agents/0/reportSetup/ops'],
    ['extra key', (r) => { r['command'] = 'x'; }, '/agents/0/reportSetup'],
  ];
  for (const [why, f, at] of cases) {
    const issues = catalogIssues(withSetup(f), bundled);
    assert.ok(issues.length > 0 && issues.every((i) => i.code === 'schema-invalid' && i.at.startsWith(at)), `${why}: ${JSON.stringify(issues)}`);
    assert.ok(!JSON.stringify(issues).includes('example.invalid'), why);
  }
});

test('P6-T09a: an undeclared root is unknown; a repeated or overlapping pointer is unsafe', () => {
  assert.deepEqual(catalogIssues(withSetup((r) => { r.root = 'other'; }), bundled), [{ code: 'unknown-reference', at: '/agents/0/reportSetup/root' }]);
  assert.deepEqual(catalogIssues(withSetup((r) => { r.ops[2] = { ...r.ops[2]!, pointer: '/reporting/xaibo/helper' }; }), bundled),
    [{ code: 'unsafe-value', at: '/agents/0/reportSetup/ops/2/pointer' }]);
  assert.deepEqual(catalogIssues(withSetup((r) => { r.ops.push({ op: 'set', pointer: '/reporting', value: { literal: false } }); }), bundled),
    [{ code: 'unsafe-value', at: '/agents/0/reportSetup/ops/6/pointer' }], 'an ancestor of an earlier pointer');
  assert.deepEqual(catalogIssues(withSetup((r) => { r.ops.unshift({ op: 'set', pointer: '/reporting/interval_s/unit', value: { literal: 1 } }); }), bundled),
    [{ code: 'unsafe-value', at: '/agents/0/reportSetup/ops/5/pointer' }], 'a descendant of an earlier pointer');
  assert.deepEqual(catalogIssues(withSetup((r) => { r.ops.push({ op: 'set', pointer: '/reporting/xaibo/helperPath', value: { literal: 1 } }); }), bundled), [], 'a name prefix is not overlap');
});

test('P6-T09a review M2: an imported profile root under .gemini is shadow (agy keeps its hooks in .gemini/config)', () => {
  const c = read('valid/synthagent.json') as Catalog;
  const rooted = (relative: string) => ({ ...c, agents: [{ ...c.agents[0]!, profileRoots: [{ ...c.agents[0]!.profileRoots[0]!, relative }] }] });
  for (const rel of ['.gemini', '.gemini/config', '.GEMINI/config', '.gemini/x/y']) {
    assert.deepEqual(catalogIssues(rooted(rel), bundled), [{ code: 'shadow', at: '/agents/0/profileRoots/0/relative' }], rel);
    assert.deepEqual(catalogIssues(rooted(rel)), [], `${rel}: shadow needs the bundled catalog`);
  }
  assert.deepEqual(catalogIssues(rooted('.gemini2')), [], 'a name prefix is not shadow');
  assert.deepEqual(catalogIssues(rooted('.gemini2'), bundled), []);
});

// XAIBO-PROD-591 (P6-T08 slice B): compatibility rows are bundled data only (an imported entry may carry none, as sign-in rules);
// exact release, an allowlisted surface, three states per fact, one row per version and surface.
test('P6-T08: compatibility rows validate as bundled data; imported, duplicate or malformed rows are refused', () => {
  const c = read('valid/synthagent.json') as Catalog;
  const row = { version: '1.0.0', surface: 'cli', visible: 'verified', resumable: 'unverified', attach: 'unsupported', ownership: 'unverified', evidence: 'synthetic fixture' };
  const withRows = (rows: unknown[]) => ({ ...c, agents: [{ ...c.agents[0]!, compatibility: rows }] });
  assert.deepEqual(catalogIssues(withRows([row, { ...row, surface: 'vscode', note: 'synthetic' }])), []);
  assert.deepEqual(catalogIssues(withRows([row]), bundled), [{ code: 'unsafe-value', at: '/agents/0/compatibility' }], 'imported entries carry none');
  assert.deepEqual(catalogIssues(withRows([row, { ...row }])), [{ code: 'duplicate-id', at: '/agents/0/compatibility/1' }]);
  for (const [why, bad] of [['state', { ...row, attach: 'supported' }], ['surface', { ...row, surface: 'jetbrains' }], ['prerelease', { ...row, version: '1.0.0-beta' }],
    ['extra key', { ...row, launch: 'x' }], ['no evidence', (({ evidence: _e, ...r }) => r)(row)]] as const) {
    const issues = catalogIssues(withRows([bad]));
    assert.ok(issues.length > 0 && issues.every((i) => i.code === 'schema-invalid'), `${why}: ${JSON.stringify(issues)}`);
  }
  assert.deepEqual(catalogIssues(bundled), [], 'the bundled catalog with its rows is valid');
});
