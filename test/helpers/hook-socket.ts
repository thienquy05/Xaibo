// Synthetic hook emitter for packaged-app tests (P3-T10, moved here for P3-T11's E2E and perf probe): one delivery per
// connection on the app's hook socket (the server closes idle connections), and the synced Claude profile id read from
// the store read-only.
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDecoder, encodeFrame, type Envelope } from '../../src/shared/hook-protocol.ts';

export function claudeProfile(dataDir: string): string | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true });
    return (db.prepare("SELECT id FROM profiles WHERE agent = 'claude'").get() as { id: string } | undefined)?.id ?? null;
  } catch { return null; } finally { db?.close(); }
}

/** One delivery on its own connection: hello, envelope, wait for the ack. */
export function deliver(dataDir: string, e: Envelope): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path.join(dataDir, 'run', 'xaibo.sock'));
    const decode = createDecoder();
    sock.on('error', reject);
    sock.on('data', (c: Buffer) => { const acks = decode(c); if (acks.length) { sock.end(); resolve(acks[0]); } });
    sock.on('connect', () => {
      sock.write(encodeFrame({ v: 1, token: readFileSync(path.join(dataDir, 'run', 'token'), 'utf8') }));
      sock.write(encodeFrame(e));
    });
  });
}
