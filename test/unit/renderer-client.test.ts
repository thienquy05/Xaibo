// XAIBO-PROD-110 (P1-T12): the renderer's port client. Requests carry increasing ids; a response resolves only its own
// request; pushes go to their handlers; every message is validated and invalid ones are counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, parseVisible, type PortLike } from '../../src/renderer/client.ts';
import { workspaceApiOf } from '../../src/renderer/workspace/workspace-api.ts';

test('P4-T02: main\'s window visibility message (via the preload) is a strict boolean; anything else is ignored', () => {
  assert.equal(parseVisible({ xaiboVisible: true }), true);
  assert.equal(parseVisible({ xaiboVisible: false }), false);
  for (const x of [null, 'xaibo-port', { xaiboVisible: 'true' }, { xaiboVisible: 1 }, { visible: true }, [true]]) assert.equal(parseVisible(x), null);
});
import type { AgentStatus, SessionRow } from '../../src/shared/ipc.ts';

function fakePort() {
  const sent: unknown[] = [];
  const port: PortLike & { closed: boolean } = {
    onmessage: null, closed: false,
    postMessage(m) { sent.push(m); },
    close() { this.closed = true; },
  };
  return { port, sent, deliver: (data: unknown) => port.onmessage?.({ data }) };
}
const row: SessionRow = { id: 1, agent: 'claude', entrypoint: null, origin: null, interactive: null, model: 'Model unavailable', cwd: null, title: null, lastActivity: null, drift: false, compressed: false, quarantined: 0,
  live: null, contextPct: null, costUsd: null, costCoverage: 'unavailable', tokens: null, tokensComplete: true };

test('listSessions posts a versioned request and resolves with its own page only', async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const a = c.listSessions(null, 50);
  const b = c.listSessions({ lastActivity: 5, id: 1 }, 50);
  assert.deepEqual(f.sent, [
    { v: 1, type: 'listSessions', id: 1, cursor: null, limit: 50 },
    { v: 1, type: 'listSessions', id: 2, cursor: { lastActivity: 5, id: 1 }, limit: 50 },
  ]);
  f.deliver({ v: 1, type: 'page', id: 2, rows: [], next: null });
  f.deliver({ v: 1, type: 'page', id: 1, rows: [row], next: null });
  f.deliver({ v: 1, type: 'page', id: 99, rows: [], next: null }); // nobody asked: ignored
  assert.deepEqual(await a, { rows: [row], next: null });
  assert.deepEqual(await b, { rows: [], next: null });
});

test('pushes reach their handlers; invalid messages are dropped and counted', () => {
  const f = fakePort();
  const got: { sessions: SessionRow[][]; agents: (AgentStatus[] | null)[] } = { sessions: [], agents: [] };
  const c = createClient(f.port, { sessions: (rows) => got.sessions.push(rows), agents: (a) => got.agents.push(a) });
  f.deliver({ v: 1, type: 'sessions', rows: [row] });
  f.deliver({ v: 1, type: 'agents', agents: null });
  f.deliver({ v: 1, type: 'sessions', rows: [{ ...row, id: 'x' }] });
  f.deliver('<script>');
  assert.deepEqual(got, { sessions: [[row]], agents: [null] });
  assert.equal(c.dropped, 2);
});

test('P4-T10c1: a resync push reaches its handler', () => {
  const f = fakePort();
  let resyncs = 0;
  createClient(f.port, { sessions: () => assert.fail('no rows'), agents: () => assert.fail('no agents'), resync: () => resyncs++ });
  f.deliver({ v: 1, type: 'resync' });
  assert.equal(resyncs, 1);
});

test('close detaches and closes the port', () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  c.close();
  assert.equal(f.port.onmessage, null);
  assert.equal(f.port.closed, true);
});

test('H3: an invalid reply to a request settles it with an error instead of leaving it pending', { timeout: 5_000 }, async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const p = c.listSessions(null, 50);
  f.deliver({ v: 1, type: 'page', id: 1, rows: [{ id: 'bad' }], next: null });
  await assert.rejects(p, /invalid reply/);
  assert.equal(c.dropped, 1);
});

