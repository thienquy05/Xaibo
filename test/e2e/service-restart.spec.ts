// XAIBO-PROD-104 (P1-T06, ROB): SIGKILL of the service restarts it with backoff; committed rows stay, without
// duplicates; a post-restart append is ingested. Evidence: the app log (event codes only) and a read-only look at the
// temp store. The renderer's health text is checked once the renderer exists (P1-T12).
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { alive, expect, servicePid, test } from './fixtures.ts';

const SESSION = '00000000-0000-4000-8000-000000001000';
const TRANSCRIPT = ['.claude', 'projects', '-tmp-xaibo-fixture-project', `${SESSION}.jsonl`];

function counts(dataDir: string) {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true });
    const n = (sql: string) => Number(Object.values(db!.prepare(sql).get() ?? {})[0]);
    return { events: n('SELECT count(*) FROM events'), distinct: n('SELECT count(DISTINCT native_id) FROM events') };
  } catch { return { events: -1, distinct: -1 }; } finally { db?.close(); }
}
const logEvents = (dataDir: string) => readFileSync(path.join(dataDir, 'logs', 'xaibo.log'), 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l) as { event: string; attempt?: number; delayMs?: number });

test('service SIGKILL: restart with backoff, committed rows kept once, a post-restart append arrives', async ({ xaibo }) => {
  const run = await xaibo.launch({ serviceKills: 1 });
  await xaibo.window(run);
  const first = await servicePid(run.app!);
  await expect.poll(() => counts(run.dataDir).events).toBe(9);

  process.kill(first, 'SIGKILL');
  await expect.poll(() => logEvents(run.dataDir).filter((e) => e.event === 'service_ready').length, { timeout: 15_000 }).toBe(2);
  expect(logEvents(run.dataDir).find((e) => e.event === 'service_restart')).toMatchObject({ attempt: 1, delayMs: 500 });
  const second = await servicePid(run.app!);
  expect(second).not.toBe(first);
  expect(alive(second)).toBe(true);
  expect(counts(run.dataDir)).toEqual({ events: 9, distinct: 9 });

  xaibo.touchStore(() => appendFileSync(path.join(xaibo.home, ...TRANSCRIPT), JSON.stringify({ parentUuid: null, type: 'user',
    uuid: '00000000-0000-4000-8000-0000000010e2', timestamp: '2026-01-01T00:02:00.000Z', cwd: '/tmp/xaibo-fixture/alpha',
    sessionId: SESSION, message: { role: 'user', content: 'after restart' } }) + '\n'));
  await expect.poll(() => counts(run.dataDir), { timeout: 15_000 }).toEqual({ events: 10, distinct: 10 });
});
