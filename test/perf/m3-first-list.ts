// M3 first-list (P1-T14, OQ-P1-09): main process creation -> the renderer's first-usable-page mark (two frames after the
// first commit with a row), over cold runs (fresh data dir each) while the corpus imports in the background. Long frames
// above 100 ms are counted (reported at Gate 1, not enforced). One extra run times the full import, for information.
import path from 'node:path';
import { FIRST_PAGE_MARK, LONG_FRAME } from '../../src/renderer/perf-marks.ts';
import { close, environment, fileBytes, launch, query, sleep, stats, waitForEvent } from './app.ts';

export async function m3FirstList(corpus: string, runs: number, timeImport = true) {
  const claude = path.join(corpus, '.claude');
  const times: number[] = [];
  const longFrames: number[] = [];
  let missing = 0;
  let env: Awaited<ReturnType<typeof environment>> | undefined;
  for (let i = 0; i < runs; i++) {
    const l = await launch(claude);
    try {
      env ??= await environment(l.app);
      const markAt = await l.page.evaluate(async ({ name, timeout }) => {
        const t0 = performance.now();
        while (performance.now() - t0 < timeout) {
          const e = performance.getEntriesByName(name)[0];
          if (e) return performance.timeOrigin + e.startTime;
          await new Promise((r) => setTimeout(r, 10));
        }
        return null;
      }, { name: FIRST_PAGE_MARK, timeout: 30_000 });
      if (markAt === null || Number.isNaN(l.created)) missing++;
      else times.push(markAt - l.created);
      await sleep(2_000); // long frames around the first page, during the import
      longFrames.push(...await l.page.evaluate((n) => performance.getEntriesByName(n).map((e) => e.duration), LONG_FRAME));
    } finally { await close(l); }
  }

  // Full import, for information: process creation -> the service's backfill_done.
  let importMs: number | null = null;
  let db: Record<string, number> = {};
  if (timeImport) {
    const l = await launch(claude);
    try {
      const done = await waitForEvent(l.dataDir, 'backfill_done', 30 * 60_000);
      importMs = done === null ? null : done - l.created;
      db = {
        dbBytes: fileBytes(path.join(l.dataDir, 'xaibo.db')) + fileBytes(path.join(l.dataDir, 'xaibo.db-wal')),
        sessions: query<number>(l.dataDir, 'SELECT count(*) FROM sessions'),
        events: query<number>(l.dataDir, 'SELECT count(*) FROM events'),
        ftsItems: query<number>(l.dataDir, 'SELECT count(*) FROM events WHERE content IS NOT NULL'),
      };
    } finally { await close(l); }
  }

  const m3 = stats(times);
  return {
    metric: 'm3-first-list', runs, missing, m3Ms: m3, targetP95Ms: 1500, pass: missing === 0 && m3.p95 <= 1500,
    longFramesOver100Ms: { count: longFrames.length, maxMs: longFrames.length ? Math.max(...longFrames) : 0 },
    fullImportMs: importMs, store: db, env,
  };
}
