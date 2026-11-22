// P5-T20 (M13 at PRD §6.6 TP): the UI path P5-T11's quota probe leaves out. The packaged app imports the tp corpus once
// (session retention set to Never through Settings first, so the app's own runs never purge it; the import must reach the
// TP workload, >= 1,450 sessions and >= ~2.4 GiB DB, G5e-1, or the probe stops); then `runs` cold launches (app restart, OS
// cache not dropped, Q-5.11) each time one selection (Session list row click -> first Conversation item painted), one
// rare-term search and one common-term search (Apply -> first result page painted), and one warm launch times `runs` of
// each in the same app. G5g-2: common terms are 1- and 2-syllable corpus words that match most events (counts reported and
// checked). G5g-1: the warm launch then stays open into the app's own first retention run (10 min after its backfill,
// real clock): session retention Never, so the run only expires the tp quota streams (older than 45 days); samples run
// back to back from just before it is due until retention_run is logged; every sample that overlaps the run (ended after
// the store's quota rows were seen dropping, started before retention_run) counts with its full latency, and one that
// timed out there is a miss (G5Rr2-1). Clicks and waits run in the
// page, so no Playwright round trip is timed. Targets: selection p95 <= 300 ms, search p95 <= 500 ms. Also reported: M12
// at TP (each cold launch), DB/WAL/FTS bytes. ponytail: unfiltered search only (the filtered variant is measured at T3 in
// the owner-started scale-up stage, P5-T19); M1/M2 dispatch lag during retention needs the live-load emitter (t2.ts),
// not run here.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { agyRoot, close, environment, fileBytes, firstPage, launch, retentionNever, retentionRuns, serviceLog, sleep, stats, tpWorkload, until, waitForEvent,
  type Launched } from './app.ts';

const SELECT_TARGET_MS = 300;
const SEARCH_TARGET_MS = 500;
// Gate 5 round 3: never the row already open (aria-current): clicking it paints nothing new, so the sample timed out as a
// miss when a search result list put the open session at the clicked index
const ROWS = 'ul[aria-label="Sessions"] button:not([aria-current]):has([data-field="folder"])';
const QUOTA_CWD = '/tmp/xaibo-fixture/quota'; // scripts/gen-perf-corpus.ts --case tp
const SYL = ['ka', 'lo', 'mi', 'ne', 'su', 'ta', 'ri', 'po', 've', 'zu', 'qa', 'jo', 'fi', 'de', 'bu', 'xo']; // the generator's syllables
const RETENTION_DELAY_MS = 10 * 60_000; // src/service/boot.ts: the first retention run after each backfill
const LEAD_MS = 15_000; // sampling starts this long before the run is due
const RUN_WAIT_MS = 5 * 60_000; // after it is due, no retention_run by then is a failed phase
const MIN_OVERLAP = 3; // samples of each kind (selection; search, rare or common) that must fall inside the run
const COMMON_MIN = { events: 10_000, sessions: 500 }; // "common": far more matches than a 50-row page

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

/** G5g-2: deterministic common terms, alternating a 1-syllable word (every event has several) and a 2-syllable word. */
const commonTerms = (n: number) => Array.from({ length: n }, (_, k) => (k % 2 === 0 ? SYL[(k / 2) % SYL.length]! : SYL[k % SYL.length]! + SYL[(3 * k + 1) % SYL.length]!));

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

/** Types `term`, submits, and resolves with ms until the first result row with a snippet is painted and the rendered hit
 *  rows then (the list is virtual: at most a screenful of the 50-row page); null: none in 30 s. */
async function search(l: Launched, term: string): Promise<{ ms: number; rendered: number } | null> {
  const form = l.page.getByRole('search', { name: 'Search sessions' });
  const clear = l.page.getByRole('button', { name: 'Clear search' });
  if (await clear.isVisible()) { await clear.click(); await l.page.locator('[data-field="snippet"]').first().waitFor({ state: 'detached', timeout: 10_000 }); }
  await form.getByRole('searchbox').fill(term);
  return form.evaluate((el) => new Promise<{ ms: number; rendered: number } | null>((res) => {
    const hits = 'ul[aria-label="Sessions"] [data-field="snippet"]';
    const t0 = performance.now();
    (el as HTMLFormElement).requestSubmit();
    const tick = () => {
      if (document.querySelector(hits)) {
        requestAnimationFrame(() => requestAnimationFrame(() => res({ ms: performance.now() - t0, rendered: document.querySelectorAll(hits).length })));
        return;
      }
      if (performance.now() - t0 > 30_000) { res(null); return; }
      requestAnimationFrame(tick);
    };
    tick();
  }));
}

type Sample = { kind: 'select' | 'search' | 'common'; t0: number; t1: number; ms: number | null };

