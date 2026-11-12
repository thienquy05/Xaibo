// M3 full (P2-T14, plan §6.6, OQ-P2-03) on the mixed Claude/Codex/agy corpus (scripts/gen-perf-corpus.ts --case t1mix):
// (1) full import <= 120 s: process creation -> every discovered file's checkpoint at EOF (offset = size, status ok) after
//     the service's backfill_done (the writer queue is drained by then); pricing runs inside it;
// (2) usable list p95 <= 1.5 s: first-usable-page mark over cold runs while the corpus imports;
// (3) no renderer frame > 100 ms: long frames over the first-list windows and over the whole timed import.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { close, environment, fileBytes, firstPage, launch, longFramesOf, query, sleep, stats, waitForEvent } from './app.ts';

const IMPORT_TARGET_MS = 120_000;
const LIST_TARGET_MS = 1_500;

export async function m3Full(corpus: string, runs: number) {
  const summary = JSON.parse(readFileSync(path.join(corpus, 'summary.json'), 'utf8')) as { case: string; files: number };
  if (summary.case !== 't1mix') throw new Error('m3-full needs the mixed corpus: node scripts/gen-perf-corpus.ts --case t1mix');
  const home = path.join(corpus, 'home');
  const roots = { codex: path.join(home, '.codex'), agy: path.join(home, '.gemini', 'antigravity-cli') };
  const claude = path.join(home, '.claude');
  const times: number[] = [];
  const longFrames: number[] = [];
  let missing = 0;
  let env: Awaited<ReturnType<typeof environment>> | undefined;

  for (let i = 0; i < runs; i++) {
    const l = await launch(claude, roots);
    try {
      env ??= await environment(l.app);
      const r = await firstPage(l);
      if (r.ms === null) missing++;
      else times.push(r.ms);
      longFrames.push(...r.longFrames);
    } finally { await close(l); }
  }

  // Timed full import, with every frame of the whole import observed.
  const l = await launch(claude, roots);
  let importMs: number | null = null;
  let checkpoints: Record<string, number> = {};
  let db: Record<string, number> = {};
  try {
    const done = await waitForEvent(l.dataDir, 'backfill_done', 30 * 60_000);
    if (done !== null) {
      const atEof = () => query<number>(l.dataDir, "SELECT count(*) FROM source_files WHERE status = 'ok' AND offset = size");
      const notAtEof = () => query<number>(l.dataDir, "SELECT count(*) FROM source_files WHERE NOT (status = 'ok' AND offset = size)");
      const complete = () => atEof() === summary.files && notAtEof() === 0; // G2-13: exactly the expected files, none incomplete
      let reached = complete() ? done : null;
      for (const end = Date.now() + 60_000; reached === null && Date.now() < end;) {
        await sleep(100);
        if (complete()) reached = Date.now();
      }
      importMs = reached === null ? null : reached - l.created;
      checkpoints = { expected: summary.files, atEof: atEof(), notAtEof: notAtEof() };
    }
    longFrames.push(...await longFramesOf(l));
    db = {
      dbBytes: fileBytes(path.join(l.dataDir, 'xaibo.db')) + fileBytes(path.join(l.dataDir, 'xaibo.db-wal')),
      ...Object.fromEntries(['claude', 'codex', 'agy'].map((a) => [`${a}Sessions`, query<number>(l.dataDir, 'SELECT count(*) FROM sessions WHERE agent = ?', a)])),
      events: query<number>(l.dataDir, 'SELECT count(*) FROM events'),
      usageRows: query<number>(l.dataDir, 'SELECT count(*) FROM usage'),
      costEstimates: query<number>(l.dataDir, 'SELECT count(*) FROM cost_estimates'),
    };
  } finally { await close(l); }

  const m3 = stats(times);
  const over = longFrames.filter((d) => d > 100);
  return {
    metric: 'm3-full', runs, missing, m3Ms: m3, targetP95Ms: LIST_TARGET_MS, fullImportMs: importMs, targetImportMs: IMPORT_TARGET_MS, checkpoints,
    longFramesOver100Ms: { count: over.length, maxMs: over.length ? Math.max(...over) : 0 },
    pass: missing === 0 && m3.p95 <= LIST_TARGET_MS && importMs !== null && importMs <= IMPORT_TARGET_MS && over.length === 0,
    store: db, env,
  };
}
