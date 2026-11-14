// XAIBO-PROD-311 (P3-T11; US-2, FR-10, EC-41, EC-59): a confirmed PermissionRequest on the packaged app's hook socket
// gives exactly one OS notification, recorded by the test-mode stub (XAIBO_NOTIFY_STUB=1) with only the allowed text
// and an hrtime stamp. A redelivered duplicate and the request's resolution add none; canary prompt, title, path and
// tool strings never reach it.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { canaries } from '../helpers/canary.ts';
import { claudeProfile, deliver } from '../helpers/hook-socket.ts';
import { expect, test } from './fixtures.ts';

const SID = '00000000-0000-4000-8000-0000000f1111';

test('a confirmed PermissionRequest gives exactly one stub notification with agent, placeholder label and state only', async ({ xaibo }) => {
  const c = canaries();
  const dataDir = path.join(path.dirname(xaibo.home), 'data-notify'); // inside the fixture's temp root, short for the socket path
  const run = await xaibo.launch({ dataDir, env: { XAIBO_NOTIFY_STUB: '1' } });
  const page = await xaibo.window(run);
  await expect(page.getByRole('status')).toContainText('Running');
  let profile: string | null = null;
  await expect.poll(() => (profile = claudeProfile(dataDir)), { timeout: 15_000 }).toBeTruthy();
  await expect.poll(() => existsSync(path.join(dataDir, 'run', 'token')), { timeout: 15_000 }).toBe(true);

  const hook = async (event: string, payload: Record<string, unknown> = {}, id = randomUUID()) => {
    const ack = await deliver(dataDir, { v: 1, delivery_id: id, agent: 'claude', profile_key: profile!, event, session_id: SID, cwd: c.home,
      received_ts: Date.now(), payload: { hook_event_name: event, session_id: SID, cwd: c.home, transcript_path: c.home, title: c.email, ...payload } });
    expect(ack).toMatchObject({ status: 'accepted' }); // a redelivery is accepted with code 'duplicate'
  };
  const stub = path.join(dataDir, 'logs', 'notify-stub.jsonl');
  const lines = () => (existsSync(stub) ? readFileSync(stub, 'utf8').trim().split('\n').filter(Boolean) : []);

  await hook('SessionStart', { source: 'startup' });
  await hook('UserPromptSubmit', { prompt: `fix ${c['secret-generic']}` });
  await hook('PreToolUse', { tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: c.home, content: c['secret-github'] } });
  expect(lines()).toEqual([]);
  const request = randomUUID();
  await hook('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: c.home } }, request);
  await expect.poll(() => lines().length, { timeout: 5_000 }).toBe(1);
  await hook('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: c.home } }, request); // redelivered
  await hook('PostToolUse', { tool_name: 'Write', tool_use_id: 'w1', tool_response: { ok: true } });
  await hook('Stop');
  await page.waitForTimeout(1_500);

  const got = lines().map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(got).toHaveLength(1);
  expect(Object.keys(got[0]!).sort()).toEqual(['t', 'title']);
  expect(got[0]!['title']).toBe('Claude Code · Project · Waiting for permission');
  expect(String(got[0]!['t'])).toMatch(/^\d+$/);
  const raw = readFileSync(stub, 'utf8');
  for (const v of Object.values(c)) expect(raw).not.toContain(v);
  expect(raw).not.toMatch(/Write|fix /);
});