/** G5g-1: samples back to back in the open launch `l` from LEAD_MS before its first retention run is due until the run is
 *  logged. G5Rr2-1: a sample is during retention when it overlaps the run: it ended at or after the moment fewer
 *  usage_history rows were first seen (the run was under way then: quota expiry is its only work under Never) and started
 *  at or before retention_run (logged at its end). A slow one that finishes after the run keeps its whole latency; one
 *  that timed out inside the window is a miss. */
async function duringRetention(l: Launched, rare: string[], common: string[]) {
  const done = await until(() => serviceLog(l.dataDir).filter((e) => e.event === 'backfill_done' && Date.parse(e.t) >= l.created).at(-1), 30 * 60_000, 500);
  const due = Date.parse(done.t) + RETENTION_DELAY_MS;
  await sleep(Math.max(0, due - LEAD_MS - Date.now()));
  const db = new DatabaseSync(path.join(l.dataDir, 'xaibo.db'), { readOnly: true });
  const rows = db.prepare('SELECT count(*) AS n FROM usage_history');
  const count = () => Number((rows.get() as { n: number }).n);
  const samples: Sample[] = [];
  let before = 0, after = 0;
  let drop: number | null = null;
  let run: ReturnType<typeof retentionRuns>[number] | undefined;
  try {
    before = count();
    const timed = async (kind: Sample['kind'], f: () => Promise<number | null>) => {
      const t0 = Date.now();
      const ms = await f();
      const t1 = Date.now();
      if (drop === null && count() < before) drop = t1; // the run was under way as this sample ended: it overlaps
      samples.push({ kind, t0, t1, ms });
    };
    for (let k = 0; !run && Date.now() < due + RUN_WAIT_MS; k++) {
      await timed('select', () => select(l, k + 1));
      await timed('search', async () => (await search(l, rare[k % rare.length]!))?.ms ?? null);
      await timed('common', async () => (await search(l, common[k % common.length]!))?.ms ?? null);
      run = retentionRuns(l.dataDir, l.created)[0];
    }
    after = count();
  } finally { db.close(); }
  const end = run?.at;
  const inside = samples.filter((s) => drop !== null && end !== undefined && s.t1 >= drop && s.t0 <= end);
  const ms = (...kinds: Sample['kind'][]) => inside.filter((s) => kinds.includes(s.kind) && s.ms !== null).map((s) => s.ms!);
  return {
    usageHistoryRows: { before, after }, run: run ? { sessions: run.sessions, trash: run.trash, quota: run.quota } : null,
    // seconds after the run was due: first drop seen (upper bound on the start) and the logged end
    dropSeenS: drop === null ? null : (drop - due) / 1000, endS: end === undefined ? null : (end - due) / 1000,
    samples: samples.length, inside: inside.length, missing: inside.filter((s) => s.ms === null).length,
    overlap: { select: ms('select').length, search: ms('search', 'common').length },
    select: stats(ms('select')), search: stats(ms('search')), searchCommon: stats(ms('common')), searchAll: stats(ms('search', 'common')),
  };
}

