// XAIBO-PROD-308 (P3-T08, EC-02): a session started before hooks is backfilled from its transcript as inferred and is
// upgraded to confirmed on its first hook; the upgrade survives a service restart on the same store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/service/store/db.ts';
import { createEngine } from '../../src/service/status/engine.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'synthetic', 'claude', '2.1.319', 'usage-basic');
const SID = '00000000-0000-4000-8000-000000001000';

test('EC-02: transcript-only backfill is inferred; the first hook confirms; a restart keeps it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xaibo-prehook-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'b') });
  let now = Date.parse('2026-01-01T00:01:00.000Z');
  const make = () => createEngine({ db, now: () => now, settleMs: 4000, log: () => {} });
  let e = make();
  const lines = readFileSync(join(FIX, `${SID}.jsonl`), 'utf8').trimEnd().split('\n');
  let offset = 0;
  for (const line of lines) {
    e.ingest({ source: 'file', agent: 'claude', sessionId: SID, file: `${SID}.jsonl`, offset, line, receivedTs: now });
    offset += Buffer.byteLength(line) + 1;
  }
  const backfilled = e.status('claude', SID)!;
  assert.equal(backfilled.confidence, 'inferred');
  assert.notEqual(backfilled.lifecycle, 'unknown');
  now += 1000;
  e.advance(now);
  e.ingest({ source: 'hook', envelope: { v: 1, delivery_id: 'prehook-1', agent: 'claude', profile_key: 'p1', event: 'UserPromptSubmit', session_id: SID,
    cwd: '/tmp/xaibo-fixture/alpha', received_ts: now, payload: { session_id: SID, hook_event_name: 'UserPromptSubmit', prompt: 'p' } } });
  assert.deepEqual([e.status('claude', SID)!.lifecycle, e.status('claude', SID)!.confidence], ['busy', 'confirmed']);
  e.close();
  e = make();
  e.advance(now);
  assert.deepEqual([e.status('claude', SID)!.lifecycle, e.status('claude', SID)!.confidence], ['busy', 'confirmed']);
  e.close();
  db.close();
});
