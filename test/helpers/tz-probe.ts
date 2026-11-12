// EC-42 probe (P3-T12), run as a child process with TZ set by test/unit/timezone-dst.test.ts: parses agent timestamps
// around the 2026 US and EU DST transitions through the Claude, Codex and agy parsers, and runs status-engine timers
// (settle, R1) on a fake clock across the US spring-forward instant. Prints one JSON line; stored ms only, never content.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLine as agy } from '../../src/service/adapters/agy/parse.ts';
import { parseLine as claude } from '../../src/service/adapters/claude/parse.ts';
import { parseLine as codex } from '../../src/service/adapters/codex/parse.ts';
import { createEngine } from '../../src/service/status/engine.ts';
import { openStore } from '../../src/service/store/db.ts';
import { hookObs, SID } from './status.ts';

export const STAMPS = [
  '2026-03-08T06:59:59.000Z', '2026-03-08T07:00:00Z', '2026-03-08T01:30:00-05:00', '2026-03-08T03:30:00-04:00',
  '2026-10-25T01:30:00+01:00', '2026-10-25T00:30:00.000+00:00',
  '2026-03-08T12:30:00+0530', '2026-03-08 07:00:00.5Z', '2026-03-08T04:00:00.123456-0300', // review: explicit offsets, other spellings
  '2026-03-08T07:00:00+00', // V8 cannot parse an hour-only offset: unknown
  '2026-03-08T02:30:00', '2026-11-01T01:30:00.000', '2026-03-29T01:30:00', // no offset: nonexistent / ambiguous local times
];
const ms = (r: { ok: boolean; record?: { sourceTs?: number } } | null) => (r?.ok && Number.isFinite(r.record?.sourceTs) ? r.record!.sourceTs! : null);
const ctx = { offset: 0, fileMtime: 0, receivedTs: 0 };
const parsed = STAMPS.map((t) => ({
  claude: ms(claude(Buffer.from(JSON.stringify({ type: 'user', uuid: 'u', timestamp: t, message: { role: 'user', content: 'p' } })), ctx)),
  codex: ms(codex(Buffer.from(JSON.stringify({ type: 'event_msg', timestamp: t, payload: { type: 'task_started' } })), { ...ctx, fileIdentity: 'f' })),
  agy: ms(agy(Buffer.from(JSON.stringify({ type: 'USER_INPUT', step_index: 0, created_at: t })), ctx)),
}));

const dir = mkdtempSync(join(tmpdir(), 'xaibo-tz-'));
const { db } = await openStore({ file: join(dir, 'xaibo.db'), backupDir: join(dir, 'b') });
const T = Date.parse('2026-03-08T06:59:58.000Z'); // 2 s before 02:00 EST becomes 03:00 EDT
let now = T;
const e = createEngine({ db, now: () => now, settleMs: 4000, log: () => {} });
const read = () => { const s = e.status('claude', SID)!; return [s.lifecycle, s.reason, s.findings.join(',')].join('|'); };
const timers: string[] = [];
const feed = (event: string, t: number) => {
  now = t;
  const o = hookObs('claude', { hook_event_name: event });
  e.ingest({ ...o, envelope: { ...o.envelope, received_ts: t } });
};
feed('UserPromptSubmit', T);
feed('Stop', T + 1000);
for (const d of [2000, 4999, 5001]) { now = T + d; timers.push(read()); }
feed('UserPromptSubmit', T + 10_000);
for (const d of [10_000 + 300_000, 10_000 + 300_001]) { now = T + d; timers.push(read()); }
e.close();
db.close();
process.stdout.write(`${JSON.stringify({ parsed, timers })}\n`);