// XAIBO-PROD-502: an invalid message with an id but no type, for an id nothing waits on, is only counted.
test('an invalid typeless message with an unknown id is dropped without touching pending requests', async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const p = c.listSessions(null, 50);
  f.deliver({ id: 99 });
  f.deliver({ id: 1 });
  assert.equal(c.dropped, 2);
  f.deliver({ v: 1, type: 'page', id: 1, rows: [], next: null });
  assert.deepEqual(await p, { rows: [], next: null });
});

// XAIBO-PROD-404 review M2: the live-set request has its own pending map; an invalid reply rejects it; a page reply
// never settles it.
test('liveSet resolves with its own reply, ignores a page reply with its id, and rejects on an invalid reply', async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const a = c.liveSet();
  assert.deepEqual(f.sent, [{ v: 1, type: 'liveSet', id: 1 }]);
  f.deliver({ v: 1, type: 'page', id: 1, rows: [], next: null }); // a different request kind: not this one
  f.deliver({ v: 1, type: 'liveSet', id: 1, rows: [row], more: true });
  assert.deepEqual(await a, { rows: [row], more: true });
  const b = c.liveSet();
  f.deliver({ v: 1, type: 'liveSet', id: 2, rows: [row], more: 'no' });
  await assert.rejects(b, /invalid reply/);
});

// XAIBO-PROD-405: one pending map keyed by id; a reply settles only a request of its own type.
test('usage and usageHistory resolve their own replies; a reply of another type never settles them', async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const u = c.usage();
  const h = c.usageHistory(4, 'five_hour', 10, 20, null, 50);
  assert.deepEqual(f.sent, [{ v: 1, type: 'usage', id: 1 }, { v: 1, type: 'usageHistory', id: 2, scope: 4, stream: 'five_hour', from: 10, to: 20, cursor: null, limit: 50 }]);
  f.deliver({ v: 1, type: 'liveSet', id: 1, rows: [], more: false });
  f.deliver({ v: 1, type: 'usageHistory', id: 2, records: [], next: null });
  f.deliver({ v: 1, type: 'usage', id: 1, scopes: [], profiles: [] });
  assert.deepEqual(await u, []);
  assert.deepEqual(await h, { records: [], next: null });
  const bad = c.usage();
  f.deliver({ v: 1, type: 'usage', id: 3, scopes: 'none' });
  await assert.rejects(bad, /invalid reply/);
});

// XAIBO-PROD-585 (P6-T10a unit 4a): the sign-in read and its three mutations, by profile id and loaded revision only
test('signIn sends the profile id, op and revision only, and resolves the code and view of its own reply', async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const P = '00000000-0000-4000-8000-0000000c8501';
  const r = c.signIn(P, { op: 'set', method: 'api-key', expectedRevision: 2 });
  const rd = c.signIn(P, { op: 'read' });
  assert.deepEqual(f.sent, [{ v: 1, type: 'signIn', id: 1, profileId: P, op: 'set', method: 'api-key', expectedRevision: 2 }, { v: 1, type: 'signIn', id: 2, profileId: P, op: 'read' }]);
  f.deliver({ v: 1, type: 'signIn', id: 2, code: 'unavailable', view: null });
  f.deliver({ v: 1, type: 'signIn', id: 1, code: 'stale', view: { profileId: P, revision: 3, method: 'unknown', source: null, at: null, declaration: null, evidence: null, conflict: false, usingDeclaration: false, outputStatus: 'unavailable', generation: 0, boundary: null } });
  assert.deepEqual((await r).code, 'stale');
  assert.equal((await r).view?.revision, 3);
  assert.deepEqual(await rd, { code: 'unavailable', view: null });
});

