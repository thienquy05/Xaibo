// XAIBO-PROD-312 (P3-T12; EC-43, FR-02, §6.4): main forwards power suspend (stamped with its own clock at the event, so a
// message delivered only after the wake still marks the right start) and resume to the service; a busy session over a
// 2-hour suspend on the fake clock gets no R1 finding, reads stale across the gap and connected on new evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forwardPower } from '../../src/main/power.ts';
import { parseServiceCommand, type ServiceCommand } from '../../src/shared/ipc.ts';
import { openStore } from '../../src/service/store/db.ts';
import { createEngine } from '../../src/service/status/engine.ts';
import { hookObs, SID, T0 } from '../helpers/status.ts';

test('power: suspend sends suspend with the time of the event; resume sends wake', () => {
  const power = new EventEmitter();
  const sent: ServiceCommand[] = [];
  let t = 1_000;
  forwardPower(power, (c) => sent.push(c), () => t);
  power.emit('suspend');
  t = 7_201_000;
  power.emit('resume');
  assert.deepEqual(sent, [{ v: 1, type: 'suspend', at: 1_000 }, { v: 1, type: 'wake' }]);
});

test('suspend command: at is a positive finite ms time; extra fields stripped', () => {
  assert.deepEqual(parseServiceCommand({ v: 1, type: 'suspend', at: 5, x: 1 }), { v: 1, type: 'suspend', at: 5 });
  for (const at of [undefined, 0, -1, Number.NaN, Infinity, '5']) assert.equal(parseServiceCommand({ v: 1, type: 'suspend', at }), null, String(at));
});

test('EC-43: busy session, 2-hour suspend on the fake clock, resume: no R1, stale, then connected on new evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xaibo-sleep-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'b') });
  let now = T0;
  const e = createEngine({ db, now: () => now, settleMs: 4000, log: () => {} });
  e.ingest(hookObs('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'p' }, { at: 0 }));
  now = T0 + 60_000; e.suspend(now);
  now = T0 + 60_000 + 7_200_000; e.resume(now);
  let s = e.status('claude', 'p1', SID)!;
  assert.deepEqual([s.lifecycle, s.health, s.findings], ['busy', 'stale', []]);
  now += 1000;
  e.ingest(hookObs('claude', { hook_event_name: 'PreToolUse', tool_use_id: 't', tool_name: 'Bash' }, { at: now - T0 }));
  s = e.status('claude', 'p1', SID)!;
  assert.deepEqual([s.lifecycle, s.health, s.findings], ['busy', 'connected', []]);
  now += 299_000; // 4 min 59 s awake since the call started; R5 needs 10 min
  assert.deepEqual(e.status('claude', 'p1', SID)!.findings, []);
});

test('review L3: a second suspend while asleep is ignored, so health and the R1 exclusion agree on the sleep start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xaibo-sleep-'));
  const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'b') });
  let now = T0;
  const e = createEngine({ db, now: () => now, settleMs: 4000, log: () => {} });
  e.ingest(hookObs('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'p' }, { at: 0 }));
  now = T0 + 60_000; e.suspend(now);
  e.ingest(hookObs('claude', { hook_event_name: 'PreToolUse', tool_use_id: 't', tool_name: 'Bash' }, { at: 100_000 })); // received after the first suspend
  e.suspend(T0 + 7_000_000); // a duplicate suspend for the same sleep
  now = T0 + 7_260_000; e.resume(now);
  assert.equal(e.status('claude', 'p1', SID)!.health, 'connected', 'evidence after the sleep start (60 s) is newer than the suspend');
});
