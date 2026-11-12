// XAIBO-PROD-312 (P3-T12; EC-42, §5.11): stored times are UTC ms and timers use elapsed ms, so child processes with TZ
// set to DST zones across the transitions give identical parsed times and timer outcomes. An agent timestamp without an
// explicit offset is unknown in every zone, never read as local time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const PROBE = join(import.meta.dirname, '..', 'helpers', 'tz-probe.ts');
const ZONES = ['UTC', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kolkata'];
type Out = { parsed: Record<'claude' | 'codex' | 'agy', number | null>[]; timers: string[] };

function run(tz: string): Out {
  const r = spawnSync(process.execPath, [PROBE], { env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `probe in ${tz}: ${r.stderr}`);
  return JSON.parse(r.stdout) as Out;
}

test('EC-42: identical stored ms and timer outcomes in every zone; offset-less timestamps are unknown', () => {
  const outs = ZONES.map(run);
  for (const [i, o] of outs.entries()) assert.deepEqual(o, outs[0], `TZ=${ZONES[i]} differs from UTC`);
  const { parsed, timers } = outs[0]!;
  const want = [Date.parse('2026-03-08T06:59:59Z'), Date.parse('2026-03-08T07:00:00Z'), Date.parse('2026-03-08T06:30:00Z'),
    Date.parse('2026-03-08T07:30:00Z'), Date.parse('2026-10-25T00:30:00Z'), Date.parse('2026-10-25T00:30:00Z'),
    Date.parse('2026-03-08T07:00:00Z'), Date.parse('2026-03-08T07:00:00.500Z'), Date.parse('2026-03-08T07:00:00.123Z'), null,
    null, null, null];
  assert.deepEqual(parsed, want.map((v) => ({ claude: v, codex: v, agy: v })));
  assert.deepEqual(timers, ['busy|Finishing…|', 'busy|Finishing…|', 'idle||', 'busy||', 'busy||R1']);
});
