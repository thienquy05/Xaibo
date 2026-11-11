// P0-S7-T3: JSON-RPC handshake of the spike MCP server over a pipe (no agent). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

type Msg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };

function server() {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'elicit-mcp.ts')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const queue: Msg[] = []; const waiters: ((m: Msg) => void)[] = [];
  createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l) as Msg; const w = waiters.shift(); if (w) w(m); else queue.push(m); });
  const next = () => new Promise<Msg>((res, rej) => { const m = queue.shift(); if (m) return res(m); waiters.push(res); setTimeout(() => rej(new Error('no message from the server')), 3000); });
  const send = (m: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  return { child, next, send };
}

async function callWith(action: string, capabilities: object = { elicitation: {} }) {
  const s = server();
  try {
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'test', version: '0' } } });
    const init = await s.next();
    assert.equal(init.id, 1);
    assert.equal(init.result?.protocolVersion, '2025-06-18');
    s.send({ method: 'notifications/initialized' });
    s.send({ id: 2, method: 'tools/list' });
    const tools = (await s.next()).result?.tools as { name: string }[];
    assert.deepEqual(tools.map((t) => t.name), ['ask_name']);
    s.send({ id: 3, method: 'tools/call', params: { name: 'ask_name', arguments: {} } });
    let m = await s.next();
    if (m.method === 'elicitation/create') {
      assert.equal(typeof m.params?.message, 'string');
      s.send({ id: m.id, result: action === 'accept' ? { action, content: { name: 'Synthetic' } } : { action } });
      m = await s.next();
    }
    assert.equal(m.id, 3);
    return (m.result?.content as { text: string }[])[0]!.text;
  } finally { s.child.kill(); }
}

test('handshake, tools/list, and ask_name relays the elicitation action without echoing the answer', async () => {
  assert.equal(await callWith('accept'), 'action=accept');
  assert.equal(await callWith('decline'), 'action=decline');
  assert.equal(await callWith('cancel'), 'action=cancel');
});

test('a client without the elicitation capability gets a plain result, no request', async () => {
  assert.equal(await callWith('accept', {}), 'action=unsupported');
});