export async function m13Probe(corpus: string, runs: number) {
  const summary = JSON.parse(readFileSync(path.join(corpus, 'summary.json'), 'utf8')) as { case: string };
  if (summary.case !== 'tp') throw new Error('needs the TP corpus: node scripts/gen-perf-corpus.ts --case tp');
  const home = path.join(corpus, 'home');
  const words = terms(home, runs * 2 + 1);
  if (words.length < runs * 2 + 1) throw new Error(`only ${words.length} search terms found`);
  const common = commonTerms(runs * 2 + 1);
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'xaibo-perf-m13-'));
  const dataDir = path.join(dataRoot, 'data');
  const open = () => launch(path.join(home, '.claude'), { codex: path.join(home, '.codex'), agy: agyRoot(home), dataDir });
  const cold = { select: [] as number[], search: [] as number[], common: [] as number[], m12: [] as number[] };
  const warm = { select: [] as number[], search: [] as number[], common: [] as number[] };
  const rendered: number[] = []; // hit rows painted with a common-term first page
  let missing = 0;
  const push = (to: number[], ms: number | null) => { if (ms === null) missing++; else to.push(ms); };
  const pushSearch = (to: number[], r: { ms: number; rendered: number } | null, isCommon = false) => {
    push(to, r?.ms ?? null);
    if (r && isCommon) rendered.push(r.rendered);
  };
  let env: Awaited<ReturnType<typeof environment>> | undefined;
  let importMs: number | null = null;
  let workload: ReturnType<typeof tpWorkload> | undefined;
  let bytes: Record<string, number> = {};
  let commonMatches: Record<string, { events: number; sessions: number }> = {};
  let sessions = 0;
  let runsBefore: ReturnType<typeof retentionRuns> = [];
  let during: Awaited<ReturnType<typeof duringRetention>> | undefined;
  try {
    const first = await open();
    try {
      env = await environment(first.app);
      await retentionNever(first); // stored in the data dir: every later launch keeps it
      const done = await waitForEvent(dataDir, 'backfill_done', 30 * 60_000);
      if (done === null) throw new Error('no backfill_done within 30 min');
      importMs = done - first.created;
    } finally { await close(first); }
    workload = tpWorkload(dataDir); // G5e-1: stops here when the import is smaller than TP

    for (let i = 0; i < runs; i++) {
      const l = await open();
      try {
        push(cold.m12, (await firstPage(l)).ms); // also lets the boot-time list commits settle: a replaced row ignores a click
        push(cold.select, await select(l, i % 10));
        pushSearch(cold.search, await search(l, words[i]!));
        pushSearch(cold.common, await search(l, common[i]!), true);
      } finally { await close(l); }
    }
    const l = await open();
    try {
      await firstPage(l);
      await select(l, 0); // the first use of each path is the cold sample above; these are warm
      await search(l, words[runs]!);
      await search(l, common[runs]!);
      for (let i = 0; i < runs; i++) {
        push(warm.select, await select(l, i + 1)); // never the row already open (ROWS leaves it out)
        pushSearch(warm.search, await search(l, words[runs + 1 + i]!));
        pushSearch(warm.common, await search(l, common[runs + 1 + i]!), true);
      }
      runsBefore = retentionRuns(dataDir, 0); // none may have run yet: each launch so far lived < 10 min past its backfill
      during = await duringRetention(l, words, common);
      missing += during.missing;
    } finally { await close(l); }

    const db = new DatabaseSync(path.join(dataDir, 'xaibo.db'), { readOnly: true });
    try {
      sessions = Number((db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n);
      bytes = Object.fromEntries((db.prepare(`SELECT name, sum(pgsize) AS b FROM dbstat WHERE name LIKE 'event_fts%' OR name IN ('sessions', 'events') GROUP BY name`).all() as { name: string; b: number }[])
        .map((r) => [r.name, r.b]));
      // G5g-2: matching events and sessions of the first common terms (two of each length), counted once, untimed
      const matches = db.prepare('SELECT count(*) AS events, count(DISTINCT e.session_id) AS sessions FROM (SELECT rowid AS id FROM event_fts WHERE event_fts MATCH ?) m JOIN events e ON e.id = m.id');
      commonMatches = Object.fromEntries(common.slice(0, 4).map((t) => [t, matches.get(`"${t}"`) as { events: number; sessions: number }]));
    } finally { db.close(); }
    bytes.db = fileBytes(path.join(dataDir, 'xaibo.db'));
    bytes.wal = fileBytes(path.join(dataDir, 'xaibo.db-wal'));
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
  const s = {
    m12: stats(cold.m12), coldSelect: stats(cold.select), coldSearch: stats(cold.search), coldSearchCommon: stats(cold.common),
    warmSelect: stats(warm.select), warmSearch: stats(warm.search), warmSearchCommon: stats(warm.common),
  };
  const r = during!;
  const checks = {
    coldSelect: s.coldSelect.p95 <= SELECT_TARGET_MS, warmSelect: s.warmSelect.p95 <= SELECT_TARGET_MS, // an empty sample is NaN: fails
    coldSearch: s.coldSearch.p95 <= SEARCH_TARGET_MS, warmSearch: s.warmSearch.p95 <= SEARCH_TARGET_MS,
    coldSearchCommon: s.coldSearchCommon.p95 <= SEARCH_TARGET_MS, warmSearchCommon: s.warmSearchCommon.p95 <= SEARCH_TARGET_MS,
    commonLarge: Object.values(commonMatches).length === 4 && Object.values(commonMatches).every((m) => m.events >= COMMON_MIN.events && m.sessions >= COMMON_MIN.sessions),
    noneMissing: missing === 0, noRetentionBefore: runsBefore.length === 0,
    // the run kept every session (Never) and expired the quota streams
    retentionRan: r.run !== null && r.run.sessions === 0 && r.run.trash === 0 && r.run.quota > 0 && r.usageHistoryRows.after < r.usageHistoryRows.before,
    retentionOverlap: r.overlap.select >= MIN_OVERLAP && r.overlap.search >= MIN_OVERLAP,
    retentionSelect: r.select.p95 <= SELECT_TARGET_MS, retentionSearch: r.searchAll.p95 <= SEARCH_TARGET_MS,
  };
  return {
    tier: 'TP', metric: 'm13', runs, env, importMs, workload, sessions, bytes, ...s, commonTerms: common.slice(0, 4), commonMatches,
    commonRenderedHits: stats(rendered), missing, retentionRunsBefore: runsBefore.length, duringRetention: r, checks,
    pass: Object.values(checks).every(Boolean),
  };
}
