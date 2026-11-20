// P5-T20 (M13 at PRD §6.6 TP): the UI path P5-T11's quota probe leaves out. The packaged app imports the tp corpus once;
// then `runs` cold launches (app restart, OS cache not dropped, Q-5.11) each time one selection (Session list row click ->
// first Conversation item painted) and one search (Apply -> first result page painted), and one warm launch times `runs`
// selections and `runs` searches in the same app. Clicks and waits run in the page, so no Playwright round trip is timed.
// Targets: selection p95 <= 300 ms, search p95 <= 500 ms. Also reported: M12 at TP (each cold launch), DB/WAL/FTS bytes and whether the app's own
// retention ran (it would purge the corpus mid-measurement). ponytail: unfiltered search only; the filtered variant
// is measured at T3 in the owner-started scale-up stage (P5-T19).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { agyRoot, close, environment, fileBytes, firstPage, launch, serviceLog, stats, waitForEvent, type Launched } from './app.ts';

const SELECT_TARGET_MS = 300;
const SEARCH_TARGET_MS = 500;
const ROWS = 'ul[aria-label="Sessions"] button:has([data-field="folder"])';
const QUOTA_CWD = '/tmp/xaibo-fixture/quota'; // scripts/gen-perf-corpus.ts --case tp

/** Rarer three-syllable words from the corpus's own prompts, so every search has hits. */
function terms(home: string, n: number): string[] {
  const root = path.join(home, '.claude', 'projects');
  const out = new Set<string>();
  for (const dir of readdirSync(root)) {
    for (const f of readdirSync(path.join(root, dir)).filter((x) => x.endsWith('.jsonl'))) {
      const first = JSON.parse(readFileSync(path.join(root, dir, f), 'utf8').split('\n', 1)[0]!) as { message?: { content?: unknown } };
      const c = first.message?.content;
      if (typeof c === 'string') for (const w of c.split(' ')) if (w.length === 6) out.add(w);
      if (out.size >= n) return [...out].slice(0, n);
    }
  }
  return [...out];
}

/** Clicks the k-th rendered Session list row (the list is virtual: k wraps over the rows on screen) and resolves with ms
 *  until the first Conversation item is painted (null: none in 10 s). */
async function select(l: Launched, k: number): Promise<number | null> {
  // the tp corpus's quota-stream rollouts sort first and hold no conversation items: only sessions with content count
  const rows = l.page.locator(ROWS).filter({ hasNotText: QUOTA_CWD });
  await rows.first().waitFor({ timeout: 30_000 });
  const row = rows.nth(k % await rows.count());
  return row.evaluate((el) => new Promise<number | null>((res) => {
    for (const li of document.querySelectorAll('ul[aria-label="Conversation"] > li')) li.remove(); // a stale item never counts
    const t0 = performance.now();
    (el as HTMLElement).click();
    const tick = () => {
      if (document.querySelector('ul[aria-label="Conversation"] > li')) { requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t0))); return; }
      if (performance.now() - t0 > 10_000) { res(null); return; }
      requestAnimationFrame(tick);
    };
    tick();
  }));
}

/** Types `term`, submits, and resolves with ms until the first result row with a snippet is painted (null: none in 10 s). */
async function search(l: Launched, term: string): Promise<number | null> {
  const form = l.page.getByRole('search', { name: 'Search sessions' });
  const clear = l.page.getByRole('button', { name: 'Clear search' });
  if (await clear.isVisible()) { await clear.click(); await l.page.locator('[data-field="snippet"]').first().waitFor({ state: 'detached', timeout: 10_000 }); }
  await form.getByRole('searchbox').fill(term);
  return form.evaluate((el) => new Promise<number | null>((res) => {
    const t0 = performance.now();
    (el as HTMLFormElement).requestSubmit();
    const tick = () => {
      if (document.querySelector('ul[aria-label="Sessions"] [data-field="snippet"]')) { requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t0))); return; }
      if (performance.now() - t0 > 10_000) { res(null); return; }
      requestAnimationFrame(tick);
    };
    tick();
  }));
}

