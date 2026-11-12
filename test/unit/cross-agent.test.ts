// XAIBO-PROD-212 (P2-T12, EC-74 tag part): a Codex session started by Claude Code through the Codex plugin carries the
// app-server client name as originator (S6: rollout originator = clientInfo.name; plugin 1.0.6 sends "Claude Code").
// The catalog kind gives it a badge, marks it non-interactive and keeps resume disabled with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../src/service/catalog/validate.ts';
import { resumeArgv, sessionKind } from '../../src/service/resume.ts';

const kinds = loadCatalog().sessionKinds;
const ID = '00000000-0000-4000-8000-0000000c0074';

test('EC-74: a Codex rollout with originator "Claude Code" maps to the cross-agent kind', () => {
  for (const entrypoint of ['vscode', null]) {
    const k = sessionKind(kinds, { agent: 'codex', entrypoint, originator: 'Claude Code' });
    assert.equal(k?.badge, 'via Claude Code');
    assert.equal(k?.interactive, false);
    const r = resumeArgv(kinds, { agent: 'codex', entrypoint, originator: 'Claude Code', nativeSessionId: ID });
    assert.ok('disabled' in r && /Claude Code/.test(r.reason), 'resume disabled with a reason');
  }
});

test('EC-74: other Codex kinds are unchanged; the originator alone never makes a Claude session', () => {
  assert.equal(sessionKind(kinds, { agent: 'codex', entrypoint: 'vscode', originator: 'codex_vscode' })?.badge, 'VS Code');
  assert.equal(sessionKind(kinds, { agent: 'codex', entrypoint: 'cli', originator: 'codex-tui' })?.badge, 'CLI');
  assert.equal(sessionKind(kinds, { agent: 'claude', entrypoint: 'cli', originator: 'Claude Code' })?.agent, 'claude');
  assert.equal(sessionKind(kinds, { agent: 'codex', entrypoint: 'vscode', originator: 'claude code' }), undefined, 'exact strings only');
});
