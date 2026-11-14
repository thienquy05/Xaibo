// P3-T16c helper audit, second layer (plan P3-T16, M6): a `node --import` preload that records every outbound socket and
// HTTP request the process makes, through Node's diagnostics_channel, to the JSON-lines file named by XAIBO_NET_RECORD
// (one line each, written synchronously so a fast exit cannot lose it). Hosts and kinds only, never payloads. DNS has no
// channel: the Seatbelt layer covers it.
import { subscribe } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';
import type { Socket } from 'node:net';

const out = process.env['XAIBO_NET_RECORD'];
if (out) {
  const rec = (o: object) => appendFileSync(out, `${JSON.stringify(o)}\n`);
  // Published before connect() runs; the handle (Pipe for a Unix socket, TCP otherwise) and the host exist one tick later.
  subscribe('net.client.socket', (m) => {
    const socket = (m as { socket: Socket & { _handle?: object | null; _host?: string | null } }).socket;
    process.nextTick(() => rec({ ch: 'net.client.socket', kind: socket._handle?.constructor.name ?? 'none', host: socket._host ?? socket.remoteAddress ?? null }));
  });
  for (const ch of ['http.client.request.start', 'undici:request:create']) subscribe(ch, () => rec({ ch }));
}
