// P0-S13-T4 capture listener: capture-listener.ts <socket> <out.jsonl>. Decodes tee frames (4-byte BE length + JSON)
// and appends each record as one JSON line to <out> (0600). Never prints; SIGTERM closes and removes the socket.
import { appendFileSync, chmodSync, lstatSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';

const MAX_FRAME = 1024 * 1024;
const [sock, out] = process.argv.slice(2);
if (!sock || !out) process.exit(2);

try { if (lstatSync(sock).isSocket()) rmSync(sock); } catch { /* no stale socket */ }
const srv = createServer((s) => {
  let buf = Buffer.alloc(0);
  s.on('error', () => {});
  s.on('data', (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4) {
      const n = buf.readUInt32BE(0);
      if (n > MAX_FRAME) { s.destroy(); return; }
      if (buf.length < 4 + n) return;
      try { appendFileSync(out, `${JSON.stringify(JSON.parse(buf.subarray(4, 4 + n).toString('utf8')))}\n`, { mode: 0o600 }); } catch { /* bad frame dropped */ }
      buf = buf.subarray(4 + n);
    }
  });
});
srv.on('error', () => process.exit(1));
srv.listen(sock, () => chmodSync(sock, 0o600));
process.on('SIGTERM', () => { srv.close(); try { rmSync(sock); } catch { /* already gone */ } process.exit(0); });
