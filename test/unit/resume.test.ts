// XAIBO-PROD-204 (P2-T04, EC-05, EC-50, OQ-P2-08): pure resumeArgv() gives structured argv (no binary, no shell) for
// kinds verified in S6/S7 (Claude 2.1.322, Codex 0.160.0) and agy per D-P2-02, or {disabled, reason} for unverified
// kinds, unknown agents and ids that are not UUIDs. Nothing is executed before Phase 7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog, validateCatalog } from '../../src/service/catalog/validate.ts';
import { resumeArgv } from '../../src/service/resume.ts';

const catalog = loadCatalog();
const ID = '00000000-0000-4000-8000-0000000e0001';
const resume = (agent: string, entrypoint: string | null, originator: string | null = null, nativeSessionId = ID) =>
  resumeArgv(catalog.sessionKinds, { agent, entrypoint, originator, nativeSessionId });
const disabled = (r: ReturnType<typeof resume>) => ('disabled' in r ? r.reason : undefined);

test('EC-05/EC-50: exact argv per verified kind; non-interactive kinds need a prompt', () => {
  assert.deepEqual(resume('claude', 'cli'), { argv: ['--resume', ID], promptRequired: false }); // S7
  assert.deepEqual(resume('claude', 'sdk-cli'), { argv: ['-p', '--resume', ID], promptRequired: true }); // S7 claude -p
  assert.deepEqual(resume('codex', 'cli', 'codex-tui'), { argv: ['resume', ID], promptRequired: false }); // S6
  assert.deepEqual(resume('codex', 'exec', 'codex_exec'), { argv: ['exec', 'resume', ID], promptRequired: true }); // S6
  assert.deepEqual(resume('agy', null), { argv: [`--conversation=${ID}`], promptRequired: false }); // D-P2-02 (10)
});

test('unverified kinds are disabled with their reason', () => {
  for (const [agent, ep, orig] of [['claude', 'claude-vscode', null], ['claude', 'claude-desktop', null],
    ['codex', 'vscode', 'codex_vscode'], ['codex', 'vscode', 'codex_work_desktop']] as const) {
    assert.match(disabled(resume(agent, ep, orig)) ?? '', /not verified/, `${agent} ${ep} ${orig}`);
  }
  for (const [agent, ep, orig] of [['codex', 'vscode', 'xaibo-spike'], ['codex', 'appServer', null], ['claude', null, null], ['gemini', 'cli', null]] as const) {
    assert.equal(disabled(resume(agent, ep, orig)), 'Entry point not verified; resume disabled', `${agent} ${ep} ${orig}`);
  }
});

test('an id that is not a UUID never reaches argv (no flag or path injection)', () => {
  for (const id of ['--dangerously-skip-permissions', '../x', `${ID} -p`, '', ID.slice(1), `${ID}\n`]) {
    assert.equal(disabled(resume('claude', 'cli', null, id)), 'Session id is not a UUID; resume disabled', JSON.stringify(id));
    assert.equal(disabled(resume('agy', null, null, id)), 'Session id is not a UUID; resume disabled', JSON.stringify(id));
  }
  assert.deepEqual(resume('codex', 'cli', 'codex-tui', ID.toUpperCase()), { argv: ['resume', ID.toUpperCase()], promptRequired: false });
});

test('catalog schema: a kind needs exactly one of resume / resumeDisabled; args are literal tokens', () => {
  const k = catalog.sessionKinds[0]!;
  const withKind = (x: object) => ({ ...catalog, sessionKinds: [x] });
  assert.deepEqual(validateCatalog(withKind(k)), []);
  assert.notDeepEqual(validateCatalog(withKind({ ...k, resumeDisabled: 'x' })), [], 'both');
  const { resume: _r, ...neither } = k;
  assert.notDeepEqual(validateCatalog(withKind(neither)), [], 'neither');
  for (const arg of ['$(id)', '{id}; rm', 'a b', '`x`']) assert.notDeepEqual(validateCatalog(withKind({ ...k, resume: { args: [arg] } })), [], arg);
  assert.notDeepEqual(validateCatalog(withKind({ ...k, match: { cwd: '/' } })), [], 'unknown match field');
});