// XAIBO-PROD-412 (P4-T05c): the session workspace calls; each settles only on its own reply type and id.
test('session workspace calls post their requests and resolve their own replies; an invalid reply rejects', async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const detail = c.session(9);
  const tr = c.transcript(9, 'latest', 50);
  const sl = c.slice(9, 12, 'reasoning', 0);
  const tools = c.tools(9, null, 50);
  const subs = c.subagents(9, 4, 50);
  const files = c.files(9, null, 50);
  const marks = c.markers(9, { ts: 5, id: 2 }, 50);
  assert.deepEqual(f.sent, [
    { v: 1, type: 'session', id: 1, session: 9 },
    { v: 1, type: 'transcript', id: 2, session: 9, at: 'latest', limit: 50 },
    { v: 1, type: 'slice', id: 3, session: 9, event: 12, part: 'reasoning', offset: 0 },
    { v: 1, type: 'tools', id: 4, session: 9, cursor: null, limit: 50 },
    { v: 1, type: 'subagents', id: 5, session: 9, cursor: 4, limit: 50 },
    { v: 1, type: 'files', id: 6, session: 9, cursor: null, limit: 50 },
    { v: 1, type: 'markers', id: 7, session: 9, cursor: { ts: 5, id: 2 }, limit: 50 },
  ]);
  f.deliver({ v: 1, type: 'tools', id: 1, calls: [], next: null }); // wrong type for id 1: ignored
  f.deliver({ v: 1, type: 'session', id: 1, detail: null });
  f.deliver({ v: 1, type: 'transcript', id: 2, items: [], prev: null, next: { seq: 3, id: 4 } });
  f.deliver({ v: 1, type: 'slice', id: 3, text: 'abc', next: null });
  f.deliver({ v: 1, type: 'tools', id: 4, calls: [], next: null });
  f.deliver({ v: 1, type: 'subagents', id: 5, subagents: [], next: null });
  f.deliver({ v: 1, type: 'files', id: 6, touches: [], next: 8 });
  f.deliver({ v: 1, type: 'markers', id: 7, markers: [{ turn: 3, ts: 6, model: 'model-b' }], next: null });
  assert.equal(await detail, null);
  assert.deepEqual(await tr, { items: [], prev: null, next: { seq: 3, id: 4 } });
  assert.deepEqual(await sl, { text: 'abc', next: null });
  assert.deepEqual(await tools, { calls: [], next: null });
  assert.deepEqual(await subs, { subagents: [], next: null });
  assert.deepEqual(await files, { touches: [], next: 8 });
  assert.deepEqual(await marks, { markers: [{ turn: 3, ts: 6, model: 'model-b' }], next: null });
  for (const [call, reply] of [
    [() => c.tools(9, null, 50), { type: 'tools', calls: 'x', next: null }],
    [() => c.markers(9, null, 50), { type: 'markers', markers: [], next: { ts: 5 } }],
    [() => c.transcript(9, 'first', 50), { type: 'transcript', items: [], prev: 0, next: null }],
  ] as const) {
    const p = call();
    f.deliver({ v: 1, id: (f.sent.at(-1) as { id: number }).id, ...reply });
    await assert.rejects(p, /invalid reply/, reply.type);
  }
});

// XAIBO-PROD-434 (P4-T14, EC-97): a restarted service brings a new port and main.tsx closes the old client; a request
// still waiting on the dead port must settle, or the section that asked stays loading and never refetches.
test('close() rejects every pending request; a reply after close changes nothing; answered requests keep their result', async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const answered = c.listSessions(null, 50);
  f.deliver({ v: 1, type: 'page', id: 1, rows: [row], next: null });
  const waiting = c.listSessions(null, 50);
  const settled = waiting.then(() => 'resolved', (e: Error) => e.message);
  c.close();
  assert.equal(f.port.closed, true);
  const outcome = await Promise.race([settled, new Promise((r) => setTimeout(() => r('pending'), 200))]); // bounded: a hang must fail, not stall the suite
  assert.equal(outcome, 'closed', 'the waiting request is rejected, not left hanging');
  f.deliver({ v: 1, type: 'page', id: 2, rows: [row], next: null }); // too late: the client is closed
  assert.deepEqual(await answered, { rows: [row], next: null });
});

