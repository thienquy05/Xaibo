// Fresh store with one Claude profile (`p1`) plus hook envelopes, for the P3-T04 intake and replay tests.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Envelope } from '../../src/shared/hook-protocol.ts';
import { createIntake, type IntakeOptions } from '../../src/service/receivers/intake.ts';
import { openStore } from '../../src/service/store/db.ts';
import { Writer, type WriterOptions } from '../../src/service/store/writer.ts';

export const SESSION = '00000000-0000-4000-8000-0000000f0401';
export const T0 = Date.parse('2026-01-01T00:00:00.000Z');

export function envelope(o: Partial<Envelope> = {}): Envelope {
  return {
    v: 1, delivery_id: randomUUID(), agent: 'claude', profile_key: 'p1', event: 'Stop', session_id: SESSION,
    cwd: '/tmp/xaibo-fixture/alpha', received_ts: T0, payload: { hook_event_name: 'Stop', session_id: SESSION }, ...o,
  };
}

/** Short real path (the socket path limit), store in <dir>/xaibo.db, profile p1 (claude). */
export async function hookStore(o: { writer?: WriterOptions; intake?: Omit<IntakeOptions, 'db' | 'writer'> } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'xh-')));
  const store = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'backups') });
  store.db.prepare("INSERT INTO profiles (id, agent, root, origin) VALUES ('p1', 'claude', ?, 'default')").run(join(dir, 'claude'));
  const writer = new Writer(store.db, o.writer);
  const intake = createIntake({ db: store.db, writer, ...o.intake });
  return { dir, db: store.db, writer, intake };
}

/** Runs a command without blocking this event loop (an in-process socket server must be able to ack). */
export function run(cmd: string, args: string[], input: string, env: Record<string, string> = {}): Promise<{ status: number | null; out: number }> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: { PATH: process.env.PATH ?? '', ...env } });
    let out = 0;
    c.stdout.on('data', (b: Buffer) => { out += b.length; });
    c.stderr.on('data', (b: Buffer) => { out += b.length; });
    c.on('error', reject);
    c.on('close', (status) => resolve({ status, out }));
    c.stdin.on('error', () => {});
    c.stdin.end(input);
  });
}

/** The installed layout: <app>/integrations/bin/{xaibo-hook, xaibo-forwarder}, the forwarder a dev-runtime wrapper. */
export function installShim(app: string): { bin: string; hook: string; forwarder: string } {
  const repo = join(import.meta.dirname, '..', '..');
  const bin = join(app, 'integrations', 'bin');
  mkdirSync(bin, { recursive: true });
  const hook = join(bin, 'xaibo-hook');
  copyFileSync(join(repo, 'src', 'forwarder', 'xaibo-hook'), hook);
  chmodSync(hook, 0o755);
  // ELECTRON_RUN_AS_NODE: under test:electron the exec path is Electron, which must run the forwarder as Node (as the SEA would)
  const forwarder = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(repo, 'src', 'forwarder', 'forwarder.ts'))} "$@"\n`;
  writeFileSync(join(bin, 'xaibo-forwarder'), forwarder, { mode: 0o755 });
  return { bin, hook, forwarder };
}