export async function m13Probe(corpus: string, runs: number) {
  const summary = JSON.parse(readFileSync(path.join(corpus, 'summary.json'), 'utf8')) as { case: string };
  if (summary.case !== 'tp') throw new Error('needs the TP corpus: node scripts/gen-perf-corpus.ts --case tp');
  const home = path.join(corpus, 'home');
  const words = terms(home, runs * 2);
  if (words.length < runs * 2) throw new Error(`only ${words.length} search terms found`);
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-m13-'));
  const dataDir = path.join(dataRoot, 'data');
  const open = () => launch(path.join(home, '.claude'), { codex: path.join(home, '.codex'), agy: agyRoot(home), dataDir });
  const cold = { select: [] as number[], search: [] as number[], m12: [] as number[] };
  const warm = { select: [] as number[], search: [] as number[] };
  const push = (to: number[], ms: number | null) => { if (ms === null) missing++; else to.push(ms); };
  let missing = 0;
  let env: Awaited<ReturnType<typeof environment>> | undefined;
  let importMs: number | null = null;
  let bytes: Record<string, number> = {};
  let sessions = 0;
  let retentionRan = false;
  try {
    const first = await open();
    try {
      env = await environment(first.app);
      const done = await waitForEvent(dataDir, 'backfill_done', 30 * 60_000);
      if (done === null) throw new Error('no backfill_done within 30 min');
      importMs = done - first.created;
    } finally { await close(first); }

    for (let i = 0; i < runs; i++) {
      const l = await open();
      try {
        push(cold.m12, (await firstPage(l)).ms); // also lets the boot-time list commits settle: a replaced row ignores a click
        push(cold.select, await select(l, i % 10));
        push(cold.search, await search(l, words[i]!));
      } finally { await close(l); }
    }
    const l = await open();
    try {
      await firstPage(l);
      await select(l, 0); // the first use of each path is the cold sample above; these are warm
      await search(l, words[runs]!);
      for (let i = 0; i < runs; i++) {
        push(warm.select, await select(l, i + 1)); // never the row already open (k wraps; consecutive k differ)
        push(warm.search, await search(l, words[runs + i]!));
      }
    } finally { await close(l); }

    const db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true });
    try {
      sessions = Number((db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n);
      bytes = Object.fromEntries((db.prepare(`SELECT name, sum(pgsize) AS b FROM dbstat WHERE name LIKE 'event_fts%' OR name IN ('sessions', 'events') GROUP BY name`).all() as { name: string; b: number }[])
        .map((r) => [r.name, r.b]));
    } finally { db.close(); }
    bytes.db = fileBytes(path.join(dataDir, 'xaibo.db'));
    bytes.wal = fileBytes(path.join(dataDir, 'xaibo.db-wal'));
  } finally {
    retentionRan = serviceLog(dataDir).some((e) => e.event === 'retention_run'); // it would have purged corpus sessions mid-run
    rmSync(dataRoot, { recursive: true, force: true });
  }
  const s = { m12: stats(cold.m12), coldSelect: stats(cold.select), coldSearch: stats(cold.search), warmSelect: stats(warm.select), warmSearch: stats(warm.search) };
  const checks = {
    coldSelect: s.coldSelect.p95 <= SELECT_TARGET_MS, warmSelect: s.warmSelect.p95 <= SELECT_TARGET_MS, // an empty sample is NaN: fails
    coldSearch: s.coldSearch.p95 <= SEARCH_TARGET_MS, warmSearch: s.warmSearch.p95 <= SEARCH_TARGET_MS,
    noneMissing: missing === 0, noRetention: !retentionRan,
  };
  return { tier: 'TP', metric: 'm13', runs, env, importMs, sessions, bytes, ...s, missing, retentionRan, checks, pass: Object.values(checks).every(Boolean) };
}
