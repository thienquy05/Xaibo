// XAIBO-PROD-431 (P4-T12b finding, EC-44): a service that starts while the disk is full cannot create its socket and
// listened never again, so hooks were lost until the next restart. A failed listen is retried until it listens; hooks
// the forwarder spooled meanwhile replay after the late listen; close() stops the retry. The listen is made to fail by
// a regular file where run/ must be (the socket server refuses it), then the file is removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHooks } from '../../src/service/receivers/intake.ts';
import { count } from '../helpers/claude-profile.ts';
import { envelope, hookStore } from '../helpers/hook-store.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms: number) {
  for (const end = Date.now() + ms; !f(); await sleep(20)) if (Date.now() > end) return false;
  return true;
}
const logger = () => { const events: string[] = []; return { events, log: { log: (e: string) => { events.push(e); } } }; };

test('a socket that cannot listen at start retries until it listens, then replays what was spooled meanwhile', async () => {
  const h = await hookStore();
  writeFileSync(join(h.dir, 'run'), ''); // run/ cannot be made: the listen fails, as a full disk makes it fail
  const l = logger();
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, log: l.log, socketRetryMs: 50 });
  try {
    await svc.replay; // the start replay found nothing
    assert.equal(svc.socket, null);
    await sleep(200); // several retries fail
    assert.deepEqual(l.events.filter((e) => e.startsWith('hook_socket')), ['hook_socket_failed'], 'one failure line per outage, not one per retry');
    mkdirSync(join(h.dir, 'spool'), { mode: 0o700 }); // the forwarder spooled a hook while nothing listened
    writeFileSync(join(h.dir, 'spool', '2026-01-01.jsonl'), `\n${JSON.stringify(envelope())}\n`, { mode: 0o600 });
    rmSync(join(h.dir, 'run')); // space is back
    assert.ok(await until(() => svc.socket !== null, 2000), 'listens again without a restart');
    assert.ok(existsSync(join(h.dir, 'run', 'xaibo.sock')));
    assert.ok(l.events.includes('hook_socket_listening'));
    assert.ok(await until(() => count(h.db, 'SELECT count(*) FROM hook_delivery') === 1, 3000), 'the spooled hook is stored after the late listen');
  } finally { await svc.close(); }
});

test('close() during the outage stops the retry: nothing listens afterwards', async () => {
  const h = await hookStore();
  writeFileSync(join(h.dir, 'run'), '');
  const svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer, socketRetryMs: 50 });
  await svc.close();
  rmSync(join(h.dir, 'run'));
  await sleep(200);
  assert.equal(svc.socket, null);
  assert.equal(existsSync(join(h.dir, 'run', 'xaibo.sock')), false);
});
