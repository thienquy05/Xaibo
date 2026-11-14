// XAIBO-PROD-304 (P3-T04, EC-46): upgrade while agents run. Hooks keep calling the stable shim; while the service is
// down they spool; the forwarder is replaced by an atomic rename; on restart the service listens, then replays: every
// delivery is stored once, the spool is empty, and a record of an unknown protocol version is refused and counted
// (no v-1 path until a second version exists). Skips only on the Claude sandbox's EPERM for bind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { startHooks } from '../../src/service/receivers/intake.ts';
import { replaySpool } from '../../src/service/receivers/spool-replay.ts';
import { count } from '../helpers/claude-profile.ts';
import { envelope, hookStore, installShim, run, SESSION } from '../helpers/hook-store.ts';

const probe = await (async () => {
  const { dir } = await hookStore();
  return new Promise<string>((resolve) => {
    const s = net.createServer().once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error')).listen(join(dir, 'p.sock'), () => s.close(() => resolve('ok')));
  });
})();
if (probe !== 'ok' && probe !== 'EPERM') throw new Error(`unexpected socket probe failure: ${probe}`);
const skip = probe === 'EPERM' ? 'Unix socket bind is denied here (Claude sandbox); runs in the unsandboxed suite' : false;

test('EC-46: fire during, across and after a forwarder upgrade with a service restart: each delivery once, spool empty', { skip }, async () => {
  const h = await hookStore();
  const shim = installShim(h.dir);
  const fire = async (n: number) => {
    const r = await run(shim.hook, ['hook', 'claude', 'p1'], JSON.stringify({ hook_event_name: 'PostToolUse', session_id: SESSION, n }));
    assert.equal(r.status, 0);
    assert.equal(r.out, 0);
  };
  let svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer });
  assert.ok(svc.socket, 'listening');
  for (let i = 0; i < 5; i++) await fire(i);
  await svc.close();

  for (let i = 5; i < 10; i++) await fire(i); // service down: spooled
  writeFileSync(join(shim.bin, '.xaibo-forwarder.new'), shim.forwarder, { mode: 0o755 });
  renameSync(join(shim.bin, '.xaibo-forwarder.new'), join(shim.bin, 'xaibo-forwarder')); // the upgrade
  for (let i = 10; i < 15; i++) await fire(i);
  const spool = join(h.dir, 'spool');
  writeFileSync(join(spool, '2026-01-01.jsonl'), `\n${JSON.stringify({ ...envelope(), v: 2 })}\n`, { mode: 0o600 });

  svc = await startHooks({ dataDir: h.dir, db: h.db, writer: h.writer });
  try {
    assert.equal((await svc.replay).torn, 1, 'the unknown version is refused');
    for (let i = 15; i < 20; i++) await fire(i); // after the restart
    await replaySpool({ dataDir: h.dir, db: h.db, deliver: svc.intake.deliver }); // any slow-ack spill of the last five
    const ns = h.db.prepare("SELECT json_extract(raw, '$.payload.n') AS n FROM events WHERE source = 'hook' ORDER BY n").all().map((r) => (r as { n: number }).n);
    assert.deepEqual(ns, Array.from({ length: 20 }, (_, i) => i));
    assert.equal(count(h.db, 'SELECT count(*) FROM hook_delivery'), 20);
    assert.deepEqual(existsSync(spool) ? readdirSync(spool).filter((f) => f.endsWith('.jsonl')) : [], []);
    assert.equal(count(h.db, "SELECT count FROM hook_gaps WHERE reason = 'spool-torn'"), 1);
  } finally { await svc.close(); }
});
