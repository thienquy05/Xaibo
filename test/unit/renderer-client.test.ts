// XAIBO-PROD-110 (P1-T12): the renderer's port client. Requests carry increasing ids; a response resolves only its own
// request; pushes go to their handlers; every message is validated and invalid ones are counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type PortLike } from '../../src/renderer/client.ts';
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
const row: SessionRow = { id: 1, agent: 'claude', entrypoint: null, cwd: null, title: null, lastActivity: null, drift: false, compressed: false, quarantined: 0 };

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

test('close detaches and closes the port', () => {
  const f = fakePort();
  const c = createClient(f.port, { sessions() {}, agents() {} });
  c.close();
  assert.equal(f.port.onmessage, null);
  assert.equal(f.port.closed, true);
});
