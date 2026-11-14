// XAIBO-PROD-310 (P3-T10; US-1, US-4, FR-09, A11Y, EC-12): live status in the packaged app's list, driven by a synthetic
// emitter on the hook socket (one connection per delivery: the server closes idle connections) and a transcript append
// for the no-hook heuristic; one event goes through the packaged forwarder under the audit profile (P3-T16c). Assertions are on accessible text. A spool overflow line seeded before launch becomes the
// gap banner. With XAIBO_PERF_TRACE=1 the renderer acks painted deltas and main and service write IDs-only trace lines.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeProfile, deliver } from '../helpers/hook-socket.ts';
import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

const HOOKED = '00000000-0000-4000-8000-0000000f1101';
const FILE_ONLY = '00000000-0000-4000-8000-0000000f1102';
const project = (home: string) => path.join(home, '.claude', 'projects', '-tmp-xaibo-fixture-project');
const rowOf = (page: Page, folder: string) => page.getByRole('table', { name: 'Sessions' }).getByRole('row').filter({ hasText: folder });

test('busy, waiting, R2 badge, Finishing… then idle, Probably waiting, overflow banner; perf trace acks painted deltas', async ({ xaibo }) => {
  const dataDir = path.join(path.dirname(xaibo.home), 'data-live'); // inside the fixture's temp root (cleaned), short for the socket path
  mkdirSync(path.join(dataDir, 'spool'), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dataDir, 'spool', 'overflow.log'), `${JSON.stringify({ ts: Date.now(), agent: 'claude', session_id: HOOKED, event: 'Stop' })}\n`, { mode: 0o600 });
  const run = await xaibo.launch({ dataDir, env: { XAIBO_PERF_TRACE: '1' } });
  const page = await xaibo.window(run);
  await expect(page.getByRole('status')).toContainText('Running');

  await expect(page.getByRole('region', { name: 'Coverage' })).toContainText('Hook events missing (spool overflow): 1 from Claude Code', { timeout: 15_000 });

  let profile: string | null = null;
  await expect.poll(() => (profile = claudeProfile(dataDir)), { timeout: 15_000 }).toBeTruthy();
  await expect.poll(() => existsSync(path.join(dataDir, 'run', 'token')), { timeout: 15_000 }).toBe(true);
  const ids: string[] = [];
  const hook = async (event: string, payload: Record<string, unknown> = {}) => {
    const id = randomUUID();
    ids.push(id);
    const ack = await deliver(dataDir, { v: 1, delivery_id: id, agent: 'claude', profile_key: profile!, event, session_id: HOOKED, cwd: '/tmp/xaibo-fixture/live',
      received_ts: Date.now(), payload: { hook_event_name: event, session_id: HOOKED, ...payload } });
    expect(ack).toMatchObject({ status: 'accepted' });
  };
  const status = () => rowOf(page, '/tmp/xaibo-fixture/live').getByRole('cell').nth(7);

  await hook('SessionStart', { source: 'startup' });
  // P3-T16c: this event goes through the packaged forwarder, run and audited by the fixture
  const sent = await xaibo.hook(run, profile!, { hook_event_name: 'UserPromptSubmit', session_id: HOOKED, cwd: '/tmp/xaibo-fixture/live', prompt: 'fixture prompt' });
  expect(sent).toEqual({ exit: { code: 0, signal: null }, bytes: 0 });
  await expect(status()).toContainText('Busy (confirmed)');

  await hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/tmp/xaibo-fixture/live/a' }, tool_use_id: 'w1' });
  await hook('PermissionRequest', { tool_name: 'Write' });
  await expect(status()).toContainText('Waiting for permission (confirmed)');
  await hook('PostToolUse', { tool_name: 'Write', tool_use_id: 'w1', tool_response: { ok: true } });
  await expect(status()).toContainText('Busy (confirmed)');

  for (let i = 0; i < 4; i++) {
    await hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: `b${i}` });
    await hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: `b${i}`, tool_response: { stdout: '1 failing' } });
  }
  await expect(status()).toContainText('R2 Repeated tool');

  await hook('Stop');
  await expect(status()).toContainText('Busy · Finishing… (confirmed)');
  await expect(status()).toContainText('Idle (confirmed)', { timeout: 10_000 }); // the 4 s settle, with no new event
  await expect(status()).not.toContainText('Repeated tool');

  // No hooks for this session: a pending tool call with no transcript writes for > 5 s reads as a heuristic wait.
  const now = new Date().toISOString();
  const line = (o: object) => `${JSON.stringify({ parentUuid: null, isSidechain: false, cwd: '/tmp/xaibo-fixture/fileonly', sessionId: FILE_ONLY, version: '2.1.319', timestamp: now, ...o })}\n`;
  xaibo.touchStore(() => appendFileSync(path.join(project(xaibo.home), `${FILE_ONLY}.jsonl`),
    line({ type: 'user', uuid: '00000000-0000-4000-8000-0000000f1201', message: { role: 'user', content: 'fixture prompt' } })
    + line({ type: 'assistant', uuid: '00000000-0000-4000-8000-0000000f1202', message: { id: 'msg_fixture_live', role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_fixture_live', name: 'Bash', input: { command: 'npm run build' } }], stop_reason: 'tool_use' } })));
  const fileStatus = rowOf(page, '/tmp/xaibo-fixture/fileonly').getByRole('cell').nth(7);
  await expect(fileStatus).toContainText('Busy (inferred)', { timeout: 15_000 });
  await expect(fileStatus).toContainText('Waiting for permission · Probably waiting (heuristic)', { timeout: 15_000 });

  // Perf trace: IDs and hrtime stamps only; every painted delta id was emitted by the service; our deliveries are in deltas.
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  const service = lines(path.join(dataDir, 'logs', 'perf-trace-service.jsonl'));
  const main = lines(path.join(dataDir, 'logs', 'perf-trace-main.jsonl'));
  const deltas = new Map(service.filter((l) => l['ev'] === 'delta').map((l) => [l['delta'], l['ids'] as string[]]));
  const paints = main.filter((l) => l['ev'] === 'paint');
  expect(paints.length).toBeGreaterThan(0);
  for (const p of paints) {
    expect(deltas.has(p['delta'])).toBe(true);
    expect(String(p['t'])).toMatch(/^\d+$/);
  }
  const traced = new Set([...deltas.values()].flat());
  expect(ids.filter((id) => traced.has(id)).length).toBeGreaterThan(0);
  for (const l of [...service, ...main]) expect(JSON.stringify(l)).not.toMatch(/fixture prompt|npm test|xaibo-fixture/);
});
