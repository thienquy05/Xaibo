// P0-S7-T3 spike MCP server (stdio, newline-delimited JSON-RPC 2.0, stdlib only). One tool, ask_name, which sends
// elicitation/create to the client and returns only the action (accept | decline | cancel), never the typed answer.
// Registered in the TEMP Claude profile only. Writes nothing but protocol messages.
import { createInterface } from 'node:readline';

type Msg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown };
const send = (m: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const waiting = new Map<string, (m: Msg) => void>();
let canElicit = false;
let nextId = 1;

async function askName(): Promise<string> {
  if (!canElicit) return 'action=unsupported';
  const id = `elicit-${nextId++}`;
  const answer = await new Promise<Msg>((res) => {
    waiting.set(id, res);
    send({ id, method: 'elicitation/create', params: { message: 'What is your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } });
  });
  return `action=${typeof answer.result?.action === 'string' ? answer.result.action : 'error'}`;
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let m: Msg;
  try { m = JSON.parse(line) as Msg; } catch { return; }
  if (m.method === undefined) { if (typeof m.id === 'string') { waiting.get(m.id)?.(m); waiting.delete(m.id); } return; }
  if (m.id === undefined) return; // notification
  if (m.method === 'initialize') {
    canElicit = !!(m.params?.capabilities as Record<string, unknown> | undefined)?.elicitation;
    send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'spike', version: '0.0.0' } } });
  } else if (m.method === 'tools/list') {
    send({ id: m.id, result: { tools: [{ name: 'ask_name', description: 'Asks the user for a name (spike).', inputSchema: { type: 'object', properties: {} } }] } });
  } else if (m.method === 'tools/call' && m.params?.name === 'ask_name') {
    void askName().then((text) => send({ id: m.id, result: { content: [{ type: 'text', text }] } }));
  } else if (m.method === 'ping') send({ id: m.id, result: {} });
  else send({ id: m.id, error: { code: -32601, message: 'method not found' } });
});
