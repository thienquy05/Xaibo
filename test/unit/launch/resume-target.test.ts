// XAIBO-PROD-626 (P7-T05, P7-T09; FR-13, FR-21, EC-20, EC-67, EC-81): the service's resume target for main. The resume template
// is the catalog's interactive one (native availability first; prompt-required print modes and unsupported placeholders are not
// offered); fork only where the bundled catalog has a tested template (Claude cli, S7); the VS Code handoff only with a verified
// vscode compatibility row for the detected version; the liveness classification (silence is uncertain, never safe).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogIssues, loadCatalog, type Catalog } from '../../../src/service/catalog/validate.ts';
import { resumeTarget } from '../../../src/service/launch/resume-target.ts';
import { parseServiceCommand, parseServiceEvent } from '../../../src/shared/ipc.ts';

const catalog = loadCatalog();
const ID = '00000000-0000-4000-8000-0000000a0001';
const s = (o: object = {}) => ({ agent: 'claude', profileId: 'p1', nativeSessionId: ID, cwd: '/synthetic/proj', entrypoint: 'cli', originator: null, nativeAvailable: true,
  live: { lifecycle: 'busy' as const, health: 'connected' as const }, ...o });

test('Claude cli: resume and fork templates, VS Code unverified with its reason, busy and connected is live', () => {
  assert.deepEqual(resumeTarget(catalog, s(), '2.1.332'), {
    agent: 'claude', profileId: 'p1', nativeId: ID, cwd: '/synthetic/proj',
    resume: { args: ['--resume', '{id}'] }, fork: { args: ['--resume', '{id}', '--fork-session'] },
    vscode: 'VS Code history visibility: unverified for 2.1.332', liveness: 'live',
  });
  const t = (o: object) => resumeTarget(catalog, s(o), '2.1.332');
  assert.deepEqual(t({ entrypoint: 'sdk-cli' }).resume, { disabled: 'Print mode (-p) needs a prompt; not offered as an interactive resume' });
  assert.deepEqual(t({ entrypoint: 'claude-desktop' }).resume, { disabled: 'Desktop resume not verified; view-only (S7)' });
  assert.deepEqual([t({ nativeAvailable: false }).resume, t({ nativeAvailable: false }).fork], [{ disabled: 'Native session deleted; resume unavailable' }, { disabled: 'Native session deleted; resume unavailable' }]);
  assert.deepEqual(t({ nativeSessionId: 'not-a-uuid' }).resume, { disabled: 'Session id is not a UUID; resume disabled' });
  assert.deepEqual(t({ nativeSessionId: ID.toUpperCase() }).resume, { disabled: 'Session id is not a UUID; resume disabled' }, 'gate nit: lowercase only, as the launch layer');
  assert.deepEqual([t({ pending: true }).resume, t({ pending: true }).fork], [{ disabled: 'A resume from Xaibo is still starting; wait for it or remove its Starting… row' },
    { args: ['--resume', '{id}', '--fork-session'] }], 'G7-1 (OQ-P7-3): a pending Xaibo resume locks the session; a fork stays available');
  assert.deepEqual([t({ live: { lifecycle: 'idle', health: 'connected' } }).liveness, t({ live: { lifecycle: 'ended', health: 'connected' } }).liveness, t({ live: null }).liveness], ['uncertain', 'not-live', 'uncertain']);
});

test('Codex resumes, has no tested fork; agy has no supported resume template; a verified vscode row enables the handoff', () => {
  const codex = resumeTarget(catalog, s({ agent: 'codex', entrypoint: 'cli', originator: 'codex-tui' }), '0.160.0');
  assert.deepEqual([codex.resume, codex.fork, codex.vscode], [{ args: ['resume', '{id}'] }, { disabled: 'Fork not verified for this agent' }, 'Open in VS Code is available for Claude Code sessions only']);
  assert.deepEqual(resumeTarget(catalog, s({ agent: 'agy', entrypoint: null }), '1.0.0').resume, { disabled: 'Resume template not supported' });
  const verified: Catalog = { ...catalog, agents: catalog.agents.map((a) => (a.id === 'claude' ? { ...a, compatibility: [...(a.compatibility ?? []),
    { version: '2.1.332', surface: 'vscode' as const, visible: 'verified' as const, resumable: 'unverified' as const, attach: 'unverified' as const, ownership: 'unverified' as const, evidence: 'synthetic' }] } : a)) };
  assert.equal(resumeTarget(verified, s(), '2.1.332').vscode, null);
  assert.equal(resumeTarget(verified, s(), '2.1.333').vscode, 'VS Code history visibility: unverified for 2.1.333');
});

test('fork data: bundled only, interactive, with the {id} token; resumeTarget command and event parse strictly', () => {
  const bundled = catalog;
  const withFork = (fork: unknown) => ({ ...catalog, sessionKinds: catalog.sessionKinds.map((k) => (k.agent === 'codex' && k.id === 'cli' ? { ...k, fork } : k)) });
  assert.deepEqual(catalogIssues(withFork({ args: ['fork', '{id}'], evidence: 'x' })), []);
  assert.ok(catalogIssues(withFork({ args: ['fork', '{id}'], evidence: 'x' }), bundled).some((i) => i.code === 'unsafe-value' && i.at === '/sessionKinds/4/fork'), 'an imported catalog carries none');
  assert.deepEqual(catalogIssues(withFork({ args: ['-p', '{id}'], evidence: 'x' })), [{ code: 'unsafe-value', at: '/sessionKinds/4/fork/args/0' }]);
  assert.deepEqual(catalogIssues(withFork({ args: ['fork'], evidence: 'x' })), [{ code: 'unsafe-value', at: '/sessionKinds/4/fork' }]);
  assert.deepEqual(parseServiceCommand({ v: 1, type: 'resumeTarget', id: 3, session: 9 }), { v: 1, type: 'resumeTarget', id: 3, session: 9 });
  assert.equal(parseServiceCommand({ v: 1, type: 'resumeTarget', id: 3, session: 0 }), null);
  const target = resumeTarget(catalog, s(), '2.1.332');
  assert.deepEqual(parseServiceEvent({ v: 1, type: 'resumeTarget', id: 3, target }), { v: 1, type: 'resumeTarget', id: 3, target });
  assert.deepEqual(parseServiceEvent({ v: 1, type: 'resumeTarget', id: 3, target: null }), { v: 1, type: 'resumeTarget', id: 3, target: null });
  assert.equal(parseServiceEvent({ v: 1, type: 'resumeTarget', id: 3, target: { ...target, cwd: 'relative' } }), null);
  assert.equal(parseServiceEvent({ v: 1, type: 'resumeTarget', id: 3, target: { ...target, liveness: 'maybe' } }), null);
});

test('626 reviews: imported agent ids may not end in -resume or -fork (grant keys)', () => {
  const imported = { ...catalog, agents: [{ ...catalog.agents.find((a) => a.id === 'agy')!, id: 'claude-resume', detection: { binaries: [{ id: 'b', names: ['synthetic-cr'], versionArgs: ['--version'] }] }, profileRoots: [{ id: 'r', base: 'home' as const, relative: '.synthetic-cr' }], hookEvents: undefined, launch: undefined, launchDisabled: undefined }], sessionKinds: [] };
  assert.ok(catalogIssues(imported, catalog).some((i) => i.code === 'shadow' && i.at === '/agents/0/id'), JSON.stringify(catalogIssues(imported, catalog)));
});
