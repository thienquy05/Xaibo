// S3 candidate C receiver (P0-S3-T6): loopback HTTP on 127.0.0.1 with an ephemeral port (never recorded), SEC2
// conditional-receiver rules: token header, no Origin, exact loopback Host, JSON only, body <= 1 MB, empty 2xx body,
// no decision/context fields. Port and token go to <data>/run/http.json (0600) for the temp-profile settings.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_BODY = 1024 * 1024;
const BODY_DEADLINE_MS = 1_000;

export async function startHttpReceiver(dataDir: string, onEvent: (d: Record<string, unknown>, t_recv: bigint) => void) {
  const token = Buffer.from(readFileSync(path.join(dataDir, 'run', 'token'), 'utf8')); // shared with the socket receiver
  const rejected: Record<string, number> = {};
  let port = 0;
  const bad = (why: string, res: { writeHead: (n: number) => void; end: () => void }, code = 400) => { rejected[why] = (rejected[why] ?? 0) + 1; res.writeHead(code); res.end(); };
  const server: Server = createServer((req: IncomingMessage, res) => {
    if (req.method !== 'POST') return bad('method', res, 405);
    if (req.headers.origin !== undefined) return bad('origin', res, 403);
    if (req.headers.host !== `127.0.0.1:${port}`) return bad('host', res, 403);
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return bad('content-type', res, 415);
    const t = Buffer.from(String(req.headers['x-xaibo-token'] ?? ''));
    if (t.length !== token.length || !timingSafeEqual(t, token)) return bad('token', res, 401);
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { req.destroy(); rejected.deadline = (rejected.deadline ?? 0) + 1; }, BODY_DEADLINE_MS);
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { clearTimeout(timer); req.destroy(); rejected['too-large'] = (rejected['too-large'] ?? 0) + 1; } else chunks.push(c); });
    req.on('end', () => {
      clearTimeout(timer);
      const t_recv = process.hrtime.bigint();
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return bad('bad-json', res); }
      res.writeHead(200, { 'content-length': '0' }); // empty body: success, no decision, no context
      res.end();
      onEvent({ v: 1, delivery_id: randomUUID(), agent: 'claude', event: String(payload.hook_event_name ?? 'unknown'), payload, via: 'http' }, t_recv);
    });
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  port = (server.address() as { port: number }).port;
  writeFileSync(path.join(dataDir, 'run', 'http.json'), JSON.stringify({ port }), { mode: 0o600 });
  return { rejected, close: () => new Promise<void>((r) => server.close(() => r())) };
}
