// XAIBO-PROD-311 (P3-T11; US-2, FR-10, D-11, EC-41, EC-59): OS notification content and intent. The engine emits a
// notify intent only on the first confirmed permission or input wait per request id; heuristic waits, evidence reloaded
// at start, duplicates and refolds never repeat it. The text is a pure function of agent, approved label and state, so
// canary prompt, title, path and tool strings in the payload can never reach it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notificationText } from '../../src/main/notifications.ts';
import { openStore } from '../../src/service/store/db.ts';
import { createEngine, type Observation, type WaitState } from '../../src/service/status/engine.ts';
import { canaries } from '../helpers/canary.ts';
import { fileObs, hookObs, SID, T0 } from '../helpers/status.ts';

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'xaibo-notify-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'b') });
  let now = T0;
  const waits: { agent: string; sid: string; state: WaitState }[] = [];
  const make = () => createEngine({ db, now: () => now, settleMs: 4000, log: () => {}, onWait: (agent, sid, state) => waits.push({ agent, sid, state }) });
  let e = make();
  const feed = (o: Observation, ms: number) => { now = T0 + ms; e.advance(now); e.ingest(o); };
  return { waits, feed, at: (ms: number) => { now = T0 + ms; e.advance(now); }, e: () => e, restart: () => { e.close(); e = make(); } };
}
const H = (event: string, p: Record<string, unknown> = {}, at = 0, id?: string) =>
  hookObs('claude', { hook_event_name: event, ...p }, { at, ...(id ? { id } : {}) });

test('text: agent · approved label or "Project" · state', () => {
  assert.equal(notificationText('Claude Code', null, 'waiting-for-permission'), 'Claude Code · Project · Waiting for permission');
  assert.equal(notificationText('Codex', 'Alpha', 'needs-input'), 'Codex · Alpha · Needs input');
});

test('a confirmed PermissionRequest notifies once; canary prompt, title, path and tool strings never reach the text', async () => {
  const c = canaries();
  const h = await harness();
  const leak = { prompt: `prompt ${c['secret-generic']}`, title: `title ${c.email}`, cwd: c.home, transcript_path: c.home };
  h.feed(H('UserPromptSubmit', leak), 0);
  h.feed(H('PreToolUse', { ...leak, tool_use_id: 'w', tool_name: `Write ${c['secret-aws']}`, tool_input: { file_path: c.home, content: c['secret-github'] } }, 10), 10);
  h.feed(H('PermissionRequest', { ...leak, tool_name: 'Write', tool_input: { file_path: c.home } }, 20, 'dup'), 20);
  h.feed(H('PermissionRequest', { tool_name: 'Write' }, 20, 'dup'), 30); // the same delivery again
  assert.deepEqual(h.waits, [{ agent: 'claude', sid: SID, state: 'waiting-for-permission' }]);
  const text = notificationText('Claude Code', null, h.waits[0]!.state);
  assert.equal(text, 'Claude Code · Project · Waiting for permission');
  for (const v of Object.values(c)) assert.ok(!text.includes(v));
  assert.doesNotMatch(text, /prompt|title|Write|xaibo-fixture/);
});

test('a heuristic wait never notifies (EC-41)', async () => {
  const h = await harness();
  h.feed(fileObs('claude', { type: 'assistant', message: { id: 't1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use' } }), 0);
  h.at(10_000);
  assert.equal(h.e().status('claude', SID)!.confidence, 'heuristic');
  assert.deepEqual(h.waits, []);
});

test('interleaved requests notify once each with their own state; resolution, error and end never notify', async () => {
  const h = await harness();
  h.feed(H('UserPromptSubmit', { prompt: 'p' }), 0);
  h.feed(H('PreToolUse', { tool_use_id: 'a', tool_name: 'Write' }, 10), 10);
  h.feed(H('PermissionRequest', { tool_name: 'Write' }, 20), 20);
  h.feed(H('Elicitation', { mcp_server_name: 's' }, 30), 30);
  h.feed(H('ElicitationResult', { mcp_server_name: 's', action: 'accept' }, 40), 40);
  h.feed(H('PostToolUse', { tool_use_id: 'a' }, 50), 50);
  h.feed(H('StopFailure', {}, 60), 60);
  h.feed(H('SessionEnd', {}, 70), 70);
  assert.deepEqual(h.waits.map((w) => w.state), ['waiting-for-permission', 'needs-input']);
});

test('a refold from a delayed delivery and a restart reload never repeat an intent', async () => {
  const h = await harness();
  h.feed(H('UserPromptSubmit', { prompt: 'p' }), 0);
  h.feed(H('PreToolUse', { tool_use_id: 'a', tool_name: 'Write' }, 10), 10);
  h.feed(H('PermissionRequest', { tool_name: 'Write' }, 20), 20);
  h.feed(H('CwdChanged', {}, 5), 30); // out of order: the session refolds with the request still pending
  assert.equal(h.waits.length, 1);
  h.restart();
  h.feed(H('CwdChanged', {}, 40), 40);
  assert.equal(h.waits.length, 1, 'the reloaded pending request is not new');
  assert.equal(h.e().status('claude', SID)!.lifecycle, 'waiting-for-permission');
});

test('review M2: a later id-less request joined to an already resolved tool id still notifies; one prompt reported twice notifies once', async () => {
  const h = await harness();
  h.feed(H('UserPromptSubmit', { prompt: 'p' }), 0);
  h.feed(H('PreToolUse', { tool_use_id: 't1', tool_name: 'Write' }, 10), 10);
  h.feed(H('PermissionRequest', { tool_name: 'Write' }, 20), 20);
  h.feed(H('Notification', { notification_type: 'permission_prompt' }, 25), 25); // the same prompt, second channel
  assert.equal(h.waits.length, 1);
  h.feed(H('PostToolUse', { tool_use_id: 't1' }, 30), 30);
  h.feed(H('PermissionRequest', { tool_name: 'Write' }, 40), 40); // no PreToolUse in between: joins the stale t1
  assert.equal(h.e().status('claude', SID)!.lifecycle, 'waiting-for-permission');
  assert.equal(h.waits.length, 2);
});

test('review M3: a request received more than 60 s ago (spool replay after an outage) does not notify', async () => {
  const h = await harness();
  h.feed(H('UserPromptSubmit', { prompt: 'p' }), 0);
  h.feed(H('PreToolUse', { tool_use_id: 'old', tool_name: 'Write' }, 10), 120_000);
  h.feed(H('PermissionRequest', { tool_name: 'Write' }, 20), 120_000);
  assert.deepEqual(h.waits, []);
  h.feed(H('PostToolUse', { tool_use_id: 'old' }, 30), 120_000);
  h.feed(H('PreToolUse', { tool_use_id: 'new', tool_name: 'Write' }, 100_000), 120_000);
  h.feed(H('PermissionRequest', { tool_name: 'Write' }, 100_000), 120_000); // 20 s old: still notifies
  assert.equal(h.waits.length, 1);
});

test('a late request notifies only if it is still pending once sorted in causal order', async () => {
  const h = await harness();
  h.feed(H('UserPromptSubmit', { prompt: 'p' }), 0);
  h.feed(H('ElicitationResult', { mcp_server_name: 's', action: 'cancel' }, 40), 40);
  h.feed(H('Elicitation', { mcp_server_name: 's' }, 30), 50); // sorts before its result: nothing is pending after it
  assert.deepEqual(h.waits, []);
});
