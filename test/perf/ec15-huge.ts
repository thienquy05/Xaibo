// EC-15 (P1-T14, OQ-P1-06): a 20 MB and a 200 MB transcript (the latter with a 48 MiB record below the parse cap and an
// 80 MiB record above it). Checks: the import finishes; service RSS growth (sampled every 100 ms) within
// 2 x min(largest line, 64 MiB) + 128 MiB; content chunks of the above-cap record <= 64 KiB, searchable, no gap; the
// list pages ("Load more") while the import runs.
import path from 'node:path';
import { close, launch, query, sleep, waitForEvent } from './app.ts';

const MiB = 1 << 20;

async function one(claude: string, largestLine: number, paging: boolean) {
  const l = await launch(claude);
  try {
    const samples: number[] = []; // KiB
    let pagingMs: number | null = null;
    const rows = l.page.getByRole('table', { name: 'Sessions' }).locator('tbody tr');
    const tick = async () => {
      const kb = await l.app.evaluate(({ app }) => app.getAppMetrics().find((m) => m.name === 'xaibo-service')?.memory.workingSetSize ?? 0);
      if (kb) samples.push(kb);
      if (paging && pagingMs === null && await l.page.getByRole('button', { name: 'Load more' }).isVisible().catch(() => false)) {
        const before = await rows.count();
        const t0 = Date.now();
        await l.page.getByRole('button', { name: 'Load more' }).click();
        while ((await rows.count()) <= before && Date.now() - t0 < 30_000) await sleep(10);
        pagingMs = Date.now() - t0;
      }
    };
    const done = await waitForEvent(l.dataDir, 'backfill_done', 30 * 60_000, tick);
    const pagedDuringImport = pagingMs !== null;
    const baseline = Math.min(...samples.slice(0, 3));
    const growthMiB = (Math.max(...samples) - baseline) / 1024;
    const bound = (2 * Math.min(largestLine, 64 * MiB) + 128 * MiB) / MiB;
    return {
      importMs: done === null ? null : done - l.created, rssSamples: samples.length, baselineMiB: baseline / 1024, growthMiB, boundMiB: bound,
      maxChunkBytes: query<number | null>(l.dataDir, "SELECT max(length(CAST(content AS BLOB))) FROM events WHERE kind = 'content-chunk'"),
      contentChunks: query<number>(l.dataDir, "SELECT count(*) FROM events WHERE kind = 'content-chunk'"),
      oversizedHeads: query<number>(l.dataDir, "SELECT count(*) FROM events WHERE ingest_id LIKE 'x:%' AND content IS NULL"),
      needleHits: query<number>(l.dataDir, "SELECT count(*) FROM event_fts WHERE event_fts MATCH 'needleomega'"),
      largestInMemoryContentBytes: query<number>(l.dataDir, "SELECT max(length(CAST(content AS BLOB))) FROM events WHERE kind = 'message'"),
      gaps: query<number>(l.dataDir, 'SELECT count(*) FROM quarantine'),
      pagedDuringImport, pagingMs,
    };
  } finally { await close(l); }
}

export async function ec15Huge(corpus: string) {
  const small = await one(path.join(corpus, 'small', '.claude'), 8 * 1024, false);
  const large = await one(path.join(corpus, 'large', '.claude'), 80 * MiB, true);
  const pass = small.importMs !== null && large.importMs !== null && large.growthMiB <= large.boundMiB
    && (large.maxChunkBytes ?? 0) <= 64 * 1024 && large.needleHits >= 1 && large.oversizedHeads === 1 && large.gaps === 0 && large.pagedDuringImport;
  return { case: 'ec15', small, large, pass };
}