// XAIBO-PROD-454 (G4a-1 follow-up): the workspace API main.tsx builds forwards a tool step's call id to the slice request.
test('workspaceApiOf: slice forwards the optional call selector to the port; other pages go to the current client', async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const api = workspaceApiOf(() => c);
  void api.slice(9, 12, 'text', 0, 'toolu_1');
  void api.slice(9, 12, 'text', 0);
  void api.markers(9, null, 50);
  assert.deepEqual(f.sent, [
    { v: 1, type: 'slice', id: 1, session: 9, event: 12, part: 'text', offset: 0, call: 'toolu_1' },
    { v: 1, type: 'slice', id: 2, session: 9, event: 12, part: 'text', offset: 0 },
    { v: 1, type: 'markers', id: 3, session: 9, cursor: null, limit: 50 },
  ]);
  await assert.rejects(workspaceApiOf(() => null).session(1), /no service/);
});

// XAIBO-PROD-454: a markers reply that says failed rejects, so the section shows its Retry, never an empty page.
test('markers: a failed reply rejects; an ok reply without the flag resolves', async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const bad = c.markers(9, null, 50);
  f.deliver({ v: 1, type: 'markers', id: 1, markers: [], next: null, failed: true });
  await assert.rejects(bad, /markers unavailable/);
  const ok = c.markers(9, null, 50);
  f.deliver({ v: 1, type: 'markers', id: 2, markers: [], next: null });
  assert.deepEqual(await ok, { markers: [], next: null });
  const odd = c.markers(9, null, 50);
  f.deliver({ v: 1, type: 'markers', id: 3, markers: [], next: null, failed: 'yes' });
  await assert.rejects(odd, /invalid reply/);
});

// Gate 5 G5b2-5: a history, projects or folders reply that says failed rejects, so the Session list keeps its loaded rows
// and shows the failure note with Retry (as search, map groups and markers do), never an empty page read as the end.
test('history, projects, folders: a failed reply rejects; an ok reply without the flag resolves', async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const filter = { mode: 'all' as const, agent: null, project: null, folder: null };
  const history = c.history(filter, null, 50);
  f.deliver({ v: 1, type: 'history', id: 1, rows: [], next: null, failed: true });
  await assert.rejects(history, /unavailable/);
  const projects = c.projects(null, 50);
  f.deliver({ v: 1, type: 'projects', id: 2, projects: [], next: null, failed: true });
  await assert.rejects(projects, /unavailable/);
  const folders = c.folders(3, null, 50);
  f.deliver({ v: 1, type: 'folders', id: 3, folders: [], next: null, failed: true });
  await assert.rejects(folders, /unavailable/);
  const ok = c.history(filter, null, 50);
  f.deliver({ v: 1, type: 'history', id: 4, rows: [], next: null });
  assert.deepEqual(await ok, { rows: [], next: null });
});

// XAIBO-PROD-531 (P5-T18 part 3b-2): one session's history row; failed rejects (the caller keeps its record and offers
// Retry), null resolves (gone); design security review L2: a row for another session than the one asked for rejects.
test('historyRow: its own row or null; failed rejects; a row for another session rejects', async () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  const h = { ...row, id: 7, project: null, folder: null, pinned: false, archivedAt: null, trashedAt: null, trashPurgeAt: null, keep: true, purgeAt: null };
  const ok = c.historyRow(7);
  assert.deepEqual(f.sent.at(-1), { v: 1, type: 'historyRow', id: 1, session: 7 });
  f.deliver({ v: 1, type: 'historyRow', id: 1, row: h });
  assert.deepEqual(await ok, h);
  const gone = c.historyRow(8);
  f.deliver({ v: 1, type: 'historyRow', id: 2, row: null });
  assert.equal(await gone, null);
  const failed = c.historyRow(7);
  f.deliver({ v: 1, type: 'historyRow', id: 3, row: null, failed: true });
  await assert.rejects(failed, /history row unavailable/);
  const other = c.historyRow(9);
  f.deliver({ v: 1, type: 'historyRow', id: 4, row: h });
  await assert.rejects(other, /another session/);
  for (const [i, bad] of [{ row: null, failed: false }, { row: null, failed: 1 }, { row: h, failed: true }, { row: null, extra: 1 }, { row: { ...h, purgeAt: 'x' } }].entries()) {
    const p = c.historyRow(7);
    f.deliver({ v: 1, type: 'historyRow', id: 5 + i, ...bad });
    await assert.rejects(p, /invalid reply/, JSON.stringify(bad));
  }
});
