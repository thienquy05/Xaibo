// XAIBO-PROD-624 (P7-T04 slice E; design §6.7): the renderer's launch model. Replies from main are parsed (anything else is
// unavailable, never trusted); the cwd choices come only from evidenced session folders (the chosen agent's first, most recent
// first, distinct); elapsed time for the Starting… row; refusal and failure texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterRefusal, cwdChoices, elapsed, envHint, FAILED_TEXT, launchApi, lastKnownLine, minutes, PENDING_OWNERSHIP, REFUSAL_TEXT } from '../../../src/renderer/workspace/launch.ts';
import { LAUNCH_REFUSALS, type SessionRow } from '../../../src/shared/ipc.ts';

const UUID = '00000000-0000-4000-8000-0000000e0001';
const row = (id: number, agent: string, cwd: string | null, lastActivity: number) => ({ id, agent, cwd, lastActivity }) as SessionRow;

test('launchApi: parsed replies only; no bridge or a bad reply is unavailable', async () => {
  const seen: unknown[] = [];
  const api = launchApi(async (r) => { seen.push(r); return (r as { op: string }).op === 'launch' ? { status: 'started', key: UUID } : { status: 'ok', bogus: 1 }; });
  assert.deepEqual(await api.launch(UUID), { status: 'started', key: UUID });
  assert.deepEqual(await api.options(), { status: 'refused', code: 'unavailable' });
  assert.deepEqual(await api.preview({ agent: 'claude', profileId: 'p1', cwd: '/x' }), { status: 'refused', code: 'unavailable' });
  assert.deepEqual(seen, [{ op: 'launch', previewId: UUID }, { op: 'options' }, { op: 'preview', agent: 'claude', profileId: 'p1', cwd: '/x' }]);
  assert.deepEqual(await launchApi(undefined).options(), { status: 'refused', code: 'unavailable' });
  assert.deepEqual(await launchApi(async () => { throw new Error('gone'); }).launch(UUID), { status: 'refused', code: 'unavailable' });
});

test('cwd choices: evidenced folders only, the agent first, most recent first, distinct, labelled by folder name', () => {
  const rows = [row(1, 'codex', '/w/alpha', 50), row(2, 'claude', '/w/beta', 10), row(3, 'claude', '/w/alpha', 40), row(4, 'claude', null, 99),
    row(5, 'codex', 'relative/x', 98), row(6, 'claude', '/v/beta', 5)];
  assert.deepEqual(cwdChoices(rows, 'claude'), [
    { label: 'alpha', cwd: '/w/alpha' }, { label: 'beta (/w/beta)', cwd: '/w/beta' }, { label: 'beta (/v/beta)', cwd: '/v/beta' }]);
  assert.deepEqual(cwdChoices(rows, null).map((c) => c.cwd), ['/w/alpha', '/w/beta', '/v/beta']);
  assert.equal(cwdChoices([...Array(30)].map((_, i) => row(i + 1, 'claude', `/w/p${i}`, i)), 'claude').length, 12);
});

test('elapsed and texts', () => {
  assert.deepEqual([elapsed(0), elapsed(7_400), elapsed(65_000), elapsed(3_600_000 + 61_000), elapsed(-5)], ['0:00', '0:07', '1:05', '1:01:01', '0:00']);
  for (const c of LAUNCH_REFUSALS) assert.ok(REFUSAL_TEXT[c].length > 0, c);
  assert.deepEqual(Object.keys(FAILED_TEXT).sort(), ['open', 'write']);
  assert.equal(PENDING_OWNERSHIP, 'Ownership unavailable — awaiting session evidence');
});

test('624 reviews: environment hint and coarse elapsed label for list rows', () => {
  const base = ['PATH', 'HOME', 'LANG', 'TERM', 'USER', 'SHELL', 'TMPDIR'];
  assert.equal(envHint(base), 'Environment: PATH, HOME, LANG, TERM, USER, SHELL, TMPDIR (no granted keys)');
  assert.equal(envHint([...base, 'CLAUDE_CONFIG_DIR']), "Environment: PATH, HOME, LANG, TERM, USER, SHELL, TMPDIR, CLAUDE_CONFIG_DIR (CLAUDE_CONFIG_DIR as set in Terminal's environment)");
  assert.deepEqual([minutes(0), minutes(59_999), minutes(60_000), minutes(150_000)], ['under 1 min', 'under 1 min', '1 min', '2 min']);
});

test('627: resume asks parse through the bridge; the warning names the last known state, never claims safety', async () => {
  const seen: unknown[] = [];
  const api = launchApi(async (r) => { seen.push(r); const op = (r as { op: string }).op;
    return op === 'resumeOptions' ? { status: 'ok', resume: null, fork: 'Fork not verified for this agent', vscode: 'VS Code history visibility: unverified for 2.1.319', liveness: 'uncertain' }
      : op === 'vscode' ? { status: 'refused', code: 'disabled' } : { status: 'refused', code: 'concurrent' }; });
  assert.deepEqual(await api.resumeOptions(7), { status: 'ok', resume: null, fork: 'Fork not verified for this agent', vscode: 'VS Code history visibility: unverified for 2.1.319', liveness: 'uncertain' });
  assert.deepEqual(await api.resumePreview(7, 'resume', false), { status: 'refused', code: 'concurrent' });
  assert.deepEqual(await api.vscode(7), { status: 'refused', code: 'disabled' });
  assert.deepEqual(seen, [{ op: 'resumeOptions', session: 7 }, { op: 'resumePreview', session: 7, mode: 'resume', confirmed: false }, { op: 'vscode', session: 7 }]);
  assert.equal(lastKnownLine({ lifecycle: 'busy', confidence: 'inferred', health: 'connected' } as never, 120_000), 'Last known: Busy · inferred · Health: connected · 2 min ago');
  assert.equal(lastKnownLine(null, null), 'Last known: no status evidence');
});

test('627 review: a resume main refuses as concurrent goes to the warning; other refusals are said', () => {
  assert.equal(afterRefusal('concurrent'), 'warn');
  assert.equal(afterRefusal('busy'), 'say');
  assert.equal(afterRefusal('disabled'), 'say');
});
